import {Database} from 'bun:sqlite';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigSchema,type Config} from './config';
import {usageGate} from './engine';

export type IdleQueueObservation={at:number;eligible:boolean;reason:string;lastActivity:number;heartbeatAt:number};
type Reader={query:Database['query']};
// This observer never changes controller custody. Reviews and owner turns do not
// count as builder progress. Unknown dormant custody cannot establish idleness.
export function observeIdleQueue(db:Reader,c:Config,now:number):IdleQueueObservation {
 const get=<T>(key:string):T|null=>{const r=db.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return r?JSON.parse(r.value):null;};
 const no=(reason:string):IdleQueueObservation=>({at:now,eligible:false,reason,lastActivity:now,heartbeatAt:now});
 if(get('paused')!==false)return no('paused');
 const latest=get<{at:number;status:string;ready?:number;claimed?:number}>('heartbeat');
 const h=latest?.status==='reconciling'?get<typeof latest>('last-successful-heartbeat'):latest;
 if(!h||h.status!=='ok'||h.ready!==0||h.at>now||now-h.at>300000)return no('queue not freshly confirmed empty');
 for(const project of Object.values(c.projects)){
  const inventory=get<{observedAt:number;count?:number;truncated?:boolean;error?:string|null}>(`github:${project.repo}`);
  if(!inventory||inventory.error||inventory.truncated!==false||!Number.isSafeInteger(inventory.count)||inventory.observedAt>h.at||now-inventory.observedAt>300000)return no('complete fresh project inventory unavailable');
 }
 const sessions=db.query("SELECT id,status,pid FROM sessions WHERE status!='archived' LIMIT 10001").all() as {id:string;status:string;pid:number|null}[];
 if(sessions.length>10000)return no('session inventory truncated');
 for(const x of sessions){
  if(!['finished','paused','waiting-browser','waiting-person','waiting-question','question'].includes(x.status)||x.pid!==null||get<{verified:boolean}>(`cleanup-evidence:${x.id}`)?.verified!==true)return no('builder active or custody unknown');
 }
 const provider=c.owners[c.autonomy?.intake_owner??'product']?.harness;
 if(!provider)return no('product provider unavailable');
 try{usageGate(get<Record<string,unknown>>('readings')?.[provider],true,now,c,provider);}catch{return no('usage does not allow work');}
 // Actual builder start/cleanup receipts survive observer restarts. Maintenance
 // challenge starts are intentionally absent from this query.
 const activity=db.query("SELECT MAX(at) AS at FROM events WHERE kind IN ('reservation','start-attempt','native-start-attempt','session-continuation','worker-cleanup','worker-exit','worker-halt','worker-failure') AND at<=?").get(now) as {at:number|null};
 if(activity.at===null)return no('builder history unavailable');
 return {at:now,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity:activity.at,heartbeatAt:h.at};
}

export function watchIdleQueue(dir:string,mail:string,now=Date.now()) {
 const c=ConfigSchema.parse(Bun.YAML.parse(readFileSync(join(dir,'config.yaml'),'utf8')));
 const controller=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
 let observation:IdleQueueObservation;
 try{controller.exec('PRAGMA busy_timeout=1000; BEGIN');observation=observeIdleQueue(controller,c,now);}finally{controller.close();}
 mkdirSync(join(dir,'health'),{recursive:true,mode:0o700});
 const state=new Database(join(dir,'health','idle-queue.sqlite'),{create:true,strict:true});
 try{
  state.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS observations(at INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,opened INTEGER NOT NULL,queued INTEGER,wake TEXT,evidence TEXT);');
  if(!(state.query('PRAGMA table_info(incidents)').all() as {name:string}[]).some(x=>x.name==='evidence'))state.exec('ALTER TABLE incidents ADD COLUMN evidence TEXT');
  state.query('INSERT OR IGNORE INTO observations VALUES(?,?)').run(now,JSON.stringify(observation));
  const current=observation.eligible&&now-observation.lastActivity>20*60000?`factory-idle-queue:${observation.lastActivity}`:null;
  if(current)state.query('INSERT OR IGNORE INTO incidents(id,opened,evidence) VALUES(?,?,?)').run(current,now,JSON.stringify({source:'watcher',observation}));
  const pending=state.query('SELECT id,evidence FROM incidents WHERE wake IS NULL ORDER BY opened LIMIT 100').all() as {id:string;evidence:string|null}[];
  if(!pending.length){const prior=current?state.query('SELECT wake FROM incidents WHERE id=?').get(current) as {wake:string|null}|null:null;return {...observation,alert:current,wake:prior?.wake??null};}
  if(!existsSync(mail))throw Error('existing Alido Mail bridge unavailable');
  const bridge=new Database(mail,{readwrite:true,strict:true});
  try{
   bridge.exec('PRAGMA busy_timeout=1000');
   const summary='Factory had an empty queue and idle builders for over 20 minutes while usage allowed high-benefit work.';
   const body='Restore useful product-only supply and verify actual builder claims. If work has resumed, confirm the product-only top-up remains loaded. Retained incident evidence is in health/idle-queue.sqlite.';
   const hash=createHash('sha256').update(summary+'\n'+body).digest('hex');
   let alert:string|null=current,wake:string|null=null;
   for(const incident of pending){
   if(!incident.evidence)throw Error('retained idle incident needs original evidence; do not manufacture an observation');
   JSON.parse(incident.evidence);
   const id=incident.id;
   bridge.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state) VALUES(?,?,?,'Factory Desk','codex','factory-idle-queue','Coordinator','claude','action','none',?,?,?,0,?,'unread','pending')`).run(id,id,now,summary,body,id,hash);
   const row=bridge.query('SELECT kind,hash,wake_state,wake_id FROM messages WHERE id=?').get(id) as {kind:string;hash:string;wake_state:string;wake_id:string|null}|null;
   if(row?.kind!=='action'||row.hash!==hash)throw Error('idle alert identity conflicts; retain for reconciliation');
   state.query('UPDATE incidents SET queued=COALESCE(queued,?),wake=? WHERE id=?').run(now,row.wake_state==='woken'?row.wake_id:null,id);
   alert=id;wake=row.wake_state==='woken'?row.wake_id:null;
   }
   return {...observation,alert,wake};
  }finally{bridge.close();}
 }finally{state.close();}
}
