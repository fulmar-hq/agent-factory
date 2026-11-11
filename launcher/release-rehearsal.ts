import {createHash} from 'node:crypto';
import type {Store} from '../tracking/store';
import type {ReleaseReadiness} from './release-readiness';
import {releaseAction,type ReleaseOwner} from './release-actions';
export function gapOwner(input:string,reason:string):ReleaseOwner {
 if(/AWS sign-in|usage|pause/i.test(input+' '+reason))return 'Coordinator';
 if(/quality|hosted acceptance|owner qualification/i.test(input))return 'Quality';
 if(/billing|disk|configuration|environment/i.test(input))return 'Platform';
 return 'Release';
}
export function recordRehearsal(s:Store,r:ReleaseReadiness,slot:'14:00'|'17:40',send=releaseAction){
 // Retain every observation, including clean ones; mailing is per unresolved
 // input/day, not per polling pass. A second rehearsal does not repeat a gap.
 const key=`release-rehearsal:${r.day}:${slot}`;
 s.event(`${key}:${r.at}`,'release-rehearsal',{slot,...r},'Retain dry readiness and action receipts; never replay release effects',r.at);
 s.set(key,r);
 for(const gap of r.missing){
  const owner=gapOwner(gap.input,gap.reason),id=`release-rehearsal-gap:${r.day}:${createHash('sha256').update(owner+'\n'+gap.input).digest('hex')}`;
  const retained=s.get<{summary:string;body:string;owner:ReleaseOwner}>(id)??{owner,summary:`Release gap: ${gap.input}. Due ${r.day} 18:30 Eastern.`,body:`${gap.reason}\nResolve before 18:30 America/Toronto; fixed preflight is 19:00. No pause, gate, spending or release-time exception is granted.`.slice(0,800)};
  // Persist the immutable payload before the cross-store effect, so a changed
  // reason on retry cannot conflict with mail already queued before a crash.
  s.set(id,retained);
  send(id,retained.owner,retained.summary,retained.body,r.at);
 }
 return r;
}
