import {openSync,closeSync,readFileSync,fstatSync,constants,realpathSync} from 'node:fs';
import {dirname,join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {z} from 'zod';
import {NativeReceipt} from '../adapters/native';
import {WorkerAccounting} from '../adapters/workers';
import {QualificationSchema,type Qualification} from './config';
import {collectCodexRenewalEvidence,nativeFailure,probeInvocation,securityChecks} from './codex-renewal-evidence';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function regular(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=fstatSync(fd);if(!s.isFile()||s.size===0||s.size>16*1024*1024)throw Error('bounded nonempty regular evidence required');return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
const adoptionSchema=z.object({expiresAt:z.number().int().positive(),report:z.string(),rows:z.array(z.object({effort:z.enum(['medium','high']),mode:z.enum(['security','time','token']),native:z.string().uuid(),receipt:z.string()})).length(6)});
const retainedSchema=z.object({effort:z.string(),mode:z.string(),session:z.object({native_id:z.string(),started:z.number().int().positive(),actual_tokens:z.number().positive(),actual_seconds:z.number().positive(),status:z.string(),brief:z.string()}),native:z.object({id:z.string(),path:z.string(),verified:z.literal(true)}),cleanup:z.object({verified:z.literal(true)}),samples:z.array(z.object({session:z.object({status:z.string(),actual_tokens:z.number()})})),events:z.array(z.object({kind:z.string(),data:z.string()}))});
// This observes protected adoption receipts; it never creates qualifications.
// Unsupported historical formats remain unknown instead of trusting a pathname.
export function qualificationEvidenceVerified(provider:string,q:Qualification,qualificationBytes:string,privateDir=join(homedir(),'.alido-private/factory')):boolean{
 try{
  const report=q.evidence.split('#')[0]!;if(basename(report)!=='report.md'||!realpathSync(report).startsWith(realpathSync(join(privateDir,'runs'))+'/'))return false;regular(report);const dir=dirname(report);
  if(provider!=='codex')return false;
  try{
   const prepared=z.object({next:z.string(),bindings:z.record(z.string(),z.string()).optional()}).parse(JSON.parse(regular(join(dir,'prepared.json'))));
   if(prepared.bindings?prepared.bindings[`${provider}:${q.effort}`]!==hash(JSON.stringify(q)):prepared.next!==hash(qualificationBytes))return false;
   const raw:unknown=JSON.parse(regular(join(dir,'manifest.json'))),manifest=z.object({expiresAt:z.number(),model:z.string()}).parse(raw);
   if(manifest.expiresAt!==q.expiresAt||manifest.model!==q.model)return false;
   const proof=collectCodexRenewalEvidence(raw);return proof.status==='verified'&&proof.verifiedRuns.length===6&&proof.verifiedRuns.filter(r=>r.effort===q.effort).length===3;
  }catch{/* The original owner-adoption protocol predates the automatic journal. */}
  const adoption=adoptionSchema.parse(JSON.parse(regular(join(dir,'adoption.json'))));
  const next=JSON.parse(regular(join(dir,'qualifications.next.json'))),saved=QualificationSchema.parse(next[`${provider}:${q.effort}`]??next[provider]);
  if(adoption.expiresAt!==q.expiresAt||resolve(adoption.report)!==resolve(report)||JSON.stringify(saved)!==JSON.stringify(q)||new Set(adoption.rows.map(r=>`${r.effort}:${r.mode}`)).size!==6||new Set(adoption.rows.map(r=>r.native)).size!==6)return false;
  for(const row of adoption.rows){
   const expected=join(dir,row.effort,row.mode,'result.json');if(resolve(row.receipt)!==resolve(expected))return false;
   const r=retainedSchema.parse(JSON.parse(regular(expected))),t=JSON.parse(r.session.brief);
   if(r.effort!==row.effort||r.mode!==row.mode||r.session.native_id!==row.native||r.native.id!==row.native||t.model!==q.model||t.effort!==row.effort||(row.mode!=='token'&&!r.samples.some(s=>s.session.status==='running'&&s.session.actual_tokens>0)))return false;
   if(row.mode==='security'){if(r.session.status!=='finished')return false;}
   else{const halt=r.events.find(e=>e.kind==='worker-halt');if(!halt||r.session.status!=='paused')return false;const reason=JSON.parse(halt.data).reason;
    if(row.mode==='time'&&(t.estimateSeconds!==25||reason.pauseSeconds!==50||r.session.actual_seconds<50))return false;
    if(row.mode==='token'&&(t.estimateTokens!==100||reason.estimateTokens!==100||reason.pauseTokens!==200||r.session.actual_tokens<200||r.session.actual_seconds>=360))return false;
   }
   const receipt=new NativeReceipt('codex',row.native,join(dir,row.effort,row.mode,'workspace'),homedir(),r.session.started),accounting=new WorkerAccounting();for(let i=0;i<64;i++){receipt.poll(accounting);if(receipt.caughtUp)break;}
   const evidence=receipt.evidence(q.model,row.effort);if(!evidence.verified||evidence.path!==r.native.path||accounting.tokens<=0)return false;
   const rollout=regular(evidence.path!).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
   const stream=regular(join(dir,row.effort,row.mode,'native.jsonl')).trim().split('\n').filter(line=>line.trim().startsWith('{')).map(line=>JSON.parse(line) as {type?:string;item?:{type?:string;command?:string;exit_code?:number;aggregated_output?:string};usage?:unknown});
   if(rollout.some(nativeFailure)||stream.some(nativeFailure))return false;
   if(row.mode==='security'){
    if(stream.filter(x=>x.type==='turn.completed').length!==1||rollout.filter(x=>x.type==='event_msg'&&(x.payload as {type?:string})?.type==='task_complete').length!==1)return false;
    const successes=stream.filter(x=>x.type==='item.completed'&&x.item?.type==='command_execution'&&x.item.exit_code===0&&probeInvocation(x.item.command??'',join(dir,row.effort,row.mode,'workspace'),join(dir,row.effort,row.mode,'workspace/probe.py'))).filter(x=>{try{const result=JSON.parse(x.item!.aggregated_output!.trim().split('\n').at(-1)!);return securityChecks.every(key=>result[key]===true);}catch{return false;}});
    if(successes.length!==1)return false;
   }else if(stream.some(x=>x.type==='turn.completed'))return false;

  }
  return true;
 }catch{return false;}
}
