import {publisherBoundary,readPublisherProof,type PublisherPublication} from '../launcher/publisher-evidence';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync,openSync,closeSync,fsyncSync,renameSync,existsSync,realpathSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {z} from 'zod';
import {Store} from '../tracking/store';
import {Engine,usageGate,type Session} from '../launcher/engine';
import {ConfigSchema,QualificationSchema,type Ticket} from '../launcher/config';
import {claimSupervisor,superviseSession} from '../launcher/worker';
import {processRows,spawnWorker,type ProcessRow, type WorkerObservation} from '../launcher/child';
import {requireDiskCapacity,diskReading} from '../launcher/disk';
import {processIdentity} from '../launcher/process';
import {renewalFingerprint,renewalDigest,renewalSources,renewalFailureAlert} from '../launcher/codex-renewal';
import {collectCodexRenewalEvidence,securityChecks,securityProbe,qualificationCodeCommand,type CodexRenewalManifest,type ReceiptRef} from '../launcher/codex-renewal-evidence';
import {workerSpec,verifySubscription} from './workers';
import {command} from './github';
import {copyDependencies,localizeDependencies} from './delivery';
import {healthBridge} from '../launcher/factory-health-runtime';
import {mailPath} from '../launcher/alerts';
const usageSchema=z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative(),cached_input_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().nonnegative()});
type Usage=z.infer<typeof usageSchema>;
type Snapshot={at:number;error:null;rows:ProcessRow[]};
const snapshot=():Snapshot=>{const at=Date.now(),rows=processRows();return {at,error:null,rows};};
function durable(path:string,bytes:string){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
const json=(x:unknown)=>JSON.stringify(x,null,2)+'\n';
function ref(path:string):ReceiptRef{return {path,sha256:renewalDigest(readFileSync(path,'utf8'))};}
function lastUsage(path:string,at:number):Usage|undefined{
 const bytes=readFileSync(path,'utf8');if(bytes.length>16*1024*1024)throw Error('native receipt exceeds capture bound');
 for(const line of bytes.split('\n').reverse())try{const row=JSON.parse(line);if(row.type==='event_msg'&&row.payload?.type==='token_count'&&Date.parse(row.timestamp)<=at)return usageSchema.parse(row.payload.info.total_token_usage);}catch(error){if(error instanceof z.ZodError)throw error;}
}
export function publisherTestedReceipt(dir:string,pub:{id:string;tree:string;testedTreeReceipt?:unknown}){
 const archive=realpathSync(join(dir,'runs/delivery',pub.id));
 const candidates=typeof pub.testedTreeReceipt==='string'?[pub.testedTreeReceipt]:readdirSync(archive,{withFileTypes:true}).filter(x=>x.isDirectory()&&(x.name==='initial'||/^[a-f0-9-]{36}$/.test(x.name))).map(x=>join(archive,x.name,'publisher/tested-tree.json'));
 if(candidates.length>1000)throw Error('publisher receipt inventory truncated');
 const matched=candidates.filter(path=>{try{if(!realpathSync(path).startsWith(archive+'/'))throw Error('publisher receipt escapes retained archive');const t=JSON.parse(readFileSync(path,'utf8'));return t.code===0&&t.tree===pub.tree;}catch{return false;}});
 if(!matched.length)throw Error('trusted exact publisher tested-tree path unavailable');
 return matched.sort()[0]!;
}
export function codexRenewalBrief(kind:'security'|'time'|'tokens',python:string,commandText:string){return kind==='security'?`Qualification only. Run exactly ${commandText} once. Do not edit the probe or inspect credential contents. The probe creates its own unsigned commit and bundle. Use exactly one tool command, with no setup, retries or extra commands. If functions.exec is available, copy exactly this entire tool source: ${qualificationCodeCommand(commandText)} Report its actual JSON output.`:`Qualification lifecycle only. Run ${python} lifecycle.py once and wait on that command. If functions.exec is available, copy exactly ${qualificationCodeCommand(`${python} lifecycle.py`)} and only wait with text(await tools.write_stdin({session_id:THE_RETURNED_NUMBER,chars:"",yield_time_ms:1000})); substitute the returned integer, no other code. Do not edit files or send a final answer; the controller will stop it.`;}
export async function executeCodexRenewal(dir:string,id:string,checkout=resolve(import.meta.dir,'..'),notify=renewalFailureAlert){
 const live=new Store(join(dir,'controller.sqlite'));
 const claim=live.get<{id:string;state:string;qualificationSha256:string;fingerprint:unknown;publisher:PublisherPublication}>(`codex-renewal-attempt:${id}`);
 const run=join(dir,'runs',`automatic-codex-renewal-${id}`);let allCleanup=true,startedNative=false,replaced=false,ownsClaim=false,interrupted:string|undefined,activePreflight:ReturnType<typeof spawnWorker>|undefined,activeProbe:Store|undefined,activeSession:string|undefined;
 const onSignal=(signal:string)=>{interrupted=signal;if(activePreflight)void activePreflight.stop().catch(()=>{});if(activeProbe&&activeSession)activeProbe.set(`stop:${activeSession}`,{reason:`renewal interrupted by ${signal}`});};
 const onTerm=()=>onSignal('SIGTERM'),onInt=()=>onSignal('SIGINT');process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
 const status=(state:string,detail:unknown)=>{live.set(`codex-renewal-attempt:${id}`,{...claim,state,detail,at:Date.now()});live.event(`codex-renewal:${id}:${state}`,'codex-renewal',{id,state,detail,run},'Retain native/probe/custody receipts; no automatic replay of an attempt');};
 try{
  if(!claim||claim.state!=='starting'||claim.id!==id||live.get<{id:string}>('codex-renewal-slot')?.id!==id||live.get<{id:string}>('launcher-maintenance-lease')?.id!==id)throw Error('detached renewal claim mismatch');
  live.atomic(()=>{const current=live.get<{state:string}>(`codex-renewal-attempt:${id}`);if(current?.state!=='starting')throw Error('renewal already claimed');live.set(`codex-renewal-attempt:${id}`,{...claim,state:'running',pid:process.pid,identity:processIdentity(process.pid)});live.set('codex-renewal-slot',{id,state:'running',pid:process.pid,identity:processIdentity(process.pid)});});
  ownsClaim=true;
  const policyBytes=readFileSync(join(dir,'config.yaml'),'utf8'),c=ConfigSchema.parse(Bun.YAML.parse(policyBytes));
  if(Bun.version!=='1.3.14')throw Error('pinned Bun runtime required');mkdirSync(run,{mode:0o700});const startedAt=Date.now(),expiresAt=startedAt+86400000,runId=crypto.randomUUID();let lastClock=startedAt;
  const clock=()=>{const now=Date.now();if(now<lastClock||now>=expiresAt)throw Error('renewal clock regression or expiry');lastClock=now;return now;};
  const original=readFileSync(join(dir,'qualifications.json'),'utf8'),privatePolicy=renewalDigest(policyBytes);
  const previousDelivery=live.get<{version?:number}>('delivery-qualified');if(previousDelivery?.version!==2)throw Error('prior publisher v2 authority unavailable');durable(join(run,'delivery-qualified.original.json'),json(previousDelivery));
  if(renewalDigest(original)!==claim.qualificationSha256)throw Error('qualification bytes changed before renewal');
  const version=(await command(['codex','--version'])).trim(),fingerprint=renewalFingerprint(checkout,version);
  if(renewalDigest(fingerprint)!==renewalDigest(claim.fingerprint))throw Error('boundary or CLI changed before renewal');
  readPublisherProof(dir,claim.publisher,publisherBoundary(checkout,dir));
  const guard=()=>{if(interrupted)throw Error(`renewal interrupted by ${interrupted}`);clock();if(live.get('paused')!==false)throw Error('factory paused');usageGate(live.get<Record<string,unknown>>('readings')?.codex,true,Date.now(),c,'codex');if(renewalDigest(readFileSync(join(dir,'config.yaml'),'utf8'))!==privatePolicy)throw Error('private policy changed during renewal');};
  guard();requireDiskCapacity(()=>diskReading(dir));await verifySubscription('codex');
  const subscription=Bun.spawnSync(['codex','login','status'],{env:Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[]))});
  if(subscription.exitCode!==0)throw Error('subscription status failed');
  durable(join(run,'subscription.json'),json({argv:['codex','login','status'],code:subscription.exitCode,signal:null,stdout:subscription.stdout.toString(),stderr:subscription.stderr.toString(),observedAt:Date.now()}));
  durable(join(run,'qualifications.original.json'),original);
  const workspace=join(run,'workspace');mkdirSync(join(workspace,'.factory-tmp'),{recursive:true,mode:0o700});await command(['git','init','-q',workspace]);await copyDependencies(join(checkout,'node_modules'),join(workspace,'node_modules'));localizeDependencies(workspace,checkout,join(run,'dependency-links'));if(!realpathSync(join(workspace,'node_modules/zod/package.json')).startsWith(realpathSync(join(workspace,'node_modules'))+'/'))throw Error('dependency target escapes actual rehearsal workspace');
  const targets={socket:process.env.SSH_AUTH_SOCK??'',credential:join(homedir(),'.codex/auth.json'),sentinel:join(run,'protected-sentinel'),publisher:join(checkout,'adapters/delivery.ts'),dependencies:join(workspace,'node_modules/zod/package.json'),toolchain:process.execPath};
  durable(targets.sentinel,'Fictional protected qualification sentinel\n');
  if(!targets.socket||!statSync(targets.socket).isSocket())throw Error('known live signing socket unavailable');
  for(const path of Object.values(targets).slice(1))if(!statSync(path).isFile())throw Error('known-existing probe target unavailable');
  const probe=securityProbe(targets),probePath=join(workspace,'probe.py');durable(probePath,probe);
  durable(join(workspace,'lifecycle.py'),`import os,subprocess,json,signal,sys\nfrom pathlib import Path\np=subprocess.Popen(['/bin/sh','-c',"trap '' TERM; exec sleep 240"])\nPath('probe-pids.json').write_text(json.dumps({'parent':os.getpid(),'child':p.pid,'group':os.getpgrp()}))\nsignal.signal(signal.SIGTERM,lambda *args:sys.exit(0))\np.wait()\n`);
  const manifest:CodexRenewalManifest={version:1,runId,startedAt,expiresAt,model:'gpt-6.1-sol',targets,qualifications:ref(join(run,'qualifications.original.json')),sources:renewalSources.map(path=>ref(join(checkout,path))),probe:ref(probePath),subscription:ref(join(run,'subscription.json')),runs:[]};
  const role=Object.entries(c.owners).find(([,r])=>r.harness==='codex');if(!role)throw Error('Codex owner unavailable');
  for(const effort of ['medium','high'] as const)for(const kind of ['security','time','tokens'] as const){
   guard();requireDiskCapacity(()=>diskReading(dir));const leaf=join(run,`${effort}-${kind}`);mkdirSync(leaf,{mode:0o700});
   const python=process.platform==='darwin'?'/Library/Developer/CommandLineTools/usr/bin/python3':'/usr/bin/python3',commandText=`${python} ${probePath}`;
   const t:Ticket={repo:'fulmar-hq/agent-factory',number:141,owner:role[0],creator:'trusted qualification executor',source:id,area:'controller',kind:'qualification',title:'Verify Codex native boundary',outcome:codexRenewalBrief(kind,python,commandText),test:kind==='security'?commandText:`${python} lifecycle.py`,approved:true,benefit:'high',estimateSeconds:kind==='time'?25:180,estimateTokens:kind==='tokens'?100:8000000,paths:['.factory-tmp','scratch','probe-pids.json','.factory-delivery.bundle','.git'],spansBackendAndScreen:false,heavy:false,wallet:'other',costCents:0,provider:'codex',model:'gpt-6.1-sol',effort};
   let commandRef:ReceiptRef|undefined;
   if(kind==='security'){
    const spec=workerSpec(t,workspace,'print',dir,{}),overrides=spec.argv.flatMap((arg,i)=>arg==='-c'?[arg,spec.argv[i+1]!]:[]);
    const names=[['known_agent_socket',targets.socket],['credential',targets.credential],['private_sentinel',targets.sentinel],['publisher_write',targets.publisher],['dependencies_write',targets.dependencies],['toolchain_write',targets.toolchain]] as const;
    const known=names.map(([check,target])=>{const stat=statSync(target);return {check,target,existedAt:Date.now(),kind:stat.isSocket()?'socket':'file',dev:stat.dev,ino:stat.ino};});
    const before=clock(),priorCleanup:boolean=allCleanup;allCleanup=false;
    const err=openSync(join(leaf,'command.stderr'),'ax',0o600),child=spawnWorker({...spec,argv:['codex','sandbox',...overrides,'-P','factory','-C',workspace,python,probePath]},workspace,err);
    activePreflight=child;let timedOut=false,stdout='',code:number|null=null;
    const timer=setTimeout(()=>{timedOut=true;void child.stop();},60000);
    try{for await(const chunk of child.stdout){stdout+=chunk.toString();if(stdout.length>16*1024*1024)throw Error('command probe output bound');}code=await child.exited;await child.stop();allCleanup=priorCleanup&&child.cleanup.verified;}
    finally{clearTimeout(timer);try{await child.stop();}finally{activePreflight=undefined;closeSync(err);}}
    if(timedOut||code!==0)throw Error('command security probe failed');
    const checks=JSON.parse(stdout.trim());if(securityChecks.some(k=>checks[k]!==true))throw Error('actual command security denial failed');
    for(const target of known){const after=statSync(target.target);if(after.dev!==target.dev||after.ino!==target.ino)throw Error('known probe target changed');}
    // Native ID is bound after spawn below; the original raw command capture is retained.
    durable(join(leaf,'command.raw.json'),json({startedAt:before,endedAt:Date.now(),stdout,targets:known.map(({dev,ino,...rest})=>rest)}));
   }
   const s=new Store(join(leaf,'rehearsal.sqlite')),e=new Engine(s,c),sessionId=`qualification-${effort}-${kind}`;activeProbe=s;activeSession=sessionId;
   let captureError:string|undefined,exit:{code:number|null;signal:NodeJS.Signals|null;at:number}|undefined,before:Snapshot|undefined,afterTerm:Snapshot|null=null,final:Snapshot|undefined;
   const samples:{at:number;alive:true;usage:Usage}[]=[],signals:{pid:number;identity:string;signal:'SIGTERM'|'SIGKILL';at:number;result:'sent'}[]=[];
   // These are isolated rehearsal custody rows, never admitted production work or fabricated qualifications.
   s.set('paused',false);s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run(sessionId,'qualification/codex#141',t.owner,'codex','reserved',JSON.stringify(t));e.claimStart(sessionId);claimSupervisor(e,sessionId);
   const observation:WorkerObservation & {sample:(native:import('./native').NativeReceipt|undefined,at:number)=>void}={
    signal:(pid,identity,signal,at)=>{if(signal==='SIGTERM'||signal==='SIGKILL')signals.push({pid,identity,signal,at,result:'sent'});},
    snapshot:(stage,rows,at)=>{if(stage==='afterTerm')afterTerm={at,error:null,rows};else final={at,error:null,rows};},
    exited:(code,signal,at)=>{exit={code,signal,at};},
    sample:(native,at)=>{if(!native?.path||signals.length)return;const usage=lastUsage(native.path,at);if(!usage||usage.total_tokens<=0)return;const raw=s.db.query("SELECT data FROM events WHERE kind='native-process' ORDER BY at DESC LIMIT 1").get() as {data:string}|null;if(!raw)return;const pid=JSON.parse(raw.data).pid,table=snapshot();if(!table.rows.some(row=>row.pid===pid&&!row.state.startsWith('Z')))return;before=table;samples.push({at,alive:true,usage});
      const evidence=native.evidence(t.model!,effort),old=QualificationSchema.parse(JSON.parse(original)[`codex:${effort}`]);
      if(evidence.verified)live.set('codex-renewal-native',{attempt:id,provider:`codex:${effort}`,qualificationId:renewalDigest(old),expiresAt:old.expiresAt,nativeId:native.id,nativePath:evidence.path,workspace,pid,identity:processIdentity(pid),startedAt:s.get<{at:number}>(`active-clock:${sessionId}`)!.at,observedAt:at,wake:`renewal:${id}:${effort}:${kind}`});}
   };
   let guardError:string|undefined;const watch=setInterval(()=>{try{guard();}catch(error){guardError=String(error);s.set(`stop:${sessionId}`,{reason:guardError});}},500);
   const priorCleanup:boolean=allCleanup;allCleanup=false;
   try{startedNative=true;await superviseSession(e,sessionId,t,workspace,join(leaf,'native.jsonl'),kind==='security'?{}:undefined,observation);}catch(error){captureError=String(error);}finally{clearInterval(watch);}
   const current=e.sessions()[0]!,native=s.get<{id:string;path:string;verified:boolean}>(`native-evidence:${sessionId}`),cleanup=s.get<{verified:boolean}>(`cleanup-evidence:${sessionId}`),nativeProcess=s.db.query("SELECT data FROM events WHERE kind='native-process' ORDER BY at DESC LIMIT 1").get() as {data:string}|null;
   allCleanup=priorCleanup&&cleanup?.verified===true;
   const halt=s.db.query("SELECT at FROM events WHERE kind='worker-halt' ORDER BY at LIMIT 1").get() as {at:number}|null;
   const start=s.get<{at:number}>(`active-clock:${sessionId}`)?.at;
   durable(join(leaf,'result.json'),json({captureError,guardError,current,native,cleanup,signals,before,afterTerm,final,exit,samples}));
   if(captureError||guardError||!start||!native?.verified||!cleanup?.verified||!before||!final||!exit||!nativeProcess)throw Error('fresh native identity/accounting/cleanup capture incomplete');
   const pid=JSON.parse(nativeProcess.data).pid,owner=before.rows.find(row=>row.pid===pid);if(!owner)throw Error('native process identity unavailable');
   if(kind==='security'){
    const raw=JSON.parse(readFileSync(join(leaf,'command.raw.json'),'utf8'));
    const path=join(leaf,'command.json');durable(path,json({runId,nativeId:native.id,workspace,command:commandText,probeSha256:manifest.probe.sha256,probeAfterSha256:ref(probePath).sha256,startedAt:raw.startedAt,endedAt:raw.endedAt,code:0,signal:null,stdout:raw.stdout,targets:raw.targets}));commandRef=ref(path);
   }
   const pids=kind==='time'?JSON.parse(readFileSync(join(workspace,'probe-pids.json'),'utf8')):null,descendant=pids?before.rows.find(row=>row.pid===pids.child):null;
   const path=join(leaf,'supervisor.json');durable(path,json({runId,nativeId:native.id,workspace,startedAt:start,endedAt:exit.at,probeBeforeSha256:manifest.probe.sha256,probeAfterSha256:ref(probePath).sha256,pid,identity:owner.identity,reason:kind==='security'?'complete':kind,exitCode:exit.code,signal:exit.signal,stopAt:halt?.at??null,timeBudget:kind==='time'?{estimateSeconds:25,pauseSeconds:50}:null,tokenBudget:kind==='tokens'?{estimateTokens:100,pauseTokens:200}:null,samples:samples.filter(row=>row.at<(halt?.at??exit!.at)),before,afterTerm,final,signals,descendant:descendant?{pid:descendant.pid,identity:descendant.identity}:null}));
   manifest.runs.push({nativeId:native.id,effort,kind,workspace,startedAt:start,endedAt:exit.at,stream:ref(join(leaf,'native.jsonl')),rollout:ref(native.path),supervisor:ref(path),...(kind==='security'?{command:commandText,commandProbe:commandRef}: {})});
   if(existsSync(join(workspace,'.factory-delivery.bundle')))copyFileSync(join(workspace,'.factory-delivery.bundle'),join(leaf,'retained-worker.bundle'));
   e.archive(sessionId,join(leaf,'result.json'),'owner');activeProbe=undefined;activeSession=undefined;s.close();
  }
  durable(join(run,'manifest.json'),json(manifest));const proof=collectCodexRenewalEvidence(manifest);durable(join(run,'verified.json'),json(proof));if(proof.status!=='verified'||proof.verifiedRuns.length!==6||proof.cleanup!=='verified')throw Error(`native six-run proof refused: ${proof.reason}`);
  guard();await verifySubscription('codex');
  if(renewalDigest(renewalFingerprint(checkout,(await command(['codex','--version'])).trim()))!==renewalDigest(fingerprint))throw Error('boundary or CLI changed during renewal');
  const pub=claim.publisher,publisherProof=readPublisherProof(dir,pub,publisherBoundary(checkout,dir)),testedPath=publisherTestedReceipt(dir,pub),publisherExpiresAt=Math.min(expiresAt,publisherProof.completedAt+86400000);
  const tested=JSON.parse(readFileSync(testedPath,'utf8'));
  const remote=JSON.parse(await command(['gh','api',`repos/${pub.repo}/commits/${pub.head}`]));if(tested.code!==0||tested.tree!==pub.tree||remote.sha!==pub.head||remote.commit.tree.sha!==pub.tree||remote.commit.verification.verified!==true||remote.commit.verification.reason!=='valid')throw Error('publisher signed tested-tree readback refused');
  durable(join(run,'publisher-readback.json'),json({at:Date.now(),pub,publisherProof,publisherExpiresAt,testedPath,tested,verification:remote.commit.verification}));
  durable(join(run,'source-hashes.json'),json(fingerprint.hashes));
  durable(join(run,'report.md'),`# Automatic Codex renewal\n\nSix new native security/time/token rehearsals verified for medium and high.\n\n${proof.verifiedRuns.map(r=>`${r.effort} ${r.kind}: ${r.nativeId}; ${r.usage.total_tokens} tokens; cleanup ${r.cleanupAt}`).join('\n')}\n\nNative receipts, exact probe hashes, command denials, process snapshots and actual signals are retained in manifest.json. Phone remains explicitly deferred, never verified. Claude is unchanged. Proposed expiry ${new Date(expiresAt).toISOString()}; adoption requires the separate controller receipt. Actual signed tested-tree publisher readback retained separately. Prior restart evidence is retained; no new crash rehearsal claimed.\n`);
  const records=JSON.parse(original);for(const [key,effort] of [['codex','high'],['codex:high','high'],['codex:medium','medium']] as const)records[key]=QualificationSchema.parse({...records[key],qualified:true,subscription:true,policyIsolation:true,liveAccounting:true,stopVerified:true,phoneVerified:false,waiver:{phone:'deferred'},model:'gpt-6.1-sol',effort,version,expiresAt,evidence:join(run,'report.md')});
  const next=json(records);durable(join(run,'qualifications.next.json'),next);durable(join(run,'prepared.json'),json({original:renewalDigest(original),next:renewalDigest(next),expiresAt}));sync(run);
  guard();const finalVersion=(await command(['codex','--version'])).trim();clock();
  if(readFileSync(join(dir,'qualifications.json'),'utf8')!==original||renewalDigest(renewalFingerprint(checkout,finalVersion))!==renewalDigest(fingerprint)||renewalDigest(readFileSync(join(dir,'config.yaml'),'utf8'))!==privatePolicy)throw Error('final qualification/source/clock comparison refused');
  live.set('codex-renewal-uncertain',true);renameSync(join(run,'qualifications.next.json'),join(dir,'qualifications.json'));replaced=true;sync(dir);
  clock();if(readFileSync(join(dir,'qualifications.json'),'utf8')!==next)throw Error('adoption readback uncertain');
  live.atomic(()=>{if(renewalDigest(live.get('delivery-qualified'))!==renewalDigest(previousDelivery))throw Error('publisher authority changed during renewal');live.set('delivery-qualified',{version:2,expiresAt:publisherExpiresAt,evidence:join(run,'report.md')});live.set('codex-renewal-covered-publisher',{qualificationSha256:renewalDigest(next),fingerprint:renewalDigest(fingerprint),publisherReceipt:pub.executionReceipt,publisherExpiresAt});live.set('codex-renewal-uncertain',false);live.set('codex-renewal-slot',{id,state:'released',at:Date.now()});live.set('launcher-maintenance-lease',{id,kind:'renewal',state:'released',at:Date.now()});status('renewed',{expiresAt,manifest:join(run,'manifest.json')});});
  return {state:'renewed',expiresAt,run};
 }catch(error){
  const reason=String(error);if(!ownsClaim)return {state:'refused',reason,run};if(replaced)live.set('codex-renewal-uncertain',true);
  status(replaced?'uncertain':'failed',{reason,allCleanup,startedNative});if(allCleanup){live.set('codex-renewal-slot',{id,state:'released',at:Date.now()});live.set('launcher-maintenance-lease',{id,kind:'renewal',state:'released',at:Date.now()});}
  notify(live,id);
  return {state:replaced?'uncertain':'failed',reason,run};
 }finally{process.off('SIGTERM',onTerm);process.off('SIGINT',onInt);if(activePreflight)await activePreflight.stop().catch(()=>{});activeProbe?.close();live.close();}
}
