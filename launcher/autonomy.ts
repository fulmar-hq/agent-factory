import {z} from 'zod';
import {enforceIntakeMode} from './intake-policy';
import {join} from 'node:path';
import {readFileSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {type Config,type Ticket,type Billing,TicketSchema,root} from './config';
import {processIdentity} from './process';
import {Engine,claimPath} from './engine';
import {Store} from '../tracking/store';
import {queueWake,type Wake} from './wake';
import {slotLimit} from './capacity';
import {observeSupplyIdle,type SupplyObservation} from './supply-idle';
import {command,approveIntake,intakeLabel,issueTicket,type Issue} from '../adapters/github';
import {branchFor,executableTest} from '../adapters/delivery';
import {available,awsRefusal} from '../wallet/ledger';
const undo='Preserve decisions, logs and custody; withdraw labels to stop future work; undo source with signed revert';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const overlap=(a:string,b:string)=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/');
const fields='number,title,body,url,updatedAt,state,labels';
export function prospective(repo:string,i:Issue) {
 const label=intakeLabel(repo,i);
 const t=issueTicket(repo,{...i,labels:[...i.labels.filter(l=>!l.name.startsWith('ready:') && !l.name.startsWith('state:')),{name:'state:ready'},{name:label}]})!;
 if(!i.labels.some(l=>l.name===`kind:${t.kind}`) || !i.labels.some(l=>l.name===`area:${t.area}`))throw Error('brief kind/area must match labels');
 return t;
}
function block(i:Issue):Record<string,unknown> {
 intakeLabel('validate/block',i);
 return JSON.parse(i.body.match(/```factory\s*\n([\s\S]*?)\n```/)![1]);
}
export function ownerDecision(s:Store,c:Config,id:string,owner:string,question:string,payload:unknown,now:number) {
 if(s.event(`decision:${id}`,'autonomy-owner-decision',{id,owner,question,payload,tier:'owner',deadline:now+7200000,default:'not approved'},undo,now)) {
  s.db.query("INSERT OR IGNORE INTO questions(id,text,answer,at,addressed_to) VALUES(?,?,NULL,?,'owner')").run(`autonomy:${id}`,question,now);
  s.set(`autonomy-decision:${id}`,{id,owner,question,payload,deadline:now+7200000,default:'not approved',state:'open'});
  queueWake(s,{id:`decision:${id}`,owner:c.owners[owner]?owner:c.autonomy!.intake_owner,kind:'owner-decision',payload:{id,question,evidence:payload,default:'not approved'}},now);
 }
}
export function expireDecisions(s:Store,now:number) {
 for(const r of s.db.query("SELECT key,value FROM kv WHERE key LIKE 'autonomy-decision:%'").all() as {key:string;value:string}[]) {
  const d=JSON.parse(r.value);if(d.state==='open' && d.deadline<=now){s.set(r.key,{...d,state:'defaulted',outcome:d.default});s.event(`default:${d.id}`,'autonomy-decision-default',d,undo,now);}
 }
}
export function policyRefusal(e:Engine,t:Ticket,raw:Record<string,unknown>,round:string,billing:Billing|undefined,now:number,others:Ticket[]=[]) {
 const p=e.c.autonomy!.auto_approval;
 const project=Object.values(e.c.projects).find(p=>p.repo===t.repo);
 if(!project?.owners.includes(t.owner) || e.c.owners[t.owner]?.harness!==t.provider)return 'unenrolled owner/provider';
 if(typeof raw.estimateBasis!=='string' || raw.estimateBasis.trim().length<20 || typeof raw.estimateSeconds!=='number' || typeof raw.estimateTokens!=='number')return 'honest explicit estimate and basis required';
 if(t.estimateSeconds>p.max_minutes*60)return 'estimate over 30 minutes';
 if(!/^[a-z][a-z0-9-]*$/.test(t.area) || t.area==='unknown')return 'one explicit area required';
 if(t.spansBackendAndScreen)return 'one area required';
 executableTest(t.test);
 const paths=t.paths.map(claimPath);
 const protectedPaths=[...p.protected_paths,'AGENTS.md','CLAUDE.md','.git'].map(claimPath);
 if(paths.some(path=>protectedPaths.some(p=>overlap(path,p)) || /(^|\/)(agents\.md|claude\.md)$/.test(path)))return 'protected path';
 // Check active custody AND all approved queue paths; independent tick admissions
 // remain the final authority. Unknown retained paths conservatively refuse.
 const occupied=(e.s.db.query("SELECT path FROM claims JOIN sessions ON claims.session=sessions.id WHERE status NOT IN ('finished','archived')").all() as {path:string}[]).map(r=>claimPath(r.path));
 occupied.push(...others.filter(o=>o.repo+'#'+o.number!==t.repo+'#'+t.number).flatMap(o=>o.paths.map(claimPath)));
 if(paths.some(p=>occupied.some(o=>overlap(p,o))))return 'paths overlap active or ready work';
 const docs=paths.every(p=>p.startsWith('docs/') || /\.(md|txt)$/.test(p));
 if(docs && !e.s.get(`auto-policy:${t.repo}#${t.number}:${t.approvalDigest}`) && (e.s.get<number>(`round-docs:${round}`) ?? 0)>=p.max_docs_per_round)return 'docs-only round limit';
 if(t.wallet==='aws'){const r=awsRefusal(e.s,e.c,now,billing);if(r)return r;}
 if(t.costCents>available(e.s,e.c,t.wallet,now,billing))return 'wallet does not fit';
 return null;
}
export type IntakeRound={id:string;at:number;attempt:number;wake:string;closed?:boolean;retryAt?:number;backoff?:number};
export function supply(e:Engine,ready:Ticket[],now:number,observation?:SupplyObservation,alertPath?:string) {
 const p=e.c.autonomy;
 if(!p || e.s.get('paused')!==false){if(e.s.get('supply-idle'))e.s.set('supply-idle',null);return;}
 const sessions=e.sessions(),refused=new Set(observation?.refusals.map(r=>r.ticket));
 const unclaimed=ready.filter(t=>!refused.has(`${t.repo}#${t.number}`) && !sessions.some(x=>x.ticket===`${t.repo}#${t.number}` && x.approval_digest===t.approvalDigest));
 const idle=observation ? observeSupplyIdle(e,unclaimed.length,now,observation,alertPath) : null;
 const idleDue=!!idle && !idle.wake && now-idle.since>=p.idle_wake_minutes*60000;
 const target=slotLimit(e.s,e.c)+p.ready_buffer;
 let round=e.s.get<IntakeRound>('intake-round');
 const markIdleWake=(wake:string)=>{
  if(!idleDue)return;
  e.s.set('supply-idle',{...idle,wake});
  e.s.event(`supply-idle-wake:${idle!.id}`,'supply-idle-wake',{...idle,wake,minutes:p.idle_wake_minutes},undo,now);
 };
 // Never replace a queued/live round because another worker published or the
 // buffer briefly filled. Native custody and cleanup remain authoritative.
 const wake=round ? e.s.get<Wake & {state:string;cleanupVerified?:boolean}>(`owner-wake:${round.wake}`) : null;
 if(round && wake && ['starting','running'].includes(wake.state)){
  markIdleWake(round.wake);
  if(now-round.at>=1800000)ownerDecision(e.s,e.c,`intake-overdue:${round.wake}`,p.intake_owner,'Intake deadline elapsed; native custody still unresolved, no duplicate started',{round,wake},now);
  return;
 }
 if(unclaimed.length>=target){if(round)e.s.set('intake-round',{...round,closed:true});return;}
 if(round && (!round.closed || wake?.state==='queued' || wake?.cleanupVerified!==true)){
  if(wake?.state==='queued'){
   markIdleWake(round.wake);
   if(now-round.at<1800000)return;
   const expired=e.s.atomic(()=>{const current=e.s.get<Wake & {state:string}>(`owner-wake:${round!.wake}`);if(current?.state!=='queued')return false;e.s.set(`owner-wake:${round!.wake}`,{...current,state:'expired',cleanupVerified:true});return true;});
   if(!expired)return;
  }else if(!wake || wake.cleanupVerified!==true || !['done','blocked','expired'].includes(wake.state)){
   if(now-round.at>=1800000)ownerDecision(e.s,e.c,`intake-custody:${round.wake}`,p.intake_owner,'Intake cleanup evidence unresolved; no duplicate started',{round,wake},now);
   return;
  }
  const delivered=e.s.db.query("SELECT data FROM events WHERE kind='launcher-publish' AND at>?").all(round.at) as {data:string}[];
  const useful=delivered.some(r=>{const x=sessions.find(x=>x.id===JSON.parse(r.data).id);if(!x)return false;const t=JSON.parse(x.brief) as Ticket;return t.paths.some(p=>!p.startsWith('docs/') && !/\.(md|txt)$/i.test(p));});
  if(useful){round={...round,closed:true};e.s.set('intake-backoff',0);}
  else if(round.attempt>=2){
   if(round.retryAt===undefined){
    const backoff=Math.min((e.s.get<number>('intake-backoff') ?? 0)+1,7);
    const delay=Math.min(60,p.idle_wake_minutes*2**(backoff-1))*60000;
    round={...round,retryAt:now+delay,backoff};e.s.set('intake-round',round);e.s.set('intake-backoff',backoff);
    if(p.intake_mode==='drain')e.s.event(`drain-exhausted:${round.id}`,'drain-intake-exhausted',{round,ready:unclaimed.length,target},undo,now);
    else ownerDecision(e.s,e.c,`intake-exhausted:${round.id}`,p.intake_owner,'Intake did not fill the ready queue after two bounded rounds; retry scheduled',{round,ready:unclaimed.length,target},now);
    e.s.event(`intake-retry:${round.id}`,'intake-retry-scheduled',{round,delay},undo,now);
   }
   // A decision default rejects its proposed effects, never future read-only
   // intake. Backoff is durable; the first idle deadline may shorten it once.
   if(now<round.retryAt! && !idleDue)return;
   round={...round,closed:true};
  }else round={...round,at:now,attempt:2,wake:`intake:${round.id}:2`};
 }
 if(!round || round.closed){const id=`${now}-${crypto.randomUUID()}`;round={id,at:now,attempt:1,wake:`intake:${id}:1`};}
 e.s.set('intake-round',round);
 const publications=new Map((e.s.db.query("SELECT data FROM events WHERE kind IN ('launcher-publish','worker-delivery') ORDER BY at").all() as {data:string}[]).map(r=>{const d=JSON.parse(r.data) as {id:string;url:string};return [d.id,d.url];}));
 const existing=(e.s.rows('tickets') as {id:string;snapshot:string}[]).map(r=>{
  const i=JSON.parse(r.snapshot) as Issue;
  const session=sessions.filter(x=>x.ticket===r.id).sort((a,b)=>b.attempt-a.attempt).find(x=>publications.has(x.id));
  const pr=session ? publications.get(session.id) : undefined;
  return {id:r.id,title:i.title.slice(0,180),state:i.state,labels:i.labels.filter(l=>/^(state|area|kind):/.test(l.name)).slice(0,8).map(l=>({name:l.name.slice(0,80)})),scope:i.body?.match(/```factory\s*\n([\s\S]*?)\n```/)?.[1].slice(0,1200),pr,checks:pr ? e.s.get(`board-pr:${pr}`) : undefined};
 }).filter(i=>i.state==='OPEN');
 const review=existing.filter(i=>i.labels.some(l=>l.name==='state:review'));
 const brief='Free capacity is work to staff. Review-state issues need bounded review, challenge or fix-up tasks tied to their existing issue/PR; do not wait for the whole review queue or invent new scope. Inspect current evidence, avoid duplicate/occupied paths, and return source-backed factory briefs with executable checks. A rejected/defaulted proposal stays unapproved. Report concrete blockers if no safe leaf exists; the launcher retries with backoff.';
 queueWake(e.s,{id:round.wake,owner:p.intake_owner,kind:'product-intake',payload:{round:round.id,ready:unclaimed.length,target,intake_mode:p.intake_mode,projects:e.c.projects,policy:p.auto_approval,brief,idleSince:idle?.since,free:e.slots().free,refusals:observation?.refusals.slice(0,20).map(r=>({...r,reason:r.reason.slice(0,500)})),reviewCount:review.length,existing:[...review,...existing.filter(i=>!review.includes(i))].slice(0,50),existingCount:existing.length,occupied:e.active().slice(0,12).map(x=>({id:x.id,ticket:x.ticket,paths:(JSON.parse(x.brief) as Ticket).paths.slice(0,30)}))}},now);
 markIdleWake(round.wake);
}
// Missing proof is an escalation, not a synthesized successful session.
export type Cause='budget'|'sandbox'|'test'|'publisher'|'timeout'|'unknown';
export function classifyFailure(text:string):Cause {
 if(/budget|overrun|token.{0,20}(?:pause|limit)/i.test(text))return 'budget';
 if(/sandbox|permission denied|CouldntReadCurrentDirectory|operation not permitted|isolation/i.test(text))return 'sandbox';
 if(/timed?\s*out|timeout|heartbeat/i.test(text))return 'timeout';
 if(/test.*(?:fail|exit)|check.*fail|assertion|tested tree/i.test(text))return 'test';
 if(/publish|bundle|empty delivery|sign|push/i.test(text))return 'publisher';
 return 'unknown';
}
export type Failure={session:string;ticket:string;repo:string;provider:string;cause:Cause;at:number};
export function failures(e:Engine,now:number) {
 if(!e.c.autonomy)return;
 for(const x of e.sessions()) {
  if(e.sessions().some(y=>y.ticket===x.ticket && y.attempt>x.attempt))continue;
  if(e.s.db.query("SELECT id FROM events WHERE kind IN ('launcher-publish','worker-delivery') AND json_extract(data,'$.id')=?").get(x.id))continue;
  const failed=e.s.db.query("SELECT data FROM events WHERE id=?").get(`failure:${x.id}`) as {data:string}|null;
  if(!failed && !['unknown','paused','archived'].includes(x.status))continue;
  if(x.status==='archived' && !failed && !e.s.db.query("SELECT id FROM events WHERE id=? AND json_extract(data,'$.ok')=0").get(`exit:${x.id}`))continue;
  const t=JSON.parse(x.brief) as Ticket;
  const reason=JSON.stringify({failure:failed?JSON.parse(failed.data):undefined,stop:e.s.get(`stop:${x.id}`)});
  const f:Failure={session:x.id,ticket:x.ticket,repo:t.repo,provider:t.provider,cause:classifyFailure(reason),at:now};
  if(!e.s.event(`classified:${x.id}`,'failure-classified',f,undo,now))continue;
  e.s.set(`failure-class:${x.id}`,f);
  const recent=(e.s.db.query("SELECT data FROM events WHERE kind='failure-classified' AND at>? AND at<=?").all(now-3600000,now) as {data:string}[]).map(r=>JSON.parse(r.data) as Failure).filter(y=>y.repo===f.repo && y.provider===f.provider && y.cause===f.cause);
  const circuit=`${t.repo}:${t.provider}:${f.cause}`;
  if(recent.length>=e.c.autonomy.restart.causes_per_hour){e.s.set(`restart-held:${circuit}`,{at:now,cause:f.cause,sessions:recent.map(f=>f.session)});ownerDecision(e.s,e.c,`restart:${circuit}:${recent[0].session}`,f.cause==='sandbox'?'platform':t.owner,'Repeated failure cause; retries held until reviewed repair',{circuit,recent},now);}
  const spent=e.s.get(`automatic-retry:${x.ticket}`);
  if(spent || f.cause==='budget' || f.cause==='unknown')ownerDecision(e.s,e.c,`failure:${x.id}`,t.owner,'Failure needs an owner decision; no automatic budget extension or uncertain replay',{...f,reason},now);
  else queueWake(e.s,{id:`diagnose:${x.id}`,owner:t.owner,kind:'failure-diagnosis',payload:{...f,brief:t,reason,deadline:now+3600000}},now);
 }
 // A stuck diagnosis is visible within an hour, even if no owner could start.
 for(const row of e.s.db.query("SELECT value FROM kv WHERE key LIKE 'owner-wake:diagnose:%'").all() as {value:string}[]) {
  const w=JSON.parse(row.value);if(now>=w.payload.deadline && !e.s.get(`automatic-retry:${w.payload.ticket}`))ownerDecision(e.s,e.c,`diagnosis-deadline:${w.id}`,w.owner,'Automatic diagnosis/retry did not finish within one hour',w.payload,now);
 }
}
function artifact(scratch:string,name:string):unknown {
 const fd=openSync(join(scratch,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {const stat=fstatSync(fd);if(!stat.isFile() || stat.size>128*1024)throw Error('bounded regular result required');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
const Intake=z.object({tickets:z.array(z.object({repo:z.string(),title:z.string().min(1).max(100),brief:z.record(z.string(),z.unknown())})).max(15)}).strict();
const Retry=z.object({session:z.string(),diagnosis:z.string().min(20),estimateBasis:z.string().min(20),test:z.string().min(1),outcome:z.string().min(1)}).strict();
// Only a completed, native-verified wake with independently verified cleanup can
// propose effects. Files are data, never controller commands or credentials.
export async function applyOwnerResults(e:Engine,dir:string,billing:Billing|undefined,now:number,execute=command) {
 if(!e.c.autonomy || e.s.get('paused')!==false)return;
 const wakes=(e.s.db.query("SELECT value FROM kv WHERE key LIKE 'owner-wake:%'").all() as {value:string}[]).map(r=>JSON.parse(r.value) as Wake & {state:string;cleanupVerified?:boolean;scratch?:string});
 for(const w of wakes) {
  if(w.state!=='done' || !w.cleanupVerified || !w.scratch || !['product-intake','failure-diagnosis'].includes(w.kind) || e.s.get(`owner-result:${w.id}`))continue;
  try {
   if(w.kind==='product-intake') {
    const data=Intake.parse(artifact(w.scratch,'intake.json'));
    const round=(w.payload as {round:string}).round;
    for(let n=0;n<data.tickets.length;n++) {
     const proposal=data.tickets[n],key=`proposal:${w.id}:${n}`;
     const project=Object.values(e.c.projects).find(p=>p.repo===proposal.repo && p.owners.includes(w.owner));if(!project)throw Error('proposal project/owner not enrolled');
     const brief:Record<string,unknown>={...proposal.brief,owner:w.owner,creator:`launcher:${w.id}`,source:`factory-event:${w.id}`,approved:true};
     const fake:Issue={number:1,title:proposal.title,body:'```factory\n'+JSON.stringify(brief,null,2)+'\n```',url:'',updatedAt:'',state:'OPEN',labels:[{name:`kind:${String(brief.kind)}`},{name:`area:${String(brief.area)}`} ]};
     const t=prospective(proposal.repo,fake);executableTest(t.test);
     await enforceIntakeMode(e,proposal.repo,brief,dir,execute);
     // Durable marker recovers an uncertain create without duplicating issues.
     let number=e.s.get<number>(key);
     if(!number) {
      const marker=`<!-- ${key} -->`;
      const matches=JSON.parse(await execute(['gh','issue','list','--repo',t.repo,'--state','all','--search',`in:body "${key}"`,'--limit','100','--json',fields])) as Issue[];
      const exact=matches.filter(i=>i.body.includes(marker));if(matches.length>=100 || exact.length>1)throw Error('proposal create custody ambiguous');
      if(exact.length)number=exact[0].number;
      else {
       for(const name of [`kind:${t.kind}`,`area:${t.area}`,'state:ready','state:building'])await execute(['gh','label','create',name,'--repo',t.repo,'--color','6F42C1','--description','Factory intake category','--force']);
       const url=(await execute(['gh','issue','create','--repo',t.repo,'--title',proposal.title,'--body',`${marker}\n${fake.body}`,'--label',`kind:${t.kind}`,'--label',`area:${t.area}`,'--label','state:ready'])).trim();
       const match=url.match(/\/issues\/(\d+)$/);if(!match)throw Error('created issue identity unknown');number=Number(match[1]);
      }
      e.s.set(key,number);
     }
     e.s.set(`proposal-round:${t.repo}#${number}`,round);
    }
   } else {
    const data=Retry.parse(artifact(w.scratch,'retry.json'));
    const payload=w.payload as Failure & {deadline?:number};
    if(payload.deadline!==undefined && now>=payload.deadline)throw Error('diagnosis deadline elapsed; owner decision required');
    if(data.session!==payload.session)throw Error('diagnosis session mismatch');
    await retryFailure(e,data,now,execute);
   }
   e.s.set(`owner-result:${w.id}`,{at:now,applied:true});
  } catch(error) {
   e.s.event(`owner-result-refused:${w.id}:${hash(String(error))}`,'owner-result-refused',{id:w.id,error:String(error)},undo,now);
   if(w.kind!=='failure-diagnosis')e.s.set(`owner-result:${w.id}`,{at:now,applied:false});
   ownerDecision(e.s,e.c,`result:${w.id}`,w.owner,'Owner result could not be applied',{wake:w.id,error:String(error)},now);
  }
 }
}
async function retryFailure(e:Engine,data:z.infer<typeof Retry>,now:number,execute:typeof command) {
 const x=e.sessions().find(x=>x.id===data.session);if(!x)throw Error('failed session missing');
 const f=e.s.get<Failure>(`failure-class:${x.id}`);if(!f || ['budget','unknown'].includes(f.cause))throw Error('failure needs owner decision');
 if(e.s.get(`restart-held:${f.repo}:${f.provider}:${f.cause}`))throw Error('failure cause restart budget held');
 if(!['archived','unknown'].includes(x.status) || x.pid!==null || !x.native_id || e.s.get<{verified:boolean}>(`cleanup-evidence:${x.id}`)?.verified!==true)throw Error('failed native custody/cleanup unresolved');
 const prior=e.sessions().filter(y=>y.ticket===x.ticket);
 if(prior.some(y=>y.id!==x.id && y.status!=='archived'))throw Error('prior custody unresolved');
 for(const y of prior) {
  if(e.s.db.query("SELECT id FROM events WHERE kind IN ('launcher-publish','worker-delivery') AND json_extract(data,'$.id')=?").get(y.id))throw Error('prior PR retained');
  const prs:unknown=JSON.parse(await execute(['gh','pr','list','--repo',f.repo,'--head',branchFor(y.id),'--state','all','--limit','1','--json','number']));
  if(!Array.isArray(prs) || prs.length)throw Error('prior PR exists or unknown');
 }
 executableTest(data.test);
 const original=JSON.parse(x.brief) as Ticket;
 const i=JSON.parse(await execute(['gh','issue','view',String(original.number),'--repo',original.repo,'--json',fields])) as Issue;
 const spent=e.s.get<{session:string;body:string;from:string;to:string}>(`automatic-retry:${x.ticket}`);
 if(spent && spent.session!==x.id)throw Error('one automatic retry already spent');
 let plan=spent;
 if(!plan) {
  if(i.state!=='OPEN' || intakeLabel(original.repo,i)!==x.approval_digest)throw Error('intake changed since failed attempt');
  const raw=block(i);
  const retry={...raw,outcome:data.outcome,test:data.test,estimateBasis:data.estimateBasis,retryOf:x.id,retryDiagnosis:data.diagnosis};
  const body=i.body.replace(/```factory\s*\n[\s\S]*?\n```/,'```factory\n'+JSON.stringify(retry,null,2)+'\n```');
  const candidate={...i,body};const t=prospective(original.repo,candidate);
  if(t.paths.map(claimPath).join('\n')!==original.paths.map(claimPath).join('\n') || t.owner!==original.owner || t.provider!==original.provider)throw Error('retry scope changed');
  plan={session:x.id,body,from:intakeLabel(original.repo,i),to:intakeLabel(original.repo,candidate)};
  e.s.atomic(()=>{if(e.s.get(`automatic-retry:${x.ticket}`))throw Error('retry already claimed');e.s.set(`automatic-retry:${x.ticket}`,plan);e.s.event(`auto-retry:${x.ticket}`,'automatic-retry-planned',{...f,digest:plan!.to,diagnosis:data.diagnosis},undo,now);});
 }
 // Archive retains original attempt, native ID, debit and workspace. The normal
 // admission path still requires this receipt and a subsequent fresh approval.
 if(x.status==='unknown')e.archive(x.id,`automatic retry after verified cleanup; diagnosis ${witness(data.diagnosis)}`,'owner');
 const current=intakeLabel(original.repo,i);
 if(current!==plan.from && current!==plan.to)throw Error('retry issue changed before edit');
 if(current!==plan.to)await execute(['gh','issue','edit',String(original.number),'--repo',original.repo,'--body',plan.body]);
 await approveIntake(original.repo,original.number,e.s,`launcher one-retry policy; ${data.diagnosis}`,execute,plan.to);
 e.s.event(`auto-retry-approved:${x.ticket}`,'automatic-retry-approved',{...f,digest:plan.to},undo,now);
}
const witness=(text:string)=>text.slice(0,1000);
export async function autoApprove(e:Engine,ready:Ticket[],billing:Billing|undefined,now:number,execute=command,dir=root) {
 if(!e.c.autonomy || e.s.get('paused')!==false)return 0;
 let approved=0;
 const round=e.s.get<IntakeRound>('intake-round')?.id ?? 'initial';
 const others=[...ready];
 for(const row of e.s.rows('tickets') as {id:string;snapshot:string;observed:number}[]) {
  const i=JSON.parse(row.snapshot) as Issue,repo=row.id.slice(0,row.id.lastIndexOf('#'));
  const state=e.s.get<{observedAt:number;error?:string;truncated?:boolean}>(`github:${repo}`);
  if(!state || state.error || state.truncated || state.observedAt!==now || row.observed!==now || i.state!=='OPEN' || !i.labels.some(l=>l.name==='state:ready') || i.labels.some(l=>l.name.startsWith('ready:')))continue;
  // Existing attempted tickets must go through diagnosis, never fresh intake.
  if(e.sessions().some(x=>x.ticket===row.id))continue;
  let t:Ticket;
  const r=e.s.get<string>(`proposal-round:${row.id}`) ?? round;
  try {
   t=prospective(repo,i);
   await enforceIntakeMode(e,repo,block(i),dir,execute);
   if(e.s.db.query("SELECT id FROM events WHERE id=?").get(`auto-approved:${row.id}:${t.approvalDigest}`)){others.push(t);continue;}
   const refusal=policyRefusal(e,t,block(i),r,billing,now,others);
   if(refusal)throw Error(refusal);
   // Pin approval's own GitHub reread to the digest evaluated above.
   const reservation=`auto-policy:${row.id}:${t.approvalDigest}`;
   const docs=t.paths.map(claimPath).every(p=>p.startsWith('docs/') || /\.(md|txt)$/.test(p));
   e.s.atomic(()=>{
    if(!e.s.get(reservation)) {
     if(docs && (e.s.get<number>(`round-docs:${r}`) ?? 0)>=1)throw Error('docs-only round limit');
     if(docs)e.s.set(`round-docs:${r}`,(e.s.get<number>(`round-docs:${r}`) ?? 0)+1);
     e.s.set(reservation,{at:now,round:r});
    }
   });
   await approveIntake(repo,i.number,e.s,`launcher auto-approval; round ${r}; ${String(block(i).estimateBasis)}`,execute,t.approvalDigest);
   e.s.event(`auto-approved:${row.id}:${t.approvalDigest}`,'intake-auto-approved',{repo,number:i.number,digest:t.approvalDigest,round:r},undo,now);
   others.push(t);approved++;
  } catch(error) {ownerDecision(e.s,e.c,`draft:${row.id}:${hash(i.body)}`,e.c.autonomy.intake_owner,'Draft outside automatic approval policy',{repo,number:i.number,error:String(error),digest:(()=>{try{return intakeLabel(repo,i);}catch{return null;}})()},now);}
 }
 return approved;
}

// Serialize external policy effects across overlapping launcher ticks without
// holding a SQLite transaction across network awaits. A live owner never loses
// the lease to a timeout; a dead process can be reclaimed by identity.
export async function autonomyEffects<T>(s:Store,run:()=>Promise<T>,identity=processIdentity):Promise<T|undefined> {
 const token=crypto.randomUUID();
 const claimed=s.atomic(()=>{
  const old=s.get<{pid:number;identity:string;token:string}>('autonomy-effects');
  if(old && identity(old.pid)===old.identity)return false;
  s.set('autonomy-effects',{pid:process.pid,identity:identity(process.pid),token});return true;
 });
 if(!claimed)return;
 try{return await run();}finally{s.atomic(()=>{if(s.get<{token:string}>('autonomy-effects')?.token===token)s.set('autonomy-effects',null);});}
}
