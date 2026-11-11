// A fictional private factory directory for ledger tests: a controller
// database made by the real Store, health databases made the way the real
// detectors make them, and a tick log. Everything lives in a temporary
// directory; nothing here can reach the live factory, mail or GitHub.
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTickResult } from "../../launcher/controller-alerts";
import { Store } from "../../tracking/store";
import type { DiskReading } from "../../launcher/disk";

export const OWNER_TOKEN = "fixture-owner-token-0123456789abcdef";
export const T0 = Date.parse("2026-11-10T09:00:00-05:00");
export const MINUTE = 60_000;
export const roomyDisk = (): DiskReading => ({ at: T0, path: "fictional-test-volume", freeGiB: 100, usedFraction: 0.1 });
export const fullDisk = (): DiskReading => ({ at: T0, path: "fictional-test-volume", freeGiB: 12, usedFraction: 0.97 });
/** A fictional worker session id, shaped like the real ones. */
export const session = (n: number) => n.toString(16).padStart(8, "0").repeat(8);
export const bundleError = (n: number) => `Error: exact tested tree required; inspect /Users/fictional/.factory/runs/delivery/${session(n)}/initial/publisher/tested-tree.json`;

export type Journal = "wal" | "delete";
const IDLE_QUEUE_SCHEMA = "CREATE TABLE IF NOT EXISTS observations(at INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,opened INTEGER NOT NULL,queued INTEGER,wake TEXT,evidence TEXT); CREATE TABLE IF NOT EXISTS observation_gap(id INTEGER PRIMARY KEY,since INTEGER NOT NULL,ended INTEGER);";

/** Opens a fixture database the way a detector does: read-write, short timeout, no journal change. */
export function writer(path: string, timeoutMs = 1000): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA busy_timeout=${timeoutMs}`);
  return db;
}
function setJournal(path: string, journal: Journal) {
  const db = writer(path);
  try {
    const now = (db.query(`PRAGMA journal_mode=${journal}`).get() as { journal_mode: string }).journal_mode;
    if (now !== journal) throw Error(`fixture journal mode is ${now}, wanted ${journal}`);
  } finally {
    db.close();
  }
}

/** The live layout is a WAL controller and rollback-journal health databases; tests may swap either. */
export function factoryDir(journals: { controller?: Journal; health?: Journal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-fixture-"));
  mkdirSync(join(dir, "health"), { mode: 0o700 });
  writeFileSync(join(dir, "owner-token"), OWNER_TOKEN, { mode: 0o600 });
  new Store(join(dir, "controller.sqlite")).close();
  recordTickResult(dir, join(dir, "no-mail.sqlite"), { at: T0, status: "ok" });
  const idle = writer(join(dir, "health/idle-queue.sqlite"));
  idle.exec(IDLE_QUEUE_SCHEMA);
  idle.close();
  setJournal(join(dir, "controller.sqlite"), journals.controller ?? "wal");
  for (const name of ["controller-alerts", "idle-queue"]) setJournal(join(dir, `health/${name}.sqlite`), journals.health ?? "delete");
  writeFileSync(join(dir, "tick.log"), "");
  return dir;
}

/** Appends controller events without changing the journal mode (the real Store would switch it back to WAL). */
export function addEvents(dir: string, events: { id: string; kind: string; at: number; data: unknown }[]) {
  const db = writer(join(dir, "controller.sqlite"), 10_000);
  try {
    const insert = db.query("INSERT INTO events VALUES(?,?,?,?,?)");
    db.transaction(() => {
      for (const e of events) insert.run(e.id, e.kind, e.at, JSON.stringify(e.data), "fixture");
    }).immediate();
  } finally {
    db.close();
  }
}
export const workerFailure = (n: number, at: number, error = bundleError(n)) => ({ id: `failure:${session(n)}`, kind: "worker-failure", at, data: { id: session(n), error } });
export function appendTick(dir: string, ...lines: (string | Record<string, unknown>)[]) {
  appendFileSync(join(dir, "tick.log"), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)) + "\n").join(""));
}
export function addIncident(dir: string, source: "controller-alerts" | "idle-queue", id: string, at: number, summary: string) {
  const db = writer(join(dir, `health/${source}.sqlite`));
  try {
    // Marked as already delivered, so the real alert writer has nothing to send and never looks for mail.
    if (source === "controller-alerts") db.query("INSERT INTO incidents(id,at,summary,body,wake) VALUES(?,?,?,?,'w_fixture')").run(id, at, summary, "fixture");
    else db.query("INSERT INTO incidents(id,opened,evidence) VALUES(?,?,?)").run(id, at, JSON.stringify({ source: "fixture", reason: summary }));
  } finally {
    db.close();
  }
}
