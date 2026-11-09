import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
    const expiresSummary = `Factory ${provider} qualification expires at ${new Date(q.expiresAt).toISOString()}; requalify before more work.`;
    const expiredSummary = `Factory ${provider} qualification expired; requalify before more work.`;
    let summary = q.expiresAt <= now ? expiredSummary : expiresSummary;
    try {
      if (!existsSync(path)) throw Error("existing Telegram bridge store unavailable");
      const db = new Database(path, { readwrite: true, strict: true });
      try {
        db.exec("PRAGMA busy_timeout=10000");
        db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
          VALUES(?,?,?,'Factory Desk','codex','factory-launcher','Vincent','telegram','fyi','none',?,'',?,0,?,'unread','pending')`)
          .run(id, id, now, summary, id, createHash("sha256").update(summary).digest("hex"));
        // OR IGNORE is not a receipt: a conflicting ID or an ignored insert
        // must never manufacture controller success. Delivery fields may advance.
        const row = db.query("SELECT * FROM messages WHERE id=?").get(id) as Record<string, unknown> | null;
        if (!row) throw Error("qualification bridge readback missing");
        const expected = {
          id, send_id:id, sender:"Factory Desk", sender_app:"codex", sender_ref:"factory-launcher",
          recipient:"Vincent", recipient_app:"telegram", kind:"fyi", reply:"none", body:"", thread_id:id, depth:0,
        };
        // A pre-expiry insert can be recovered after expiry without rewriting
        // its legitimate earlier wording or resetting an already delivered row.
        if (Object.entries(expected).some(([key, value]) => row[key] !== value)
          || (row.summary !== expiresSummary && !(q.expiresAt <= now && row.summary === expiredSummary))
          || row.hash !== createHash("sha256").update(String(row.summary)).digest("hex")) {
          throw Error("qualification bridge readback conflict");
        }
        summary = row.summary as string;
      } finally { db.close(); }
      s.set(id, {queuedAt:now, path});
      s.event(id, "qualification-expiry-alert", {provider, expiresAt:q.expiresAt, summary}, "Retain the bridge receipt; requalify with fresh native evidence. Never replay this alert.", now);
    } catch (error) {
      s.event(`alert-failure:${id}`, "qualification-alert-failure", {provider, error:String(error)}, "Restore the existing bridge; a later tick retries the same alert ID.", now);
    }
  }
}
