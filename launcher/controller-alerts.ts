import {Database} from 'bun:sqlite';
import {existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// Independent of controller.sqlite: a locked controller must still wake its owner.
function stateAt(dir:string){
 mkdirSync(join(dir,'health'),{recursive:true,mode:0o700});
 const db=new Database(join(dir,'health','controller-alerts.sqlite'),{create:true,strict:true});
 db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,at INTEGER NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,wake TEXT); CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);');
 return db;
}
export function flushControllerAlerts(dir:string,mail:string,now=Date.now()){
 const state=stateAt(dir);
 try{
  const pending=state.query('SELECT * FROM incidents WHERE wake IS NULL ORDER BY at LIMIT 100').all() as {id:string;summary:string;body:string}[];
  if(!pending.length)return;
  if(!existsSync(mail))throw Error('existing Alido Mail bridge unavailable');
  const bridge=new Database(mail,{readwrite:true,strict:true});
  try{bridge.exec('PRAGMA busy_timeout=1000');for(const x of pending){
   const hash=createHash('sha256').update(x.summary+'\n'+x.body).digest('hex');
   bridge.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state) VALUES(?,?,?,'Factory Desk','codex','factory-controller','Coordinator','claude','action','none',?,?,?,0,?,'unread','pending')`).run(x.id,x.id,now,x.summary,x.body,x.id,hash);
   const row=bridge.query('SELECT kind,hash,wake_state,wake_id FROM messages WHERE id=?').get(x.id) as {kind:string;hash:string;wake_state:string;wake_id:string|null}|null;
   if(row?.kind!=='action'||row.hash!==hash)throw Error('controller alert identity conflicts');
   // Queueing is not proof of waking. Keep retrying the same stable mail ID.
   if(row.wake_state==='woken'&&row.wake_id)state.query('UPDATE incidents SET wake=? WHERE id=?').run(row.wake_id,x.id);
  }}finally{bridge.close();}
 }finally{state.close();}
}
export function recordTickResult(dir:string,mail:string,result:{at:number;status:string}){
 const db=stateAt(dir);
 try{db.transaction(()=>{
  if(result.status!=='error'){db.query("INSERT OR REPLACE INTO state VALUES('tick-episode',NULL)").run();db.query("INSERT OR REPLACE INTO state VALUES('tick-first-error',NULL)").run();return;}
  const prior=db.query("SELECT value FROM state WHERE key='tick-episode'").get() as {value:string|null}|null;
  if(prior?.value)return;
  // One failed tick that the next tick repairs is not worth a wake-up. Page
  // only on the second consecutive failure, naming when the episode began.
  const first=db.query("SELECT value FROM state WHERE key='tick-first-error'").get() as {value:string|null}|null;
  if(!first?.value){db.query("INSERT OR REPLACE INTO state VALUES('tick-first-error',?)").run(String(result.at));return;}
  const id=`factory-tick-error:${first.value}`;
  db.query('INSERT OR IGNORE INTO incidents(id,at,summary,body) VALUES(?,?,?,?)').run(id,result.at,'Factory launcher ticks failed twice in a row; inspect them.','Read tick.log and tick.error.log for the retained failure. Reconcile controller locks and custody with normal controls; preserve work, usage gates and release windows.');
  db.query("INSERT OR REPLACE INTO state VALUES('tick-episode',?)").run(id);
 }).immediate();}finally{db.close();}
 flushControllerAlerts(dir,mail,result.at);
}
export function watchControllerAlerts(dir:string,mail:string,now=Date.now()){
 // Retry retained tick incidents before opening the controller, even if it fails.
 try{flushControllerAlerts(dir,mail,now);}catch(error){
  // Delivery and observation are independent: a bridge outage must not erase
  // a new pause incident that disappears before the bridge recovers.
  console.error('controller alert delivery retained for retry: '+String(error));
 }
 const controller=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
 let pause:{id:string;at:number}|null=null;
 try{controller.exec('PRAGMA busy_timeout=1000; BEGIN');
  const get=(key:string)=>{const row=controller.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):null;};
  if(get('paused')!==true)return {pausedReady:false};
  const latest=get('heartbeat'),h=latest?.status==='ok'?latest:get('last-successful-heartbeat');
  if(!h||h.status!=='ok'||!Number.isSafeInteger(h.at)||h.at<=0||h.at>now||now-h.at>15*60000||!Number.isSafeInteger(h.ready)||h.ready<=0)return {pausedReady:false};
  if(controller.query("SELECT id FROM sessions WHERE status IN ('starting','running') LIMIT 1").get())return {pausedReady:false};
  const p=controller.query("SELECT id,at,kind FROM events WHERE kind IN ('pause','resume') ORDER BY at DESC,rowid DESC LIMIT 1").get() as {id:string;at:number;kind:string}|null;
  if(p?.kind==='pause'&&Number.isSafeInteger(p.at)&&p.at>0&&p.at<=now-5*60000)pause=p;
 }finally{controller.close();}
 if(pause){const db=stateAt(dir);try{db.query('INSERT OR IGNORE INTO incidents(id,at,summary,body) VALUES(?,?,?,?)').run(`factory-paused-ready:${pause.id}`,now,'Factory is paused with ready tasks and no running builders.','Inspect the pause and reconcile stopped work. Resume through the normal owner control when authorized, then verify actual claims in tick.log. This alert never resumes the factory or changes admission gates.');}finally{db.close();}flushControllerAlerts(dir,mail,now);}
 return {pausedReady:!!pause};
}
