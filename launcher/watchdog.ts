import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const STALL_MS = 2 * 60 * 60 * 1000;
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const text = z.string().trim().min(1).max(4000);
const attemptSchema = z.object({
  symptom: text, at: timestamp, action: text, receipt: text,
  result: z.enum(["recovered", "failed", "refused"]),
}).strict();
// This is an evidence protocol, not a launcher/controller integration. Unknown or
// incomplete reads cannot establish absence. Receipt identity binds its window.
export const WatchdogSnapshotSchema = z.object({
  now: timestamp,
  work: z.object({
    complete: z.boolean(), readyCount: z.number().int().nonnegative(),
    freeSlots: z.number().int().nonnegative(), lastAdvancedAt: timestamp.nullable(),
  }).strict(),
  windows: z.array(z.object({
    opensAt: timestamp, receiptsComplete: z.boolean(),
    receipts: z.array(z.object({ at: timestamp, kind: z.enum(["execution", "refusal"]), receipt: text }).strict()),
  }).strict()).max(1000),
  recoveryAttempts: z.array(attemptSchema).max(1000).default([]),
}).strict();
export type WatchdogSnapshot = z.input<typeof WatchdogSnapshotSchema>;
type Snapshot = z.output<typeof WatchdogSnapshotSchema>;
type Attempt = z.infer<typeof attemptSchema>;
export type Incident = {
  id: string; symptom: string; openedAt: number; closedAt: number | null;
  evidence: unknown; recovery: Attempt[]; action: string; default: string;
  resolution?: { at: number; evidence: unknown };
};
type State = { lastPoll: number; since: number | null; advancement: number | null; sequence: number };
const toronto = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function windowKey(at: number) {
  const parts = toronto.formatToParts(at);
  const part = (key: string) => parts.find(p => p.type === key)?.value;
  const time = `${part("hour")}:${part("minute")}`;
  if (!["20:00", "21:30"].includes(time) || part("second") !== "00" || at % 1000 !== 0)
    throw Error("Window must open at 20:00 or 21:30 America/Toronto");
  return `window:${at}`;
}

