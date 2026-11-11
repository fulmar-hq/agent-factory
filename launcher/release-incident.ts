import type {Store} from '../tracking/store';
import {releaseAction} from './release-actions';
import {releaseOutcome} from './release-result';
import {toronto} from './release';
import type {ReleaseReadiness} from './release-readiness';
type Window={name:string;minute:number;state:'refused'|'missed';reason:string;knownBy:number};
type Gap={input:string;reason:string;knownBy:number;basis:'recorded observation'|'missed window'};
const previousDay=(day:string)=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const clock=(at:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',hour:'numeric',minute:'2-digit',hourCycle:'h23'}).format(at);
function reports(s:Store,day:string){
 const rows=s.db.query("SELECT kind,data FROM events WHERE kind IN ('release-rehearsal','release-readiness') AND json_extract(data,'$.day')=? ORDER BY at LIMIT 1001").all(day) as {kind:string;data:string}[];
 if(rows.length>1000)throw Error('release observation inventory exceeds incident bound');
 const result=rows.map(r=>{const data=JSON.parse(r.data);return {...data,stage:data.stage??(r.kind==='release-readiness'?'preflight':undefined)} as ReleaseReadiness&{stage?:string};}),preflight=s.get<ReleaseReadiness>(`release-preflight-report:${day}`),qa=s.get<ReleaseReadiness>(`release-qa-report:${day}`);
 if(preflight)result.push({...preflight,stage:'preflight'});if(qa)result.push({...qa,stage:'qa'});return result.sort((a,b)=>a.at-b.at);
}
type Refusal={kind:string;at:number;data:string};
function scheduledCli(day:string,at:number,data:{stage?:string;invokedAt?:number}){
 const target=({preflight:1140,qa:1200,production:1290} as Record<string,number>)[data.stage??''];
 const invoked=data.invokedAt??at;
 if(target===undefined||!Number.isSafeInteger(invoked)||invoked<=0||invoked>at)return false;
 const time=toronto(invoked);return time.day===day&&time.minute===target;
}
function releaseRefusals(s:Store,day:string){
 const rows=s.db.query("SELECT kind,at,data FROM events WHERE (kind='release-executor' AND json_extract(data,'$.day')=? AND (json_extract(data,'$.kind') LIKE 'refused:%' OR json_extract(data,'$.kind') LIKE '%:skipped') AND json_extract(data,'$.kind') NOT LIKE '%outside window%') OR (kind='release-executor-refusal' AND id LIKE ?) ORDER BY at LIMIT 1001").all(day,`executor-cli:${day}:%`) as Refusal[];
 if(rows.length>1000)throw Error('release refusal inventory exceeds incident bound');
 return rows.filter(r=>r.kind!=='release-executor-refusal'||scheduledCli(day,r.at,JSON.parse(r.data)));
}
function knownNight(s:Store,day:string){return !!(s.get(`release-incident:${day}`)||s.get(`release-window-result:${day}`)||s.get(`executor:${day}:night`)||s.get(`release-preflight-report:${day}`)||s.get(`release-qa-report:${day}`)||s.get(`release-rehearsal:${day}:14:00`)||s.get(`release-rehearsal:${day}:17:40`)||releaseRefusals(s,day).length);}
function missedNight(s:Store,day:string){
 const result=s.get<{shipped:boolean}>(`release-window-result:${day}`);
 if(result?.shipped===true||s.get<{shipped?:boolean}>(`release-incident:${day}`)?.shipped===true)return false;
 return knownNight(s,day)&&(result?true:!releaseOutcome(s,day).shipped);
}
export function releaseIncident(s:Store,day:string,now=Date.now(),send=releaseAction){
 const current=toronto(now),minute=current.day===day?current.minute:1440;
 const windowBoundary=(time:number)=>{const stamp=Date.parse(day+'T12:00:00Z');return stamp+(time+1-toronto(stamp).minute)*60000;};
 if(day>current.day||minute<1140)return {queued:false};
 const retainedWindows=s.get<{windows?:Window[]}>(`release-incident:${day}`)?.windows??[];
 const observed=reports(s,day),windows:Window[]=[],failedReports:ReleaseReadiness[]=[];
 for(const [name,time,step] of [['preflight',1140,'preflight'],['QA',1200,'qa'],['Production',1290,'promote']] as const){
  const effect=s.get<{state:string;evidence?:{reason?:string}}>(`executor:${day}:${step}`);
  if(minute<time)continue;
  const failed=observed.filter(r=>r.stage===(name==='preflight'?'preflight':name==='QA'?'qa':'production')&&!r.ready&&toronto(r.at).minute===time).at(-1);
  if(failed){failedReports.push(failed);windows.push({name,minute:time,state:'refused',reason:failed.missing.map(g=>g.input).join(', '),knownBy:failed.at});}
  else if(effect?.state==='failure'){const event=s.db.query('SELECT MIN(at) AS at FROM events WHERE id IN (?,?)').get(`executor:${day}:${step}:failure`,`executor:${day}:${step}:deadline`) as {at:number|null};windows.push({name,minute:time,state:'refused',reason:effect.evidence?.reason??`${name} checks or completion failed`,knownBy:event.at??retainedWindows.find(w=>w.name===name&&w.state==='refused')?.knownBy??now});}
  else if(!effect&&minute>time)windows.push({name,minute:time,state:'missed',reason:`scheduled ${name} did not start`,knownBy:windowBoundary(time)});
 }
 const refusals=releaseRefusals(s,day);
 if(!windows.length&&!refusals.length)return {queued:false};
 const gaps:Gap[]=[];
 const latest=observed.at(-1);if(!failedReports.length&&latest?.ready===false)failedReports.push(latest);
 const firstCurrentGap=(input:string,until:number)=>{let first:number|undefined;for(const r of observed.filter(r=>r.at<=until)){if(r.missing.some(g=>g.input===input))first??=r.at;else if(!r.missing.some(g=>['release configuration','preflight checks'].includes(g.input)))first=undefined;}return first;};
 const knownPause=(until:number)=>{
  const resume=s.db.query("SELECT rowid,at FROM events WHERE kind='resume' AND at<=? ORDER BY rowid DESC LIMIT 1").get(until) as {rowid:number;at:number}|null;
  const pause=s.db.query("SELECT at FROM events WHERE kind='pause' AND at<=? AND rowid>? ORDER BY rowid LIMIT 1").get(until,resume?.rowid??0) as {at:number}|null;
  return {resumeAt:resume?.at,pauseAt:pause?.at};
 };
 const knownInput=(input:string,reason:string,until:number)=>{
  let report=firstCurrentGap(input,until);
  if(input==='factory state'&&/paused/i.test(reason)){const episode=knownPause(until);if(episode.resumeAt!==undefined&&report!==undefined&&report<=episode.resumeAt)report=undefined;return Math.min(report??until,episode.pauseAt??until);}
  return report??until;
 };
 for(const failed of failedReports)for(const gap of failed.missing){if(!gaps.some(g=>g.input===gap.input))gaps.push({...gap,knownBy:knownInput(gap.input,gap.reason,failed.at),basis:'recorded observation'});}
 for(const row of refusals){const event=JSON.parse(row.data),reason=String(event.data?.reason??event.error??event.kind),input=/paused/.test(reason)?'factory state':/billing|wallet/.test(reason)?'fresh billing':/config/i.test(reason)?'release configuration':'release admission';if(!gaps.some(g=>g.input===input)){gaps.push({input,reason,knownBy:knownInput(input,reason,row.at),basis:'recorded observation'});}}
 if(!gaps.length)for(const w of windows)gaps.push({input:`${w.name} window`,reason:w.reason,knownBy:w.knownBy,basis:w.state==='missed'?'missed window':'recorded observation'});
 const shipped=s.get<{shipped?:boolean}>(`release-incident:${day}`)?.shipped===true||s.get<{shipped?:boolean}>(`release-window-result:${day}`)?.shipped===true||releaseOutcome(s,day).shipped;
 let consecutiveMisses=shipped?0:1,prior=previousDay(day);
 while(!shipped&&consecutiveMisses<30&&missedNight(s,prior)){consecutiveMisses++;prior=previousDay(prior);}
 const key=`release-incident:${day}`,earlier=s.get<{firstObservedAt:number;mail:{summary:string;body:string}}>(key);
 const summary=consecutiveMisses>=2?`Release incident: ${consecutiveMisses} consecutive missed nights.`:`Release incident for ${day}.`;
 const body=`${shipped?'Release later shipped. ':''}${windows.map(w=>`${w.name} ${w.state}`).join('; ')||'Release admission refused'}. ${gaps.map(g=>`${g.input}: known by ${toronto(g.knownBy).day===day?'':toronto(g.knownBy).day+' '}${clock(g.knownBy)} Eastern (${g.basis})`).join('; ')}. Resolve the inputs before the next scheduled night; no catch-up release.`.slice(0,800);
 const incident={day,firstObservedAt:earlier?.firstObservedAt??now,at:now,shipped,consecutiveMisses,windows,gaps,summary,body,mail:earlier?.mail??{summary,body}};
 // The plain current summary is updated as later windows settle. The immutable
 // first action is mailed once/night; retries recover the same cross-store ID.
 const priorIncident=s.get<Record<string,unknown>>(key);
 const material=(value:Record<string,unknown>)=>{const {at,...rest}=value;return JSON.stringify(rest);};
 if(!priorIncident||material(priorIncident)!==material(incident)){
  s.set(key,incident);s.event(`${key}:${now}`,'release-incident',incident,'Retain each incident observation and first mail; correct through later evidence, never replay releases',now);
 }
 const id=`release-incident-action:${day}`,pending=s.get<IncidentAction>(id);
 const action=pending??{id,day,at:now,summary:incident.mail.summary,body:incident.mail.body};
 if(!pending)s.set(id,action);
 deliverIncidentAction(s,action,now,send);
 return {queued:true,day,consecutiveMisses};
}
type IncidentAction={id:string;day:string;at:number;summary:string;body:string;queuedAt?:number};
function deliverIncidentAction(s:Store,action:IncidentAction,now:number,send:typeof releaseAction){
 if(action.queuedAt!==undefined)return;
 send(action.id,'Coordinator',action.summary,action.body,now);
 s.set(action.id,{...action,queuedAt:now});
 s.event(`${action.id}:queued`,'release-incident-action-queued',{day:action.day,id:action.id},'Retain queue readback; never claim delivery or replay this completed action',now);
}
export function reconcileReleaseIncidents(s:Store,now=Date.now(),send=releaseAction){
 const today=toronto(now).day,days=[today];let prior=previousDay(today);
 for(let i=0;i<2;i++){if(knownNight(s,prior))days.unshift(prior);prior=previousDay(prior);}
 const attempted=new Set<string>();
 const once:typeof releaseAction=(id,to,summary,body,at,path)=>{attempted.add(id);return send(id,to,summary,body,at,path);};
 const failure=(day:string,error:unknown)=>s.event(`release-incident-mail-failure:${day}:${String(error)}`,'release-incident-mail-failure',{day,error:String(error)},'Retain all summaries and pending actions; retry each original identity independently',now);
 const results=days.map(day=>{try{return releaseIncident(s,day,now,once);}catch(error){failure(day,error);return {queued:false,day,error:String(error)};}});
 // Discovery is bounded to two past nights; already-retained pending actions
 // have independent retry custody and cannot age out during a bridge outage.
 const rows=s.db.query("SELECT value FROM kv WHERE key LIKE 'release-incident-action:%' AND json_extract(value,'$.queuedAt') IS NULL ORDER BY json_extract(value,'$.at') LIMIT 2001").all() as {value:string}[];
 if(rows.length>2000)throw Error('pending incident action inventory exceeds bound');
 for(const row of rows){const action=JSON.parse(row.value) as IncidentAction;if(attempted.has(action.id))continue;try{deliverIncidentAction(s,action,now,once);}catch(error){failure(action.day,error);}}
 return results;
}
