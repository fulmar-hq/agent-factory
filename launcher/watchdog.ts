import {Engine} from './engine';
export type ClaimProgress={since:number;at:number;free:boolean;claimed:number};
const undo='Retain incident evidence; progress closes the incident without another notification';
// State changes, reconciliation heartbeats, labels and owner wakes are not
// worker claims. An empty/poisoned queue must not conceal a work-supply stall.
export function observeClaimProgress(e:Engine,h:{at:number;claimed:number;paused:boolean}) {
 return e.s.atomic(()=>{
  const free=!h.paused && e.slots().free>0;
  const prior=e.s.get<ClaimProgress>('claim-progress');
  const last=e.s.db.query("SELECT MAX(at) AS at FROM events WHERE kind IN ('reservation','start-attempt','native-start-attempt','session-continuation','factory-challenge-started') AND at<=?").get(h.at) as {at:number|null};
  const since=free&&h.claimed===0&&prior?.free ? (last.at!==null&&last.at>prior.at?last.at:prior.since) : h.at;
  const p={since,at:h.at,free,claimed:h.claimed};
  e.s.set('claim-progress',p);
  checkClaimStall(e,h.at);
  return p;
 });
}
export function checkClaimStall(e:Engine,now:number) {
 return e.s.atomic(()=>{
  let p=e.s.get<ClaimProgress>('claim-progress');
  const free=e.s.get('paused')===false&&e.slots().free>0;
  if(!p){p={since:now,at:now,free,claimed:0};e.s.set('claim-progress',p);}
  else if(now>p.at){
   const last=e.s.db.query("SELECT MAX(at) AS at FROM events WHERE kind IN ('reservation','start-attempt','native-start-attempt','session-continuation') AND at<=?").get(now) as {at:number|null};
   p={...p,since:!free||!p.free?now:Math.max(p.since,last.at??p.since),at:now,free,claimed:0};e.s.set('claim-progress',p);
  }
  const old=e.s.get<{id:string;state:string}>('watchdog-stall');
  const stalled=p && p.free && e.s.get('paused')===false && e.slots().free>0 && now>=p.since+7200000;
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
