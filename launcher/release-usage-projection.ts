import type {Store} from '../tracking/store';
import {MeterSchema,type Meter,type Config,optionalJSON} from './config';
import {acceptanceProfile} from './acceptance-profile';
import {deadlineAt} from './release';
import type {ReleaseReadiness} from './release-readiness';
export type UsageReadings={codex?:Meter;claude?:Meter};
const historyKey=(provider:string)=>`release-usage-history:${provider}`;
const key=(w:Meter['windows'][number],index:number)=>`${w.name??index}:${w.durationMinutes??'unknown'}`;
function continuous(before:Meter,after:Meter){
 if(before.observedAt>after.observedAt||before.windows.length!==after.windows.length)return false;
 return after.windows.every((w,i)=>{const matches=before.windows.filter((v,j)=>key(v,j)===key(w,i));
  return matches.length===1&&matches[0].resetsAt===w.resetsAt&&matches[0].used<=w.used&&(before.observedAt!==after.observedAt||matches[0].used===w.used);
 });
}
// Retain bounded native metadata, including discontinuities between ordinary
// five-minute samples. No transcript, model call or fresh zero is manufactured.
export function observeReleaseUsage(s:Store,readings:UsageReadings,now=Date.now()){
 for(const provider of ['codex','claude'] as const){
  const p=MeterSchema.safeParse(readings[provider]);
  if(!p.success||p.data.nativeProvider!==provider||p.data.observedAt>now||now-p.data.observedAt>15*60000)continue;
  const history=(s.get<Meter[]>(historyKey(provider))??[]).filter(m=>now-m.observedAt<=6*3600000&&m.observedAt<=now).slice(-72),retained=history.at(-1);
  const seen=MeterSchema.safeParse(s.get(`release-usage-last-native:${provider}`)),last=seen.success?seen.data:retained;
  if(last&&p.data.observedAt<last.observedAt)continue;
  const broken=!!last&&!continuous(last,p.data);
  s.set(`release-usage-last-native:${provider}`,p.data);
  if(retained&&!broken&&p.data.observedAt-retained.observedAt<5*60000)continue;
  if(broken&&last&&(!retained||last.observedAt>retained.observedAt))history.push(last);
  history.push(p.data);s.set(historyKey(provider),history.slice(-72));
 }
}
export function projectUsage(current:Meter|undefined,history:Meter[],provider:'codex'|'claude',now:number,target:number,gate:number){
 const parsed=MeterSchema.safeParse(current);
 if(!parsed.success||parsed.data.nativeProvider!==provider||parsed.data.observedAt>now||now-parsed.data.observedAt>15*60000)throw Error('fresh native usage is unavailable; headroom projection unknown');
 if(target<=now)throw Error('18:30 projection target has passed; collect current readiness');
 const samples:Meter[]=[];
 for(const raw of history){const p=MeterSchema.safeParse(raw);if(!p.success)throw Error('native usage history is invalid; projection unknown');if(p.data.nativeProvider!==provider)continue;if(p.data.observedAt>now)throw Error('future native history cannot supply a projection');samples.push(p.data);}
 samples.push(parsed.data);samples.sort((a,b)=>a.observedAt-b.observedAt);
 const meter=samples.at(-1)!; // A newer trusted tick sample cannot be hidden by an older collection.
 const timeline=samples.filter(m=>meter.observedAt-m.observedAt<=60*60000);
 let start=0;for(let i=1;i<timeline.length;i++)if(!continuous(timeline[i-1],timeline[i]))start=i;
 const baseline=timeline.slice(start).find(m=>meter.observedAt-m.observedAt>=15*60000);
 if(!baseline)throw Error('at least 15 minutes of comparable native burn history after the latest discontinuity is required; projection unknown');
 const windows=meter.windows.map((window,index)=>{
  const candidates=baseline.windows.filter((w,i)=>key(w,i)===key(window,index)),before=candidates.length===1?candidates[0]:undefined;
  if(!before||before.resetsAt!==window.resetsAt||before.used>window.used||window.resetsAt<=now)throw Error('usage window reset, identity or counters changed; projection unknown until comparable samples exist');
  const ratePerHour=(window.used-before.used)/((meter.observedAt-baseline.observedAt)/3600000),resetAssumed=window.resetsAt<=target;
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
