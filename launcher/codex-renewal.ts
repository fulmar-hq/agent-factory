import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {QualificationSchema,type Qualification} from './config';
import {type Engine,usageGate} from './engine';
import {builderSlots} from './capacity';
export const renewalSources=['adapters/workers.ts','adapters/native.ts','adapters/delivery.ts','launcher/child.ts','launcher/worker.ts','launcher/process.ts','launcher/config.ts','adapters/codex-renewal.ts','launcher/codex-renewal-evidence.ts'];
export const renewalDigest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:(JSON.stringify(value)??"undefined")).digest('hex');
export function renewalFingerprint(checkout:string,version:string){return {version,hashes:Object.fromEntries(renewalSources.map(path=>[path,renewalDigest(readFileSync(join(checkout,path),'utf8'))]))};}
export function renewalDue(q:Record<string,unknown>,fingerprint:unknown,prior:unknown,now:number){
 const records=['codex','codex:medium','codex:high'].map(key=>QualificationSchema.parse(q[key]));
 for(const [i,effort] of ['high','medium','high'].entries())if(records[i]!.model!=='gpt-6.1-sol'||records[i]!.effort!==effort)throw Error('expected actual Codex qualifications required');
 const expiresAt=Math.min(...records.map(r=>r.expiresAt));
 return {expiresAt,dueAt:renewalDigest(fingerprint)!==renewalDigest(prior)?now:expiresAt-6*3600000};
}
export function scheduleCodexRenewal(e:Engine,dir:string,checkout:string,version:string,spawn:(id:string)=>void,now=Date.now()){
 const bytes=readFileSync(join(dir,'qualifications.json'),'utf8'),q=JSON.parse(bytes),fingerprint=renewalFingerprint(checkout,version);
 let prior:unknown;
 try{prior={version:QualificationSchema.parse(q.codex).version,hashes:JSON.parse(readFileSync(join(dirname(QualificationSchema.parse(q.codex).evidence),'source-hashes.json'),'utf8'))};}catch{/* No matching material evidence makes renewal due, never qualified. */}
 const due=renewalDue(q,fingerprint,prior,now),id=renewalDigest({qualification:renewalDigest(bytes),fingerprint});
 return e.s.atomic(()=>{
  const previous=e.s.get<{id:string;dueAt:number}>('codex-renewal-schedule');
  const schedule={id,...due,fingerprint,observedAt:now};e.s.set('codex-renewal-schedule',schedule);
  if(previous?.id!==id)e.s.event(`renewal-scheduled:${id}`,'codex-renewal-scheduled',schedule,'Retain schedule and custody; rollback through reviewed source, never advance expiry from a schedule',now);
  if(now<due.dueAt)return {state:'scheduled',...schedule};
  if(e.s.get(`codex-renewal-attempt:${id}`))return {state:'claimed',...schedule};
  if(e.s.get<{state:string}>('codex-renewal-slot')?.state!=='released'&&e.s.get('codex-renewal-slot'))return {state:'custody-blocked',...schedule};
  if(e.s.get('paused')!==false)return {state:'paused',...schedule};
  usageGate(e.s.get<Record<string,unknown>>('readings')?.codex,true,now,e.c,'codex');
  if(!builderSlots(e.s,e.c).free)return {state:'waiting-capacity',...schedule};
  const claim={id,state:'starting',at:now,qualificationSha256:renewalDigest(bytes),fingerprint};
  e.s.set(`codex-renewal-attempt:${id}`,claim);e.s.set('codex-renewal-slot',claim);
  // Claim and synchronous detached-spawn attempt share normal slot custody.
  spawn(id);return {state:'starting',...schedule};
 });
}
