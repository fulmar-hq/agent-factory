import {createHash} from 'node:crypto';
import {command} from './github';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,openSync,closeSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {root} from '../launcher/config';
import {carrierIdentity,type ReleaseBatch} from '../launcher/release-batch';

export type ReleaseStep = 'preflight'|'freeze'|'qa'|'promote'|'readback';
export type ReleaseContext = {day:string;revision:string;tree:string;holdId:string;deadline:number;acceptance?:object;batch?:ReleaseBatch;readiness?:object};
export type ReleaseObservation = {state:'pending'|'success'|'failure';evidence:Record<string,unknown>};
export interface ReleasePort {
 snapshot():Promise<{revision:string;tree:string;holdId:string;held:boolean;overlap:boolean}>;
 perform(step:ReleaseStep,context:ReleaseContext):Promise<Record<string,unknown>>;
 observe(step:ReleaseStep,context:ReleaseContext,handle:Record<string,unknown>):Promise<ReleaseObservation>;
}
const REPO='fulmar-hq/alido', WORKFLOW='factory-release.yml';
const MARKER='factory-release-contract: tree-deadline-v1';
const sha=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
// No Mini AWS profile, credential renewal or shell fallback. A missing protected
// remote executor is a refusal, never permission to use a weaker release path.
export class AlidoReleasePort implements ReleasePort {
 constructor(private execute=command,private now=Date.now,private local:LocalReleaseEffects=localReleaseEffects,private batch?:ReleaseBatch,private readiness?:object) {}
 private async api(path:string,method='GET',fields:string[]=[]):Promise<any> {
  return JSON.parse(await this.execute(['gh','api','--method',method,`repos/${REPO}/${path}`,...fields]) || 'null');
 }
 private async runs(branch:string,status:string){
  const all:any[]=[],ids=new Set<number>();
  for(let page=1;page<=20;page++){
   const value=await this.api(`actions/runs?branch=${branch}&status=${status}&per_page=100&page=${page}`),rows=value?.workflow_runs;
   if(!Array.isArray(rows))throw Error('Release run inventory incomplete');
   for(const run of rows){if(!Number.isSafeInteger(run.id)||ids.has(run.id))throw Error('Changing release run inventory');ids.add(run.id);all.push(run);}
   if(rows.length<100)return {workflow_runs:all};
  }
  throw Error('Release run inventory exceeds bound');
 }
 async snapshot() {
  const [ref,variable,pulls,runs]=await Promise.all([
   this.api('git/ref/heads/QA'),this.api('actions/variables/QA_HOLD'),
   this.api('pulls?state=open&base=main&per_page=100'), Promise.all(['requested','queued','in_progress','waiting','pending'].flatMap(status=>['QA','main'].map(branch=>this.runs(branch,status))))]);
  let revision=ref?.object?.sha;
  if(!sha(revision))throw Error('QA revision unverified');
  if(this.batch){
   const pull=await this.api(`pulls/${this.batch.pr}`);carrierIdentity(this.batch,pull);
   if(pull.merged===true){if(pull.merge_commit_sha!==revision)throw Error('Merged carrier no longer current QA');}
   else {if(pull.state!=='open'||revision!==this.batch.base)throw Error('Carrier base changed');revision=this.batch.revision;}
  }
  const commit=await this.api(`git/commits/${revision}`),tree=commit?.tree?.sha;
  const hold=JSON.parse(variable?.value ?? 'null');
  if(!sha(tree)||!record(hold)||typeof hold.id!=='string'||typeof hold.held!=='boolean')throw Error('QA tree/hold unverified');
  if(!Array.isArray(pulls)||pulls.length===100||!Array.isArray(runs)||runs.some(page=>!Array.isArray(page?.workflow_runs)))throw Error('Release inventory incomplete');
  if(this.batch&&tree!==this.batch.tree)throw Error('Carrier tree changed');
  const overlap=pulls.some((p:any)=>p.head?.ref==='QA')||runs.flatMap(page=>page.workflow_runs).some((r:any)=>
   ['requested','queued','in_progress','waiting','pending'].includes(r.status) &&
   ['.github/workflows/deploy.yml','.github/workflows/ci.yml',`.github/workflows/${WORKFLOW}`].includes(r.path) &&
   ['QA','main'].includes(r.head_branch) && (r.path!=='.github/workflows/ci.yml'||r.event==='push'));
  return {revision,tree,holdId:hold.id,held:hold.held,overlap};
 }
 private validate(c:ReleaseContext) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.day)||!sha(c.revision)||!sha(c.tree)||!c.holdId||!Number.isSafeInteger(c.deadline))throw Error('Invalid frozen release context');
  if(this.now()>=c.deadline)throw Error('Release effect deadline expired');
 }
 async perform(step:ReleaseStep,c:ReleaseContext) {
  this.validate(c);
  const branch=step==='readback'?'main':this.batch&&['preflight','qa'].includes(step)?this.batch.ref:'QA';
  const ref=await this.api(`git/ref/heads/${branch}`),source=ref?.object?.sha;
  if(!sha(source))throw Error('Protected executor source missing');
  if(step!=='readback'){
   if(source!==c.revision)throw Error('Protected QA executor revision changed');
   const commit=await this.api(`git/commits/${source}`);
   if(commit?.tree?.sha!==c.tree)throw Error('Protected QA executor tree changed');
  }
  const file=await this.api(`contents/.github/workflows/${WORKFLOW}?ref=${source}`);
  const body=typeof file?.content==='string'?Buffer.from(file.content,'base64').toString('utf8'):'';
  if(!body.includes(`# ${MARKER}`)||!body.includes('workflow_dispatch:'))throw Error('Protected tree/deadline release workflow not delivered; refuse effect');
  const key=createHash('sha256').update(JSON.stringify([c.day,step,c.revision,c.tree])).digest('hex');
  this.validate(c); // Source discovery must not consume the remaining effect window.
  if(step!=='readback')return this.local.start(step,{...c,...(this.batch&&step!=='promote'?{batch:this.batch}:{}),...(step==='preflight'&&this.readiness?{readiness:this.readiness}:{})},key,source,this.now());
  await this.api(`actions/workflows/${WORKFLOW}/dispatches`,'POST',[
   '-f','ref=main','-f',`inputs[executor_source]=${source}`,'-f',`inputs[step]=${step}`,'-f',`inputs[day]=${c.day}`,
   '-f',`inputs[revision]=${c.revision}`,'-f',`inputs[tree]=${c.tree}`,
   '-f',`inputs[hold_id]=${c.holdId}`,'-f',`inputs[deadline]=${c.deadline}`,
   '-f',`inputs[key]=${key}`,'-f',`inputs[acceptance]=${JSON.stringify(c.acceptance??{})}`]);
  return {key,source,workflow:WORKFLOW,dispatchedAt:this.now()};
 }
 async observe(step:ReleaseStep,c:ReleaseContext,h:Record<string,unknown>):Promise<ReleaseObservation> {
  if(h.local===true)return this.local.observe(step,c,h,this.now());
  if(!sha(h.source)||typeof h.key!=='string'||!/^[a-f0-9]{64}$/.test(h.key)||h.workflow!==WORKFLOW||!Number.isSafeInteger(h.dispatchedAt))return {state:'failure',evidence:{reason:'Invalid remote effect handle'}};
  const data=await this.api(`actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&head_sha=${h.source}&per_page=100`);
  if(!Array.isArray(data?.workflow_runs)||data.workflow_runs.length===100)return {state:'failure',evidence:{reason:'Remote effect inventory incomplete'}};
  const found=data.workflow_runs.filter((r:any)=>r.display_title===`factory-release ${h.key}`);
  if(found.length===0)return {state:'pending',evidence:{key:h.key,reason:'Dispatch outcome not yet observed; never redispatch'}};
  if(found.length!==1)return {state:'failure',evidence:{reason:'Duplicate remote release effects',key:h.key}};
  const run=found[0];
  if(run.head_sha!==h.source||run.event!=='workflow_dispatch'||run.path!==`.github/workflows/${WORKFLOW}`||run.run_attempt!==1)return {state:'failure',evidence:{reason:'Remote release identity/attempt differs',run:run.id}};
  if(run.status!=='completed')return {state:'pending',evidence:{run:run.id,status:run.status}};
  if(run.conclusion!=='success')return {state:'failure',evidence:{run:run.id,conclusion:run.conclusion}};
  const log=await this.execute(['gh','run','view',String(run.id),'--repo',REPO,'--log']);
  const receipts=log.split('\n').filter(line=>line.includes('FACTORY_RELEASE_RECEIPT ')).map(line=>JSON.parse(line.split('FACTORY_RELEASE_RECEIPT ')[1]??'null'));
  if(receipts.length!==1)return {state:'failure',evidence:{reason:'Unique native release receipt missing',run:run.id}};
  const receipt=receipts[0];
  if(!record(receipt)||receipt.version!==1||receipt.key!==h.key||receipt.step!==step||receipt.day!==c.day||receipt.revision!==c.revision||receipt.tree!==c.tree||receipt.status!=='success'||!Number.isSafeInteger(receipt.completedAt)||Number(receipt.completedAt)>c.deadline||Number(receipt.completedAt)<Number(h.dispatchedAt)||Number(receipt.completedAt)>this.now())return {state:'failure',evidence:{reason:'Native release receipt differs from frozen context/deadline',run:run.id}};
  const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
  const artifact=(v:unknown)=>typeof v==='string' && /@sha256:[a-f0-9]{64}$/.test(v);
  let proof=false;
  if(step==='preflight')proof=positive(receipt.preflightRun);
  else if(step==='qa')proof=artifact(receipt.artifact)&&positive(receipt.qaRun)&&receipt.holdId===c.holdId;
  else if(step==='promote')proof=sha(receipt.main)&&positive(receipt.promotion)&&artifact(receipt.artifact);
  else if(step==='readback'){
   const readback=receipt.readback,containers=record(readback)?readback.containers:null;
   proof=sha(receipt.main)&&positive(receipt.deployRun)&&record(readback)&&typeof readback.command==='string'&&record(containers)&&Object.keys(containers).sort().join(',')==='alido-web,alido-worker'&&Object.values(containers).every(x=>record(x)&&x.source===receipt.main&&x.running===true&&x.health==='healthy'&&x.restarts===0)&&artifact(receipt.artifact);
  }
  if(!proof)return {state:'failure',evidence:{reason:'Required native operation proof missing',run:run.id}};
  return {state:'success',evidence:{...receipt,run:run.id,executorSource:h.source}};
 }
}

