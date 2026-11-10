import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join,dirname } from "node:path";
import { Store } from "../tracking/store";
import { QualificationSchema } from "./config";

export const mailPath = () => process.env.FACTORY_MAIL_DB ?? join(homedir(), ".alido-private/mail/mail.sqlite");

// A stable episode ID survives retries/restarts and a crash between stores.
// Failure to notify never opens admission; later ticks retry the same alarm.
export function diskCapacityAlert(s:Store,now:number,path=mailPath()) {
 const r=s.get<{state:string;episode?:string;freeGiB?:number;usedFraction?:number}>('disk-capacity');
 if(!r || !['critical','unknown'].includes(r.state) || !r.episode || s.get(`alert:${r.episode}`))return;
 if(r.state==='critical'&&(r.usedFraction??0)>0.85&&((s.db.filename!==':memory:'&&healthOwnsAlerts(dirname(s.db.filename),now))||relatedFactoryAlarm(path,'disk',now,'',true)))return;
 const summary=r.state==='unknown' ? 'Factory cannot read free disk space; new work is blocked.' : `Factory has ${r.freeGiB?.toFixed(1)} GiB free; new work is blocked below 30 GiB. Please inspect factory capacity.`;
 try {
  if(!existsSync(path))throw Error('existing Telegram bridge store unavailable');
  const db=new Database(path,{readwrite:true,strict:true});
  try {
   db.exec('PRAGMA busy_timeout=10000');
   db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
     VALUES(?,?,?,'Factory Desk','codex','factory-disk','Vincent','telegram','blocker','none',?,'',?,0,?,'unread','pending')`)
     .run(r.episode,r.episode,now,summary,r.episode,createHash('sha256').update(summary).digest('hex'));
  }finally{db.close();}
  s.set(`alert:${r.episode}`,{queuedAt:now,path});
  s.event(`alert:${r.episode}`,'disk-alert-queued',{episode:r.episode,summary},'Retain bridge receipt; rearm only after recovery',now);
 }catch(error){s.event(crypto.randomUUID(),'disk-alert-failure',{episode:r.episode,error:String(error)},'Retry the same alarm; admission stays closed',now);}
}

// Use the existing bridge's outbox; never create a replacement store or bot.
// Stable IDs make retries after a crash idempotent across both SQLite stores.
export function qualificationAlerts(s: Store, qualifications: Record<string, unknown>, now: number, path = mailPath()) {
  if(s.db.filename!==':memory:'&&healthOwnsAlerts(dirname(s.db.filename),now))return;
  for (const provider of ["codex", "claude"]) {
    const parsed = QualificationSchema.safeParse(qualifications[provider]);
    if (!parsed.success) continue;
    const q = parsed.data;
    if (q.expiresAt > now + 2 * 60 * 60 * 1000) continue;
    const id = `qualification-expiry:${provider}:${q.expiresAt}`;
    if(relatedFactoryAlarm(path,'qualification',now,id,true))continue;
    if (s.get(id)) continue;
    const summary = `Factory ${provider} qualification ${q.expiresAt <= now ? "expired" : `expires at ${new Date(q.expiresAt).toISOString()}`}; requalify before more work.`;
    try {
      if (!existsSync(path)) throw Error("existing Telegram bridge store unavailable");
      const db = new Database(path, { readwrite: true, strict: true });
      try {
        db.exec("PRAGMA busy_timeout=10000");
        db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
          VALUES(?,?,?,'Factory Desk','codex','factory-launcher','Vincent','telegram','fyi','none',?,'',?,0,?,'unread','pending')`)
          .run(id, id, now, summary, id, createHash("sha256").update(summary).digest("hex"));
      } finally { db.close(); }
      s.set(id, {queuedAt:now, path});
      s.event(id, "qualification-expiry-alert", {provider, expiresAt:q.expiresAt, summary}, "Retain the bridge receipt; requalify with fresh native evidence. Never replay this alert.", now);
    } catch (error) {
      s.event(`alert-failure:${id}`, "qualification-alert-failure", {provider, error:String(error)}, "Restore the existing bridge; a later tick retries the same alert ID.", now);
    }
  }
}

// Independent alarm owns overlapping notifications only while its completed
// heartbeat remains fresh. Failed/stopped monitoring restores the legacy path.
export function healthOwnsAlerts(dir:string,now:number){try{const value=JSON.parse(readFileSync(join(dir,'health','heartbeat.json'),'utf8'));return Number.isSafeInteger(value.at)&&value.at>=0&&value.at<=now&&now-value.at<=10*60000;}catch{return false;}}

export function relatedFactoryAlarm(path:string,condition:'qualification'|'disk'|'release',now:number,except='',healthOnly=false):{id:string;summary:string}|null{
 if(!existsSync(path))return null;const db=new Database(path,{readonly:true,strict:true});
 try{const legacy=healthOnly?'0':condition==='qualification'?"id LIKE 'qualification-expiry:%'":condition==='disk'?"sender_ref='factory-disk'":"id LIKE 'release-preflight-missing:%'";
 const rows=db.query(`SELECT id,summary,created_at FROM messages WHERE recipient='Vincent' AND recipient_app='telegram' AND id<>? AND created_at<=? AND (id LIKE ? OR (${legacy})) ORDER BY created_at DESC LIMIT 32`).all(except,now,`factory-health:${condition}:%:opening:Vincent`) as {id:string;summary:string;created_at:number}[];
 for(const row of rows){if(row.created_at>=now-2*3600000)return row;const table=db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_messages'").get();if(!table||!db.query('SELECT 1 FROM telegram_messages WHERE mail_id=? LIMIT 1').get(row.id))return row;}return null;
 }finally{db.close();}
}
