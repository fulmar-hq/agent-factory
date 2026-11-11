import type {Store} from '../tracking/store';
import {MeterSchema,type Meter,type Config,optionalJSON} from './config';
import {acceptanceProfile} from './acceptance-profile';
import {deadlineAt} from './release';
import type {ReleaseReadiness} from './release-readiness';
export type UsageReadings={codex?:Meter;claude?:Meter};
const historyKey=(provider:string)=>`release-usage-history:${provider}`;
const key=(w:Meter['windows'][number],index:number)=>`${w.name??index}:${w.durationMinutes??'unknown'}`;
// Native metadata only, bounded to six hours/72 observations per provider. No
// transcript, model call or fresh zero is manufactured. Tick already reads it.
export function observeReleaseUsage(s:Store,readings:UsageReadings,now=Date.now()){
 for(const provider of ['codex','claude'] as const){
  const p=MeterSchema.safeParse(readings[provider]);
  if(!p.success||p.data.nativeProvider!==provider||p.data.observedAt>now||now-p.data.observedAt>15*60000)continue;
  const history=(s.get<Meter[]>(historyKey(provider))??[]).filter(m=>now-m.observedAt<=6*3600000&&m.observedAt<=now).slice(-71),last=history.at(-1);
  if(last&&p.data.observedAt-last.observedAt<5*60000)continue;
  history.push(p.data);s.set(historyKey(provider),history);
 }
}
export function projectUsage(current:Meter|undefined,history:Meter[],provider:'codex'|'claude',now:number,target:number,gate:number){
 const parsed=MeterSchema.safeParse(current);
 if(!parsed.success||parsed.data.nativeProvider!==provider||parsed.data.observedAt>now||now-parsed.data.observedAt>15*60000)throw Error('fresh native usage is unavailable; headroom projection unknown');
 const meter=parsed.data;
 if(target<=now)throw Error('18:30 projection target has passed; collect current readiness');
 const baseline=history.filter(m=>m.nativeProvider===provider&&meter.observedAt-m.observedAt>=15*60000&&meter.observedAt-m.observedAt<=60*60000&&meter.windows.every((w,i)=>{const matches=m.windows.filter((before,j)=>key(before,j)===key(w,i));return matches.length===1&&matches[0].resetsAt===w.resetsAt;})).sort((a,b)=>a.observedAt-b.observedAt)[0];
 if(!baseline)throw Error('at least 15 minutes of comparable current native burn history is required; projection unknown');
 const windows=meter.windows.map((window,index)=>{
  const candidates=baseline.windows.filter((w,i)=>key(w,i)===key(window,index));
  const before=candidates.length===1?candidates[0]:undefined;
  if(!before||before.resetsAt!==window.resetsAt||before.used>window.used||window.resetsAt<=now)throw Error('usage window reset, identity or counters changed; projection unknown until comparable samples exist');
  const ratePerHour=(window.used-before.used)/((meter.observedAt-baseline.observedAt)/3600000);
  const resetAssumed=window.resetsAt<=target;
  const projectedUsed=resetAssumed?ratePerHour*(target-window.resetsAt)/3600000:window.used+ratePerHour*(target-meter.observedAt)/3600000;
  return {name:window.name??String(index),used:window.used,observedAt:meter.observedAt,baselineAt:baseline.observedAt,ratePerHour,resetsAt:window.resetsAt,resetAssumed,projectedUsed,underGate:projectedUsed<gate};
 });
 return {provider,target,gate,assumption:'current measured burn continues; any scheduled reset is a forecast assumption, not available quota',windows,underGate:windows.every(w=>w.underGate)};
}
export async function collectUsageProjection(s:Store,c:Config,dir:string,r:ReleaseReadiness,readings:UsageReadings,readJSON=optionalJSON){
 const target=deadlineAt(r.at,1110),evidence:Record<string,unknown>={};
 // Preserve this observation for the next collection, but never let one fresh
 // sample substitute for a rate history or stale native usage.
 observeReleaseUsage(s,readings,r.at);
 for(const owner of ['release','quality'] as const){
  try{
   const role=owner==='quality'?(await acceptanceProfile(c,dir,r.day,r.validThrough,readJSON)).role:c.owners.release;
   if(!role)throw Error('release owner configuration unavailable');
   const projection=projectUsage(readings[role.harness],s.get<Meter[]>(historyKey(role.harness))??[],role.harness,r.at,target,c.usage_gates.admit_below);
   evidence[owner]=projection;
   if(!projection.underGate)r.missing.push({input:`${owner} usage projection`,reason:`At the current native burn rate, ${owner} is projected at ${projection.windows.map(w=>`${w.name}: ${(w.projectedUsed*100).toFixed(1)}%`).join(', ')} at 18:30 Eastern; every window must be below ${(c.usage_gates.admit_below*100).toFixed(0)}%. Coordinator must decide early; gates remain 0.70/0.90.`});
  }catch(error){r.missing.push({input:`${owner} usage projection`,reason:String(error)});}
 }
 r.evidence['18:30 usage projection']=evidence;r.ready=r.missing.length===0;
 s.event(`release-usage-projection:${r.day}:${r.at}`,'release-usage-projection',{day:r.day,at:r.at,target,evidence,missing:r.missing.filter(m=>m.input.includes('usage projection'))},'Retain forecast and actual native samples; no quota, gate, capacity or admission is changed',r.at);
 return r;
}
