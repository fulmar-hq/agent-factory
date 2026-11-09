import {join} from 'node:path';
import {Store} from '../tracking/store';
import {configAt,inputs,root} from '../launcher/config';
import {ReleaseExecutor,toronto} from '../launcher/release';
import {AlidoReleasePort} from '../adapters/release';
import {available,awsRefusal,debit} from '../wallet/ledger';
const stage=process.argv[2];
if(!['preflight','qa','production','reconcile','dry-run'].includes(stage))throw Error('release preflight|qa|production|reconcile|dry-run');
const s=new Store(join(root,'controller.sqlite'));
try {
 const c=await configAt(join(root,'config.yaml'));
 const port=new AlidoReleasePort();
 let admittedBilling=(await inputs(root)).billing;
 const executor=new ReleaseExecutor(s,port,async()=>{
  if(s.get('aws-stop-latched')===true)return 'wallet stopped';
  if(s.get('paused')!==false)return 'factory paused';
  const r=await inputs(root);admittedBilling=r.billing;const now=Date.now(),reason=awsRefusal(s,c,now,r.billing);
  if(reason)return reason;
  // Each remote admission reserves a conservative dollar. Existing holds/caps apply.
  if(available(s,c,'aws',now,r.billing)<100)return 'release wallet insufficient';
  return null;
 },Date.now,id=>{
  const now=Date.now();if(awsRefusal(s,c,now,admittedBilling)||available(s,c,'aws',now,admittedBilling)<100)throw Error('wallet changed before reservation');
  debit(s,id,'aws',100,now);
 });
 if(stage==='dry-run')console.log(JSON.stringify({effects:false,snapshot:await port.snapshot(),brake:await executor.brake()}));
 else console.log(JSON.stringify(await executor.run(stage as 'preflight'|'qa'|'production'|'reconcile')));
}catch(error){
 const {day}=toronto(Date.now());s.event(`executor-cli:${day}:${stage}:${String(error)}`,'release-executor-refusal',{stage,error:String(error)},'Retain refusal; reconcile configuration before the next scheduled window');
 console.error(String(error));process.exitCode=1;
}finally{s.close();}
