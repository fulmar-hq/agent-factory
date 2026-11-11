import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../tracking/store";
import {TestEngine as Engine} from './fixtures';
import { available } from "../wallet/ledger";
import {
  config,
  ticket,
  qualification,
  meter,
  now,
  admission,
  billing,
} from "./fixtures";
const fictionalProcesses = { identity: () => "fictional-process-start", absent: () => false };
function setup() {
  const s = new Store(":memory:"),
    e = new Engine(s, config(), fictionalProcesses);
  e.pause(false, "owner");
  return e;
}
for (const [used, benefit, ok] of [
  [0.69, "normal", true],
  [0.7, "normal", false],
  [0.7, "high", true],
  [0.89, "high", true],
  [0.9, "high", false],
  [0.9, "normal", false],
] as const)
  test(`quota ${used} ${benefit} ${ok ? "admits" : "blocks"}`, () => {
    const e = setup(),
      fn = () =>
        e.admit(
          { ...ticket(), benefit },
          { ...admission(), meter: meter(used) },
        );
    if (ok) expect(fn().status).toBe("reserved");
    else expect(fn).toThrow();
    e.s.close();
  });
test("either provider window at 90% blocks", () => {
  const e = setup(),
    m = meter();
  m.windows[1].used = 0.9;
  expect(() => e.admit(ticket(), { ...admission(), meter: m })).toThrow(
    "usage stop",
  );
  e.s.close();
});
for (const age of [900001, -1])
  test(`stale or future usage age ${age} blocks`, () => {
    const e = setup();
    expect(() =>
      e.admit(ticket(), {
        ...admission(),
        meter: { ...meter(), observedAt: now - age },
      }),
    ).toThrow("stale");
    e.s.close();
  });
