import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {command} from '../adapters/github';
import {mailPath} from './alerts';
import {type Config,type Meter,QualificationSchema,optionalJSON} from './config';
import {usageGate} from './engine';
import {deadlineAt,toronto} from './release';
import {processIdentity} from './process';
import type {Store} from '../tracking/store';

type Carrier={day:string;base:string;revision:string;tree:string;pr:number;ref:string;holdId:string};
type Disk={freeGiB:number;usedFraction:number;source?:string;path?:string};
type Missing={input:string;reason:string};
export type ReleaseReadiness={day:string;at:number;validThrough:number;ready:boolean;missing:Missing[];evidence:Record<string,unknown>};
export type ReadinessOptions={dir:string;config:Config;store:Store;brake:string|null;billingRefusal?:string|null;billingEvidence?:unknown;factorySource?:string;readings?:{codex?:Meter;claude?:Meter};carrier?:Carrier;now?:number;execute?:typeof command;readJSON?:typeof optionalJSON;disk?:()=>Disk|Promise<Disk>;identity?:typeof processIdentity};
const repo='fulmar-hq/alido';
const record=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const heldLabel=(l:unknown)=>record(l)&&typeof l.name==='string'&&['qa hold','qa-hold'].includes(l.name.toLowerCase());

// This is original sign-in provenance, not an AWS access-token/role-credential
// expiry. Refreshing either of those never extends a password/MFA session.
export function originalSessionExpiry(raw:unknown,now:number,validThrough:number) {
 if(!record(raw)||raw.version!==1||raw.kind!=='original-password-mfa-session'||typeof raw.signedInAt!=='string'||typeof raw.expiresAt!=='string'||typeof raw.receipt!=='string'||!raw.receipt.trim())throw Error('original AWS sign-in receipt is missing');
 const start=Date.parse(raw.signedInAt),end=Date.parse(raw.expiresAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=start||end-start>24*3600000||end<=validThrough)throw Error('original AWS sign-in does not remain valid through 22:30');
 return {signedInAt:start,expiresAt:end,receipt:raw.receipt};
}

export async function releaseDiskReading(execute=command,path=process.platform==='darwin'?'/System/Volumes/Data':'/'):Promise<Disk> {
 // Use the owning runbook's actual df observation. APFS container/snapshot
 // accounting can make statfs blocks-bfree disagree with the Data-volume row.
 const lines=(await execute(['/bin/df','-kP',path],undefined,3000)).trim().split('\n');
 if(lines.length!==2)throw Error('Data-volume df reading unavailable or ambiguous');
 const f=lines[1].trim().split(/\s+/),capacity=f[4]?.match(/^(\d{1,3})%$/);
 if(f.length!==6||f[5]!==path||!capacity||Number(capacity[1])>100||![f[1],f[2],f[3]].every(v=>/^\d+$/.test(v)&&Number.isSafeInteger(Number(v)))||Number(f[1])<=0)throw Error('Data-volume df reading malformed');
 return {freeGiB:Number(f[3])/2**20,usedFraction:Number(capacity[1])/100,source:'df -kP',path};
}

