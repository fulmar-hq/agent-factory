import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { Engine } from "./engine";
import type { Config } from "./config";
import { Store } from "../tracking/store";

// This consumes the existing bridge's verified roots, never caller-supplied role labels.
// Same-user SQLite access is not a security boundary; see operations.md.
export const mailHook = `
CREATE TABLE IF NOT EXISTS factory_commands (
  id TEXT PRIMARY KEY, command TEXT NOT NULL, created_at INTEGER NOT NULL,
  completed_at INTEGER, response TEXT
);
CREATE TRIGGER IF NOT EXISTS factory_command_intake AFTER INSERT ON messages
WHEN NEW.sender='Vincent' AND NEW.sender_app='telegram' AND NEW.forward_of IS NULL
  AND NEW.sender_ref LIKE 'telegram:%'
  AND length(substr(NEW.sender_ref,10))>0
  AND substr(NEW.sender_ref,10) NOT GLOB '*[^0-9]*'
  AND (NEW.body='' OR NEW.body=NEW.summary)
  AND (lower(trim(NEW.summary)) IN ('status','pause','resume')
    OR lower(trim(NEW.summary)) LIKE 'stop %')
BEGIN
  INSERT OR IGNORE INTO factory_commands(id,command,created_at)
    VALUES(NEW.id,trim(NEW.summary),NEW.created_at);
  UPDATE messages SET state='acked',wake_state='none',acked_at=NEW.created_at,
    ack_note='Factory command retained for deterministic launcher; no chat wake'
    WHERE id=NEW.id;
END;
`;

export function factoryCommand(
  s: Store,
  c: Config,
  id: string,
  text: string,
): string {
  return s.atomic(() => {
    const key = `telegram-command:${id}`;
    const prior = s.get<{ command: string; response: string }>(key);
    if (prior) {
      if (prior.command !== text) throw Error("command identity changed");
      return prior.response;
    }
    const e = new Engine(s, c),
      command = text.trim().toLowerCase();
    let response: string;
    if (command === "status") {
      const heartbeat = s.get<{ at: number }>("heartbeat");
      response = `Factory ${s.get("paused") === false ? "running" : "paused"}; ${e.active().length} retained sessions; ${s.db.query<{ n: number }, []>("SELECT count(*) AS n FROM questions WHERE answer IS NULL").get()!.n} unanswered questions. Last tick: ${heartbeat ? new Date(heartbeat.at).toISOString() : "unverified"}.`;
    } else if (command === "pause" || command === "resume") {
      e.pause(command === "pause", "owner");
      if (command === "pause")
        for (const session of e.active())
          s.set(`stop:${session.id}`, {
            at: Date.now(),
            reason: "verified Telegram pause",
          });
      response =
        command === "pause"
          ? "Factory paused; active work will stop and remain retained."
          : "Factory resumed; retained claims and safety gates remain in force.";
    } else {
      const match =
        /^stop (?:([a-z0-9_.-]+\/[a-z0-9_.-]+)#|#)?([1-9]\d*)$/i.exec(
          text.trim(),
        );
      const matches = match
        ? e.active().filter((x) => {
            const split = x.ticket.lastIndexOf("#");
            return (
              x.ticket.slice(split + 1) === match[2] &&
              (!match[1] ||
                x.ticket.slice(0, split).toLowerCase() ===
                  match[1].toLowerCase())
            );
          })
        : [];
      if (!match)
        response =
          "Use status, pause, resume, or stop owner/repo#123 (stop 123 if unambiguous).";
      else if (matches.length !== 1)
        response = matches.length
          ? "Issue is ambiguous; use stop owner/repo#123."
          : "No retained active session found for that issue.";
      else {
        const session = matches[0]!;
        s.db
          .query("UPDATE sessions SET status='paused' WHERE id=?")
          .run(session.id);
        s.set(`stop:${session.id}`, {
          at: Date.now(),
          reason: "verified Telegram stop",
        });
        response = `Stop requested for ${session.ticket}; work and custody retained.`;
      }
    }
    s.set(key, { command: text, response });
    s.event(
      key,
      "telegram-command",
      { command: text, response },
      "Append a corrected decision; resume does not replay stopped custody",
    );
    return response;
  });
}

export function processTelegramMail(
  s: Store,
  c: Config,
  mailPath: string,
): number {
  // Missing integration is deliberately inert, never create an imitation mail store.
  const db = new Database(mailPath, { readwrite: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=10000");
    if (
      !db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='factory_commands'",
        )
        .get()
    )
      return 0;
    const commands = db
      .query<{ id: string; command: string; created_at: number }, []>(
        "SELECT id,command,created_at FROM factory_commands WHERE completed_at IS NULL ORDER BY rowid LIMIT 100",
      )
      .all();
    for (const row of commands) {
      const response = factoryCommand(s, c, row.id, row.command);
      db.transaction(() => {
        if (
          !db
            .query(
              "SELECT id FROM factory_commands WHERE id=? AND completed_at IS NULL",
            )
            .get(row.id)
        )
          return;
        // Outbound uses the existing mail-telegram-sender queue, not a new bot/API client.
        const parent = db
          .query<{ send_id: string; thread_id: string }, [string]>(
            "SELECT send_id,thread_id FROM messages WHERE id=?",
          )
          .get(row.id);
        if (!parent) throw Error("verified command root missing");
        const at = Date.now();
        db.query(`INSERT INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,reply_to,thread_id,depth,hash,state,wake_state)
          VALUES(?,?,?,'Factory Desk','codex','factory-launcher','Vincent','telegram','fyi','none',?,'',?,?,1,?,'unread','pending')`).run(
          `factory-reply:${row.id}`,
          randomUUID(),
          at,
          response,
          row.id,
          parent.thread_id,
          createHash("sha256").update(response).digest("hex"),
        );
        db.query(
          "UPDATE factory_commands SET completed_at=?,response=? WHERE id=?",
        ).run(at, response, row.id);
      }).immediate();
    }
    return commands.length;
  } finally {
    db.close();
  }
}
