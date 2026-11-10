import {Database} from 'bun:sqlite';
import {openSync,closeSync,fstatSync,readSync,readFileSync,existsSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ConfigSchema,QualificationSchema,BillingSchema,MeterSchema,type Meter} from './config';
import {releaseAvailable} from '../wallet/release';
import {awsRefusal} from '../wallet/ledger';
import {readReleaseBatch} from './release-batch';
import {originalSessionExpiry,supportedReleaseHold,collectReleaseReadiness} from './release-readiness';
import {relatedFactoryAlarm} from './alerts';
import {command} from '../adapters/github';
import {diskReading} from './disk';
import {processIdentity} from './process';
import {qualificationEvidenceVerified} from './qualification-evidence';
import {NativeReceipt} from '../adapters/native';
import {WorkerAccounting} from '../adapters/workers';
import {healthReleaseWindows,transitionFactoryHealth,initialFactoryHealthState,FactoryHealthStateSchema,pendingHealthDeliveries,beginHealthDelivery,acknowledgeHealthDelivery,type FactoryHealthSnapshot,type FactoryHealthState,type HealthDeliveryCommand} from './factory-health';
const failed=(at:number,reason:string)=>({state:'unavailable' as const,observedAt:at,reason});
const ok=<T>(at:number,receipt:string,value:T)=>({state:'ok' as const,observedAt:at,receipt,value});
function tail(path:string){const fd=openSync(path,'r');try{const stat=fstatSync(fd),n=Math.min(stat.size,65536),bytes=Buffer.alloc(n);readSync(fd,bytes,0,n,stat.size-n);return bytes.toString().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}finally{closeSync(fd);}}
export function freshestHealthReadings(dir:string,current:unknown):{codex?:Meter;claude?:Meter}{
 let saved:unknown;try{saved=JSON.parse(readFileSync(join(dir,'readings.json'),'utf8'));}catch{/* Fresh controller/native reads can recover a missing import. */}
 const result:{codex?:Meter;claude?:Meter}={};
 for(const provider of ['codex','claude'] as const){const candidates=[saved,current].flatMap(raw=>{const p=MeterSchema.safeParse(raw&&typeof raw==='object'?(raw as Record<string,unknown>)[provider]:undefined);return p.success?[p.data]:[];}).sort((a,b)=>b.observedAt-a.observedAt);
  if(candidates.length>1&&candidates[0]!.observedAt===candidates[1]!.observedAt&&JSON.stringify(candidates[0]!.windows)!==JSON.stringify(candidates[1]!.windows))throw Error('contradictory same-time native usage');
  if(candidates[0])result[provider]=candidates[0];
 }return result;
}
export async function collectFactoryHealth(dir:string,now:number,previousInactive:number|null=null,identity=processIdentity,execute=command):Promise<{snapshot:FactoryHealthSnapshot;inactive:number|null}>{
 const snapshot:FactoryHealthSnapshot={version:1,capturedAt:now};
 const disk=diskReading(undefined,now);snapshot.disk='error' in disk?failed(now,disk.error):ok(now,'statfs Data volume', {usedFraction:disk.usedFraction});
 try{const entries=tail(join(dir,'tick.log')).filter(x=>Number.isSafeInteger(x.at)&&x.at<=now&&['ok','error'].includes(x.status));const latest=entries.at(-1),last=entries.findLast(x=>x.status==='ok');snapshot.tick=latest&&last?ok(now,'bounded tick.log readback',{lastSuccessAt:last.at,lastAttemptAt:latest.at,result:latest.status==='ok'?'success':'failure'}):failed(now,'successful tick log evidence unavailable');}catch(error){snapshot.tick=failed(now,String(error));}
 let inactive:number|null=null;
 try {
  const rawPolicy=Bun.YAML.parse(readFileSync(join(dir,'config.yaml'),'utf8')),c=ConfigSchema.parse(rawPolicy);
  const db=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
  try{db.exec('PRAGMA busy_timeout=1000; BEGIN');
   const get=<T>(key:string):T|null=>{const row=db.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):null;};
   const paused=get<boolean>('paused');if(typeof paused!=='boolean')throw Error('controller pause state unavailable');
   const pause=db.query("SELECT id,at,data FROM events WHERE kind IN ('pause','resume') ORDER BY at DESC,rowid DESC LIMIT 1").get() as {id:string;at:number;data:string}|null;
   // Existing legacy pause events have no actor provenance. Never call them Vincent's.
   const provenance=pause?JSON.parse(pause.data):null;
   snapshot.controller=ok(now,'read-only controller snapshot',{paused,actor:provenance?.actor==='Vincent'?'Vincent':null,actorVerified:provenance?.actor==='Vincent'&&provenance?.verified===true,changedAt:pause?.at??now,changeReceipt:pause?.id??'unpaused controller readback'});
   try{
   const sessions=db.query("SELECT * FROM sessions LIMIT 10001").all() as {id:string;status:string;pid:number|null;native_id:string|null;provider:string;started:number|null;brief:string}[];
   if(sessions.length>10000)throw Error('session inventory truncated');
   const running=[];let workUnknown=false;
   for(const x of sessions.filter(x=>['starting','running'].includes(x.status))){
    const recorded=get<string>(`supervisor:${x.id}`),workspace=(db.query("SELECT data FROM events WHERE id=? AND kind='workspace'").get(`workspace:${x.id}`) as {data:string}|null);
    if(!x.pid||!x.native_id||!x.started||!recorded||!workspace){workUnknown=true;continue;}
    const observed=identity(x.pid),path=JSON.parse(workspace.data).workspace,t=JSON.parse(x.brief);
    const receipt=new NativeReceipt(x.provider,x.native_id,path,homedir(),x.started),accounting=new WorkerAccounting();for(let i=0;i<64;i++){receipt.poll(accounting);if(receipt.caughtUp)break;}
    const evidence=receipt.evidence(t.model,t.effort);
    if(observed!==recorded||!evidence.verified){workUnknown=true;continue;}
    running.push({sessionId:x.id,nativeSessionId:x.native_id,provider:x.provider,purpose:'work' as const,qualificationId:null,qualificationExpiresAt:null,wakeId:null,pid:x.pid,startedAt:x.started,observedAt:now,recordedIdentity:recorded,observedIdentity:observed,receipt:evidence.path!,state:'running' as const});
   }
   const latest=get<{at:number;status:string;ready?:number;refusals?:{reason:string}[]}>('heartbeat');
   const h=latest?.status==='ok'?latest:get<typeof latest>('last-successful-heartbeat');
   if(!h||h.status!=='ok'||now-h.at>300000||h.at>now||!Number.isSafeInteger(h.ready)||workUnknown)snapshot.work=failed(now,'complete current work custody unavailable');
   else {
    const ready=h.ready!,building=sessions.filter(x=>['starting','running'].includes(x.status)).length;
    const progress=db.query("SELECT id,at,kind FROM events WHERE (kind IN ('reservation','start-attempt','native-start-attempt','session-continuation','factory-challenge-started') OR (kind='worker-cleanup' AND json_extract(data,'$.verified')=1)) AND at<=? ORDER BY at DESC,rowid DESC LIMIT 1").get(now) as {id:string;at:number;kind:string}|null;
    const claim=db.query("SELECT id,at FROM events WHERE kind IN ('reservation','start-attempt','native-start-attempt','session-continuation','factory-challenge-started') AND at<=? AND at>? ORDER BY at DESC,rowid DESC LIMIT 1").get(now,now-20*60000) as {id:string;at:number}|null;
    const claims=claim?[{id:claim.id,heldSince:claim.at,receipt:`controller event ${claim.id}`}]:[];
    const floor=previousInactive??(claim?progress?.at??claim.at:now);
    inactive=running.length?null:Math.max(floor,progress?.at??floor);
    const reason=h.refusals?.[0]?.reason??'';
    const refusal=/qualif/.test(reason)?'qualification':/usage/.test(reason)?'usage':/slot|capacity/.test(reason)?'capacity':/wallet|billing/.test(reason)?'billing':/approval|intake/.test(reason)?'approval':'unknown';
    snapshot.work=ok(now,'controller heartbeat plus fresh native/process readback',{complete:true as const,ready,building,claims,running,inactiveSince:claims.length?null:inactive,refusal:refusal as 'qualification'|'usage'|'capacity'|'billing'|'approval'|'unknown'});
   }
   }catch(error){snapshot.work=failed(now,String(error));}
   try{
   const qualificationBytes=readFileSync(join(dir,'qualifications.json'),'utf8'),raw=JSON.parse(qualificationBytes),required=new Map<string,string>();
   for(const role of Object.values(c.owners)){const key=`${role.harness}:${role.effort}`;if(required.has(key)&&required.get(key)!==role.model)throw Error("conflicting required qualification models");required.set(key,role.model);}
   for(const [key,value] of Object.entries(raw)){const provider=key.split(':')[0],q=QualificationSchema.safeParse(value);if(['codex','claude'].includes(provider!)&&q.success&&!required.has(`${provider}:${q.data.effort}`))required.set(`${provider}:${q.data.effort}`,q.data.model);}
   const binding=get<{attempt:string;provider:string;qualificationId:string;expiresAt:number;nativeId:string;nativePath:string;workspace:string;pid:number;identity:string;startedAt:number;wake:string}>('codex-renewal-native');
   const slot=get<{id:string;state:string}>('codex-renewal-slot');
   const records=[...required].map(([key,model])=>{const q=QualificationSchema.safeParse(raw[key]??raw[key.split(':')[0]]),effort=key.split(':')[1],qualificationId=q.success?createHash('sha256').update(JSON.stringify(q.data)).digest('hex'):key;
    let renewal:null|NonNullable<Extract<NonNullable<FactoryHealthSnapshot['qualifications']>,{state:'ok'}>['value']['records'][number]['renewal']>=null;
    if(q.success&&binding?.provider===key&&binding.qualificationId===qualificationId&&binding.expiresAt===q.data.expiresAt&&slot?.id===binding.attempt&&slot.state==='running'){
     try{const observed=identity(binding.pid),receipt=new NativeReceipt('codex',binding.nativeId,binding.workspace,homedir(),binding.startedAt),accounting=new WorkerAccounting();for(let i=0;i<64;i++){receipt.poll(accounting);if(receipt.caughtUp)break;}if(observed===binding.identity&&receipt.evidence(model,effort!).verified){const at=Date.now();renewal={qualificationId,expiresAt:q.data.expiresAt,wakeId:binding.wake,sessionId:binding.attempt,nativeSessionId:binding.nativeId,receipt:binding.nativePath,process:{sessionId:binding.attempt,nativeSessionId:binding.nativeId,provider:key,purpose:'qualification-renewal',qualificationId,qualificationExpiresAt:q.data.expiresAt,wakeId:binding.wake,pid:binding.pid,startedAt:binding.startedAt,observedAt:at,recordedIdentity:binding.identity,observedIdentity:observed,receipt:binding.nativePath,state:'running'}};}}catch{/* Unknown custody never suppresses a qualification warning. */}
    }
    return {provider:key,qualificationId,verified:q.success&&q.data.model===model&&q.data.effort===effort&&qualificationEvidenceVerified(key.split(':')[0]!,q.data,qualificationBytes,dir),expiresAt:q.success?q.data.expiresAt:0,receipt:q.success?q.data.evidence:'missing evidence',renewal};});
   snapshot.qualifications=ok(Date.now(),'protected qualification file and exact live renewal readback',{required:[...required.keys()],records});
   }catch(error){snapshot.qualifications=failed(now,String(error));}
   try{
   const effects=db.query("SELECT key,value FROM kv WHERE key LIKE 'executor:%' LIMIT 10001").all() as {key:string;value:string}[];
   if(effects.length>10000)throw Error('release inventory truncated');
   const windows=effects.flatMap(row=>{const m=row.key.match(/^executor:(\d{4}-\d{2}-\d{2}):(qa|promote)$/);if(!m)return [];const e=JSON.parse(row.value),prefix=row.key+':';const events=db.query("SELECT at,data FROM events WHERE kind='release-executor' AND id LIKE ? ORDER BY at").all(prefix+'%') as {at:number;data:string}[];
    const started=events.find(r=>JSON.parse(r.data).kind===`${m[2]}:started`),completed=events.findLast(r=>[`${m[2]}:success`,`${m[2]}:failure`,`${m[2]}:deadline`].includes(JSON.parse(r.data).kind));
    let state=e.state==='success'?'success' as const:e.state==='failure'?'failed' as const:'running' as const,done=completed?.at??null,receipt=row.key;
    if(m[2]==='promote'&&e.state==='success'){
     const readback=effects.find(r=>r.key===`executor:${m[1]}:readback`);if(!readback)throw Error('required Production readback is unavailable');
     const result=JSON.parse(readback.value);receipt+=`;${readback.key}`;
     const final=db.query("SELECT at FROM events WHERE kind='release-executor' AND id IN (?,?,?) ORDER BY at DESC LIMIT 1").get(`executor:${m[1]}:readback:success`,`executor:${m[1]}:readback:failure`,`executor:${m[1]}:readback:deadline`) as {at:number}|null;
     state=result.state==='success'?'success':result.state==='failure'?'failed':'running';done=state==='running'?null:final?.at??null;
    }
    return [{windowId:`${m[1]}:${m[2]==='qa'?'qa':'production'}`,state,startedAt:started?.at??null,completedAt:done,receipt}];});
   const first=db.query('SELECT MIN(at) AS at FROM events').get() as {at:number|null};snapshot.releases=first.at===null?failed(now,'release history unavailable'):ok(now,'complete retained release executor inventory',{completeFrom:first.at,completeThrough:now,windows});
   }catch(error){snapshot.releases=failed(now,String(error));}
   try{const b=BillingSchema.parse(JSON.parse(readFileSync(join(dir,'release-billing.json'),'utf8')));snapshot.billing=ok(now,b.receipt,{verified:true,month:b.month,billingObservedAt:b.observedAt,allowed:releaseAvailable({db,get},c,b,rawPolicy,now)>=100});}catch(error){snapshot.billing=failed(now,String(error));}
   const day=healthReleaseWindows(now)[0]!.day,report=get<{day:string;validThrough:number;ready:boolean;missing:{input:string;reason:string}[]}>(`release-preflight-report:${day}`);if(report){const saved=db.query("SELECT at,data FROM events WHERE id=? AND kind='release-readiness'").get(`release-readiness:${day}`) as {at:number;data:string}|null;if(!saved||JSON.stringify(JSON.parse(saved.data))!==JSON.stringify(report))snapshot.readiness=failed(now,'authoritative preflight report receipt unavailable or mismatched');else snapshot.readiness=ok(saved.at,`release-preflight-report:${day}`,{day:report.day,validThrough:report.validThrough,ready:report.ready,missing:report.missing.map(m=>m.input)});}else snapshot.readiness=failed(now,'authoritative effective preflight report unavailable');
   const windows=healthReleaseWindows(now);
   if(now>=windows[0]!.startAt-3600000&&now<windows[1]!.endAt){
    try{
     // Recompute the effective checks through the existing read-only collector.
     // Cached billing retains its original age; no AWS refresh is performed.
     const b=BillingSchema.parse(JSON.parse(readFileSync(join(dir,'release-billing.json'),'utf8')));
     let carrier:ReturnType<typeof readReleaseBatch>|undefined;try{carrier=readReleaseBatch(dir,windows[0]!.day);}catch{/* Missing accepted carrier remains a concrete failed check. */}
     const billingRefusal=awsRefusal({db,get},c,now,b)??(releaseAvailable({db,get},c,b,rawPolicy,now)<100?'release wallet insufficient':null);
     const factorySource=(await execute(['git','rev-parse','HEAD'],join(import.meta.dir,'..'),8000)).trim();
     const report=await collectReleaseReadiness({dir,config:c,store:{get},brake:get('paused')!==false?'factory paused':billingRefusal,billingRefusal,billingEvidence:b,factorySource,carrier,now,identity,readings:freshestHealthReadings(dir,get('readings')),execute:async(args,cwd,timeout)=>execute(args,cwd,Math.min(timeout??8000,8000))});
     snapshot.readiness=ok(now,'fresh read-only effective release preflight',{day:report.day,validThrough:report.validThrough,ready:report.ready,missing:report.missing.map(m=>m.input)});
    }catch(error){snapshot.readiness=failed(now,String(error));}
   }
   db.exec('COMMIT');
  }finally{db.close();}
 }catch(error){snapshot.controller=failed(now,String(error));snapshot.work=failed(now,String(error));}
 // Existing non-secret sign-in provenance and cached budget import; never SSO
 // tokens, credential contents, AWS requests or a manufactured ready decision.
 try{const p=originalSessionExpiry(JSON.parse(readFileSync(join(dir,'release-auth-session.json'),'utf8')),now,0);snapshot.aws=ok(now,p.receipt,{verified:true,credentialId:createHash('sha256').update(p.receipt).digest('hex'),expiresAt:p.expiresAt});}catch(error){snapshot.aws=failed(now,String(error));}
 try{const [variable,issue]=await Promise.all([execute(['gh','api','--method','GET','repos/fulmar-hq/alido/actions/variables/QA_HOLD'],undefined,8000),execute(['gh','api','--method','GET','repos/fulmar-hq/alido/issues/1192'],undefined,8000)]),v=supportedReleaseHold(JSON.parse(JSON.parse(variable).value)),i=JSON.parse(issue);if(!Array.isArray(i.labels)||i.labels.length>=100)throw Error('supported release hold readback unavailable');let blocking=v.held||i.labels.some((l:{name:string})=>['qa hold','qa-hold'].includes(l.name.toLowerCase()));if(v.legacy_issue!==null&&v.legacy_issue!==1192){if(!Number.isSafeInteger(v.legacy_issue)||v.legacy_issue<1)throw Error('legacy hold identity unavailable');const legacy=JSON.parse(await execute(['gh','api','--method','GET',`repos/fulmar-hq/alido/issues/${v.legacy_issue}`],undefined,8000));if(!Array.isArray(legacy.labels)||legacy.labels.length>=100)throw Error('legacy hold labels unavailable');blocking ||= legacy.labels.some((l:{name:string})=>['qa hold','qa-hold'].includes(l.name.toLowerCase()));}snapshot.holds=ok(now,'fresh supported GitHub hold and release-board labels',{blocking});}catch(error){snapshot.holds=failed(now,String(error));}
 return {snapshot,inactive};
}

