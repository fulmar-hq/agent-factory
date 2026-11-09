import {join} from 'node:path';
import {mkdirSync,openSync,closeSync,writeSync,readFileSync,writeFileSync} from 'node:fs';
import {Store} from '../tracking/store';
import {configAt,root,type Ticket} from './config';
import {workerSpec,materializeSettings,WorkerAccounting,claudeSettings} from '../adapters/workers';
import {NativeReceipt} from '../adapters/native';
import {spawnWorker} from './child';
import {processIdentity} from './process';
import {type Wake,type OwnerRuntime} from './wake';
import {recordAcceptance} from './release';
// Permanent owners review events; ticket work is admitted separately. Their
// command tools get read-only source plus this wake's scratch, never publisher
// credentials. A wake cannot merge, deploy or write the launcher source.
export function ownerSpec(t:Ticket,workspace:string,scratch:string,native?:string) {
 const spec=workerSpec(t,workspace);
 if(t.provider==='codex') {
  spec.argv=spec.argv.map(a=>a.startsWith('permissions.factory.filesystem=') ? a.replace('\":workspace_roots\"=\"write\"','\":workspace_roots\"=\"read\"').replace(/ }$/,`, ${JSON.stringify(scratch)}="write" }`) : a);
  if(native){const i=spec.argv.indexOf('-C');spec.argv.splice(i,2,'resume',native);}
 } else {
  if(native){const i=spec.argv.indexOf('--session-id');spec.argv.splice(i,2,'--resume',native);spec.nativeId=native;}
  if(spec.settings) {
   // Build private sibling denials around this exact scratch, rather than denying its ancestor.
   spec.settings=claudeSettings(scratch);
   spec.settings.sandbox.filesystem.allowRead=[workspace,scratch];
   spec.argv.splice(spec.argv.indexOf('--settings'),0,'--add-dir',scratch);
   spec.settings.permissions.deny.push(`Edit(/${workspace}/**)`);
   spec.settings.sandbox.filesystem.denyWrite.push(workspace);
   spec.settings.sandbox.filesystem.allowWrite=[scratch];
  }
 }
 spec.env.TMPDIR=scratch;
 return spec;
}
export async function runOwner(id:string,dir=root) {
 const s=new Store(join(dir,'controller.sqlite')),c=await configAt(join(dir,'config.yaml'));
 let fd:number|undefined,child:ReturnType<typeof spawnWorker>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 let wake:Wake|undefined,runtime:OwnerRuntime|undefined;
 let stop:Promise<void>|undefined;
 let onSignal:(()=>void)|undefined;
 try {
  const claimed=s.atomic(()=>{
   const w=s.get<Wake & {state:string}>(`owner-wake:${id}`);if(w?.state!=='starting')return null;
   const r=s.get<OwnerRuntime>(`owner-runtime:${w.owner}`);if(!r || r.wake!==id || r.pid)return null;
   s.set(`owner-wake:${id}`,{...w,state:'running'});s.set(`owner-runtime:${w.owner}`,{...r,pid:process.pid,identity:processIdentity(process.pid)});return {w,r};
  });
  if(!claimed)return;
  wake=claimed.w;runtime=claimed.r;
  const role=c.owners[wake.owner];if(!role)throw Error('owner not configured');
  const scratch=join(dir,'runs','owner-wakes',id.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)+'-'+crypto.randomUUID());mkdirSync(scratch,{recursive:true,mode:0o700});
  if(wake.kind==='qa-deployed' && Date.now()>=(wake.payload as {deadline:number}).deadline)throw Error('Quality acceptance deadline expired');
  if(wake.kind==='qa-deployed')writeFileSync(join(scratch,'qa-evidence.json'),JSON.stringify(wake.payload,null,2),{mode:0o600});
  const fullBrief=readFileSync(join(dir,'owners',`${wake.owner}.md`),'utf8');
  const brief=fullBrief.length>60000 ? fullBrief.slice(0,12000)+'\n[Historical middle retained in owner record]\n'+fullBrief.slice(-48000) : fullBrief;
  const t:Ticket={repo:'owner/review',number:1,title:'Review owner event',owner:wake.owner,creator:'launcher',source:wake.id,outcome:`You are Alido · ${wake.owner}. Review this event and report the required follow-up. This wake is read-only: do not implement changes, publish, merge, release, sign in or send messages. Ticket workers and the trusted launcher perform effects separately. Preserve work.\nOwner record:\n${brief}\nEvent:\n${JSON.stringify(wake)}`,test:'Report source-backed owner decisions',approved:true,benefit:'normal',estimateSeconds:1800,estimateTokens:8000000,paths:['.factory-tmp'],spansBackendAndScreen:false,heavy:false,wallet:'other',costCents:0,provider:role.harness,model:role.model,effort:role.effort,area:'owner',kind:'review'};
  if(wake.kind==='qa-deployed'){
   t.outcome=`You are independent Alido Quality. Accept or reject ONLY this hosted frozen QA revision/tree/artifact. Deadline is an absolute epoch milliseconds; finish before it. Read the trusted launcher-fetched native/hosted evidence in ${join(scratch,'qa-evidence.json')}. Inspect additional hosted/browser evidence only if the sandbox has a qualified supported path; do not assume those capabilities exist. Record exactly which feature checks are proven and which are missing. Do not use AWS SSO, change customer settings, send real-person messages or mutate release state. Missing hosted evidence means REJECT. Write ${join(scratch,'acceptance.json')} with exactly {day,revision,tree,artifact,verdict: ACCEPT or REJECT,evidence: nonempty source-backed findings}. Do not accept from passing CI alone. Your launcher validates the receipt after verified native completion.\nOwner record:\n${brief}\nQA deployed packet:\n${JSON.stringify(wake.payload)}`;
  }
  const ownerNative=wake.kind==='qa-deployed' ? undefined : runtime.native;
  const spec=materializeSettings(ownerSpec(t,runtime.workspace,scratch,ownerNative),join(scratch,'settings.json'));
  let native=ownerNative ?? spec.nativeId;
  const started=native && role.harness==='codex' ? Number.parseInt(native.replaceAll('-','').slice(0,12),16) : Date.now();
  let receipt:NativeReceipt|undefined=native ? new NativeReceipt(t.provider,native,runtime.workspace,spec.env.HOME,started) : undefined;
  const accounting=new WorkerAccounting();
  if(ownerNative) {
   for(let i=0;i<256;i++){receipt!.poll(accounting);if(receipt!.caughtUp)break;}
   if(!receipt?.evidence(t.model!,t.effort!).bound || !receipt.caughtUp)throw Error('existing owner native custody unverified');
   receipt.beginTurn();
  }
  const baseline=accounting.tokens,cachedBaseline=accounting.cachedTokens;
  fd=openSync(join(scratch,'native.jsonl'),'ax',0o600);child=spawnWorker(spec,runtime.workspace,fd);
  s.event(`owner-native:${id}`,'owner-native-start',{id,pid:child.pid,native:native ?? null,scratch,baseline},'Retain native ID, logs and stable wake claim');
  const start=Date.now();let done=false,halted=false;
  const halt=()=>{halted=true;stop ??= child!.stop();void stop.catch(()=>{});};
  onSignal=halt;process.on("SIGTERM",onSignal);process.on("SIGINT",onSignal);
  const sample=()=>{
   try{receipt?.poll(accounting);}catch{halt();}
   if(wake?.kind==='qa-deployed' && Date.now()>=(wake.payload as {deadline:number}).deadline)halt();
   const seconds=(Date.now()-start)/1000,paused=seconds>=3600 || accounting.tokens-baseline>=16000000;
   s.set(`owner-budget:${id}`,{seconds,tokens:accounting.tokens-baseline,cachedTokens:accounting.cachedTokens-cachedBaseline,checkpoint:seconds>=3240 || accounting.tokens-baseline>=14400000,overshootTokens:Math.max(0,accounting.tokens-baseline-16000000),overshootSeconds:Math.max(0,seconds-3600),nextTurnBlocked:paused});
   if(paused || s.get('paused')!==false || receipt?.evidence(t.model!,t.effort!).conflict)halt();
  };
  timer=setInterval(sample,500);
  let pending='';for await(const chunk of child.stdout){writeSync(fd,chunk);pending+=new TextDecoder().decode(chunk);let end:number;
   while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);const event=accounting.ingest(t.provider,line);
    if(event.native){if(native && native!==event.native)throw Error('owner native ID changed');native=event.native;receipt ??=new NativeReceipt(t.provider,native,runtime.workspace,spec.env.HOME,Date.now());s.set(`owner-runtime:${wake.owner}`,{...s.get<OwnerRuntime>(`owner-runtime:${wake.owner}`),native});}
    if(event.done)done=true;sample();
   }
  }
  const code=await child.exited;for(let i=0;i<64;i++){sample();if(!receipt || receipt.caughtUp || halted)break;}
  await child.stop();if(stop)await stop;
  const ok=!halted && code===0 && done && receipt?.evidence(t.model!,t.effort!).verified===true && child.cleanup.verified;
  if(ok && wake.kind==='qa-deployed')recordAcceptance(s,id,native!,JSON.parse(readFileSync(join(scratch,'acceptance.json'),'utf8')));
  s.set(`owner-wake:${id}`,{...wake,state:ok?'done':'blocked',native,at:Date.now(),scratch});
  s.event(`owner-complete:${id}`,'owner-wake-complete',{id,ok,native,cleanup:child.cleanup},'Retain completed wake; use a distinct new event for further work');
 } catch(error){
  if(wake){s.set(`owner-wake:${id}`,{...wake,state:'blocked',error:String(error)});s.event(`owner-failure:${id}`,'owner-wake-failure',{id,error:String(error)},'Reconcile native custody; never replay this wake');}
 } finally {
  if(timer)clearInterval(timer);
  if(onSignal){process.off("SIGTERM",onSignal);process.off("SIGINT",onSignal);}
  try{if(child){await child.stop();await child.exited;}}
  finally{if(fd!==undefined)closeSync(fd);if(wake && (!child || child.cleanup.verified)){s.set(`owner-wake:${id}`,{...s.get(`owner-wake:${id}`) as object,cleanupVerified:true});const r=s.get<OwnerRuntime>(`owner-runtime:${wake.owner}`);if(r?.wake===id)s.set(`owner-runtime:${wake.owner}`,{...r,pid:undefined,identity:undefined});}s.close();}
 }
}
if(import.meta.main)await runOwner(process.argv[2]);