test("missing meter and inferred reset zero refuse", () => {
  const e = setup();
  expect(() => e.admit(ticket(), { ...admission(), meter: undefined })).toThrow(
    "unknown",
  );
  const m = meter(0);
  m.windows[0].resetsAt = now;
  expect(() => e.admit(ticket(), { ...admission(), meter: m })).toThrow(
    "stale",
  );
  e.s.close();
});
test("stable duplicate survives changed title, completion and retry", () => {
  const e = setup(),
    t = ticket(),
    a = e.admit(t, admission());
  e.finish(a.id, true);
  expect(() =>
    e.admit({ ...t, title: "Retried", estimateSeconds: 200 }, admission()),
  ).toThrow("duplicate");
  expect(e.s.rows("debits")).toHaveLength(1);
  e.s.close();
});
test("spawn is claimed exactly once, never replayed after uncertain custody", () => {
  const e = setup(),
    x = e.admit(ticket(), admission());
  expect(e.claimStart(x.id, now)).toBe(true);
  expect(e.claimStart(x.id, now)).toBe(false);
  e.register(x.id, 123, "native");
  expect(e.claimStart(x.id, now)).toBe(false);
  e.s.close();
});
test("empty wallet refuses paid task and never borrows", () => {
  const e = setup();
  e.c.wallet.other.default_usd = 0;
  expect(() => e.admit({ ...ticket(), costCents: 1 }, admission())).toThrow(
    "wallet empty",
  );
  expect(
    e.s.rows("events").filter((x: any) => x.kind === "reservation"),
  ).toHaveLength(0);
  e.s.close();
});
test("ledger is debit only, capped, idempotent and append only", () => {
  const e = setup();
  e.admit({ ...ticket(), costCents: 100 }, admission());
  expect(available(e.s, e.c, "other", now)).toBe(0);
  expect(() => e.admit({ ...ticket(2), costCents: 1 }, admission())).toThrow(
    "wallet",
  );
  expect(() => e.s.db.exec("UPDATE debits SET cents=0")).toThrow("append-only");
  expect(() => e.s.db.exec("DELETE FROM debits")).toThrow("append-only");
  expect(() => e.admit({ ...ticket(3), costCents: -1 }, admission())).toThrow();
  e.s.close();
});
test("AWS headroom deducts liabilities, reserve and all commitments", () => {
  const e = setup();
  expect(available(e.s, e.c, "aws", now, billing())).toBe(4800);
  e.admit({ ...ticket(), wallet: "aws", costCents: 100 }, admission());
  expect(available(e.s, e.c, "aws", now, billing())).toBe(4700);
  e.s.close();
});
test("stale, missing, wrong-month, projected and actual AWS gates refuse", () => {
  const e = setup();
  for (const b of [
    undefined,
    { ...billing(), observedAt: now - 86400001 },
    { ...billing(), month: "2026-10" },
    { ...billing(), projectedCents: 6000 },
    { ...billing(), postedCents: 6500 },
  ])
    expect(() =>
      e.admit(
        { ...ticket(), wallet: "aws", costCents: 1 },
        { ...admission(), billing: b },
      ),
    ).toThrow("wallet");
  e.s.close();
});
test("helper bypass attempts cannot fund, raise caps, pause or release", () => {
  const e = setup();
  expect(() => e.pause(false, "helper")).toThrow("owner");
  expect(() =>
    e.release("qa", "a".repeat(40), "fixture", "helper", now),
  ).toThrow("refused");
  expect(() =>
    e.admit({ ...ticket(), approved: false }, admission()),
  ).toThrow();
  expect(() =>
    e.admit({ ...ticket(), owner: "stranger" }, admission()),
  ).toThrow("owner");
  expect(() =>
    e.admit(ticket(), {
      ...admission(),
      qualification: { ...qualification(), policyIsolation: false } as any,
    }),
  ).toThrow("unqualified");
  e.s.close();
});
test("missing qualification, paid route, model and expired evidence refuse", () => {
  const e = setup();
  for (const q of [
    undefined,
    { ...qualification(), subscription: false },
    { ...qualification(), expiresAt: now },
    { ...qualification(), model: "other" },
  ])
    expect(() =>
      e.admit(ticket(), { ...admission(), qualification: q as any }),
    ).toThrow("unqualified");
  e.s.close();
});
test("ticket override wins only with matching qualification", () => {
  const e = setup();
  expect(() =>
    e.admit({ ...ticket(), model: "override" }, admission()),
  ).toThrow("unqualified");
  const x = e.admit(
    { ...ticket(), model: "override" },
    {
      ...admission(),
      qualification: { ...qualification(), model: "override" },
    },
  );
  expect(JSON.parse(x.brief).model).toBe("override");
  e.s.close();
});
test("scope split, traversal and overlapping paths refuse", () => {
  const e = setup();
  expect(() =>
    e.admit({ ...ticket(), estimateSeconds: 14401 }, admission()),
  ).toThrow();
  expect(() =>
    e.admit({ ...ticket(), spansBackendAndScreen: true }, admission()),
  ).toThrow();
  expect(() =>
    e.admit({ ...ticket(), paths: ["../config.yaml"] }, admission()),
  ).toThrow();
  e.admit({ ...ticket(), paths: ["src"] }, admission());
  expect(() => e.admit(ticket(2), admission())).toThrow("path");
  e.s.close();
});
test("heavy tests have their own slot", () => {
  const e = setup();
  e.admit({ ...ticket(), heavy: true }, admission());
  expect(() => e.admit({ ...ticket(2), heavy: true }, admission())).toThrow(
    "heavy",
  );
  expect(e.admit(ticket(3), admission()).status).toBe("reserved");
  e.s.close();
});
test("1.8 checkpoint, 2x time pause, immutable baseline and one question", () => {
  const e = setup(),
    x = e.admit(ticket(), admission());
  e.claimStart(x.id, now);
  e.account(x.id, 180, 0);
  expect(e.sessions()[0].checkpoint).toBe(1);
  e.account(x.id, 200, 0);
  e.account(x.id, 0, 0);
  expect(e.sessions()[0].status).toBe("paused");
  expect(e.sessions()[0].actual_seconds).toBe(200);
  expect(e.s.rows("questions")).toHaveLength(1);
  expect(e.claimStart(x.id)).toBe(false);
  e.s.close();
});
test("tokens checkpoint at 1.8 and stop at twice the estimate", () => {
  const e = setup(),
    x = e.admit(ticket(), admission());
  e.account(x.id, 1, 999);
  expect(e.sessions()[0].status).toBe("reserved");
  e.account(x.id, 1, 1000);
  expect(e.sessions()[0].status).toBe("reserved");
  e.account(x.id, 1, 1800);
  expect(e.sessions()[0].checkpoint).toBe(1);
  expect(e.sessions()[0].status).toBe("reserved");
  e.account(x.id, 1, 2000);
  expect(e.sessions()[0].status).toBe("paused");
  expect(() => e.account(x.id, NaN, -1)).toThrow();
  e.s.close();
});
test("pause, custody and debits survive controlled reboot", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-reboot-")),
    path = join(dir, "state.sqlite");
  let s = new Store(path),
    e = new Engine(s, config(), fictionalProcesses);
  expect(s.get("paused")).toBe(true);
  e.pause(false, "owner");
  const x = e.admit({ ...ticket(), costCents: 100 }, admission());
  e.claimStart(x.id, now);
  e.register(x.id, 123, "native-custody");
  e.pause(true, "owner");
  s.close();
  s = new Store(path);
  e = new Engine(s, config(), fictionalProcesses);
  expect(s.get("paused")).toBe(true);
  expect(e.sessions()[0].native_id).toBe("native-custody");
  expect(available(s, e.c, "other", now)).toBe(0);
  expect(() => e.admit(ticket(2), admission())).toThrow("paused");
  e.pause(false, "owner");
  expect(() => e.admit(ticket(), admission())).toThrow("duplicate");
  s.close();
  rmSync(dir, { recursive: true });
});
test("release windows refuse missed, early and catch-up releases", () => {
  const e = setup();
  for (const time of ["19:59", "20:01", "21:29", "21:31"])
    expect(() =>
      e.release(
        time.startsWith("20") || time === "19:59" ? "qa" : "production",
        "a".repeat(40),
        "fixture",
        "release",
        Date.parse(`2026-11-07T${time}:00-05:00`),
      ),
    ).toThrow("window");
  expect(e.s.rows("releases")).toHaveLength(0);
  e.s.close();
});
test("QA and production enforce one frozen accepted revision per Toronto day", () => {
  const e = setup(),
    revision = "a".repeat(40),
    qa = Date.parse("2026-11-07T20:00:00-05:00"),
    prod = Date.parse("2026-11-07T21:30:00-05:00");
  e.release("qa", revision, "qa-run", "release", qa);
  expect(() => e.release("qa", revision, "duplicate", "release", qa)).toThrow();
  expect(() =>
    e.release("production", revision, "prod-run", "release", prod),
  ).toThrow("acceptance");
  e.s.set("qa-acceptance", {
    day: "2026-11-07",
    revision,
    receipt: "independent-quality",
  });
  expect(() =>
    e.release("production", "b".repeat(40), "prod-run", "release", prod),
  ).toThrow("mismatch");
  expect(e.release("production", revision, "prod-run", "release", prod)).toBe(
    "2026-11-07:production",
  );
  e.pause(true, "owner");
  expect(() => e.release("qa", revision, "qa", "release", qa)).toThrow(
    "refused",
  );
  e.s.close();
});
for (const date of ["2026-07-07T20:00:00-04:00", "2026-11-07T20:00:00-05:00"])
  test(`Toronto DST window ${date}`, () => {
    const e = setup();
    expect(
      e.release("qa", "a".repeat(40), "fixture", "release", Date.parse(date)),
    ).toEndWith(":qa");
    e.s.close();
  });
test("AWS actual stop latches across lower subsequent readings", async () => {
  const { observeBilling } = await import("../wallet/ledger");
  const e = setup();
  observeBilling(e.s, e.c, { ...billing(), postedCents: 6500 }, now);
  observeBilling(e.s, e.c, billing(), now);
  expect(available(e.s, e.c, "aws", now, billing())).toBe(0);
  expect(e.s.get("aws-stop-latched")).toBe(true);
  e.s.close();
});
