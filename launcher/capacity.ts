import type {Config} from './config';
import type {Store} from '../tracking/store';
import {command} from '../adapters/github';
import {processIdentity} from './process';
import type {Session} from './engine';
export type SlotProcessEvidence = {
 identity: typeof processIdentity;
 absent: (pid:number)=>boolean;
};
const processEvidence:SlotProcessEvidence = {
 identity:processIdentity,
 absent(pid) {
  try {process.kill(pid,0);return false;}
  catch(error) {return (error as NodeJS.ErrnoException).code==='ESRCH';}
 },
};
// Custody is independent of local builder occupancy. Call inside the same
// immediate transaction as admission/start; never cache this observation.
export function builderSlots(s:Store,c:Config,evidence:SlotProcessEvidence=processEvidence) {
 const dormant=new Set<string>();
 const occupied=(s.rows('sessions') as Session[]).filter(x=>{
  if(['finished','archived'].includes(x.status))return false;
  if(!['paused','waiting-browser','waiting-person','waiting-question','question'].includes(x.status))return true;
  try {
   const cleanup=s.get<{verified:boolean}>(`cleanup-evidence:${x.id}`);
   const legacy=!cleanup ? s.db.query('SELECT data FROM events WHERE id=?').get(`cleanup:${x.id}`) as {data:string}|null : null;
   if((cleanup ?? (legacy ? JSON.parse(legacy.data) as {verified?:boolean} : null))?.verified!==true)return true;
   if(x.pid!==null) {
    if(!Number.isInteger(x.pid) || x.pid<=0)return true;
    const current=evidence.identity(x.pid),recorded=s.get<string>(`supervisor:${x.id}`);
    // A null identity alone is not positive death evidence (e.g. denied ps).
    if(current===null) {
     if(evidence.absent(x.pid)!==true)return true;
    }else if(!current.trim() || typeof recorded!=='string' || !recorded.trim() || current===recorded)return true;
   }
  }catch{return true;}
  dormant.add(x.id);return false;
 });
 const max=slotLimit(s,c),used=occupied.length;
 return {used,max,free:Math.max(0,max-used),occupied,dormant};
}
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
  const exits=s.db.query("SELECT kind,data FROM events WHERE kind IN ('worker-exit','worker-failure','worker-halt') AND at>? AND at<=?").all(now-3600000,now) as {kind:string;data:string}[];
  const outcomes=new Map<string,boolean>();for(const r of exits){const d=JSON.parse(r.data);outcomes.set(d.id,outcomes.get(d.id)===false ? false : r.kind!=='worker-exit' ? false : d.ok);}
  const failureRate=outcomes.size ? [...outcomes.values()].filter(x=>!x).length/outcomes.size : 0;
  const busy=active/slots,healthy=busy>p.busy_above && pressure==='normal' && failureRate<p.failure_below;
  let healthySince=healthy ? (prior && now>=prior.at && now-prior.at<=120000 ? prior.healthySince ?? now : now) : null;
  let reason=!healthy ? pressure!=='normal'?'memory pressure not normal':busy<=p.busy_above?'occupancy below threshold':'failure rate too high' : 'collecting healthy hour';
  if(healthySince!==null && now-healthySince>=p.interval_minutes*60000 && slots<p.max){slots++;healthySince=null;reason='added one slot after healthy hour';s.event(`capacity:${now}`,'capacity-increased',{from:slots-1,to:slots,busy,pressure,failureRate},'Disable controller or append a reviewed capacity decision; retain evidence',now);}
  if(slots===p.max)reason='maximum capacity';
  const state:Capacity={slots,at:now,healthySince,pressure,busy,failureRate,reason};s.set('capacity-controller',state);return state;
 });
}
