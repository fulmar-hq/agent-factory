import {queueWake} from './wake';
import {readReleaseBatch} from './release-batch';
import {toronto} from './release';
import {releaseAction,type ReleaseOwner} from './release-actions';
import type {Store} from '../tracking/store';
export function pauseOwner(value:unknown):ReleaseOwner {
 if(value===undefined)return 'Coordinator'; // accountable role for generic owner controls
 if(['Coordinator','Release','Quality','Platform'].includes(String(value)))return value as ReleaseOwner;
 throw Error('pause owner must be Coordinator, Release, Quality or Platform');
}
// Called directly after an authenticated pause and by the 30-second release
// reconciler. A pause already active at 17:30 receives the same episode alert.
export function watchReleasePause(s:Store,dir:string,now=Date.now(),send=releaseAction){
 const {day,minute}=toronto(now);
 if(minute<1050||minute>=1355||s.get('paused')===false)return {queued:false};
 try{readReleaseBatch(dir,day);}catch{return {queued:false};}
 const last=s.db.query("SELECT id,at,data FROM events WHERE kind='pause' AND at<=? ORDER BY at DESC,rowid DESC LIMIT 1").get(now) as {id:string;at:number;data:string}|null;
 const raw=last?JSON.parse(last.data):null,owner=pauseOwner(raw?.owner),episode=last?.id??'legacy-active';
 const deadline=minute<1140?'19:00':minute<1200?'20:00':minute<1290?'21:30':'22:35';
 for(const to of new Set<ReleaseOwner>(['Coordinator',owner])){
  const id=`release-pause:${day}:${episode}:${to}`;
  const payload=s.get<{summary:string;body:string}>(id)??{summary:`Release is blocked by an active pause. Due ${day} ${deadline} Eastern.`,body:`An accepted batch is scheduled today. A factory pause is active during 17:30–22:35 America/Toronto. Accountable pausing role: ${owner}${raw?.owner?'':' (generic/legacy owner control; actual caller not recorded)'}. Resolve the release impact immediately and before the next fixed window; do not automatically lift the pause. Pause first observed/set: ${last?new Date(last.at).toISOString():'unknown'}.`};
  s.set(id,payload);send(id,to,payload.summary,payload.body,now);
  if(to!=='Coordinator')queueWake(s,{id:`mail:${id}`,owner:to.toLowerCase(),kind:'release-pause-action',payload:{mailId:id,...payload}},now);
 }
 return {queued:true,day,episode,owner};
}
