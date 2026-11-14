import {publisherBoundary,publisherQualificationVerified} from './publisher-evidence';
import {Database} from 'bun:sqlite';
import {openSync,closeSync,fstatSync,readSync,readFileSync,existsSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {ConfigSchema,QualificationSchema} from './config';
import {relatedFactoryAlarm} from './alerts';
import {diskReading} from './disk';
import {processIdentity} from './process';
import {qualificationEvidenceVerified} from './qualification-evidence';
import {NativeReceipt} from '../adapters/native';
import {WorkerAccounting} from '../adapters/workers';
import {transitionFactoryHealth,initialFactoryHealthState,FactoryHealthStateSchema,pendingHealthDeliveries,beginHealthDelivery,acknowledgeHealthDelivery,type FactoryHealthSnapshot} from './factory-health';
const failed=(at:number,reason:string)=>({state:'unavailable' as const,observedAt:at,reason});
const ok=<T>(at:number,receipt:string,value:T)=>({state:'ok' as const,observedAt:at,receipt,value});
function tail(path:string){const fd=openSync(path,'r');try{const stat=fstatSync(fd),n=Math.min(stat.size,65536),bytes=Buffer.alloc(n);readSync(fd,bytes,0,n,stat.size-n);return bytes.toString().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}finally{closeSync(fd);}}
export function collectFactoryHealth(dir:string,now:number,identity=processIdentity):{snapshot:FactoryHealthSnapshot}{
 const snapshot:FactoryHealthSnapshot={version:1,capturedAt:now};
 const disk=diskReading(undefined,now);snapshot.disk='error' in disk?failed(now,disk.error):ok(now,'statfs Data volume', {usedFraction:disk.usedFraction});
 try{const entries=tail(join(dir,'tick.log')).filter(x=>Number.isSafeInteger(x.at)&&x.at<=now&&['ok','error'].includes(x.status));const latest=entries.at(-1),last=entries.findLast(x=>x.status==='ok');snapshot.tick=latest&&last?ok(now,'bounded tick.log readback',{lastSuccessAt:last.at,lastAttemptAt:latest.at,result:latest.status==='ok'?'success':'failure'}):failed(now,'successful tick log evidence unavailable');}catch(error){snapshot.tick=failed(now,String(error));}
 try {
  const c=ConfigSchema.parse(Bun.YAML.parse(readFileSync(join(dir,'config.yaml'),'utf8')));
  const db=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
  try{db.exec('PRAGMA busy_timeout=1000; BEGIN');
   const get=<T>(key:string):T|null=>{const row=db.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):null;};
   const paused=get<boolean>('paused');if(typeof paused!=='boolean')throw Error('controller pause state unavailable');
   const pause=db.query("SELECT id,at,data FROM events WHERE kind IN ('pause','resume') ORDER BY at DESC,rowid DESC LIMIT 1").get() as {id:string;at:number;data:string}|null;
   // Existing legacy pause events have no actor provenance. Never call them Vincent's.
   const provenance=pause?JSON.parse(pause.data):null;
   snapshot.controller=ok(now,'read-only controller snapshot',{paused,actor:provenance?.actor==='Vincent'?'Vincent':null,actorVerified:provenance?.actor==='Vincent'&&provenance?.verified===true,changedAt:pause?.at??now,changeReceipt:pause?.id??'unpaused controller readback'});
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
   const publisher=get<{version:number;expiresAt:number;evidence:string}>('delivery-qualified');
   records.push({provider:'publisher:v2',qualificationId:createHash('sha256').update(JSON.stringify(publisher)).digest('hex'),verified:publisherQualificationVerified(dir,publisher,qualificationBytes,publisherBoundary(join(import.meta.dir,'..'),dir)),expiresAt:publisher?.expiresAt??0,receipt:publisher?.evidence??'missing publisher evidence',renewal:null});
   snapshot.qualifications=ok(Date.now(),'protected qualification file, publisher adoption and exact live renewal readback',{required:[...required.keys(),'publisher:v2'],records});
   }catch(error){snapshot.qualifications=failed(now,String(error));}
   db.exec('COMMIT');
  }finally{db.close();}
 }catch(error){snapshot.controller=failed(now,String(error));}
 return {snapshot};
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
export function watchFactoryHealth(dir:string,mail:string,at?:number,ports:{identity?:typeof processIdentity}={}){
 const clock=at===undefined?Date.now:()=>at;let now=clock();
 mkdirSync(join(dir,'health'),{recursive:true,mode:0o700});const db=new Database(join(dir,'health','state.sqlite'),{create:true,strict:true});
 db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,inactive INTEGER); CREATE TABLE IF NOT EXISTS delivery_links(notification TEXT NOT NULL,recipient TEXT NOT NULL,bridge_id TEXT NOT NULL,PRIMARY KEY(notification,recipient)); CREATE TABLE IF NOT EXISTS delivery_failures(notification TEXT NOT NULL,recipient TEXT NOT NULL,at INTEGER NOT NULL,error TEXT NOT NULL);');
 try{db.exec('BEGIN IMMEDIATE');const row=db.query('SELECT json,inactive FROM state WHERE id=1').get() as {json:string;inactive:number|null}|null;
  const old=row?FactoryHealthStateSchema.parse(JSON.parse(row.json)):initialFactoryHealthState(),collected=collectFactoryHealth(dir,now,ports.identity??processIdentity);
  const evaluated=clock();if(evaluated<now)throw Error("health collection clock regressed");now=evaluated;collected.snapshot.capturedAt=now;
  let {state,evaluation}=transitionFactoryHealth(old,collected.snapshot,()=>now);
  const save=()=>db.query('INSERT INTO state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,inactive=excluded.inactive').run(JSON.stringify(state),null);
  save();db.exec('COMMIT');
  const bridge=healthBridge(mail);
  try{for(const pending of pendingHealthDeliveries(state,()=>now)){
   try{

   db.exec('BEGIN IMMEDIATE');const current=db.query('SELECT json FROM state WHERE id=1').get() as {json:string};state=FactoryHealthStateSchema.parse(JSON.parse(current.json));
   const begun=beginHealthDelivery(state,pending.notificationId,pending.recipient,()=>now);state=begun.state;
   const command=begun.command,id=command.idempotencyKey,condition=state.outbox.find(n=>n.id===command.notificationId)!.condition;
   let link=db.query('SELECT bridge_id FROM delivery_links WHERE notification=? AND recipient=?').get(command.notificationId,command.recipient) as {bridge_id:string}|null;
   if(!link){const related=command.recipient==='Vincent'&&command.kind==='opening'&&['qualification','disk'].includes(condition)?relatedFactoryAlarm(mail,condition as 'qualification'|'disk',now,id):null;link={bridge_id:related?.id??id};db.query('INSERT INTO delivery_links VALUES(?,?,?)').run(command.notificationId,command.recipient,link.bridge_id);}
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