export interface LocalReleaseEffects {
 start(step:ReleaseStep,c:ReleaseContext,key:string,source:string,now:number):Promise<Record<string,unknown>>;
 observe(step:ReleaseStep,c:ReleaseContext,h:Record<string,unknown>,now:number):Promise<ReleaseObservation>;
}
const effectsRoot=resolve(root,'runs','release-effects');
const localReleaseEffects:LocalReleaseEffects={
 async start(step,c,key,source,now){
  if(step==='readback'||step==='freeze')throw Error('Unsupported local release operation');
  mkdirSync(effectsRoot,{recursive:true,mode:0o700});
  const dir=join(effectsRoot,key);mkdirSync(dir,{mode:0o700}); // Exclusive retained custody, never reuse.
  const context=join(dir,'context.json'),result=join(dir,'result.json'),log=join(dir,'effect.log');
  writeFileSync(context,JSON.stringify({...c,step,key,scratch:dir,hold_id:c.holdId,executor_source:source,dispatched_at:new Date(now).toISOString()}),{mode:0o600,flag:'wx'});
  const fd=openSync(log,'ax',0o600);
  try {
   const env=Object.fromEntries(['HOME','PATH','LANG','TZ','GH_HOST','GH_CONFIG_DIR'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
   const child=spawn('/usr/bin/python3',['-I','-B',resolve(import.meta.dir,'../scripts/alido-release.py'),context,result],{env,stdio:['ignore',fd,fd],detached:true});
   await new Promise<void>((ok,no)=>{child.once('spawn',ok);child.once('error',no);});
   child.unref();
   return {local:true,key,source,step,dir,dispatchedAt:now,pid:child.pid};
  }finally{closeSync(fd);}
 },
 async observe(step,c,h,now){
  if(typeof h.key!=='string'||!/^[a-f0-9]{64}$/.test(h.key)||h.dir!==join(effectsRoot,h.key)||h.step!==step||!Number.isSafeInteger(h.dispatchedAt))return {state:'failure',evidence:{reason:'Invalid local custody handle'}};
  const result=join(String(h.dir),'result.json');
  if(!existsSync(result))return {state:'pending',evidence:{reason:'Retained local effect not terminal; never replay',pid:h.pid}};
  const value=JSON.parse(readFileSync(result,'utf8'));
  if(value.state==='failure')return {state:'failure',evidence:value.evidence};
  const r=value.evidence;
  if(value.state!=='success'||!record(r)||r.version!==1||r.key!==h.key||r.step!==step||r.day!==c.day||r.revision!==c.revision||r.tree!==c.tree||r.status!=='success'||!Number.isSafeInteger(r.completedAt)||Number(r.completedAt)<Number(h.dispatchedAt)||Number(r.completedAt)>now||Number(r.completedAt)>=c.deadline)return {state:'failure',evidence:{reason:'Local native receipt differs'}};
  const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
  const artifact=(v:unknown)=>typeof v==='string'&&/@sha256:[a-f0-9]{64}$/.test(v);
  const proof=step==='preflight'?(positive(r.preflightRun)||r.readiness===true):step==='qa'?positive(r.qaRun)&&artifact(r.artifact)&&typeof r.holdId==='string'&&record(r.qaReadback)&&r.qaReadback.source===(c.batch?r.qaRevision:c.revision)&&(!c.batch||sha(r.qaRevision)):step==='promote'?sha(r.main)&&positive(r.promotion)&&artifact(r.artifact):false;
  if(!proof)return {state:'failure',evidence:{reason:'Local native operation proof missing'}};
  return {state:'success',evidence:{...r,executorSource:h.source,localReceipt:result}};
 }
};
