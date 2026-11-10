import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {command} from '../adapters/github';
import type {Store} from '../tracking/store';
import {mailPath} from './alerts';
import {toronto,type Acceptance,type ReleaseContext} from './release';

type Effect={state:string;context:ReleaseContext;evidence?:Record<string,unknown>};
export type QaServerStates={observedAt:number;ec2:string;rds:string;evidence:string};
export type QaServerTarget={profile:string;region:string;instance:string;database:string};
export type ReleaseResultOptions={now?:number;path?:string;observeServers?:()=>Promise<QaServerStates>};
const undo='Retain the daily result, AWS observations and existing Telegram outbox receipt. Correct through new evidence; never replay the result.';

// An exact read-only target comes from the private installation. This observer
// has no resource start/stop, sign-in or credential-renewal operation.
export async function readQaServerStates(target:QaServerTarget,execute=command):Promise<QaServerStates> {
 if(!target.profile||!target.region||!/^i-[a-f0-9]+$/.test(target.instance)||!target.database)throw Error('QA resource target missing');
 const args=['--profile',target.profile,'--region',target.region,'--output','json'];
 const [ec2,rds]=await Promise.all([
  execute(['aws','ec2','describe-instances',...args,'--instance-ids',target.instance,'--query','Reservations[].Instances[].[InstanceId,State.Name]'],undefined,10000),
  execute(['aws','rds','describe-db-instances',...args,'--db-instance-identifier',target.database,'--query','DBInstances[].[DBInstanceIdentifier,DBInstanceStatus]'],undefined,10000),
 ]);
 const vm=JSON.parse(ec2),database=JSON.parse(rds);
 if(!Array.isArray(vm)||vm.length!==1||!Array.isArray(vm[0])||vm[0].length!==2||vm[0][0]!==target.instance||typeof vm[0][1]!=='string'||!Array.isArray(database)||database.length!==1||!Array.isArray(database[0])||database[0].length!==2||database[0][0]!==target.database||typeof database[0][1]!=='string')throw Error('Exact QA server state readback unavailable');
 return {observedAt:Date.now(),ec2:vm[0][1],rds:database[0][1],evidence:'AWS EC2 DescribeInstances and RDS DescribeDBInstances for exact private QA targets'};
}

function outcome(s:Store,day:string) {
 const effect=(step:string)=>s.get<Effect>(`executor:${day}:${step}`);
 const preflight=effect('preflight'),qa=effect('qa'),promote=effect('promote'),readback=effect('readback');
 const accepted=s.get<Acceptance>(`executor:${day}:acceptance`);
 const same=(e:Effect| null)=>e?.context.day===day&&e.context.tree===qa?.context.tree&&e.context.revision===qa?.context.revision;
 const bound=typeof qa?.context.revision==='string'&&/^[a-f0-9]{40}$/.test(qa.context.revision)&&typeof qa.context.tree==='string'&&/^[a-f0-9]{40}$/.test(qa.context.tree)&&typeof accepted?.artifact==='string'&&/@sha256:[a-f0-9]{64}$/.test(accepted.artifact)&&typeof accepted.native==='string'&&!!accepted.native.trim()&&Number.isSafeInteger(accepted.at)&&accepted.at>=Number(qa.evidence?.completedAt??Infinity)&&accepted.at<qa.context.deadline;
 const shipped=bound&&qa?.state==='success'&&promote?.state==='success'&&readback?.state==='success'&&same(promote)&&same(readback)&&accepted?.verdict==='ACCEPT'&&accepted.day===day&&accepted.tree===qa.context.tree&&accepted.revision===qa.context.revision&&accepted.artifact===qa.evidence?.artifact&&promote.evidence?.artifact===accepted.artifact&&readback.evidence?.artifact===accepted.artifact&&typeof promote.evidence?.main==='string'&&promote.evidence.main===readback.evidence?.main;
 if(shipped)return {shipped:true,reason:'Production deployment and readback passed'};
 if(readback)return {shipped:false,reason:readback.state==='failure'?'Production verification failed':'Production verification is unconfirmed'};
 if(promote)return {shipped:false,reason:promote.state==='failure'?'Production promotion failed':'Production deployment is unconfirmed'};
 if(qa?.state==='success')return {shipped:false,reason:accepted?.verdict==='REJECT'?'the independent tester rejected the release':accepted?.verdict==='ACCEPT'?'Production promotion did not complete':'independent acceptance was missing or late'};
 if(qa)return {shipped:false,reason:qa.state==='failure'?'hosted QA checks failed':'hosted QA completion is unconfirmed'};
 const report=s.get<{ready?:boolean;missing?:{input:string}[]}>(`release-preflight-report:${day}`);
 const missing=report?.missing?.map(m=>m.input)??[];
 if(missing.some(m=>/qualification|hosted acceptance|Quality runner/.test(m)))return {shipped:false,reason:'a qualified independent acceptance path was unavailable'};
 if(missing.some(m=>/billing|factory state/.test(m)))return {shipped:false,reason:'billing or factory readiness checks failed'};
 if(missing.includes('AWS sign-in'))return {shipped:false,reason:'AWS sign-in did not cover the release window'};
 if(missing.includes('disk space'))return {shipped:false,reason:'disk space checks failed'};
 if(missing.includes('release holds'))return {shipped:false,reason:'the release was held'};
 if(missing.includes('PR checks'))return {shipped:false,reason:'the changes did not pass release checks'};
 if(s.get('aws-stop-latched')===true)return {shipped:false,reason:'the AWS spending stop was on'};
 if(s.get('paused')!==false)return {shipped:false,reason:'the factory was paused'};
 if(preflight)return {shipped:false,reason:preflight.state==='failure'?'release preflight failed':'the QA merge or deployment did not complete'};
 return {shipped:false,reason:missing.length?'release readiness checks failed':'the scheduled release did not run'};
}