// Collect each dependency independently: a billing failure must not conceal an
// expired Quality qualification, explicit hold or missing candidate check.
// This function performs only local/remote reads and never queues a message.
export async function collectReleaseReadiness(o:ReadinessOptions):Promise<ReleaseReadiness> {
 const now=o.now??Date.now(),day=toronto(now).day,validThrough=deadlineAt(now,1350);
 const report:ReleaseReadiness={day,at:now,validThrough,ready:false,missing:[],evidence:{}};
 const execute=o.execute??command,readJSON=o.readJSON??optionalJSON;
 const missing=(input:string,reason:string)=>report.missing.push({input,reason});
 const check=async(input:string,f:()=>unknown|Promise<unknown>)=>{try{report.evidence[input]=await f();}catch(error){missing(input,String(error));}};
 const api=async(path:string)=>JSON.parse(await execute(['gh','api','--method','GET',`repos/${repo}/${path}`]));
 // The caller must attempt this read independently of admission's early
 // pause/STOP returns; a null brake alone is not a fresh billing receipt.
 if(o.billingRefusal!==null)missing('fresh billing',o.billingRefusal??'independent fresh billing read was not collected');
 else report.evidence['fresh billing']=o.billingEvidence??{readSucceeded:true};
 if(o.brake!==null)missing('billing and factory state',o.brake);
 if(o.store.get('paused')!==false)missing('factory state','factory is paused');
 if(o.store.get('aws-stop-latched')===true)missing('factory state','AWS stop remains latched');
 await Promise.all([
  check('AWS sign-in',async()=>originalSessionExpiry(await readJSON(join(o.dir,'release-auth-session.json')),now,validThrough)),
  check('disk space',async()=>{
   const d=await (o.disk??releaseDiskReading)();
   if(!Number.isFinite(d.freeGiB)||!Number.isFinite(d.usedFraction)||d.freeGiB<60||d.usedFraction<0||d.usedFraction>1)throw Error('Data volume needs a verified reading with at least 60 GiB free');
   // Platform's 80% signal is advisory, not authority for a new release stop.
   return {...d,warning:d.usedFraction>=0.8,...(d.usedFraction>=0.8?{action:'Platform must inspect Data-volume usage and follow the disk-capacity runbook; retain at least 60 GiB free'}:{})};
  }),
  check('owner qualification',async()=>{
   const raw=await readJSON(join(o.dir,'qualifications.json'));
   const receipts:Record<string,unknown>={};
   for(const owner of ['release','quality']){
    const role=o.config.owners[owner];
    if(!role){missing(`${owner} qualification`,'owner is not configured');continue;}
    const data=record(raw)?raw[`${role.harness}:${role.effort}`]??raw[role.harness]:undefined;
    const q=QualificationSchema.safeParse(data);
    if(!q.success||q.data.model!==role.model||q.data.effort!==role.effort||q.data.expiresAt<=validThrough){missing(`${owner} qualification`,'current configured model and effort must be qualified through 22:30');continue;}
    receipts[owner]={provider:role.harness,model:q.data.model,effort:q.data.effort,expiresAt:q.data.expiresAt,evidence:q.data.evidence};
   }
   return receipts;
  }),
  check('owner usage',async()=>{
   const raw=await readJSON(join(o.dir,'readings.json'));
   for(const owner of ['release','quality']){
    const role=o.config.owners[owner];if(!role)continue;
    try{usageGate(o.readings?.[role.harness]??(record(raw)?raw[role.harness]:undefined),false,now,o.config,role.harness);}
    catch(error){missing(`${owner} usage`,String(error));}
   }
   return {checkedAt:now};
  }),
  check('Quality runner',()=>{
   const r=o.store.get<{workspace?:string;wake?:string;pid?:number;identity?:string}>('owner-runtime:quality');
   if(!r||!r.workspace||!existsSync(r.workspace))throw Error('Quality has no registered existing workspace');
   // Match dispatchWake's start-identity gate. A missing identity cannot
   // prove an old owner exited; a same-identity PID still owns the runtime.
   if(r.pid!==undefined){
    if(!Number.isSafeInteger(r.pid)||r.pid<=0||!r.identity)throw Error('Quality owner native custody is unknown');
    const current=(o.identity??processIdentity)(r.pid);
    if(current===r.identity)throw Error('Quality owner is still running');
   }
   if(r.wake){const prior=o.store.get<{state?:string;cleanupVerified?:boolean}>(`owner-wake:${r.wake}`);if(prior&&(['starting','running'].includes(prior.state??'')||prior.cleanupVerified!==true))throw Error('Quality retains unresolved native custody');}
   return {workspace:r.workspace};
  }),
  check('hosted acceptance path',async()=>{
   // A qualified CLI owner is not proof that it can inspect the hosted app
   // and return a receipt through this release's trusted ingestion path.
   const p=await readJSON(join(o.dir,'release-quality-path.json')),role=o.config.owners.quality;
   if(!role||!record(p)||p.version!==1||p.qualified!==true||p.provider!==role.harness||p.model!==role.model||p.effort!==role.effort||!Number.isSafeInteger(p.expiresAt)||Number(p.expiresAt)<=validThrough||typeof p.source!=='string'||!/^[a-f0-9]{40}$/.test(p.source)||p.source!==o.factorySource||typeof p.evidence!=='string'||!p.evidence.trim()||p.browser!==true||p.receiptIngestion!==true)throw Error('current configured Quality hosted browser and receipt path has no valid qualification through 22:30');
   return {provider:p.provider,model:p.model,effort:p.effort,source:p.source,expiresAt:p.expiresAt,evidence:p.evidence,browser:true,receiptIngestion:true};
  }),
  check('release holds',async()=>{
   const [variable,issue]=await Promise.all([api('actions/variables/QA_HOLD'),api('issues/1192')]);
   const hold=JSON.parse(variable?.value??'null');
   // This installation is on legacy protocol 1. A protocol migration requires
   // the captain's deliberate qualification, not permissive field guessing.
   const fields=['at','by','held','id','legacy_issue','reason','version'];
   if(!record(hold)||hold.version!==1||Object.keys(hold).sort().join(',')!==fields.join(',')||typeof hold.id!=='string'||!/^[-A-Za-z0-9_.:]{1,120}$/.test(hold.id)||typeof hold.held!=='boolean'||typeof hold.reason!=='string'||!hold.reason.trim()||hold.reason.length>500||typeof hold.by!=='string'||!hold.by.trim()||hold.by.length>120||typeof hold.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(hold.at)||!Number.isFinite(Date.parse(hold.at))||hold.id!==o.carrier?.holdId)throw Error('current supported QA hold identity differs');
   if(hold.held)throw Error('QA hold is on');
   if(!Array.isArray(issue?.labels)||issue.labels.length>=100)throw Error('release issue labels are unavailable or truncated');
   if(issue.labels.some(heldLabel))throw Error('release board has an explicit QA hold');
   if(hold.legacy_issue!==null && hold.legacy_issue!==1192){
    if(!Number.isSafeInteger(hold.legacy_issue)||Number(hold.legacy_issue)<1)throw Error('legacy hold identity unavailable');
    const legacy=await api(`issues/${hold.legacy_issue}`);
    if(!Array.isArray(legacy?.labels)||legacy.labels.some(heldLabel))throw Error('legacy release hold is on or unavailable');
   }
   return {id:hold.id,held:false,board:1192};
  }),
  check('PR checks',async()=>{
   const c=o.carrier;if(!c||c.day!==day)throw Error('current-day accepted batch carrier is missing');
   const [pull,ref,commit,checks]=await Promise.all([api(`pulls/${c.pr}`),api('git/ref/heads/QA'),api(`git/commits/${c.revision}`),api(`commits/${c.revision}/check-runs?per_page=100`)]);
   if(pull?.state!=='open'||pull.draft!==false||pull?.head?.sha!==c.revision||pull?.head?.ref!==c.ref||pull?.base?.ref!=='QA'||pull?.head?.repo?.full_name!==repo||pull?.base?.repo?.full_name!==repo||pull.mergeable!==true||pull.mergeable_state!=='clean'||ref?.object?.sha!==c.base||commit?.tree?.sha!==c.tree)throw Error('batch carrier head, base, tree or merge readiness changed');
   if(!Array.isArray(checks?.check_runs)||checks.check_runs.length>=100||checks.total_count!==checks.check_runs.length)throw Error('exact-head required checks unavailable or truncated');
   for(const name of ['Verify','Secret scan','Release hold']){
    const found=checks.check_runs.filter((r:any)=>r.name===name&&r.app?.slug==='github-actions').sort((a:any,b:any)=>b.id-a.id);
    if(!found[0]||found[0].head_sha!==c.revision||found[0].status!=='completed'||found[0].conclusion!=='success')throw Error(`${name} is not successful on the exact carrier head`);
   }
   return {pr:c.pr,head:c.revision,base:c.base,tree:c.tree,required:['Verify','Secret scan','Release hold']};
  }),
 ]);
 report.ready=report.missing.length===0;
 return report;
}