export class Watchdog {
  private db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS watchdog_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watchdog_incidents(id TEXT PRIMARY KEY,symptom TEXT NOT NULL,closed_at INTEGER,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS watchdog_one_open ON watchdog_incidents(symptom) WHERE closed_at IS NULL;
      CREATE TABLE IF NOT EXISTS watchdog_window_receipts(opens_at INTEGER PRIMARY KEY,evidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watchdog_outbox(incident TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','cancelled')));`);
  }
  close() { this.db.close(); }
  incidents(): Incident[] {
    return (this.db.query("SELECT data FROM watchdog_incidents ORDER BY rowid").all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  outbox() {
    return this.db.query("SELECT incident,payload,state FROM watchdog_outbox ORDER BY rowid").all() as { incident: string; payload: string; state: "queued" | "cancelled" }[];
  }
  poll(raw: WatchdogSnapshot) {
    const input = WatchdogSnapshotSchema.parse(raw);
    this.validate(input);
    return this.db.transaction(() => {
      const row = this.db.query("SELECT data FROM watchdog_state WHERE id=1").get() as { data: string } | null;
      const state: State = row ? JSON.parse(row.data) : { lastPoll: input.now, since: null, advancement: null, sequence: 0 };
      if (input.now < state.lastPoll) throw Error("Watchdog clock moved backwards");
      if (input.work.complete && state.advancement !== null &&
          (input.work.lastAdvancedAt === null || input.work.lastAdvancedAt < state.advancement))
        throw Error("Ticket advancement evidence regressed");
      const opened: string[] = [], closed: string[] = [];
      const incidents = this.incidents();
      const reconcile = (symptom: string, present: boolean, evidence: unknown, action: string, fallback: string) => {
        let incident = incidents.find(i => i.symptom === symptom && i.closedAt === null);
        const attempts = input.recoveryAttempts.filter(a => a.symptom === symptom);
        if (incident) {
          for (const attempt of attempts) {
            if (!incident.recovery.some(a => a.receipt === attempt.receipt)) incident.recovery.push(attempt);
          }
        }
        if (!present) {
          if (!incident) return;
          incident.closedAt = input.now;
          incident.resolution = { at: input.now, evidence };
          this.db.query("UPDATE watchdog_incidents SET closed_at=?,data=? WHERE id=?").run(input.now, JSON.stringify(incident), incident.id);
          // Closing is silent. Cancel an undelivered entry; retain its history.
          this.db.query("UPDATE watchdog_outbox SET state='cancelled' WHERE incident=?").run(incident.id);
          closed.push(incident.id);
          return;
        }
        if (incident) {
          this.db.query("UPDATE watchdog_incidents SET data=? WHERE id=?").run(JSON.stringify(incident), incident.id);
          return;
        }
        // A window is a single episode. Once an actual receipt closes it, a
        // later incomplete/history-losing read must not reopen that window.
        if (symptom.startsWith("window:") && incidents.some(i => i.symptom === symptom)) return;
        const id = `watchdog:${++state.sequence}`;
        // The only built-in recovery is a local evidence recheck. No executor,
        // wake, release, message, credential or schedule mutation is attempted.
        const recheck: Attempt = {
          symptom, at: input.now, action: "Recheck the validated symptom evidence locally",
          receipt: `${id}:local-recheck`, result: "failed",
        };
        incident = { id, symptom, openedAt: input.now, closedAt: null, evidence,
          recovery: [recheck, ...attempts], action, default: fallback };
        this.db.query("INSERT INTO watchdog_incidents VALUES(?,?,NULL,?)").run(id, symptom, JSON.stringify(incident));
        this.db.query("INSERT INTO watchdog_outbox VALUES(?,?,'queued')").run(id, JSON.stringify(incident));
        incidents.push(incident);
        opened.push(id);
      };
      const work = input.work;
      if (!work.complete) state.since = null;
      else {
        const advanced = work.lastAdvancedAt !== null && (state.advancement === null || work.lastAdvancedAt > state.advancement);
        const eligible = work.readyCount > 0 && work.freeSlots > 0;
        if (!eligible || advanced) {
          reconcile("stalled-work", false, work, "", "");
          state.since = eligible ? input.now : null;
        } else if (state.since === null) state.since = input.now;
        state.advancement = work.lastAdvancedAt;
        if (eligible && state.since !== null && input.now - state.since >= STALL_MS)
          reconcile("stalled-work", true, { ...work, since: state.since },
            "Inspect launcher reconciliation and admission refusals; repair the recorded blocker before retrying approved work.",
            "Keep existing admission gates and custody; do not force a worker start.");
      }
      for (const window of input.windows) {
        const symptom = windowKey(window.opensAt);
        // Wait until the authorized minute ends. A refusal is an executor
        // receipt, not a successful release. Late receipts also clear silently.
        if (window.receipts.length)
          this.db.query("INSERT OR IGNORE INTO watchdog_window_receipts VALUES(?,?)").run(window.opensAt, JSON.stringify(window.receipts));
        const receipted = this.db.query("SELECT opens_at FROM watchdog_window_receipts WHERE opens_at=?").get(window.opensAt);
        if (receipted) reconcile(symptom, false, window, "", "");
        else if (window.receiptsComplete && input.now >= window.opensAt + 60000)
          reconcile(symptom, true, window,
            "Inspect the release executor and record its execution or refusal receipt for this window.",
            "Do not perform a catch-up release; retain the missed-window evidence.");
      }
      state.lastPoll = input.now;
      this.db.query("INSERT INTO watchdog_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(state));
      return { opened, closed, queued: this.outbox().filter(o => o.state === "queued").length, delivered: 0 as const };
    }).immediate();
  }
  private validate(input: Snapshot) {
    if (input.work.lastAdvancedAt !== null && input.work.lastAdvancedAt > input.now) throw Error("Future advancement evidence");
    const keys = new Set<string>();
    for (const window of input.windows) {
      const key = windowKey(window.opensAt);
      if (keys.has(key)) throw Error("Duplicate window evidence");
      keys.add(key);
      for (const receipt of window.receipts) {
        if (receipt.at < window.opensAt || receipt.at > input.now) throw Error("Receipt outside observed window history");
      }
    }
    for (const attempt of input.recoveryAttempts) {
      if (attempt.at > input.now) throw Error("Future recovery evidence");
      if (attempt.symptom !== "stalled-work" && !keys.has(attempt.symptom)) throw Error("Recovery symptom not in snapshot");
    }
  }
}
