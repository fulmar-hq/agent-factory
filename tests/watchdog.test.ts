import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STALL_MS, Watchdog, type WatchdogSnapshot } from "../launcher/watchdog";

const base = Date.parse("2026-11-08T12:00:00Z");
const qa = Date.parse("2026-11-09T01:00:00Z"); // 20:00 Toronto after DST
const prod = Date.parse("2026-11-09T02:30:00Z");
function snapshot(now = base, overrides: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return { now, work: { complete: true, readyCount: 1, freeSlots: 1, lastAdvancedAt: null }, windows: [], ...overrides };
}
function fixture(run: (path: string, dir: string) => void) {
  mkdirSync(".factory-tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".factory-tmp/watchdog-"));
  try { run(join(dir, "watchdog.sqlite"), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("two-hour threshold survives restarts; repeated polls retain exactly one incident/outbox", () => {
  fixture(path => {
    let w = new Watchdog(path);
    expect(w.poll(snapshot()).opened).toEqual([]);
    expect(w.poll(snapshot(base + STALL_MS - 1)).opened).toEqual([]);
    w.close();
    w = new Watchdog(path);
    try {
      const result = w.poll(snapshot(base + STALL_MS));
      expect(result).toMatchObject({ opened: ["watchdog:1"], queued: 1, delivered: 0 });
      for (let n = 0; n < 10; n++) expect(w.poll(snapshot(base + STALL_MS + n)).opened).toEqual([]);
      expect(w.incidents()).toHaveLength(1);
      expect(w.outbox()).toHaveLength(1);
      expect(w.incidents()[0]).toMatchObject({ symptom: "stalled-work", closedAt: null,
        evidence: { since: base }, recovery: [{ action: "Recheck the validated symptom evidence locally", result: "failed" }] });
      expect(w.incidents()[0]!.action).toContain("admission refusals");
      expect(w.incidents()[0]!.default).toContain("do not force");
    } finally { w.close(); }
  });
});

test("no ready work, no free capacity, unknown reads and observed progress prevent false positives", () => {
  for (const work of [
    { complete: true, readyCount: 0, freeSlots: 1, lastAdvancedAt: null },
    { complete: true, readyCount: 1, freeSlots: 0, lastAdvancedAt: null },
    { complete: false, readyCount: 1, freeSlots: 1, lastAdvancedAt: null },
  ]) {
    const w = new Watchdog(":memory:");
    try {
      w.poll(snapshot());
      w.poll(snapshot(base + STALL_MS, { work }));
      expect(w.incidents()).toHaveLength(0);
      w.poll(snapshot(base + STALL_MS + 1));
      expect(w.poll(snapshot(base + 2 * STALL_MS)).opened).toEqual([]);
    } finally { w.close(); }
  }
  const w = new Watchdog(":memory:");
  try {
    const work = { complete: true, readyCount: 2, freeSlots: 1, lastAdvancedAt: base - 1000 };
    w.poll(snapshot(base, { work }));
    // Ready-count changes and heartbeat polls do not count as advancement.
    w.poll(snapshot(base + STALL_MS - 1, { work: { ...work, readyCount: 3 } }));
    const progress = { ...work, lastAdvancedAt: base + STALL_MS };
    expect(w.poll(snapshot(base + STALL_MS, { work: progress })).opened).toEqual([]);
    expect(w.poll(snapshot(base + 2 * STALL_MS, { work: progress })).opened).toHaveLength(1);
  } finally { w.close(); }
});

test("recovery closes silently, retains attempt receipts, and a new stall creates a new episode", () => {
  fixture(path => {
    let w = new Watchdog(path);
    w.poll(snapshot());
    w.poll(snapshot(base + STALL_MS));
    const recovery = { symptom: "stalled-work", at: base + STALL_MS + 1,
      action: "Reconciled fictional launcher source", receipt: "fictional-recovery-1", result: "recovered" as const };
    const cleared = snapshot(recovery.at, {
      work: { complete: true, readyCount: 1, freeSlots: 1, lastAdvancedAt: recovery.at }, recoveryAttempts: [recovery],
    });
    expect(w.poll(cleared)).toEqual({ opened: [], closed: ["watchdog:1"], queued: 0, delivered: 0 });
    expect(w.incidents()[0]!.recovery).toContainEqual(recovery);
    expect(w.outbox()[0]!.state).toBe("cancelled");
    w.close();
    w = new Watchdog(path);
    try {
      w.poll(cleared);
      expect(w.poll({ ...cleared, now: recovery.at + STALL_MS }).opened).toEqual(["watchdog:2"]);
      expect(w.incidents()).toHaveLength(2);
      expect(w.outbox()).toHaveLength(2);
      expect(w.outbox().filter(o => o.state === "queued")).toHaveLength(1);
    } finally { w.close(); }
  });
});

test("loss of ready work or free capacity clears an open stall without a second notification", () => {
  for (const work of [
    { complete: true, readyCount: 0, freeSlots: 1, lastAdvancedAt: null },
    { complete: true, readyCount: 1, freeSlots: 0, lastAdvancedAt: null },
  ]) {
    const w = new Watchdog(":memory:");
    try {
      w.poll(snapshot());
      w.poll(snapshot(base + STALL_MS));
      const clear = snapshot(base + STALL_MS + 1, { work });
      expect(w.poll(clear)).toEqual({ opened: [], closed: ["watchdog:1"], queued: 0, delivered: 0 });
      expect(w.incidents()[0]!.resolution).toEqual({ at: clear.now, evidence: work });
      w.poll(clear);
      expect(w.outbox()).toHaveLength(1);
    } finally { w.close(); }
  }
});

test("20:00 and 21:30 need complete absent receipts after their minute; refusal is a receipt", () => {
  const w = new Watchdog(":memory:");
  const window = { opensAt: qa, receiptsComplete: true, receipts: [] };
  const idle = { complete: true, readyCount: 0, freeSlots: 1, lastAdvancedAt: null };
  try {
    expect(w.poll(snapshot(qa, { work: idle, windows: [window] })).opened).toEqual([]);
    expect(w.poll(snapshot(qa + 59999, { work: idle, windows: [window] })).opened).toEqual([]);
    expect(w.poll(snapshot(qa + 60000, { work: idle, windows: [{ ...window, receiptsComplete: false }] })).opened).toEqual([]);
    expect(w.poll(snapshot(qa + 60000, { work: idle, windows: [window] })).opened).toHaveLength(1);
    const refusal = { opensAt: prod, receiptsComplete: true, receipts: [{ at: prod, kind: "refusal" as const, receipt: "fictional-executor:refused-gate" }] };
    w.poll(snapshot(prod + 60000, { work: idle, windows: [window, refusal] }));
    expect(w.incidents()).toHaveLength(1);
    const late = { ...window, receipts: [{ at: qa + 1000, kind: "refusal" as const, receipt: "fictional-late-read" }] };
    expect(w.poll(snapshot(prod + 60001, { work: idle, windows: [late] })).closed).toHaveLength(1);
    w.poll(snapshot(prod + 60002, { work: idle, windows: [window] }));
    expect(w.incidents()).toHaveLength(1);
    expect(w.outbox()).toHaveLength(1);
    expect(w.outbox()[0]!.state).toBe("cancelled");
  } finally { w.close(); }
});

test("an executor receipt seen before detection remains authoritative after restart and history loss", () => {
  fixture(path => {
    let w = new Watchdog(path);
    const window = { opensAt: qa, receiptsComplete: true, receipts: [
      { at: qa, kind: "refusal" as const, receipt: "fictional-prior-refusal" },
    ] };
    const idle = { complete: true, readyCount: 0, freeSlots: 1, lastAdvancedAt: null };
    w.poll(snapshot(qa, { work: idle, windows: [window] }));
    w.close();
    w = new Watchdog(path);
    try {
      expect(w.poll(snapshot(qa + 60000, { work: idle, windows: [{ ...window, receipts: [] }] })).opened).toEqual([]);
      expect(w.incidents()).toHaveLength(0);
      expect(w.outbox()).toHaveLength(0);
    } finally { w.close(); }
  });
});

test("missed windows persist independently across restarts and clear only on their own receipt", () => {
  fixture(path => {
    const windows = [qa, prod].map(opensAt => ({ opensAt, receiptsComplete: true, receipts: [] }));
    const input = snapshot(prod + 60000, { windows });
    let w = new Watchdog(path);
    expect(w.poll(input).opened).toHaveLength(2);
    w.close();
    w = new Watchdog(path);
    try {
      expect(w.poll(input).opened).toEqual([]);
      // Omission or unknown evidence doesn't clear an existing incident.
      w.poll({ ...input, windows: [] });
      expect(w.outbox().filter(o => o.state === "queued")).toHaveLength(2);
      expect(w.poll({ ...input, windows: [{ opensAt: prod, receiptsComplete: false, receipts: [
        { at: prod + 1000, kind: "execution", receipt: "fictional-production-executor" },
      ] }] }).closed).toHaveLength(1);
      expect(w.incidents().filter(i => i.closedAt === null)[0]!.symptom).toBe(`window:${qa}`);
    } finally { w.close(); }
  });
});

test("Toronto summer windows are accepted; arbitrary times and invalid/future evidence are rejected", () => {
  const w = new Watchdog(":memory:");
  try {
    const summer = Date.parse("2026-07-09T00:00:00Z");
    w.poll(snapshot(summer + 60000, { windows: [{ opensAt: summer, receiptsComplete: true, receipts: [] }] }));
    expect(w.incidents()).toHaveLength(1);
    for (const input of [
      snapshot(summer), // backward clock
      snapshot(base, { work: { complete: true, readyCount: -1, freeSlots: 1, lastAdvancedAt: null } }),
      snapshot(base, { work: { complete: true, readyCount: 1, freeSlots: 1, lastAdvancedAt: base + 1 } }),
      snapshot(prod, { windows: [{ opensAt: qa + 1000, receiptsComplete: true, receipts: [] }] }),
      snapshot(prod, { windows: [{ opensAt: qa, receiptsComplete: true, receipts: [{ at: prod + 1, kind: "execution", receipt: "x" }] }] }),
      snapshot(prod, { windows: [{ opensAt: qa, receiptsComplete: true, receipts: [{ at: qa - 1, kind: "refusal", receipt: "x" }] }] }),
      snapshot(prod, { windows: [{ opensAt: qa, receiptsComplete: true, receipts: [] }, { opensAt: qa, receiptsComplete: true, receipts: [] }] }),
    ]) expect(() => w.poll(input)).toThrow();
    expect(w.incidents()).toHaveLength(1);
  } finally { w.close(); }
});

test("advancement cannot regress and unproven recovery cannot clear an actual symptom", () => {
  const w = new Watchdog(":memory:");
  try {
    const work = { complete: true, readyCount: 1, freeSlots: 1, lastAdvancedAt: base };
    w.poll(snapshot(base, { work }));
    w.poll(snapshot(base + STALL_MS, { work }));
    expect(() => w.poll(snapshot(base + STALL_MS + 1))).toThrow("regressed");
    const attempt = { symptom: "stalled-work", at: base + STALL_MS + 1,
      action: "Attempted fictional reconciliation", receipt: "fictional-failed-recovery", result: "failed" as const };
    const input = snapshot(attempt.at, { work, recoveryAttempts: [attempt] });
    w.poll(input); w.poll(input);
    expect(w.incidents()[0]!.recovery.filter(a => a.receipt === attempt.receipt)).toHaveLength(1);
    expect(w.incidents()[0]!.closedAt).toBeNull();
    w.poll({ ...input, now: input.now + 1, work: { ...work, complete: false } });
    expect(w.incidents()[0]!.closedAt).toBeNull();
    expect(w.outbox()).toHaveLength(1);
  } finally { w.close(); }
});

test("incident, outbox and dwell state commit atomically on write failure", () => {
  fixture(path => {
    const w = new Watchdog(path), db = new Database(path);
    try {
      w.poll(snapshot());
      db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON watchdog_outbox BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
      expect(() => w.poll(snapshot(base + STALL_MS))).toThrow("simulated storage failure");
      expect(w.incidents()).toHaveLength(0);
      expect(w.outbox()).toHaveLength(0);
      db.exec("DROP TRIGGER fail_outbox");
      expect(w.poll(snapshot(base + STALL_MS)).opened).toEqual(["watchdog:1"]);
    } finally { db.close(); w.close(); }
  });
});

test("standalone CLI repeats across processes and reports queue, never delivery", async () => {
  mkdirSync(".factory-tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".factory-tmp/watchdog-cli-"));
  try {
    const path = join(dir, "watchdog.sqlite"), input = join(dir, "snapshot.json");
    const run = (args = ["--state", path, "--input", input]) => Bun.spawn([
      process.execPath, "--no-env-file", "scripts/watchdog.ts", ...args,
    ], { stdout: "pipe", stderr: "pipe", env: process.env });
    writeFileSync(input, JSON.stringify(snapshot()));
    let proc = run();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text()).delivered).toBe(0);
    writeFileSync(input, JSON.stringify(snapshot(base + STALL_MS)));
    const children = [run(), run()];
    const outputs = await Promise.all(children.map(async child => {
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout);
    }));
    expect(outputs.flatMap(o => o.opened)).toEqual(["watchdog:1"]);
    for (const output of outputs) expect(output).toMatchObject({ queued: 1, delivered: 0, notification: "local outbox only; no message delivered" });
    proc = run([]);
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("Usage:");
    writeFileSync(input, '{"now":"invalid"}');
    proc = run();
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('"status":"error"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