// Call from the existing observer's finally block, before closing its Store,
// even when configuration/readiness/reconciliation fails. Never call from a
// dry-run or rehearsal. No alert is queued before the release deadline.
export async function releaseWindowResult(s:Store,o:ReleaseResultOptions={}) {
 const now=o.now??Date.now(),{day,minute}=toronto(now),id=`release-window-result:${day}`;
 if(minute<1320||s.get(id))return {queued:false};
 const result=outcome(s,day);
 let servers:QaServerStates|undefined,error:string|undefined;
 try{
  if(!o.observeServers)throw Error('QA resource observer unavailable');
  servers=await o.observeServers();
  if(!Number.isSafeInteger(servers.observedAt)||servers.observedAt>now+30000||servers.observedAt<now-60000||!servers.evidence?.trim()||!servers.ec2||!servers.rds)throw Error('Fresh QA resource readback unavailable');
 }catch(failure){error=String(failure);servers=undefined;}
 const stopped=servers?.ec2==='stopped'&&servers.rds==='stopped';
 const serverText=stopped?'QA servers stopped: yes.':servers?'QA servers stopped: no.':'QA servers stopped: no, stop could not be confirmed.';
 const plain=`${result.shipped?'Shipped.':`Not shipped because ${result.reason}.`} ${serverText}`;
 const summary=plain.length<=120?plain:result.shipped?'Shipped.':`Not shipped because ${result.reason}.`;
 const body=plain.length<=120?'':serverText;
 const path=o.path??mailPath();
 if(!existsSync(path))throw Error('existing Alido Mail outbox is unavailable');
 const db=new Database(path,{readwrite:true,strict:true});
 try{
  db.exec('PRAGMA busy_timeout=10000');
  db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
   VALUES(?,?,?,'Release','codex','factory-release-result','Vincent','telegram','handoff','none',?,?,?,0,?,'unread','pending')`)
   .run(id,id,now,summary,body,id,createHash('sha256').update(summary+'\n'+body).digest('hex'));
 }finally{db.close();}
 const receipt={queuedAt:now,path,...result,stopped,servers:servers??null,...(error?{error}:{})};
 s.set(id,receipt);s.event(id,'release-window-result',receipt,undo,now);
 return {queued:true,id,...result,stopped};
}
