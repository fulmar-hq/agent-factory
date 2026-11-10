import {Engine} from './engine';
export type ClaimProgress={since:number;at:number;free:boolean;claimed:number};
const undo='Retain incident evidence; progress closes the incident without another notification';
// State changes, reconciliation heartbeats, labels and owner wakes are not
// worker claims. An empty/poisoned queue must not conceal a work-supply stall.
export function observeClaimProgress(e:Engine,h:{at:number;claimed:number;paused:boolean}) {
 return e.s.atomic(()=>{
  const free=!h.paused && e.slots().free>0;
  const prior=e.s.get<ClaimProgress>('claim-progress');
  const p={since:free && h.claimed===0 && prior?.free ? prior.since : h.at,at:h.at,free,claimed:h.claimed};
  e.s.set('claim-progress',p);
  checkClaimStall(e,h.at);
  return p;
 });
}
export function checkClaimStall(e:Engine,now:number) {
 return e.s.atomic(()=>{
  const p=e.s.get<ClaimProgress>('claim-progress');
  const old=e.s.get<{id:string;state:string}>('watchdog-stall');
  const stalled=p && p.free && p.claimed===0 && e.s.get('paused')===false && e.slots().free>0 && now>=p.since+7200000;
  if(stalled){
   if(old?.state==='open')return old;
   const incident={id:`claim-stall:${p.since}`,state:'open',since:p.since,at:now,summary:'Factory claimed no work for two hours while capacity was free. Intake and queue reconciliation have not restored starts; inspect refusals and the intake round.',heartbeat:e.s.get('heartbeat'),intake:e.s.get('intake-round')};
   e.s.event(incident.id,'watchdog-stalled',incident,undo,now);
   e.s.set('watchdog-stall',incident);return incident;
  }
  if(old?.state==='open'){
   e.s.event(`resolved:${old.id}`,'watchdog-resolved',{id:old.id,at:now},undo,now);
   e.s.set('watchdog-stall',{...old,state:'resolved'});
  }
  return null;
 });
}
