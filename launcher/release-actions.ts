import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mailPath} from './alerts';
export type ReleaseOwner='Release'|'Quality'|'Platform'|'Coordinator';
// Existing Alido Mail only. Stable IDs and exact readback make a lost reply safe
// to retry; no Telegram/customer recipient or new mail store is permitted.
export function releaseAction(id:string,to:ReleaseOwner,summary:string,body:string,now=Date.now(),path=mailPath()) {
 if(!existsSync(path))throw Error('existing Alido Mail outbox unavailable');
 if(summary.length>120||body.length>800)throw Error('release action exceeds mail bounds');
 const db=new Database(path,{readwrite:true,strict:true}),hash=createHash('sha256').update(summary+'\n'+body).digest('hex');
 try{
  db.exec('PRAGMA busy_timeout=1000');
  db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
   VALUES(?,?,?,'Factory Desk','codex','factory-release-operations',?,?,'action','none',?,?,?,0,?,'unread','pending')`)
   .run(id,id,now,to,to==='Coordinator'?'claude':'codex',summary,body,id,hash);
  const row=db.query('SELECT recipient,recipient_app,kind,summary,body,hash FROM messages WHERE id=?').get(id) as Record<string,unknown>|null;
  if(!row||row.recipient!==to||row.recipient_app!==(to==='Coordinator'?'claude':'codex')||row.kind!=='action'||row.summary!==summary||row.body!==body||row.hash!==hash)throw Error('release action identity conflict');
  return {id,queued:true};
 }finally{db.close();}
}
