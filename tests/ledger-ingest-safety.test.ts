// The ledger job reads databases the tick and the health job write. These
// tests prove it cannot get in their way: it never opens a source for writing,
// holds nothing between batches, and a deliberately slow run leaves a tick and
// a health evaluation free to finish, on both journal modes.
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTickResult } from "../launcher/controller-alerts";
import { LOOP_FILES } from "../launcher/loop-contract";
import { Store } from "../tracking/store";
import { BATCH_ROWS, SOURCE_FILES, ingestOnce, openSource, sourceRows, type RunReport } from "../scripts/ledger-ingest";
import { reconcile } from "../scripts/ledger";
import { MINUTE, T0, addEvents, addIncident, appendTick, factoryDir, roomyDisk, workerFailure, writer, type Journal } from "./helpers/ledger-fixture";

const repo = join(import.meta.dir, "..");
const none = "/nonexistent-ledger-folder";
const layouts: { name: string; controller: Journal; health: Journal }[] = [
  { name: "the live layout (WAL controller, rollback-journal health)", controller: "wal", health: "delete" },
  { name: "the swapped layout (rollback-journal controller, WAL health)", controller: "delete", health: "wal" },
];
const sources = (dir: string) => ["controller", "controller-alerts", "idle-queue"].map((name) => join(dir, SOURCE_FILES[name as keyof typeof SOURCE_FILES]));
const digest = (path: string) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent");
function seed(dir: string, batches: number) {
  addEvents(dir, Array.from({ length: batches * BATCH_ROWS }, (_, n) => workerFailure(n + 1, T0 + n)));
  appendTick(dir, { at: T0 + 1, status: "ok" }, { at: T0 + 2, status: "error", error: "SQLiteError: database is locked" });
  addIncident(dir, "controller-alerts", `factory-tick-error:${T0 + 2}`, T0 + 2, "Factory launcher tick failed; inspect it and restore task claims.");
  addIncident(dir, "idle-queue", `factory-idle-queue:${T0 + 3}`, T0 + 3, "empty queue and stopped builders");
}
/** What a tick does to the controller: open, one write transaction, close. The live layout uses the real Store. */
function tick(dir: string, layout: { controller: Journal }, at: number) {
  const path = join(dir, "controller.sqlite"),
    event = { id: randomUUID(), kind: "fixture-tick", at, data: JSON.stringify({ at }), undo: "fixture" };
  if (layout.controller === "wal") {
    const store = new Store(path);
    try {
      store.atomic(() => {
        store.event(event.id, event.kind, { at }, event.undo, at);
        store.set("heartbeat", { at, status: "ok" });
      });
    } finally {
      store.close();
    }
  } else {
    // The Store would switch this fixture back to WAL, so the same statements run on a plain connection.
    const db = writer(path, 10_000);
    try {
      db.transaction(() => {
        db.query("INSERT INTO events VALUES(?,?,?,?,?)").run(event.id, event.kind, at, event.data, event.undo);
        db.query("INSERT INTO kv VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ at, status: "ok" }));
      }).immediate();
    } finally {
      db.close();
    }
  }
}
/** What the health job does: the real controller-alert write, and an idle-queue observation as that watcher stores it. */
function healthEvaluation(dir: string, at: number) {
  recordTickResult(dir, join(dir, "no-mail.sqlite"), { at, status: "ok" });
  const idle = writer(join(dir, "health/idle-queue.sqlite"), 1000);
  try {
    idle.transaction(() => idle.query("INSERT OR REPLACE INTO observations VALUES(?,?)").run(at, JSON.stringify({ at, eligible: false }))).immediate();
  } finally {
    idle.close();
  }
}

test("the job never opens a source database for writing", async () => {
  // In the source: one way to open a source, and it is read-only. The only writable database is the ledger itself.
  const job = readFileSync(join(repo, "scripts/ledger-ingest.ts"), "utf8");
  const opens = job.split("\n").filter((line) => line.includes("new Database("));
  expect(opens).toHaveLength(1);
  expect(opens[0]).toContain("{ readonly: true, strict: true }");
  expect(job).not.toMatch(/readwrite|create:\s*true|tracking\/store|new Store\(/);
  expect(job.match(/new Ledger\(/g)).toHaveLength(1);
  expect(job).toContain("new Ledger(join(o.dir, LOOP_FILES.ledger))");

  for (const layout of layouts) {
    const dir = factoryDir(layout);
    seed(dir, 2);
    // A connection the tick left open, with work still in its journal, as the job would find it mid-day.
    const held = writer(join(dir, "controller.sqlite"), 10_000);
    held.query("INSERT INTO events VALUES(?,?,?,?,?)").run("held:1", "worker-failure", T0 + 9, JSON.stringify({ error: "Error: still in the write-ahead log" }), "fixture");
    try {
      for (const path of sources(dir)) {
        const db = openSource(path);
        try {
          expect(() => db.run("CREATE TABLE written_by_the_ledger(x)")).toThrow(/readonly|read-only/i);
          expect(() => db.run("INSERT INTO incidents(id) VALUES('x')")).toThrow();
          expect(() => db.run("DELETE FROM events")).toThrow();
          expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(path.endsWith("controller.sqlite") ? layout.controller : layout.health);
        } finally {
          db.close();
        }
        // Whatever a rule passes in, a write is refused and a second statement never runs.
        const table = path.endsWith("controller.sqlite") ? "events" : "incidents";
        const count = () => sourceRows<{ n: number }>(path, `SELECT count(*) AS n FROM ${table}`)[0]!.n;
        const rows = count();
        expect(() => sourceRows(path, `DELETE FROM ${table}`)).toThrow(/readonly|read-only/i);
        expect(sourceRows(path, `SELECT 1 AS one; DELETE FROM ${table}`)).toEqual([{ one: 1 }]);
        expect(count()).toBe(rows);
      }
      // A statement is cut at 200 rows however it is written.
      expect(sourceRows(join(dir, "controller.sqlite"), "SELECT id FROM events")).toHaveLength(BATCH_ROWS);
      expect(() => sourceRows(join(dir, "never-created.sqlite"), "SELECT 1")).toThrow();
      expect(existsSync(join(dir, "never-created.sqlite"))).toBe(false);

      // A whole run changes no byte of any source file, including a write-ahead log that is present.
      const files = sources(dir).flatMap((path) => [path, `${path}-wal`, `${path}-journal`]);
      const before = files.map(digest);
      const report = await ingestOnce({ dir, startAt: "beginning", disk: roomyDisk, rulesDir: none, stepsDir: none, now: () => T0 + MINUTE });
      expect(report).toMatchObject({ occurrences: 2 * BATCH_ROWS + 4, sourceErrors: [], stoppedAtLimit: false });
      expect(files.map(digest)).toEqual(before);
      expect(before[0]).not.toBe("absent");
      if (layout.controller === "wal") expect(before[1]).not.toBe("absent");
    } finally {
      held.close();
    }
  }
});

test("between batches nothing is open: a full checkpoint and every writer succeed in each pause", async () => {
  for (const layout of layouts) {
    const dir = factoryDir(layout);
    seed(dir, 4);
    let pauses = 0;
    const report = await ingestOnce({
      dir,
      startAt: "beginning",
      disk: roomyDisk,
      rulesDir: none,
      stepsDir: none,
      now: () => T0 + MINUTE,
      betweenBatches: () => {
        pauses++;
        tick(dir, layout, T0 + pauses);
        healthEvaluation(dir, T0 + pauses);
        // A reader that kept a snapshot would leave this checkpoint busy, or the journal-mode writers above locked out.
        for (const path of sources(dir)) {
          const db = writer(path);
          try {
            if ((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode === "wal") expect(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
          } finally {
            db.close();
          }
        }
      },
    });
    expect(pauses).toBeGreaterThanOrEqual(7);
    expect(report).toMatchObject({ occurrences: 4 * BATCH_ROWS + 3, sourceErrors: [], stoppedAtLimit: false });
  }
});

test("the fixtures have teeth: a reader in another process that holds its snapshot does lock a health write out", async () => {
  const dir = factoryDir();
  const careless = join(mkdtempSync(join(tmpdir(), "careless-reader-")), "careless-reader.ts");
  writeFileSync(careless, `import { openSource } from ${JSON.stringify(join(repo, "scripts/ledger-ingest.ts"))};
const db = openSource(process.argv[2]);
db.exec("BEGIN");
db.query("SELECT count(*) FROM incidents").get();
console.log("holding");
await Bun.sleep(2500);
db.close();
`);
  const child = Bun.spawn([process.execPath, careless, join(dir, "health/controller-alerts.sqlite")], { env: { ...process.env, FACTORY_PRIVATE_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("holding");
  expect(() => healthEvaluation(dir, T0)).toThrow("database is locked");
  await child.exited;
  healthEvaluation(dir, T0);
}, 20_000);

test("with the job's read loop slowed for 30 seconds, ticks and health evaluations complete on WAL and rollback-journal sources", async () => {
  const SLOW_MS = 30_000,
    PAUSE_MS = 2500;
  const wrapper = join(mkdtempSync(join(tmpdir(), "slow-ledger-job-")), "slow-ledger-job.ts");
  // The real job in its own process, as launchd runs it, with only its read loop slowed.
  writeFileSync(
    wrapper,
    `import { ingestOnce } from ${JSON.stringify(join(repo, "scripts/ledger-ingest.ts"))};
let slept = 0;
const report = await ingestOnce({ dir: process.argv[2], startAt: "beginning", rulesDir: ${JSON.stringify(none)}, stepsDir: ${JSON.stringify(none)}, disk: () => ({ at: Date.now(), path: "fictional-test-volume", freeGiB: 100, usedFraction: 0.1 }), betweenBatches: async () => { if (slept < ${SLOW_MS}) { slept += ${PAUSE_MS}; await Bun.sleep(${PAUSE_MS}); } } });
console.log(JSON.stringify({ ...report, slept }));
process.exit(0);
`,
  );
  const runs = layouts.map((layout) => {
    const dir = factoryDir(layout);
    seed(dir, 13);
    const started = Date.now();
    const child = Bun.spawn([process.execPath, wrapper, dir], { env: { ...process.env, FACTORY_PRIVATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const finished = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => ({ out, err, code, elapsed: Date.now() - started }));
    return { layout, dir, finished, done: false, ticks: 0, evaluations: 0, slowest: 0, errors: [] as string[] };
  });
  for (const run of runs) void run.finished.then(() => (run.done = true));

  // Meanwhile this process is the tick and the health job, on both fixtures, four times a second.
  for (let n = 0; runs.some((run) => !run.done); n++) {
    for (const run of runs.filter((r) => !r.done)) {
      for (const [count, work] of [["ticks", () => tick(run.dir, run.layout, Date.now())], ["evaluations", () => healthEvaluation(run.dir, Date.now())]] as const) {
        const before = performance.now();
        try {
          work();
          run[count]++;
        } catch (error) {
          run.errors.push(`${count}: ${String(error)}`);
        }
        run.slowest = Math.max(run.slowest, performance.now() - before);
      }
      // Real failures keep arriving while the job is mid-run; it must pick each of them up exactly once, later.
      if (n % 20 === 0) addEvents(run.dir, [workerFailure(100_000 + n, Date.now())]);
    }
    await Bun.sleep(250);
  }

  for (const run of runs) {
    const { out, err, code, elapsed } = await run.finished;
    expect({ layout: run.layout.name, code, err }).toEqual({ layout: run.layout.name, code: 0, err: "" });
    const report = JSON.parse(out) as RunReport & { slept: number };
    expect(report.slept).toBe(SLOW_MS);
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS);
    expect(report).toMatchObject({ sourceErrors: [], stoppedAtLimit: false, ruleErrors: [] });
    expect(report.occurrences).toBeGreaterThanOrEqual(13 * BATCH_ROWS + 3);
    // Every tick and every health evaluation completed, none waited on the ledger job, none saw a locked database.
    expect(run.errors).toEqual([]);
    expect(run.ticks).toBeGreaterThanOrEqual(60);
    expect(run.evaluations).toBe(run.ticks);
    expect(run.slowest).toBeLessThan(1000);
    // The journal modes are what the fixture promised, so both kinds were really exercised.
    for (const [file, journal] of [["controller.sqlite", run.layout.controller], ["health/controller-alerts.sqlite", run.layout.health], ["health/idle-queue.sqlite", run.layout.health]] as const) expect(sourceRows<{ journal_mode: string }>(join(run.dir, file), "SELECT * FROM pragma_journal_mode")[0]!.journal_mode).toBe(journal);
    // An ordinary run afterwards has everything, once.
    const after = await ingestOnce({ dir: run.dir, disk: roomyDisk, rulesDir: none, stepsDir: none });
    expect(after).toMatchObject({ sourceErrors: [], behindMs: 0 });
    expect(reconcile(run.dir)).toMatchObject({ difference: 0, workerFailures: { missing: [] } });
    expect(reconcile(run.dir).workerFailures.source).toBeGreaterThan(13 * BATCH_ROWS);
    expect(existsSync(join(run.dir, LOOP_FILES.ledgerHeartbeat))).toBe(true);
  }
}, 120_000);
