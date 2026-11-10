import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync,readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "../tracking/store";
import { QualificationSchema } from "./config";

export const mailPath = () => process.env.FACTORY_MAIL_DB ?? join(homedir(), ".alido-private/mail/mail.sqlite");

// Use the existing bridge's outbox; never create a replacement store or bot.
// Stable IDs make retries after a crash idempotent across both SQLite stores.
export function qualificationAlerts(s: Store, qualifications: Record<string, unknown>, now: number, path = mailPath()) {
  for (const provider of ["codex", "claude"]) {
    const parsed = QualificationSchema.safeParse(qualifications[provider]);
    if (!parsed.success) continue;
    const q = parsed.data;
    if (q.expiresAt > now + 2 * 60 * 60 * 1000) continue;
    const id = `qualification-expiry:${provider}:${q.expiresAt}`;
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
