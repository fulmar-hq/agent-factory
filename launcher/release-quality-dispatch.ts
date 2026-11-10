import {dispatchWake,spawnOwner,type Wake} from './wake';
import {type Store} from '../tracking/store';
import {processIdentity} from './process';
// Called inside the release executor's queue transaction, so the ordinary tick
// never observes a runnable acceptance wake bound to an older owner executable.
export function dispatchReleaseQuality(s:Store,w:Wake,dir:string,spawn=(id:string)=>spawnOwner(id,dir),identity=processIdentity){
 if(w.owner!=='quality'||w.kind!=='qa-deployed')throw Error('only release acceptance uses the pinned executor');
 return s.atomic(()=>{
  const retained=s.get<Wake & {state:string;cleanupVerified?:boolean}>(`owner-wake:${w.id}`);
  if(!retained||!['queued','waiting-release-runner'].includes(retained.state))return false;
  s.set(`owner-wake:${w.id}`,{...retained,state:'queued'});
  const started=dispatchWake(s,w,spawn,identity);
  const current=s.get<{state:string}>(`owner-wake:${w.id}`);
  if(!started&&current?.state==='queued')s.set(`owner-wake:${w.id}`,{...retained,state:'waiting-release-runner'});
  return started;
 });
}