// The report retains the scheduled 19:00 admission time. Slow read completion
// may queue its alert until 19:50; a new later invocation gains no admission.
// The same Alido Mail outbox/day ID retain delivery across process crashes.
// Dry-runs/rehearsals never call this function.
export function releasePreflightAlert(s:Store,r:ReleaseReadiness,now=Date.now(),path=mailPath()) {
 if(r.ready||!r.missing.length)return {queued:false};
 if(!Number.isSafeInteger(r.at)||!Number.isSafeInteger(now)||now<r.at)throw Error('preflight alert is only admitted at 19:00');
 const admitted=toronto(r.at),current=toronto(now);
 if(admitted.day!==r.day||admitted.minute!==1140||current.day!==r.day||current.minute>=1190)throw Error('preflight alert is only admitted at 19:00 and must finish before 19:50');
 const id=`release-preflight-missing:${r.day}`;
 if(s.get(id))return {queued:false,id};
 const names:Record<string,string>={
  'fresh billing':'a fresh AWS bill reading','billing and factory state':'the billing and factory checks',
  'factory state':'the factory to be ready','AWS sign-in':'an AWS sign-in lasting past 10:30 PM',
  'disk space':'enough disk space','quality qualification':'a qualified independent tester',
  'release qualification':'a qualified release runner','quality usage':'a fresh usage reading for the tester',
  'release usage':'a fresh usage reading for the release runner','hosted acceptance path':'working browser tests and acceptance',
  'Quality runner':'an available independent tester','release holds':'the release holds resolved',
  'PR checks':"passing checks for tonight's changes",'preflight checks':'working release checks',
  'release configuration':'a working release setup',
 };
 const labels=[...new Set(r.missing.map(m=>names[m.input]??m.input))];
 const plain=`Tonight's release needs ${labels.join(', ')} before it can run.`;
 const summary=plain.length<=120?plain:"Tonight's release has missing inputs.";
 const body=plain.length<=120?'':plain.slice(0,790);
 if(!existsSync(path))throw Error('existing Alido Mail outbox is unavailable');
 const db=new Database(path,{readwrite:true,strict:true});
 try{
  db.exec('PRAGMA busy_timeout=10000');
  db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
   VALUES(?,?,?,'Release','codex','factory-release-preflight','Vincent','telegram','blocker','none',?,?,?,0,?,'unread','pending')`)
   .run(id,id,now,summary,body,id,createHash('sha256').update(summary+'\n'+body).digest('hex'));
 }finally{db.close();}
 s.set(id,{queuedAt:now,path});
 s.event(id,'release-preflight-alert',{day:r.day,missing:r.missing},'Retain the single Alido Mail receipt; correct inputs before the fixed release window',now);
 return {queued:true,id};
}