export function healthBridge(path:string){
 if(!existsSync(path))throw Error('existing Alido Mail bridge unavailable');
 const db=new Database(path,{readwrite:true,strict:true});db.exec('PRAGMA busy_timeout=1000');
 return {close:()=>db.close(),send:(id:string,recipient:'Vincent'|'Coordinator',message:string)=>{
  db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state) VALUES(?,?,?,'Factory Desk','codex','factory-health',?,?,'fyi','none',?,'',?,0,?,'unread','pending')`).run(id,id,Date.now(),recipient,recipient==='Vincent'?'telegram':'claude',message,id,createHash('sha256').update(message).digest('hex'));
  const row=db.query('SELECT recipient,recipient_app,summary,hash FROM messages WHERE id=?').get(id) as {recipient:string;recipient_app:string;summary:string;hash:string}|null;
  if(!row||row.recipient!==recipient||row.recipient_app!==(recipient==='Vincent'?'telegram':'claude')||row.summary!==message||row.hash!==createHash('sha256').update(message).digest('hex'))throw Error('bridge id belongs to different notification; retained for reconciliation');
 },delivered:(id:string,recipient:'Vincent'|'Coordinator')=>{
  if(recipient==='Vincent'){const row=db.query('SELECT message_id,sent_at FROM telegram_messages WHERE mail_id=?').get(id) as {message_id:number;sent_at:number}|null;return row?`telegram:${row.message_id}:${row.sent_at}`:null;}
  const row=db.query("SELECT state,wake_state,wake_id FROM messages WHERE id=?").get(id) as {state:string;wake_state:string;wake_id:string|null}|null;
  return row?.wake_state==='woken'&&row.wake_id?`alido-mail:${id}:${row.wake_id}`:null;
 }};
}
export async function watchFactoryHealth(dir:string,mail:string,at?:number,ports:{execute?:typeof command;identity?:typeof processIdentity}={}){
 const clock=at===undefined?Date.now:()=>at;let now=clock();
 mkdirSync(join(dir,'health'),{recursive:true,mode:0o700});const db=new Database(join(dir,'health','state.sqlite'),{create:true,strict:true});
 db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,inactive INTEGER); CREATE TABLE IF NOT EXISTS delivery_links(notification TEXT NOT NULL,recipient TEXT NOT NULL,bridge_id TEXT NOT NULL,PRIMARY KEY(notification,recipient)); CREATE TABLE IF NOT EXISTS delivery_failures(notification TEXT NOT NULL,recipient TEXT NOT NULL,at INTEGER NOT NULL,error TEXT NOT NULL);');
 try{db.exec('BEGIN IMMEDIATE');const row=db.query('SELECT json,inactive FROM state WHERE id=1').get() as {json:string;inactive:number|null}|null;
  const old=row?FactoryHealthStateSchema.parse(JSON.parse(row.json)):initialFactoryHealthState(),collected=await collectFactoryHealth(dir,now,row?.inactive??null,ports.identity??processIdentity,ports.execute??command);
  const evaluated=clock();if(evaluated<now)throw Error("health collection clock regressed");now=evaluated;collected.snapshot.capturedAt=now;
  let {state,evaluation}=transitionFactoryHealth(old,collected.snapshot,()=>now);
  const save=()=>db.query('INSERT INTO state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,inactive=excluded.inactive').run(JSON.stringify(state),collected.inactive);
  save();db.exec('COMMIT');
  const bridge=healthBridge(mail);
  try{for(const pending of pendingHealthDeliveries(state,()=>now)){
   try{

   db.exec('BEGIN IMMEDIATE');const current=db.query('SELECT json FROM state WHERE id=1').get() as {json:string};state=FactoryHealthStateSchema.parse(JSON.parse(current.json));
   const begun=beginHealthDelivery(state,pending.notificationId,pending.recipient,()=>now);state=begun.state;
   const command=begun.command,id=command.idempotencyKey,condition=state.outbox.find(n=>n.id===command.notificationId)!.condition;
   let link=db.query('SELECT bridge_id FROM delivery_links WHERE notification=? AND recipient=?').get(command.notificationId,command.recipient) as {bridge_id:string}|null;
   if(!link){const related=command.recipient==='Vincent'&&command.kind==='opening'&&['qualification','disk','release','work'].includes(condition)?relatedFactoryAlarm(mail,condition as 'qualification'|'disk'|'release'|'work',now,id):null;link={bridge_id:related?.id??id};db.query('INSERT INTO delivery_links VALUES(?,?,?)').run(command.notificationId,command.recipient,link.bridge_id);}
   save();db.exec('COMMIT');
   if(link.bridge_id===id)bridge.send(id,command.recipient,command.message);
   const receipt=bridge.delivered(link.bridge_id,command.recipient);
   if(receipt){db.exec('BEGIN IMMEDIATE');const latest=db.query('SELECT json FROM state WHERE id=1').get() as {json:string};state=acknowledgeHealthDelivery(FactoryHealthStateSchema.parse(JSON.parse(latest.json)),command,{state:'delivered',receipt},()=>now);save();db.exec('COMMIT');}
   }catch(error){if(db.inTransaction)db.exec('ROLLBACK');db.query('INSERT INTO delivery_failures VALUES(?,?,?,?)').run(pending.notificationId,pending.recipient,now,String(error));}
  }}finally{bridge.close();}
  const heartbeat=join(dir,'health',`heartbeat-${crypto.randomUUID()}.json`);writeFileSync(heartbeat,JSON.stringify({at:now}),{mode:0o600});renameSync(heartbeat,join(dir,'health','heartbeat.json'));
  return {at:now,findings:evaluation.findings,outbox:state.outbox.length};
 }finally{if(db.inTransaction)db.exec('ROLLBACK');db.close();}
}
export function rehearseFactoryAlarm(mail:string,day:string,now=Date.now()){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('rehearsal date required');
 const result=transitionFactoryHealth(initialFactoryHealthState(),{version:1,capturedAt:now,disk:ok(now,'explicit synthetic alarm rehearsal',{usedFraction:0.9})},()=>now);
 if(!result.state.outbox.some(n=>n.condition==='disk'&&n.kind==='opening'))throw Error('alarm evaluator rehearsal failed');
 const bridge=healthBridge(mail),id=`factory-alarm-test:${day}`;
 try{bridge.send(id,'Vincent','This is a test of the new factory alarm. This message is a rehearsal, so no real factory fault is being reported.');return {id,queued:true,delivered:bridge.delivered(id,'Vincent')};}finally{bridge.close();}
}

export {healthOwnsAlerts} from './alerts';
