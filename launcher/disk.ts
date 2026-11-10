import {statfsSync} from 'node:fs';
import type {Store} from '../tracking/store';
export type DiskReading = {at:number;path:string;freeGiB:number;usedFraction:number} | {at:number;path:string;error:string};
// Conservative 30 GiB floor (32.2 decimal GB). This never pauses/stops work
// already in custody; it refuses additional claims and continuations only.
export const minimumFreeGiB=30;
export function requireDiskCapacity(read:()=>DiskReading=()=>diskReading()) {
 const r=read();
 if('error' in r || !Number.isFinite(r.freeGiB) || r.freeGiB<minimumFreeGiB)throw Error('disk admission refused: less than 30 GiB free or capacity unknown');
 return r;
}
export function diskReading(path=process.platform==='darwin' ? '/System/Volumes/Data' : '/',at=Date.now()):DiskReading {
 try {
  const f=statfsSync(path),used=f.blocks-f.bfree,available=f.bavail;
  if(![f.bsize,used,available].every(Number.isFinite) || f.bsize<=0 || used<0 || available<0 || used+available<=0)throw Error('invalid filesystem reading');
  return {at,path,freeGiB:available*f.bsize/2**30,usedFraction:used/(used+available)};
 } catch(error) {return {at,path,error:String(error)};}
}
// Observation never clears pause or performs cleanup. Admission separately
// takes a new synchronous reading immediately before a claim/spawn.
export function observeDisk(s:Store,r:DiskReading,warn:(message:string)=>void=console.warn) {
 return s.atomic(()=>{
 const state='error' in r || !Number.isFinite(r.freeGiB) ? 'unknown' : r.freeGiB<minimumFreeGiB ? 'critical' : r.usedFraction>=0.8 ? 'warning' : 'healthy';
 const prior=s.get<{state:string;episode?:string}>('disk-capacity');
 const episode=prior?.state===state ? prior.episode : `disk-capacity:${r.at}:${state}`;
 s.set('disk-capacity',{...r,state,episode});
 if(prior?.state===state)return;
 const message=state==='unknown' ? 'Factory disk capacity unavailable; new work is blocked. Platform must inspect the Data volume.' : state==='critical' ? `Factory disk has ${'freeGiB' in r ? r.freeGiB.toFixed(1) : '?'} GiB free; new work is blocked below 30 GiB. Platform must reclaim factory caches.` : state==='warning' ? `Factory disk ${Math.round(('usedFraction' in r ? r.usedFraction : 0)*100)}% used; ${'freeGiB' in r ? r.freeGiB.toFixed(1) : '?'} GiB free. Platform: follow docs/operations.md Mac mini disk capacity; target 60 GiB free.` : 'Factory disk capacity below 80% used.';
 s.event(`disk-capacity:${r.at}:${state}`,'disk-capacity',{...r,state,message},'Advisory evidence only; retain readings and reconcile capacity before owner-authorized resume.',r.at);
 if(state!=='healthy')warn(message);
 });
}
