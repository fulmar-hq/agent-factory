import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStatus, codexStatusMetadata, localReadings } from "../adapters/usage";
import { Engine } from "../launcher/engine";
import { Store } from "../tracking/store";
import { admission, config, meter, now, ticket } from "./fixtures";
const native = (at = now, used = .1) => ({ ...meter(used), nativeProvider: "codex" as const, observedAt: at });
const idle = () => ({ ...admission(), meter: native(now - 900001), recoverUsage: true });
const snapshot = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: now / 1000 + 604800 } } }, accountId: "private", credits: "private" };

test("non-model status protocol initializes, reads usage once and strips account data", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin}); let initialized=false;
    rl.on('line',line=>{const x=JSON.parse(line);
      if(x.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));
      else if(x.method==='initialized')initialized=true;
      else if(initialized && x.method==='account/rateLimits/read' && x.params.excludeResetCreditDetails===true)console.log(JSON.stringify({id:2,result:${JSON.stringify(snapshot)}}));
      else process.exit(9);
    });`;
  const reading = await codexStatus([process.execPath, "-e", script]);
  expect(reading?.windows[0].used).toBe(.1);
  expect(reading?.source).toContain("account/rateLimits/read");
  expect(JSON.stringify(reading)).not.toContain("private");
  expect(reading!.observedAt).toBeGreaterThanOrEqual(Date.now() - 1000);
  expect(codexStatusMetadata({ rateLimits: { ...snapshot.rateLimitsByLimitId.codex, limitId: "other" } }, now)).toBeUndefined();
  expect(codexStatusMetadata({ ordinaryUsageAllowed: true }, now)).toBeUndefined();
});

test("unavailable or hung status is bounded; polling retains original receipt age", async () => {
  expect(await codexStatus(["/nonexistent/factory-usage-fixture"])).toBeUndefined();
  expect(await codexStatus([process.execPath, "-e", "setInterval(()=>{},1000)"], 30)).toBeUndefined();
  const stale = native(now - 900001);
  let polls = 0;
  const sources = { receipt: async () => stale, claude: async () => undefined, status: async () => { polls++; return undefined; } };
  expect((await localReadings(now, sources)).codex?.observedAt).toBe(stale.observedAt);
  expect((await localReadings(now + 1000, sources)).codex?.observedAt).toBe(stale.observedAt);
  expect(polls).toBe(2);
  expect((await localReadings(now, { ...sources, status: async () => native() })).codex?.observedAt).toBe(now);
});

test("idle -> one admission -> restart stays bounded -> own native reading fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-idle-")), path = join(dir, "controller.sqlite");
  let s = new Store(path), e = new Engine(s, config());
  try {
    e.pause(false, "owner");
    const x = e.admit(ticket(), idle());
    expect(e.claimStart(x.id, now)).toBe(true);
    expect(() => e.workerUsage(x.id, idle().meter, now + 1)).not.toThrow();
    expect(() => e.workerUsage(x.id, native(now + 1, .9), now + 1)).toThrow("usage stop");
    expect(() => e.workerUsage(x.id, idle().meter, now + 120001)).toThrow("usage stale");
    expect(() => e.admit(ticket(2), idle())).toThrow("awaiting fresh");
    e.finish(x.id, true);
    s.close(); s = new Store(path); e = new Engine(s, config());
    expect(() => e.admit(ticket(2), idle())).toThrow("awaiting fresh");
    e.refreshUsage("codex", native(now - 1), now + 1);
    expect(s.get("usage-bootstrap")).toBeTruthy();
    // The admitted run emitted a genuinely new receipt; a subsequent tick reads it.
    const fresh = native(now + 1);
    e.refreshUsage("codex", fresh, now + 1);
    expect(s.get("usage-bootstrap")).toBeNull();
    expect(e.admit(ticket(2), { ...idle(), now: now + 1, meter: fresh }).status).toBe("reserved");
    const kinds = s.rows("events").map((x: any) => x.kind);
    expect(kinds.filter(x => x === "usage-bootstrap-admission")).toHaveLength(1);
    expect(kinds.filter(x => x === "usage-bootstrap-refreshed")).toHaveLength(1);
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test("recovery never bypasses qualification, pause, bounds, known quota or native validity", () => {
  const cases = [
    { t: { ...ticket(), heavy: true }, a: idle(), reason: "small unpaid" },
    { t: { ...ticket(), estimateSeconds: 1801 }, a: idle(), reason: "small unpaid" },
    { t: { ...ticket(), estimateTokens: 8000001 }, a: idle(), reason: "small unpaid" },
    { t: { ...ticket(), costCents: 1 }, a: idle(), reason: "small unpaid" },
    { t: ticket(), a: { ...idle(), meter: native(now - 900001, .9) }, reason: "usage stop" },
    { t: ticket(), a: { ...idle(), meter: native(now - 900001, .7) }, reason: "high benefit" },
    { t: ticket(), a: { ...idle(), meter: native(now + 1) }, reason: "native evidence invalid" },
    { t: ticket(), a: { ...idle(), qualification: undefined }, reason: "unqualified" },
  ];
  for (const { t, a, reason } of cases) {
    const s = new Store(":memory:"), e = new Engine(s, config());
    try {
      e.pause(false, "owner");
      expect(() => e.admit(t, a)).toThrow(reason);
      expect(s.get("usage-bootstrap")).toBeNull();
      expect(e.sessions()).toHaveLength(0);
    } finally { s.close(); }
  }
});

test("absent native usage permits exactly one small qualified run, failed run retains latch", () => {
  const s = new Store(":memory:"), e = new Engine(s, config());
  try {
    expect(() => e.admit(ticket(), { ...idle(), meter: undefined })).toThrow("paused");
    e.pause(false, "owner");
    const x = e.admit(ticket(), { ...idle(), meter: undefined });
    expect(() => e.workerUsage(x.id, undefined, now)).not.toThrow();
    e.finish(x.id, false);
    e.archive(x.id, "synthetic custody reconciled", "owner");
    expect(() => e.admit(ticket(2), { ...idle(), meter: undefined })).toThrow("awaiting fresh");
  } finally { s.close(); }
});

import { launchReady } from "../launcher/tick";
import { intakeLabel, issueTicket, type Issue } from "../adapters/github";
test("idle launcher spawns one supervisor, rollback preserves allowance after spawn failure", async () => {
  const s = new Store(":memory:"), e = new Engine(s, config());
  const i: Issue = { number: 1, title: "Synthetic", state: "OPEN", url: "fixture", updatedAt: "fixture",
    body: `\`\`\`factory\n${JSON.stringify(ticket())}\n\`\`\``,
    labels: [{ name: "state:ready" }, { name: "kind:fix" }, { name: "area:demo" }] };
  i.labels.push({ name: intakeLabel(ticket().repo, i) });
  const t = issueTicket(ticket().repo, i)!;
  const execute = async (args: string[]) => args.includes("view") ? JSON.stringify(i) : "";
  try {
    e.pause(false, "owner");
    await expect(launchReady(e, t, idle(), () => { throw Error("synthetic spawn failure"); }, execute, () => now)).rejects.toThrow("spawn failure");
    expect(s.get("usage-bootstrap")).toBeNull();
    let spawned = 0;
    const x = await launchReady(e, t, idle(), id => { spawned++; expect(() => e.workerUsage(id, idle().meter, now)).not.toThrow(); }, execute, () => now);
    expect(spawned).toBe(1);
    expect(e.sessions().find(row => row.id === x.id)?.status).toBe("starting");
    await expect(launchReady(e, t, idle(), () => { spawned++; }, execute, () => now)).rejects.toThrow("duplicate");
    expect(spawned).toBe(1);
  } finally { s.close(); }
});
