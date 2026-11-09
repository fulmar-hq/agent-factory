import { recordPulls, pullFields, type BoardPull } from "../board/pulls";
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {Store} from '../tracking/store';
import {Engine} from './engine';
import {type Config,type Ticket,QualificationSchema} from './config';
import {command} from '../adapters/github';
import {processIdentity} from './process';
export type Wake = {id:string;owner:string;kind:string;payload:unknown};
export type OwnerRuntime = {native?:string;workspace:string;pid?:number;identity?:string;wake?:string};
export function queueWake(s:Store,w:Wake,now=Date.now()) {
 return s.atomic(()=>{
  if(!s.event(`owner-event:${w.id}`,'owner-wake-queued',w,'Retain event and native custody; never replay a claimed wake',now))return false;
  s.set(`owner-wake:${w.id}`,{...w,state:'queued',at:now});return true;
 });
}
const wakePriority=(w:Wake)=>w.kind==='qa-deployed'?-3:w.kind==='production-verified'?-2:w.kind==='release-diagnosis'?-1:w.kind==='product-intake'?0:w.kind==='failure-diagnosis'?1:w.kind==='owner-decision'?2:3;
export function pendingWakes(s:Store) {
 return (s.db.query("SELECT value FROM kv WHERE key LIKE 'owner-wake:%'").all() as {value:string}[]).map(r=>JSON.parse(r.value)).filter((r:Wake & {state:string})=>r.state==='queued').sort((a:Wake,b:Wake)=>wakePriority(a)-wakePriority(b)) as Wake[];
}
export function dispatchWake(s:Store,w:Wake,spawn:(id:string)=>void,identity=processIdentity) {
 const claimed=s.atomic(()=>{
  const queued=s.get<Wake & {state:string}>(`owner-wake:${w.id}`);
  if(queued?.state!=='queued')return false;
  if(queued.kind==='qa-deployed'){
   const deadline=(queued.payload as {deadline?:number})?.deadline;
   if(!Number.isSafeInteger(deadline) || Date.now()>=deadline!){
    s.set(`owner-wake:${w.id}`,{...queued,state:'expired',cleanupVerified:true});
    s.event(`owner-deadline:${w.id}`,'owner-wake-expired',{id:w.id,deadline},'Retain missed acceptance deadline; never start a late Quality turn');return false;
   }
  }
  const runtime=s.get<OwnerRuntime>(`owner-runtime:${w.owner}`);
  if(!runtime || !existsSync(runtime.workspace))return false;
  if(runtime.pid && (!runtime.identity || identity(runtime.pid)===runtime.identity))return false;
  if(runtime.wake) {
   const previous=s.get<{state:string;cleanupVerified?:boolean}>(`owner-wake:${runtime.wake}`);
   // An uncertain spawn is never retried by clearing an old claim.
   if(previous && (['starting','running'].includes(previous.state) || previous.cleanupVerified!==true))return false;
  }
  s.set(`owner-wake:${w.id}`,{...queued,state:'starting'});
  s.set(`owner-runtime:${w.owner}`,{...runtime,pid:undefined,identity:undefined,wake:w.id});
  s.event(`owner-dispatch:${w.id}`,'owner-wake-dispatch',{...w,native:runtime.native},'Retain the dispatch claim even on uncertain exit');
  return true;
 });
 if(claimed)try{spawn(w.id);}catch(error){s.event(`owner-spawn-failure:${w.id}`,'owner-spawn-failure',{id:w.id,error:String(error)},'Retain uncertain spawn claim; reconcile before a new event');}
 return claimed;
}
export function recoverWorkers(e:Engine,now=Date.now()) {
 for(const x of e.active()) {
  if(x.status!=='unknown' || x.pid!==null || !x.native_id)continue;
  if(e.s.get<{verified:boolean}>(`cleanup-evidence:${x.id}`)?.verified!==true)continue;
  e.s.atomic(()=>{
   const current=e.sessions().find(y=>y.id===x.id);
   if(current?.status!=='unknown' || current.pid!==null)return;
   e.archive(x.id,`launcher verified stopped worker, native ${x.native_id}, retained logs/worktree; owner wake required`,'owner');
   queueWake(e.s,{id:`worker-recovered:${x.id}`,owner:x.owner,kind:'worker-recovered',payload:{session:x.id,native:x.native_id,ticket:x.ticket}},now);
  });
 }
}
export function localWakes(s:Store,c:Config,ready:Ticket[],qualifications:Record<string,unknown>,now:number) {
 for(const t of ready)queueWake(s,{id:`ready:${t.repo}#${t.number}:${createHash('sha256').update(JSON.stringify(t)).digest('hex')}`,owner:t.owner,kind:'ticket-ready',payload:t},now);
 for(const [provider,raw] of Object.entries(qualifications)) {
  const q=QualificationSchema.safeParse(raw);if(!q.success || q.data.expiresAt>now+2*3600000)continue;
  for(const [owner,role] of Object.entries(c.owners))if(role.harness===provider)queueWake(s,{id:`renew:${owner}:${q.data.expiresAt}`,owner,kind:'qualification-renewal',payload:{provider,expiresAt:q.data.expiresAt,evidence:q.data.evidence}},now);
 }
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const part=(k:string)=>parts.find(p=>p.type===k)!.value;
 const day=`${part('year')}-${part('month')}-${part('day')}`,time=`${part('hour')}:${part('minute')}`;
 if((time===c.schedule.qa_window || time===c.schedule.production_window) && c.owners.release)queueWake(s,{id:`release:${day}:${time}`,owner:'release',kind:'release-window',payload:{day,time}},now);
}
// Stable GitHub IDs, not tick times, deduplicate reviews and completed CI runs.
export async function githubWakes(s:Store,c:Config,execute=command,now=Date.now()) {
 for(const project of Object.values(c.projects)) {
  const primed=s.get(`owner-github-primed:${project.repo}`)===true;
  const emit=(w:Wake)=>{if(primed)queueWake(s,w,now);else s.event(`owner-event:${w.id}`,'owner-wake-baseline',w,'Retain historical baseline; only new events cause owner turns',now);};
  const prs=JSON.parse(await execute(['gh','pr','list','--repo',project.repo,'--state','open','--limit','100','--json',pullFields])) as BoardPull[];
  if(prs.length>=100)throw Error('owner PR reconciliation truncated');
  recordPulls(s,project.repo,prs,now);
  for(const pr of prs) {
   // PR number differs from issue number: delivery events bind the actual PR URL.
   const delivery=(s.db.query("SELECT data FROM events WHERE kind IN ('launcher-publish','worker-delivery')").all() as {data:string}[]).map(r=>JSON.parse(r.data)).find(r=>r.url===pr.url);
   const owner=(delivery ? (s.db.query('SELECT owner FROM sessions WHERE id=?').get(delivery.id) as {owner:string}|null)?.owner : undefined);
   const owners=owner ? [owner] : project.owners;
   for(const review of pr.reviews ?? [])if(review.id && ['APPROVED','CHANGES_REQUESTED','COMMENTED'].includes(review.state))for(const role of owners)emit({id:`review:${project.repo}:${review.id}:${role}`,owner:role,kind:'review-returned',payload:{repo:project.repo,pr:pr.number,head:pr.headRefOid,url:pr.url,review}});
   for(const check of pr.statusCheckRollup ?? [])if(check.status==='COMPLETED' || ['SUCCESS','FAILURE','ERROR'].includes(check.state ?? '')) {
    const key=check.detailsUrl ?? check.targetUrl;if(!key)continue;
    for(const role of owners)emit({id:`ci:${project.repo}:${pr.headRefOid}:${key}:${check.conclusion ?? check.state}:${role}`,owner:role,kind:'ci-finished',payload:{repo:project.repo,pr:pr.number,head:pr.headRefOid,url:pr.url,check}});
   }
  }
  s.set(`owner-github-primed:${project.repo}`,true);
 }
}
export function spawnOwner(id:string,dir:string) {
 const p=Bun.spawn([process.execPath,join(import.meta.dir,'owner.ts'),id],{env:{...process.env,FACTORY_PRIVATE_DIR:dir},detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});p.unref();
}
