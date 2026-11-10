import {readFileSync} from 'node:fs';
import {releaseAvailable} from '../wallet/release';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {configAt,inputs,root} from '../launcher/config';
import {ReleaseExecutor,toronto} from '../launcher/release';
import {AlidoReleasePort} from '../adapters/release';
import {releaseBilling} from '../adapters/billing';
import {observeBilling} from '../wallet/ledger';
import {awsRefusal,debit} from '../wallet/ledger';
const stage=process.argv[2];
if(!['preflight','qa','production','reconcile','dry-run'].includes(stage))throw Error('release preflight|qa|production|reconcile|dry-run');
const s=new Store(join(root,'controller.sqlite'));
try {
 const c=await configAt(join(root,'config.yaml'));
 const policy=()=>Bun.YAML.parse(readFileSync(join(root,'config.yaml'),'utf8'));
 const funds=(now:number)=>releaseAvailable(s,c,admittedBilling,policy(),now);
 const port=new AlidoReleasePort();
 const minute=toronto(Date.now()).minute;
 if(stage==='reconcile' && minute>=1080 && minute<1140 && s.get('aws-stop-latched')!==true){
  const attempt=s.get<number>('release-billing-refresh-at')??0;
  if(Date.now()-attempt>=300000){
   s.set('release-billing-refresh-at',Date.now());
   try {const b=await releaseBilling(root);observeBilling(s,c,b,Date.now());s.event(`billing-import:${b.receipt}`,'billing-import',b,'Retain source receipts; correct through a fresh import');}
   catch(error){s.event(`billing-import-failure:${Date.now()}`,'billing-import-failure',{error:String(error)},'Retry read-only import before the next window');}
  }
 }
 let admittedBilling=(await inputs(root)).billing;
 const executor=new ReleaseExecutor(s,port,async()=>{
  if(s.get('aws-stop-latched')===true)return 'AWS stop latched';
  if(s.get('paused')!==false)return 'factory paused';
  const now=Date.now();
  try {admittedBilling=await releaseBilling(root,now);}catch(error){return `billing refresh failed: ${String(error)}`;}
  if(stage!=='dry-run')observeBilling(s,c,admittedBilling,now);
  const reason=awsRefusal(s,c,now,admittedBilling);
  if(reason)return reason;
  // Each remote admission reserves a conservative dollar. Existing holds/caps apply.
  if(funds(now)<100)return 'release wallet insufficient';
  return null;
 },Date.now,id=>{
  const now=Date.now();if(awsRefusal(s,c,now,admittedBilling)||funds(now)<100)throw Error('wallet changed before reservation');
  debit(s,id,'aws',100,now);
 });
 if(stage==='dry-run')console.log(JSON.stringify({effects:false,snapshot:await port.snapshot(),brake:await executor.brake()}));
 else console.log(JSON.stringify(await executor.run(stage as 'preflight'|'qa'|'production'|'reconcile')));
}catch(error){
 const {day}=toronto(Date.now());s.event(`executor-cli:${day}:${stage}:${String(error)}`,'release-executor-refusal',{stage,error:String(error)},'Retain refusal; reconcile configuration before the next scheduled window');
 console.error(String(error));process.exitCode=1;
}finally{s.close();}
