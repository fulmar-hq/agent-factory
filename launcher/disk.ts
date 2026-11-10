import {statfsSync} from 'node:fs';
import type {Store} from '../tracking/store';
export type DiskReading = {at:number;path:string;freeGiB:number;usedFraction:number} | {at:number;path:string;error:string};
export function diskReading(path=process.platform==='darwin' ? '/System/Volumes/Data' : '/',at=Date.now()):DiskReading {
 try {
  const f=statfsSync(path),used=f.blocks-f.bfree,available=f.bavail;
  if(![f.bsize,used,available].every(Number.isFinite) || f.bsize<=0 || used<0 || available<0 || used+available<=0)throw Error('invalid filesystem reading');
  return {at,path,freeGiB:available*f.bsize/2**30,usedFraction:used/(used+available)};
 } catch(error) {return {at,path,error:String(error)};}
}
// Advisory only: no pause clears, cleanup, workload starts or limit changes.
export function observeDisk(s:Store,r:DiskReading,warn:(message:string)=>void=console.warn) {
 return s.atomic(()=>{
 const state='error' in r ? 'unknown' : r.usedFraction>=0.8 ? 'warning' : 'healthy';
 const prior=s.get<{state:string}>('disk-capacity');
 s.set('disk-capacity',{...r,state});
 if(prior?.state===state)return;
 const message=state==='unknown' ? 'Factory disk capacity unavailable; Platform must inspect the Data volume.' : state==='warning' ? `Factory disk ${Math.round(('usedFraction' in r ? r.usedFraction : 0)*100)}% used; ${'freeGiB' in r ? r.freeGiB.toFixed(1) : '?'} GiB free. Platform: follow docs/operations.md Mac mini disk capacity; target 60 GiB free.` : 'Factory disk capacity below 80% used.';
 s.event(`disk-capacity:${r.at}:${state}`,'disk-capacity',{...r,state,message},'Advisory evidence only; retain readings and reconcile capacity before owner-authorized resume.',r.at);
 if(state!=='healthy')warn(message);
 });
}
