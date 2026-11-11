import type {Store} from '../tracking/store';
import {releaseAction} from './release-actions';
import {releaseOutcome} from './release-result';
import {toronto} from './release';
import type {ReleaseReadiness} from './release-readiness';
type Window={name:string;minute:number;state:'refused'|'missed';reason:string};
type Gap={input:string;reason:string;knownBy:number;basis:'recorded observation'|'missed window'};
const previousDay=(day:string)=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const clock=(at:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',hour:'numeric',minute:'2-digit',hourCycle:'h23'}).format(at);
function reports(s:Store,day:string){
 const rows=s.db.query("SELECT data FROM events WHERE kind IN ('release-rehearsal','release-readiness') AND json_extract(data,'$.day')=? ORDER BY at LIMIT 1001").all(day) as {data:string}[];
 if(rows.length>1000)throw Error('release observation inventory exceeds incident bound');
 const result=rows.map(r=>JSON.parse(r.data) as ReleaseReadiness),preflight=s.get<ReleaseReadiness>(`release-preflight-report:${day}`);
 if(preflight)result.push(preflight);return result.sort((a,b)=>a.at-b.at);
}
function knownNight(s:Store,day:string){return !!(s.get(`release-window-result:${day}`)||s.get(`executor:${day}:night`)||s.get(`release-preflight-report:${day}`)||s.get(`release-rehearsal:${day}:14:00`)||s.get(`release-rehearsal:${day}:17:40`));}
function missedNight(s:Store,day:string){
 const result=s.get<{shipped:boolean}>(`release-window-result:${day}`);
 return knownNight(s,day)&&(result?result.shipped!==true:!releaseOutcome(s,day).shipped);
}
export function releaseIncident(s:Store,day:string,now=Date.now(),send=releaseAction){
 const current=toronto(now),minute=current.day===day?current.minute:1440;
 if(day>current.day||minute<1140)return {queued:false};
 const observed=reports(s,day),preflight=s.get<ReleaseReadiness>(`release-preflight-report:${day}`),windows:Window[]=[];
 for(const [name,time,step] of [['preflight',1140,'preflight'],['QA',1200,'qa'],['Production',1290,'promote']] as const){
  const effect=s.get<{state:string;evidence?:{reason?:string}}>(`executor:${day}:${step}`);
  if(minute<time)continue;
  if(name==='preflight'&&preflight?.ready===false)windows.push({name,minute:time,state:'refused',reason:preflight.missing.map(g=>g.input).join(', ')});
  else if(effect?.state==='failure')windows.push({name,minute:time,state:'refused',reason:effect.evidence?.reason??`${name} checks or completion failed`});
  else if(!effect&&minute>time)windows.push({name,minute:time,state:'missed',reason:`scheduled ${name} did not start`});
 }
 const refusals=s.db.query("SELECT at,data FROM events WHERE (kind='release-executor' AND json_extract(data,'$.day')=? AND (json_extract(data,'$.kind') LIKE 'refused:%' OR json_extract(data,'$.kind') LIKE '%:skipped') AND json_extract(data,'$.kind') NOT LIKE '%outside window%') OR (kind='release-executor-refusal' AND id LIKE ? AND json_extract(data,'$.stage') IN ('preflight','qa','production')) ORDER BY at LIMIT 1001").all(day,`executor-cli:${day}:%`) as {at:number;data:string}[];
 if(refusals.length>1000)throw Error('release refusal inventory exceeds incident bound');
 if(!windows.length&&!refusals.length)return {queued:false};
 const gaps:Gap[]=[];
 const failing=preflight?.ready===false?preflight:observed.findLast(r=>!r.ready);
 for(const gap of failing?.missing??[]){const first=observed.find(r=>r.missing.some(g=>g.input===gap.input));gaps.push({...gap,knownBy:first?.at??failing!.at,basis:'recorded observation'});}
 for(const row of refusals){const event=JSON.parse(row.data),reason=String(event.data?.reason??event.error??event.kind),input=/paused/.test(reason)?'factory state':/billing|wallet/.test(reason)?'fresh billing':'release admission';if(!gaps.some(g=>g.input===input)){const first=observed.find(r=>r.missing.some(g=>g.input===input));gaps.push({input,reason,knownBy:first?.at??row.at,basis:'recorded observation'});}}
 if(!gaps.length)for(const w of windows){const stamp=Date.parse(day+'T12:00:00Z'),local=toronto(stamp),knownBy=stamp+(w.minute+1-local.minute)*60000;gaps.push({input:`${w.name} window`,reason:w.reason,knownBy,basis:'missed window'});}
 const shipped=releaseOutcome(s,day).shipped;
 let consecutiveMisses=shipped?0:1,prior=previousDay(day);
 while(!shipped&&consecutiveMisses<30&&missedNight(s,prior)){consecutiveMisses++;prior=previousDay(prior);}
 const key=`release-incident:${day}`,earlier=s.get<{firstObservedAt:number;mail:{summary:string;body:string}}>(key);
 const summary=consecutiveMisses>=2?`Release incident: ${consecutiveMisses} consecutive missed nights.`:`Release incident for ${day}.`;
 const body=`${shipped?'Release later shipped. ':''}${windows.map(w=>`${w.name} ${w.state}`).join('; ')||'Release admission refused'}. ${gaps.map(g=>`${g.input}: known by ${clock(g.knownBy)} Eastern (${g.basis})`).join('; ')}. Resolve the inputs before the next scheduled night; no catch-up release.`.slice(0,800);
 const incident={day,firstObservedAt:earlier?.firstObservedAt??now,at:now,shipped,consecutiveMisses,windows,gaps,summary,body,mail:earlier?.mail??{summary,body}};
 // The plain current summary is updated as later windows settle. The immutable
 // first action is mailed once/night; retries recover the same cross-store ID.
 const priorIncident=s.get<Record<string,unknown>>(key);
 const material=(value:Record<string,unknown>)=>{const {at,...rest}=value;return JSON.stringify(rest);};
 if(!priorIncident||material(priorIncident)!==material(incident)){
  s.set(key,incident);s.event(`${key}:${now}`,'release-incident',incident,'Retain each incident observation and first mail; correct through later evidence, never replay releases',now);
 }
 send(`release-incident-action:${day}`,'Coordinator',incident.mail.summary,incident.mail.body,now);
 return {queued:true,day,consecutiveMisses};
}
export function reconcileReleaseIncidents(s:Store,now=Date.now(),send=releaseAction){
 const today=toronto(now).day,days=[today];let prior=previousDay(today);
 // Recover a watcher that was itself asleep over a window. Only existing
 // release/rehearsal evidence establishes an expected historical night.
 for(let i=0;i<2;i++){if(knownNight(s,prior))days.unshift(prior);prior=previousDay(prior);}
 return days.map(day=>releaseIncident(s,day,now,send));
}
