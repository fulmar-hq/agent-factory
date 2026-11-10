import {z} from 'zod';
import {Store} from '../tracking/store';
import {queueWake,type Wake} from './wake';
import type {ReleaseBatch} from './release-batch';
export type ReleaseStep='preflight'|'freeze'|'qa'|'promote'|'readback';
export type ReleaseContext={day:string;revision:string;tree:string;holdId:string;deadline:number;acceptance?:object;batch?:ReleaseBatch;readiness?:object};
export type Snapshot={revision:string;tree:string;holdId:string;held:boolean;overlap:boolean};
export interface ReleasePort {
 snapshot():Promise<Snapshot>;
 perform(step:ReleaseStep,context:ReleaseContext):Promise<Record<string,unknown>>;
 observe(step:ReleaseStep,context:ReleaseContext,handle:Record<string,unknown>):Promise<{state:'pending'|'success'|'failure';evidence:Record<string,unknown>}>;
}
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const SnapshotSchema=z.object({revision:sha,tree:sha,holdId:z.string().min(1),held:z.boolean(),overlap:z.boolean()});
export const AcceptanceSchema=z.object({day:z.string(),revision:sha,tree:sha,artifact:z.string().min(1),verdict:z.enum(['ACCEPT','REJECT']),evidence:z.string().min(1)}).strict();
export type Acceptance=z.infer<typeof AcceptanceSchema> & {at:number;wake:string;native:string;qaRun?:number;qaAttempt?:number};
type Effect={state:'claimed'|'running'|'success'|'failure';context:ReleaseContext;handle?:Record<string,unknown>;evidence?:Record<string,unknown>};
type Night={day:string;candidate?:Snapshot;refused?:string};
export function toronto(now:number) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const p=(k:string)=>parts.find(x=>x.type===k)!.value;
 return {day:`${p('year')}-${p('month')}-${p('day')}`,minute:Number(p('hour'))*60+Number(p('minute'))};
}
export function deadlineAt(now:number,minute:number){const d=new Date(now);return now-d.getUTCSeconds()*1000-d.getUTCMilliseconds()+(minute-toronto(now).minute)*60000;}
const undo='Retain effects, handles, frozen source, rollback and receipts. Reconcile uncertain writes; never replay a claim.';
export class ReleaseExecutor {
 constructor(readonly s:Store,readonly port:ReleasePort,readonly brake:()=>Promise<string|null>,readonly clock=Date.now,readonly reserve:(id:string)=>void=()=>{},readonly batch?:ReleaseBatch,readonly qualityDispatch?:(wake:Wake)=>void){}
 receipt(day:string,kind:string,data:unknown) {this.s.event(`executor:${day}:${kind}`,'release-executor',{day,kind,data},undo,this.clock());}
 effect(day:string,step:ReleaseStep){return this.s.get<Effect>(`executor:${day}:${step}`);}
 refuse(day:string,reason:string){this.receipt(day,`refused:${reason}`,{reason});return {state:'refused',reason};}
 async start(day:string,step:ReleaseStep,context:ReleaseContext,minute:number) {
  const prior=this.effect(day,step);if(prior)return prior;
  // Reads may take seconds. Check the real clock after every asynchronous admission read.
  const brake=await this.brake();if(brake)throw Error(brake);
  const snapshot=SnapshotSchema.parse(await this.port.snapshot());
  if(snapshot.overlap)throw Error('release overlap');
  if(snapshot.revision!==context.revision || snapshot.tree!==context.tree)throw Error('candidate changed');
  if(step==='promote' && !snapshot.held)throw Error('QA freeze missing');
  if(step!=='preflight' && snapshot.holdId!==context.holdId)throw Error('hold changed');
  const current=toronto(this.clock());
  if(current.day!==day || current.minute!==minute || this.clock()>=context.deadline)throw Error('late effect refused');
  const claimed=this.s.atomic(()=>{
   if(this.effect(day,step))return false;
   this.reserve(`executor:${day}:${step}`);
   this.s.set(`executor:${day}:${step}`,{state:'claimed',context} satisfies Effect);
   this.receipt(day,`${step}:claimed`,context);return true;
  });
  if(!claimed)return this.effect(day,step)!;
  // Persist intent BEFORE remote mutation. Throws/crashes retain uncertain custody.
  const handle=await this.port.perform(step,context);
  const running:Effect={state:'running',context,handle};
  this.s.atomic(()=>{this.s.set(`executor:${day}:${step}`,running);this.receipt(day,`${step}:started`,{handle,context});});
  return running;
 }
 async observe(day:string,step:ReleaseStep){
  const effect=this.effect(day,step);if(!effect || effect.state!=='running')return effect;
  if(this.clock()>=effect.context.deadline){const final={...effect,state:'failure' as const};this.s.set(`executor:${day}:${step}`,final);this.receipt(day,`${step}:deadline`,final);return final;}
  const result=await this.port.observe(step,effect.context,effect.handle!);
  if(result.state==='pending')return effect;
  if(this.clock()>=effect.context.deadline)throw Error('completion after deadline');
  let context=effect.context;
  if(step==='qa'&&result.state==='success'&&context.batch){
   if(!sha.safeParse(result.evidence.qaRevision).success||result.evidence.tree!==context.tree)throw Error('Merged QA identity missing');
   context={...context,revision:String(result.evidence.qaRevision)};
   const night=this.s.get<Night>(`executor:${day}:night`);
   if(!night?.candidate)throw Error('Frozen night missing');
   this.s.set(`executor:${day}:night`,{...night,candidate:{...night.candidate,revision:context.revision}});
  }
  const final:Effect={...effect,context,state:result.state,evidence:result.evidence};
  this.s.atomic(()=>{this.s.set(`executor:${day}:${step}`,final);this.receipt(day,`${step}:${result.state}`,result.evidence);});return final;
 }
 async run(stage:'preflight'|'qa'|'production'|'reconcile'){
  const now=this.clock(),{day,minute}=toronto(now);
  try {
   if(stage==='reconcile'){
    const nights=this.s.db.query("SELECT key FROM kv WHERE key LIKE 'executor:%:night' ORDER BY key").all() as {key:string}[];
    for(const night of nights)await this.reconcile(night.key.split(':')[1]);
    return {state:'reconciled'};
   }
   const target={preflight:1140,qa:1200,production:1290}[stage];
   if(minute!==target)return this.refuse(day,`${stage} outside window`);
   // Check persistent STOP before snapshots, prerequisites, reservations or remote calls.
   const brake=await this.brake();
   if(brake==='AWS stop latched'){
    const reason='QA deploy skipped: AWS stop latched';
    this.receipt(day,`${stage}:skipped`,{stage,reason});
    return {state:'skipped',reason};
   }
   if(brake)return this.refuse(day,brake);
   let night=this.s.get<Night>(`executor:${day}:night`);
   if(stage==='preflight'){
    if(!night){const candidate=SnapshotSchema.parse(await this.port.snapshot());night=this.s.atomic(()=>{const existing=this.s.get<Night>(`executor:${day}:night`);if(existing)return existing;const value={day,candidate};this.s.set(`executor:${day}:night`,value);return value;});}
    const c=night.candidate!;
    await this.start(day,'preflight',{day,...c,...(this.batch?{batch:this.batch}:{}),deadline:deadlineAt(now,1190)},target);
   }else if(stage==='qa'){
    if(!night?.candidate || this.effect(day,'preflight')?.state!=='success')throw Error('successful preflight missing');
    const context={day,...night.candidate,...(this.batch?{batch:this.batch}:{}),deadline:deadlineAt(now,1280)};
    await this.start(day,'qa',context,target);
   }else{
    if(!night?.candidate || this.effect(day,'qa')?.state!=='success')throw Error('QA deployed proof missing');
    const accepted=this.s.get<Acceptance>(`executor:${day}:acceptance`),qa=this.effect(day,'qa')!;
    if(!accepted || accepted.verdict!=='ACCEPT' || accepted.day!==day || accepted.revision!==night.candidate.revision || accepted.tree!==night.candidate.tree || accepted.artifact!==qa.evidence?.artifact || accepted.at>=deadlineAt(now,1280))throw Error('matching timely Quality ACCEPT missing');
    await this.start(day,'promote',{day,...night.candidate,holdId:typeof qa.evidence?.holdId==='string'?qa.evidence.holdId:night.candidate.holdId,acceptance:accepted,deadline:deadlineAt(now,1320)},target);
   }
   return await this.reconcile(day);
  }catch(error){return this.refuse(day,String(error));}
 }
 async reconcile(day=toronto(this.clock()).day){
  for(const step of ['preflight','freeze','qa','promote','readback'] as const){
   const result=await this.observe(day,step);
   if(result?.state==='claimed'){this.receipt(day,`${step}:uncertain`,result);queueWake(this.s,{id:`release-failed:${day}:${step}`,owner:'release',kind:'release-diagnosis',payload:{step,context:result.context,reason:'uncertain effect; reconcile native handle before any new effect'}},this.clock());}
   if(result?.state==='failure'){queueWake(this.s,{id:`release-failed:${day}:${step}`,owner:'release',kind:'release-diagnosis',payload:{step,context:result.context,evidence:result.evidence}},this.clock());return this.refuse(day,`${step} failed or deadline`);}
   if(step==='qa' && result?.state==='success'){
    const at=this.clock(),{context,evidence}=result;
    if(at>=context.deadline){
     if(!this.s.get(`executor:${day}:acceptance`))this.receipt(day,'Quality deadline expired',{tree:context.tree,deadline:context.deadline});
     this.qualityDispatch?.({id:`qa-deployed:${day}:${context.tree}`,owner:'quality',kind:'qa-deployed',payload:{...context,deadline:context.deadline}});
    }
    if(at<context.deadline)this.s.atomic(()=>{
     this.receipt(day,'QA deployed',evidence);
     const wake={id:`qa-deployed:${day}:${context.tree}`,owner:'quality',kind:'qa-deployed',payload:{...context,artifact:evidence?.artifact,qaEvidence:evidence,deadline:context.deadline}};
     queueWake(this.s,wake,at);this.qualityDispatch?.(wake);
    });
   }
   if(step==='promote' && result?.state==='success' && !this.effect(day,'readback')){
    // Readback is read-only; unlike admission it may begin after 21:30.
    if(this.clock()>=result.context.deadline)return this.refuse(day,'readback deadline');
    const brake=await this.brake();if(brake)return this.refuse(day,brake);
    if(this.clock()>=result.context.deadline)return this.refuse(day,'readback deadline');
    const claimed=this.s.atomic(()=>{if(this.effect(day,'readback'))return false;this.reserve(`executor:${day}:readback`);this.s.set(`executor:${day}:readback`,{state:'claimed',context:result.context});return true;});
    if(claimed){const handle=await this.port.perform('readback', {...result.context,acceptance:{...result.context.acceptance,...result.evidence}});this.s.set(`executor:${day}:readback`,{state:'running',context:result.context,handle});}
   }
   if(step==='readback' && result?.state==='success')this.s.atomic(()=>{
    this.receipt(day,'Production readback',result.evidence);
    queueWake(this.s,{id:`production-verified:${day}:${result.context.tree}`,owner:'quality',kind:'production-verified',payload:{...result.context,evidence:result.evidence}},this.clock());
   });
  }
  return {state:'reconciled'};
 }
}
// Called only after the supervised Quality native run and descendant cleanup verify.
export function recordAcceptance(s:Store,wake:string,native:string,raw:unknown,now=Date.now()){
 const a=AcceptanceSchema.parse(raw),qa=s.get<Effect>(`executor:${a.day}:qa`);
 const w=s.get<{owner:string;kind:string;payload:ReleaseContext & {artifact:string}}>(`owner-wake:${wake}`);
 if(!native.trim() || !w || w.owner!=='quality' || w.kind!=='qa-deployed' || w.payload.day!==a.day || w.payload.revision!==a.revision || w.payload.tree!==a.tree || w.payload.artifact!==a.artifact || !qa || qa.state!=='success' || qa.context.tree!==a.tree || qa.context.revision!==a.revision || qa.evidence?.artifact!==a.artifact || now<Number(qa.evidence?.completedAt ?? Infinity) || now>=qa.context.deadline || toronto(now).day!==a.day)throw Error('Quality receipt does not bind timely frozen QA');
 return s.atomic(()=>{if(s.get(`executor:${a.day}:acceptance`))throw Error('Quality verdict already retained');const receipt={...a,at:now,wake,native,qaRun:qa.evidence?.qaRun,qaAttempt:qa.evidence?.qaAttempt};s.set(`executor:${a.day}:acceptance`,receipt);s.event(`executor:${a.day}:quality`,'quality-acceptance',receipt,undo,now);return receipt;});
}
