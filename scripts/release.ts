import {requestFreezeProof} from '../launcher/release-freeze-proof';
import {watchReleasePause} from '../launcher/release-pause';
import {recordRehearsal} from '../launcher/release-rehearsal';
import {withReleaseAuth} from '../launcher/release-auth';
import {readFileSync} from 'node:fs';
import {dispatchReleaseQuality} from '../launcher/release-quality-dispatch';
import {releaseWindowResult,readQaServerStates} from '../launcher/release-result';
import {releaseAvailable,observeReleaseBilling} from '../wallet/release';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {configAt,inputs,root} from '../launcher/config';
import {ReleaseExecutor,toronto,deadlineAt} from '../launcher/release';
import {AlidoReleasePort} from '../adapters/release';
import {releaseBilling} from '../adapters/billing';
import {awsRefusal,debit} from '../wallet/ledger';
import {command} from '../adapters/github';
import {localReadings,claudeStatus} from '../adapters/usage';
import {readReleaseBatch,type ReleaseBatch} from '../launcher/release-batch';
import {collectReleaseReadiness,releasePreflightAlert,type ReleaseReadiness} from '../launcher/release-readiness';
const stage=process.argv[2];
const rehearsal=stage==='rehearsal';
const rehearsalSlot=process.argv[3]??'14:00';
if(rehearsal&&!['14:00','17:40'].includes(rehearsalSlot))throw Error('rehearsal slot must be 14:00 or 17:40');
const invokedAt=Date.now();
if(!['preflight','qa','production','reconcile','dry-run','rehearsal','freeze-start'].includes(stage))throw Error('release preflight|qa|production|reconcile|dry-run');
const s=new Store(join(root,'controller.sqlite'));
try {
 const installedSource=()=>command(['git','rev-parse','HEAD'],import.meta.dir+'/..');
 if(stage==='freeze-start'){
  const proof=await requestFreezeProof(s,root,installedSource);watchReleasePause(s,root);
  console.log(JSON.stringify({effects:false,proof}));
 }else{
 if(stage==='reconcile')await requestFreezeProof(s,root,installedSource);
 const c=await configAt(join(root,'config.yaml'));
 const policy=()=>Bun.YAML.parse(readFileSync(join(root,'config.yaml'),'utf8'));
 const funds=(now:number)=>releaseAvailable(s,c,admittedBilling,policy(),now);
 const minute=toronto(Date.now()).minute;
 if(stage==='reconcile' && minute>=1080 && minute<1140 && s.get('aws-stop-latched')!==true){
  const attempt=s.get<number>('release-billing-refresh-at')??0;
  if(Date.now()-attempt>=300000){
   s.set('release-billing-refresh-at',Date.now());
   try {const b=await withReleaseAuth(root,()=>releaseBilling(root));observeReleaseBilling(s,c,b,Date.now());s.event(`billing-import:${b.receipt}`,'billing-import',b,'Retain source receipts; correct through a fresh import');}
   catch(error){s.event(`billing-import-failure:${Date.now()}`,'billing-import-failure',{error:String(error)},'Retry read-only import before the next window');}
  }
 }
 let admittedBilling=(await inputs(root)).billing;
 const brake=async()=>{
  if(s.get('aws-stop-latched')===true)return 'AWS stop latched';
  if(s.get('paused')!==false)return 'factory paused';
  const now=Date.now();
  try {admittedBilling=await withReleaseAuth(root,()=>releaseBilling(root,now));}catch(error){return `billing refresh failed: ${String(error)}`;}
  if(stage!=='dry-run')observeReleaseBilling(s,c,admittedBilling,now);
  const reason=awsRefusal(s,c,now,admittedBilling);
  if(reason)return reason;
  // Each remote admission reserves a conservative dollar. Existing holds/caps apply.
  if(funds(now)<100)return 'release wallet insufficient';
  return null;
 };
 let batch:ReleaseBatch|undefined,readiness:ReleaseReadiness|undefined;
 if(stage!=='reconcile'){
  try{batch=readReleaseBatch(root,toronto(Date.now()).day);}catch(error){if(stage==='production')throw error;}
 }
 if(rehearsal||stage==='dry-run'||stage==='preflight'&&minute===1140||stage==='qa'&&minute===1200){
  let billingRefusal:string|null=null;
  try{admittedBilling=await withReleaseAuth(root,()=>releaseBilling(root));const now=Date.now();if(rehearsal){observeReleaseBilling(s,c,admittedBilling,now);s.event(`billing-rehearsal:${now}`,'billing-import',admittedBilling,'Retain AWS source age and refresh receipt');}billingRefusal=awsRefusal(s,c,rehearsal?Math.max(now,deadlineAt(now,1140)):now,admittedBilling);if(!billingRefusal&&funds(now)<100)billingRefusal='release wallet insufficient';}
  catch(error){billingRefusal=String(error);}
  // Billing is collected even when pause or STOP independently refuses starts.
  const factorySource=(await command(['git','rev-parse','HEAD'],import.meta.dir+'/..')).trim();
  const [readings,quota]=await Promise.all([localReadings(),claudeStatus()]);
  if(quota&&(!readings.claude||quota.observedAt>readings.claude.observedAt))readings.claude=quota;
  readiness=await collectReleaseReadiness({dir:root,config:c,store:s,brake:rehearsal?(s.get('aws-stop-latched')===true?'AWS stop latched':s.get('paused')!==false?'factory paused':null):await brake(),carrier:batch,billingRefusal,billingEvidence:admittedBilling,factorySource,readings});
  if(rehearsal){recordRehearsal(s,readiness,rehearsalSlot as '14:00'|'17:40');console.log(JSON.stringify({effects:false,slot:rehearsalSlot,readiness}));}
  if(stage==='preflight')readiness.at=invokedAt;
  if(stage==='preflight'){
   s.event(`release-readiness:${readiness.day}`,'release-readiness',readiness,'Retain the preflight report; correct missing inputs before the next fixed window');
   s.set(`release-preflight-report:${readiness.day}`,readiness);
   releasePreflightAlert(s,readiness);
  }
  if(!rehearsal&&stage!=='dry-run'&&!readiness.ready){console.log(JSON.stringify({state:'refused',readiness}));process.exitCode=1;}
 }
 const port=new AlidoReleasePort(undefined,Date.now,undefined,batch,readiness);
 const executor=new ReleaseExecutor(s,port,brake,Date.now,id=>{
  const now=Date.now();if(awsRefusal(s,c,now,admittedBilling)||funds(now)<100)throw Error('wallet changed before reservation');
  debit(s,id,'aws',100,now);
 },batch,w=>{dispatchReleaseQuality(s,w,root);});
 if(stage==='reconcile'&&minute>=1140&&minute<1190){
  const pending=s.get<ReleaseReadiness>(`release-preflight-report:${toronto(Date.now()).day}`);
  if(pending&&!pending.ready)try{releasePreflightAlert(s,pending);}
  catch(error){s.event(`executor-alert-retry:${pending.day}`,'release-preflight-alert-failure',{error:String(error)},'Restore existing Alido Mail; reconciliation retries the same stable alert ID before19:50');}
 }
 if(stage==='dry-run')console.log(JSON.stringify({effects:false,snapshot:await port.snapshot(),readiness}));
 else if(!rehearsal&&process.exitCode!==1){
  const result=await executor.run(stage as 'preflight'|'qa'|'production'|'reconcile');
  if(stage==='preflight'&&toronto(invokedAt).minute===1140&&['refused','skipped'].includes(result.state)){
   const failed={day:toronto(invokedAt).day,at:invokedAt,validThrough:invokedAt,ready:false,missing:[{input:'preflight checks',reason:JSON.stringify(result)}],evidence:{result}};
   s.set(`release-preflight-report:${failed.day}`,failed);releasePreflightAlert(s,failed);
  }
  console.log(JSON.stringify(result));
 }
}
}catch(error){
 const {day}=toronto(Date.now());s.event(`executor-cli:${day}:${stage}:${String(error)}`,'release-executor-refusal',{stage,error:String(error)},'Retain refusal; reconcile configuration before the next scheduled window');
 if(rehearsal){
  const failed={day:toronto(invokedAt).day,at:invokedAt,validThrough:invokedAt,ready:false,missing:[{input:'release configuration',reason:String(error)}],evidence:{error:String(error)}};
  try{recordRehearsal(s,failed,rehearsalSlot as '14:00'|'17:40');}catch(mailError){s.event(`rehearsal-mail-failed:${invokedAt}`,'release-rehearsal-alert-failure',{error:String(mailError)},'Restore mail and retry the same rehearsal gap IDs');}
 }
 if(stage==='preflight'&&toronto(invokedAt).minute===1140){
  const failed={day:toronto(invokedAt).day,at:invokedAt,validThrough:invokedAt,ready:false,missing:[{input:'release configuration',reason:String(error)}],evidence:{error:String(error)}};
  s.set(`release-preflight-report:${failed.day}`,failed);
  try{releasePreflightAlert(s,failed);}
  catch(alertError){s.event(`executor-alert-failed:${day}`,'release-preflight-alert-failure',{error:String(alertError)},'Restore existing Alido Mail outbox; retain failed delivery evidence');}
 }
 console.error(String(error));process.exitCode=1;
}finally{
 if(stage==='reconcile')try{
  watchReleasePause(s,root);
  await releaseWindowResult(s,{observeServers:()=>withReleaseAuth(root,()=>readQaServerStates({profile:'fisher-acc030',region:'ca-central-1',instance:'i-063943f2f032b2903',database:'alido-qa-db'}))});
 }catch(error){s.event(`release-result-failure:${toronto(Date.now()).day}`,'release-window-result-failure',{error:String(error)},'Restore existing outbox; observer retries the stable daily result');}
 s.close();
}
