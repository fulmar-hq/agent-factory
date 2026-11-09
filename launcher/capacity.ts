import type {Config} from './config';
import type {Store} from '../tracking/store';
import {command} from '../adapters/github';
export type Capacity = {slots:number; at:number; healthySince:number|null; pressure:'normal'|'warning'|'critical'|'unknown'; busy:number; failureRate:number; reason:string};
export function slotLimit(s:Store,c:Config) {
 const p=c.capacity.controller;
 if(!p)return c.capacity.start_parallel;
 const n=s.get<Capacity>('capacity-controller')?.slots;
 return n && Number.isInteger(n) ? Math.max(p.start,Math.min(p.max,n)) : p.start;
}
export async function memoryPressure(execute=command):Promise<Capacity['pressure']> {
 if(process.platform!=='darwin')return 'unknown';
 try {const n=(await execute(['sysctl','-n','kern.memorystatus_vm_pressure_level'],undefined,3000)).trim();return n==='1'?'normal':n==='2'?'warning':n==='4'?'critical':'unknown';}catch{return 'unknown';}
}
// Require uninterrupted healthy samples. Gaps, stale evidence and restarts with
// a missing hour reset the dwell; one sample can never grant several slots.
export function reconcileCapacity(s:Store,c:Config,active:number,pressure:Capacity['pressure'],now=Date.now()) {
 const p=c.capacity.controller;if(!p)return;
 return s.atomic(()=>{
  const prior=s.get<Capacity>('capacity-controller');let slots=slotLimit(s,c);
  const exits=s.db.query("SELECT kind,data FROM events WHERE kind IN ('worker-exit','worker-failure') AND at>? AND at<=?").all(now-3600000,now) as {kind:string;data:string}[];
  const outcomes=new Map<string,boolean>();for(const r of exits){const d=JSON.parse(r.data);outcomes.set(d.id,outcomes.get(d.id)===false ? false : r.kind==='worker-failure' ? false : d.ok);}
  const failureRate=outcomes.size ? [...outcomes.values()].filter(x=>!x).length/outcomes.size : 0;
  const busy=active/slots,healthy=busy>p.busy_above && pressure==='normal' && failureRate<p.failure_below;
  let healthySince=healthy ? (prior && now>=prior.at && now-prior.at<=120000 ? prior.healthySince ?? now : now) : null;
  let reason=!healthy ? pressure!=='normal'?'memory pressure not normal':busy<=p.busy_above?'occupancy below threshold':'failure rate too high' : 'collecting healthy hour';
  if(healthySince!==null && now-healthySince>=p.interval_minutes*60000 && slots<p.max){slots++;healthySince=null;reason='added one slot after healthy hour';s.event(`capacity:${now}`,'capacity-increased',{from:slots-1,to:slots,busy,pressure,failureRate},'Disable controller or append a reviewed capacity decision; retain evidence',now);}
  if(slots===p.max)reason='maximum capacity';
  const state:Capacity={slots,at:now,healthySince,pressure,busy,failureRate,reason};s.set('capacity-controller',state);return state;
 });
}
