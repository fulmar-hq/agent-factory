import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubUnavailable } from "../adapters/github-budget";
import { HEARTBEAT_STALE_MS, LOOP_FILES, SENDER_HEARTBEAT_FILE } from "../launcher/loop-contract";
import { Store } from "../tracking/store";
import {
  CHECKS_TO_OPEN,
  HARD_STOP_UNSENT_MS,
  HEARTBEAT_VARIABLE,
  MIN_CHECK_GAP_MS,
  STALE_MS,
  collectHeartbeat,
  initialCheckState,
  judgeHeartbeat,
  parseHeartbeatValue,
  pushHeartbeat,
  readCheckState,
  renderIssue,
  runCheck,
  stepCheck,
  type CheckIo,
  type CheckState,
  type HeartbeatValue,
  type JobBeat,
  type Notice,
} from "../scripts/push-heartbeat";

const MINUTE = 60_000;
const repo = join(import.meta.dir, "..");
const DRILL = `${HEARTBEAT_VARIABLE}_DRILL`;
/** 10:00 in Toronto on a fictional weekday, well outside 17:30-22:35. */
const T0 = Date.parse("2026-11-11T10:00:00-05:00");

// ----------------------------------------------------------------- push
/** A fictional factory folder and mail folder. Nothing here is the live machine. */
function folders(o: { tickAt?: number; health?: unknown; ledger?: unknown; sender?: unknown } = {}) {
  const base = mkdtempSync(join(tmpdir(), "heartbeat-")),
    dir = join(base, "factory"),
    mailDir = join(base, "mail"),
    budgetDir = join(base, "budget");
  for (const path of [join(dir, "health"), mailDir, budgetDir]) mkdirSync(path, { recursive: true });
  if (o.tickAt !== undefined) {
    const db = new Database(join(dir, "controller.sqlite"), { create: true, strict: true });
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.query("INSERT INTO kv VALUES('last-successful-heartbeat',?)").run(JSON.stringify({ at: o.tickAt, status: "ok", ready: 2 }));
    db.close();
  }
  const put = (path: string, value: unknown) => value !== undefined && writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  put(join(dir, LOOP_FILES.healthHeartbeat), o.health);
  put(join(dir, LOOP_FILES.ledgerHeartbeat), o.ledger);
  put(join(mailDir, SENDER_HEARTBEAT_FILE), o.sender);
  return { dir, mailDir, budgetDir };
}
const recorder = (fail?: (args: string[]) => unknown) => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      const error = fail?.(args);
      if (error) throw error;
      return "";
    },
  };
};

describe("the pusher (on the Mac)", () => {
  test("carries the pusher's own time and each watched job's time, lag and alarm flag; a missing file is missing, not healthy", async () => {
    const f = folders({ tickAt: T0 - MINUTE, health: { at: T0 - 2 * MINUTE }, ledger: { at: T0 - 3 * MINUTE, behindMs: 22 * MINUTE, alarm: "22 minutes behind on 3 runs", newest: 5 } });
    expect(await collectHeartbeat(f.dir, f.mailDir, T0)).toEqual({
      version: 1,
      at: T0,
      jobs: { tick: { state: "ok", at: T0 - MINUTE }, health: { state: "ok", at: T0 - 2 * MINUTE }, ledger: { state: "ok", at: T0 - 3 * MINUTE, behindMs: 22 * MINUTE, alarm: true }, sender: { state: "missing" } },
    });
  });

  test("a file that cannot be read, or is not in the heartbeat shape, is unreadable; no store means no tick", async () => {
    const f = folders({ health: "{not json", ledger: { when: "yesterday" }, sender: { at: T0, behindMs: 0 } });
    expect((await collectHeartbeat(f.dir, f.mailDir, T0)).jobs).toEqual({ tick: { state: "missing" }, health: { state: "unreadable" }, ledger: { state: "unreadable" }, sender: { state: "ok", at: T0, behindMs: 0 } });
  });

  test("writes one Actions variable through gh api (the budgeted route), and only times, counts and fixed words leave the Mac", async () => {
    const f = folders({ tickAt: T0, health: { at: T0 }, sender: { at: T0, alarm: "gate error for /Users/someone token ghp_abcdefghijklmnopqrstuvwxyz0123456789 +15145550100" } });
    const gh = recorder();
    const result = await pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL, now: T0, run: gh.run });
    expect(result.pushed).toBe(true);
    expect(gh.calls).toHaveLength(1);
    const [args] = gh.calls;
    // adapters/github.ts budgets and backs off only `gh api|issue|pr|label|search`.
    expect(args!.slice(0, 5)).toEqual(["gh", "api", "--method", "PATCH", `repos/fixture-owner/fixture-repo/actions/variables/${DRILL}`]);
    expect(args).toContain(`name=${DRILL}`);
    const value = args!.find((a) => a.startsWith("value="))!.slice("value=".length);
    expect(parseHeartbeatValue(value)).toEqual((result as { value: HeartbeatValue }).value);
    expect(JSON.parse(value).jobs.sender).toEqual({ state: "ok", at: T0, alarm: true });
    expect(value).not.toMatch(/someone|ghp_|5145550100|gate error/);
    expect(args!.join(" ")).not.toMatch(/someone|ghp_|5145550100|gate error/);
  });

  test("the first push ever creates the variable; any other refusal is an error, not a skip", async () => {
    const f = folders({ tickAt: T0 });
    const first = recorder((args) => (args.includes("PATCH") ? Error("gh failed (exit 1): gh: Not Found (HTTP 404)") : null));
    expect((await pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL, run: first.run })).pushed).toBe(true);
    expect(first.calls.map((c) => [c[3], c[4]])).toEqual([
      ["PATCH", `repos/fixture-owner/fixture-repo/actions/variables/${DRILL}`],
      ["POST", "repos/fixture-owner/fixture-repo/actions/variables"],
    ]);
    const denied = recorder(() => Error("gh failed (exit 1): gh: Resource not accessible by personal access token (HTTP 403)"));
    await expect(pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL, run: denied.run })).rejects.toThrow("HTTP 403");
  });

  test("a GitHub backoff makes the pusher skip without error, through the real budget and with no call made", async () => {
    const f = folders({ tickAt: T0, health: { at: T0 } });
    const retryAt = Date.now() + 20 * MINUTE;
    const budget = new Store(join(f.budgetDir, "controller.sqlite"));
    budget.set("github-backoff", { retryAt, error: "API rate limit exceeded", at: Date.now() });
    budget.close();
    // No `run` is given, so this is the real budgeted command. The budget must
    // stop it before gh starts; a host that does not exist backs that up.
    const before = { host: process.env.GH_HOST, token: process.env.GH_TOKEN };
    process.env.GH_HOST = "github.invalid";
    process.env.GH_TOKEN = "fixture";
    try {
      expect(await pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL })).toEqual({ pushed: false, skipped: "github-unavailable", retryAt });
    } finally {
      for (const [key, value] of [["GH_HOST", before.host], ["GH_TOKEN", before.token]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
    const after = new Store(join(f.budgetDir, "controller.sqlite"));
    try {
      // Nothing was counted as a call and the hold is exactly as it was.
      expect(after.db.query("SELECT key FROM kv WHERE key LIKE 'github-calls:%'").all()).toEqual([]);
      expect(after.get<{ retryAt: number }>("github-backoff")!.retryAt).toBe(retryAt);
    } finally {
      after.close();
    }
  });

  test("the scheduled command itself exits 0 with one skip line during a backoff", async () => {
    const f = folders();
    const retryAt = Date.now() + 20 * MINUTE;
    const store = new Store(join(f.dir, "controller.sqlite"));
    store.set("last-successful-heartbeat", { at: Date.now(), status: "ok", ready: 0 });
    store.set("github-backoff", { retryAt, error: "API rate limit exceeded", at: Date.now() });
    store.close();
    // The job's own environment: the private folder is the fixture, and gh could reach nothing even if it ran.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.budgetDir, FACTORY_PRIVATE_DIR: f.dir, FACTORY_MAIL_DB: join(f.mailDir, "mail.sqlite"), GH_HOST: "github.invalid", GH_TOKEN: "fixture" };
    const p = Bun.spawn([process.execPath, join(repo, "scripts/push-heartbeat.ts"), "push", "--repo", "fixture-owner/fixture-repo", "--variable", HEARTBEAT_VARIABLE], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toMatchObject({ pushed: false, skipped: "github-unavailable", retryAt });
  });

  test("GitHub being unreachable mid-push is also a quiet skip", async () => {
    const f = folders({ tickAt: T0 });
    const down = recorder(() => new GitHubUnavailable("gh failed: error connecting to api.github.com", T0 + MINUTE));
    expect(await pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL, run: down.run })).toEqual({ pushed: false, skipped: "github-unavailable", retryAt: T0 + MINUTE });
  });

  test("the real variable is never written from a drill folder, and odd names never reach gh", async () => {
    const f = folders({ tickAt: T0 });
    const gh = recorder();
    await expect(pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: HEARTBEAT_VARIABLE, run: gh.run })).rejects.toThrow("only written from the live folders");
    await expect(pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: "OTHER_SETTING", run: gh.run })).rejects.toThrow("--variable");
    await expect(pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo/../x", variable: DRILL, run: gh.run })).rejects.toThrow("--repo");
    expect(gh.calls).toEqual([]);
  });

  test("only the real variable and the drill variable are ever written: the check's own settings share the prefix and are refused", async () => {
    const f = folders({ tickAt: T0 });
    const gh = recorder();
    // Writing heartbeat JSON over one of these would switch the watch off or silence its notices.
    for (const setting of [`${HEARTBEAT_VARIABLE}_OWNER`, `${HEARTBEAT_VARIABLE}_ISSUE`, `${HEARTBEAT_VARIABLE}_TELEGRAM`, `${HEARTBEAT_VARIABLE}_DRILL_2`, `${HEARTBEAT_VARIABLE}_`])
      await expect(pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: setting, run: gh.run })).rejects.toThrow("--variable");
    expect(gh.calls).toEqual([]);
    expect((await pushHeartbeat({ ...f, repo: "fixture-owner/fixture-repo", variable: DRILL, run: gh.run })).pushed).toBe(true);
  });
});

// ---------------------------------------------------------------- judge
const fresh = (now: number, jobs: Partial<Record<"tick" | "health" | "ledger" | "sender", JobBeat>> = {}): string =>
  JSON.stringify({ version: 1, at: now - 5 * MINUTE, jobs: { tick: { state: "ok", at: now - 6 * MINUTE }, health: { state: "ok", at: now - 7 * MINUTE }, ledger: { state: "missing" }, sender: { state: "missing" }, ...jobs } } satisfies HeartbeatValue);

/** Runs checks at the given times and returns every notice that came out. */
function watch(times: number[], valueAt: (now: number) => string | undefined, start = initialCheckState(DRILL)) {
  let state = start;
  const notices: (Notice & { at: number })[] = [];
  for (const now of times) {
    state = stepCheck(state, judgeHeartbeat(valueAt(now), now, state.seen), now);
    if (state.pending) notices.push({ ...state.pending, at: now });
  }
  return { state, notices, kinds: notices.map((n) => n.kind) };
}
const every30 = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * 30 * MINUTE);

describe("what one look says", () => {
  test("the limits are the plan's: 45 minutes for any time, and the contract's 15 minutes for a held hard stop", () => {
    expect(STALE_MS).toBe(45 * MINUTE);
    expect(HARD_STOP_UNSENT_MS).toBe(HEARTBEAT_STALE_MS);
    expect(CHECKS_TO_OPEN).toBe(2);
  });

  test("a fresh value with every time inside 45 minutes is clean, and a job never seen is listed as not reporting, not as healthy", () => {
    const reading = judgeHeartbeat(fresh(T0), T0);
    expect(reading.problems).toEqual([]);
    expect(reading.seen).toEqual(["tick", "health"]);
    expect(reading.rows).toContainEqual(["the ledger job", "not reporting yet (not judged, and not counted as healthy)"]);
    expect(judgeHeartbeat(fresh(T0, { tick: { state: "ok", at: T0 - 45 * MINUTE } }), T0).problems).toEqual([]);
  });

  test("a stale Mac is named in the plan's words, and an old value is not used to judge the jobs", () => {
    const old = JSON.stringify({ version: 1, at: T0 - 62 * MINUTE, jobs: { tick: { state: "ok", at: T0 - 300 * MINUTE }, sender: { state: "ok", at: T0 - 300 * MINUTE, alarm: true } } });
    expect(judgeHeartbeat(old, T0).problems).toEqual(["no heartbeat from the Mac for 62 minutes (Mac down, or its GitHub access blocked)"]);
    expect(judgeHeartbeat("", T0).problems).toEqual(["no heartbeat from the Mac yet (Mac down, or its GitHub access blocked)"]);
    expect(judgeHeartbeat(undefined, T0).problems).toHaveLength(1);
    expect(judgeHeartbeat("{broken", T0).problems).toEqual(["the pushed heartbeat cannot be read"]);
    expect(judgeHeartbeat(JSON.stringify({ version: 2, at: T0, jobs: {} }), T0).problems).toEqual(["the pushed heartbeat cannot be read"]);
    expect(judgeHeartbeat(fresh(T0 + 60 * MINUTE), T0).problems).toEqual(["the Mac's heartbeat is dated in the future"]);
  });

  test("each kind of trouble in a watched job is a problem: stale, alarm, held hard stop, unreadable, gone missing", () => {
    const problems = (jobs: Parameters<typeof fresh>[1], seen: Parameters<typeof judgeHeartbeat>[2] = []) => judgeHeartbeat(fresh(T0, jobs), T0, seen).problems;
    expect(problems({ tick: { state: "ok", at: T0 - 46 * MINUTE } })).toEqual(["the tick last succeeded 46 minutes ago"]);
    expect(problems({ health: { state: "ok", at: T0 - 90 * MINUTE } })).toEqual(["the health job last ran 90 minutes ago"]);
    expect(problems({ ledger: { state: "ok", at: T0 - MINUTE, behindMs: 22 * MINUTE, alarm: true } })).toEqual(["the ledger job reports an alarm (its reason is in its heartbeat file on the Mac)"]);
    expect(problems({ sender: { state: "ok", at: T0 - MINUTE, behindMs: 25 * MINUTE } })).toEqual(["the Telegram sender has held a hard stop unsent for 25 minutes"]);
    expect(problems({ sender: { state: "ok", at: T0 - MINUTE, behindMs: 15 * MINUTE } })).toEqual([]);
    // Only the sender's lag is a held hard stop; the ledger says it is behind through its own alarm.
    expect(problems({ ledger: { state: "ok", at: T0 - MINUTE, behindMs: 25 * MINUTE } })).toEqual([]);
    expect(problems({ health: { state: "unreadable" } })).toEqual(["the health job's heartbeat cannot be read"]);
    expect(problems({ sender: { state: "ok", at: T0 + 30 * MINUTE } })).toEqual(["the Telegram sender has a heartbeat dated in the future"]);
    expect(problems({ ledger: { state: "missing" } }, ["ledger"])).toEqual(["the ledger job has stopped writing its heartbeat"]);
    expect(problems({ ledger: { state: "missing" } }, [])).toEqual([]);
  });

  test("a job the pusher no longer lists is forgotten rather than alarmed on", () => {
    const value = JSON.stringify({ version: 1, at: T0, jobs: { tick: { state: "ok", at: T0 } } });
    expect(judgeHeartbeat(value, T0, ["tick", "ledger"])).toMatchObject({ problems: [], seen: ["tick"] });
  });
});

describe("episodes: one notice when a problem opens, one when it recovers", () => {
  test("drill: a tick time forced stale produces one notice within two checks", () => {
    const staleTick = (now: number) => fresh(now, { tick: { state: "ok", at: T0 - 60 * MINUTE } });
    const first = watch(every30(T0, 1), staleTick);
    expect(first.kinds).toEqual([]);
    expect(first.state.bad).toBe(1);
    const run = watch(every30(T0, 6), staleTick);
    expect(run.kinds).toEqual(["open"]);
    expect(run.notices[0]!.at).toBe(T0 + 30 * MINUTE);
    expect(run.notices[0]!.problems[0]).toMatch(/^the tick last succeeded \d+ minutes ago$/);
  });

  test("drill: a sender holding a hard stop for 25 minutes produces one notice; a ledger alarm reason produces one notice", () => {
    expect(watch(every30(T0, 4), (now) => fresh(now, { sender: { state: "ok", at: now - MINUTE, behindMs: 25 * MINUTE } })).kinds).toEqual(["open"]);
    expect(watch(every30(T0, 4), (now) => fresh(now, { ledger: { state: "ok", at: now - MINUTE, alarm: true } })).kinds).toEqual(["open"]);
  });

  /** The pusher pushes every 15 minutes, stops at `stop` for `gap` minutes, then resumes. */
  const pusher = (stop: number, gap: number) => (now: number) => {
    const resumed = stop + gap * MINUTE;
    const last = now >= resumed ? resumed + Math.floor((now - resumed) / (15 * MINUTE)) * 15 * MINUTE : Math.min(stop, T0 + Math.floor((now - T0) / (15 * MINUTE)) * 15 * MINUTE);
    return JSON.stringify({ version: 1, at: last, jobs: { tick: { state: "ok", at: last }, health: { state: "ok", at: last } } });
  };

  test("drill: the pusher stopped for 100 minutes gives one notice, then one recovery comment (checks at 50 and 80 minutes, as the drill is run)", () => {
    const stop = T0 + 60 * MINUTE;
    const run = watch([T0 + 30 * MINUTE, stop + 50 * MINUTE, stop + 80 * MINUTE, stop + 105 * MINUTE, stop + 120 * MINUTE, stop + 150 * MINUTE], pusher(stop, 100));
    expect(run.kinds).toEqual(["open", "recover"]);
    expect(run.notices[0]!.problems).toEqual(["no heartbeat from the Mac for 80 minutes (Mac down, or its GitHub access blocked)"]);
    expect(run.state).toMatchObject({ open: null, bad: 0, good: 0 });
  });

  test("on the real 30-minute schedule a stop is noticed 75 to 105 minutes after the last push, whatever the timing, and never twice", () => {
    const stop = T0 + 60 * MINUTE;
    const delays: number[] = [];
    for (let phase = 0; phase < 30; phase++) {
      const run = watch(every30(T0 + phase * MINUTE, 16), pusher(stop, 110));
      expect(run.kinds).toEqual(["open", "recover"]);
      delays.push((run.notices[0]!.at - stop) / MINUTE);
    }
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(75);
    expect(Math.max(...delays)).toBeLessThanOrEqual(105);
    // So a stop of exactly 100 minutes can end just before the second bad check: never more than one notice, sometimes none.
    const hundred = Array.from({ length: 30 }, (_, phase) => watch(every30(T0 + phase * MINUTE, 16), pusher(stop, 100)).kinds.join(","));
    expect(new Set(hundred)).toEqual(new Set(["open,recover", ""]));
    expect(hundred.filter((kinds) => kinds === "open,recover").length).toBeGreaterThanOrEqual(24);
  });

  test("a value that alternates fresh and stale produces at most one notice per episode", () => {
    const stale = (now: number) => JSON.stringify({ version: 1, at: now - 60 * MINUTE, jobs: {} });
    const pattern = (bad: boolean[]) => watch(every30(T0, bad.length), (now) => (bad[(now - T0) / (30 * MINUTE)] ? stale(now) : fresh(now))).kinds;
    const repeat = (unit: boolean[], times: number) => Array.from({ length: times }, () => unit).flat();
    // Never two bad checks in a row: nothing opens.
    expect(pattern(repeat([true, false], 12))).toEqual([]);
    // One clean check does not end an episode, so it is one notice and no flapping recoveries.
    expect(pattern(repeat([true, true, false], 8))).toEqual(["open"]);
    // Two clean checks end it. Coming back within 24 hours is said once, and after that it is one continuing problem.
    expect(pattern(repeat([true, true, false, false], 3))).toEqual(["open", "recover", "reopen"]);
    expect(pattern(repeat([true], 30))).toEqual(["open"]);
  });

  test("a fault that comes and goes is bounded: one return is said, then it stays one open problem until 12 clean checks in a row", () => {
    const stale = (now: number) => JSON.stringify({ version: 1, at: now - 60 * MINUTE, jobs: {} });
    const rhythm = (bad: number, clean: number, checks: number, start = initialCheckState(DRILL), from = T0) =>
      watch(every30(from, checks), (now) => (((now - from) / (30 * MINUTE)) % (bad + clean) < bad ? stale(now) : fresh(now)), start);
    // The reviewer's case: down an hour, up an hour, for 24 hours. It was 12 openings and 12 recoveries.
    const day = rhythm(2, 2, 48);
    expect(day.kinds).toEqual(["open", "recover", "reopen"]);
    expect(day.state.open).toMatchObject({ returned: true });
    // The days after: the daily 09:00 reminder and nothing else.
    expect(rhythm(2, 2, 3 * 48).kinds).toEqual(["open", "recover", "reopen", "remind", "remind"]);
    // The worst any fault can do: go bad the moment it is declared recovered, and clean the moment it is declared open.
    let state = initialCheckState(DRILL);
    const opened: number[] = [];
    for (const now of every30(T0, 4 * 48)) {
      state = stepCheck(state, judgeHeartbeat(state.open ? fresh(now) : stale(now), now, state.seen), now);
      if (state.pending?.kind === "open" || state.pending?.kind === "reopen") opened.push(now);
    }
    const within24h = opened.map((at) => opened.filter((other) => other >= at && other - at < 24 * 60 * MINUTE).length);
    expect(Math.max(...within24h)).toBe(5);
    expect(within24h.slice(1).every((count) => count <= 4)).toBe(true);
    // A returned problem does recover: 11 clean checks are not enough, 12 are.
    const back = rhythm(2, 2, 6).state;
    expect(back.open).toMatchObject({ returned: true });
    const clean = (count: number) => watch(every30(T0 + 6 * 30 * MINUTE, count), (now) => fresh(now), back);
    expect(clean(11).kinds).toEqual([]);
    expect(clean(11).state.open).not.toBeNull();
    expect(clean(12).kinds).toEqual(["recover"]);
    // More than 24 hours after a recovery a problem is an ordinary one again, with the ordinary two clean checks.
    const later = rhythm(2, 2, 4, clean(12).state, T0 + 18 * 30 * MINUTE + 25 * 60 * MINUTE);
    expect(later.kinds).toEqual(["open", "recover"]);
  });

  test("a worse problem inside an open one is said: the Mac dying behind a ledger alarm gets one more notice in the usual 75 to 105 minutes", () => {
    // The ledger job carries an alarm all day (a rule that threw). The Mac's last push is four hours in.
    const stop = T0 + 4 * 60 * MINUTE;
    const until = (stop: number) => (now: number) => {
      const last = Math.min(stop, T0 + Math.floor((now - T0) / (15 * MINUTE)) * 15 * MINUTE);
      return JSON.stringify({ version: 1, at: last, jobs: { tick: { state: "ok", at: last }, ledger: { state: "ok", at: last, alarm: true } } });
    };
    const value = until(stop);
    const delays: number[] = [];
    for (let phase = 0; phase < 30; phase++) {
      // Through 08:30 the next morning: the opening, one more notice for the Mac, and nothing else.
      const run = watch(every30(T0 + phase * MINUTE, 45), value);
      expect(run.kinds).toEqual(["open", "worse"]);
      expect(run.notices[0]!.problems).toEqual(["the ledger job reports an alarm (its reason is in its heartbeat file on the Mac)"]);
      expect(run.notices[1]!.problems).toHaveLength(1);
      expect(run.notices[1]!.problems[0]).toMatch(/^no heartbeat from the Mac for \d+ minutes \(Mac down, or its GitHub access blocked\)$/);
      expect(run.notices[1]!.since).toBe(run.notices[0]!.at);
      delays.push((run.notices[1]!.at - stop) / MINUTE);
    }
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(75);
    expect(Math.max(...delays)).toBeLessThanOrEqual(105);
    // The daily reminder still comes at 09:00, and carries the current problem.
    const longer = watch(every30(T0, 48), value);
    expect(longer.kinds).toEqual(["open", "worse", "remind"]);
    expect(new Date(longer.notices[2]!.at).toISOString()).toBe("2026-11-12T14:00:00.000Z");
    // If the Mac is first seen gone at the 09:00 check, the reminder names it, and it is not said again as "another problem".
    const atReminder = watch(every30(T0, 60), until(T0 + 23 * 60 * MINUTE - 50 * MINUTE));
    expect(atReminder.kinds).toEqual(["open", "remind"]);
    expect(atReminder.notices[1]!.problems).toEqual(["no heartbeat from the Mac for 50 minutes (Mac down, or its GitHub access blocked)"]);
  });

  test("inside an open problem each watched thing is named at most once, and only after two bad checks in a row", () => {
    const held = { sender: { state: "ok", at: 0, behindMs: 25 * MINUTE } } as const;
    const tickOld = { tick: { state: "ok", at: T0 - 90 * MINUTE } } as const;
    const value = (plan: string) => (now: number) => {
      const step = plan[(now - T0) / (30 * MINUTE)]!;
      const sender = step === "c" ? { state: "ok", at: now - MINUTE } as const : { ...held.sender, at: now - MINUTE };
      return fresh(now, { sender, ...(step === "t" || step === "b" ? tickOld : {}), ...(step === "l" || step === "b" ? { ledger: { state: "ok", at: now - MINUTE, alarm: true } } : {}) });
    };
    const run = (plan: string) => watch(every30(T0, plan.length), value(plan));
    // "." the held hard stop alone, "t" a stale tick as well, "l" a ledger alarm as well, "b" both, "c" a clean check.
    expect(run("....").kinds).toEqual(["open"]);
    // A tick that is stale on every other check never has two bad checks in a row, so it adds nothing.
    expect(run("..t.t.t.t.").kinds).toEqual(["open"]);
    // Nor does one with a wholly clean check in between.
    expect(run("..tctctc").kinds).toEqual(["open"]);
    // Two in a row: one more notice, naming only the tick. Going on, or coming back later, adds nothing.
    const tick = run("..tttt..tttt");
    expect(tick.kinds).toEqual(["open", "worse"]);
    expect(tick.notices[1]!.at).toBe(T0 + 3 * 30 * MINUTE);
    expect(tick.notices[1]!.problems).toEqual([expect.stringMatching(/^the tick last succeeded \d+ minutes ago$/)]);
    // A third thing later is said once too; two new things on the same checks share one notice.
    expect(run("..ttttllll").kinds).toEqual(["open", "worse", "worse"]);
    const both = run("..bbbb");
    expect(both.kinds).toEqual(["open", "worse"]);
    expect(both.notices[1]!.problems).toHaveLength(2);
    // What the opening already named is never repeated as "another problem".
    expect(watch(every30(T0, 8), value("bbbbbbbb")).kinds).toEqual(["open"]);
  });

  test("two checks close together are one look: a second run minutes later can neither open nor clear a problem", () => {
    const stale = (now: number) => JSON.stringify({ version: 1, at: now - 60 * MINUTE, jobs: {} });
    expect(watch([T0, T0 + MINUTE, T0 + 2 * MINUTE, T0 + MIN_CHECK_GAP_MS - 1], stale).kinds).toEqual([]);
    const open = watch([T0, T0 + 30 * MINUTE], stale).state;
    expect(open.open).not.toBeNull();
    expect(watch([T0 + 60 * MINUTE, T0 + 61 * MINUTE, T0 + 62 * MINUTE], (now) => fresh(now), open).state.open).not.toBeNull();
  });

  test("a problem that stays open is said again once a day, at the first check from 09:00 Toronto, not every check", () => {
    const stale = (now: number) => JSON.stringify({ version: 1, at: T0 - 60 * MINUTE, jobs: {} });
    // Opens at 10:30 on day one, then stays open through 08:30 on day four.
    const run = watch(every30(T0, 142), stale);
    expect(run.kinds).toEqual(["open", "remind", "remind"]);
    expect(run.notices.map((n) => new Date(n.at).toISOString())).toEqual(["2026-11-11T15:30:00.000Z", "2026-11-12T14:00:00.000Z", "2026-11-13T14:00:00.000Z"]);
  });
});

// ------------------------------------------------------- the check itself
const marker = "<!-- factory-heartbeat-state -->";
/** A stand-in issue: its text, its comments and the Telegram lines sent. Nothing leaves the test. */
function fakeIssue(o: { body?: string; telegram?: boolean | "fails"; failComment?: number } = {}) {
  const issue = { body: o.body ?? `Factory heartbeat\n\n${marker}`, comments: [] as string[], telegrams: [] as string[], saves: 0, now: T0, failComment: o.failComment ?? 0 };
  const io: CheckIo = {
    now: () => issue.now,
    issueBody: async () => issue.body,
    saveBody: async (body) => {
      issue.body = body;
      issue.saves++;
    },
    comment: async (body) => {
      if (issue.failComment-- > 0) throw Error("GitHub POST issue comment failed: HTTP 502");
      issue.comments.push(body);
    },
    telegram: o.telegram
      ? async (text) => {
          if (o.telegram === "fails") return false;
          issue.telegrams.push(text);
          return true;
        }
      : null,
  };
  return { issue, io };
}
const stale = (now: number) => JSON.stringify({ version: 1, at: now - 60 * MINUTE, jobs: {} });

describe("the check (on the runner)", () => {
  const standing = { variable: HEARTBEAT_VARIABLE, issue: 7, standingIssue: 7, owner: "fixture-owner" };
  const drill = { variable: DRILL, issue: 8, standingIssue: 7, owner: "fixture-owner" };
  async function checks(target: ReturnType<typeof fakeIssue>, input: typeof standing, values: ((now: number) => string | undefined)[]) {
    for (const value of values) {
      await runCheck({ ...input, value: value(target.issue.now) }, target.io);
      target.issue.now += 30 * MINUTE;
    }
  }

  test("keeps its state in the issue text, comments exactly once when a problem opens and once when it recovers, and names the owner", async () => {
    const target = fakeIssue();
    await checks(target, standing, [fresh, stale, stale, stale, stale, fresh, fresh, fresh]);
    expect(target.issue.comments).toHaveLength(2);
    expect(target.issue.comments[0]).toContain("**Problem.**");
    expect(target.issue.comments[0]).toContain("- no heartbeat from the Mac for 60 minutes (Mac down, or its GitHub access blocked)");
    expect(target.issue.comments[0]).toContain("Owner: @fixture-owner");
    expect(target.issue.comments[1]).toContain("**Recovered.**");
    expect(target.issue.comments[1]).toContain("open for about 120 minutes (since 2026-11-11 11:00)");
    expect(target.issue.comments[1]).toContain("Owner: @fixture-owner");
    expect(target.issue.body).toContain("**Status: OK.**");
    expect(target.issue.body).toContain("| the tick | last succeeded 6 minutes ago |");
    expect(readCheckState(target.issue.body)).toMatchObject({ variable: HEARTBEAT_VARIABLE, open: null, bad: 0, pending: null, seen: ["tick", "health"] });
  });

  test("the issue text says what is happening between notices", async () => {
    const target = fakeIssue();
    await checks(target, standing, [fresh, stale]);
    expect(target.issue.body).toContain("**Status: watching.** One bad check");
    expect(target.issue.comments).toEqual([]);
    await checks(target, standing, [stale]);
    expect(target.issue.body).toContain("**Status: PROBLEM since 2026-11-11 11:00.**");
    expect(target.issue.body).toContain("Last check: 2026-11-11 11:00 (America/Toronto). Variable `FACTORY_HEARTBEAT`. The Mac last pushed 60 minutes before this check.");
    await checks(target, standing, [fresh]);
    expect(target.issue.body).toContain("One clean check so far");
    expect(target.issue.comments).toHaveLength(1);
  });

  test("with the Telegram secret stored, one plain line goes out from GitHub and the comment does not also ping", async () => {
    const target = fakeIssue({ telegram: true });
    await checks(target, standing, [stale, stale, stale, fresh, fresh]);
    expect(target.issue.telegrams).toEqual(["The factory needs a look: no heartbeat from the Mac for 60 minutes (Mac down, or its GitHub access blocked). This comes from GitHub, not from the Mac."]);
    expect(target.issue.comments).toHaveLength(2);
    expect(target.issue.comments[0]).toContain("Owner: fixture-owner (told on Telegram).");
    expect(target.issue.comments.join("\n")).not.toContain("@");
  });

  test("a dead Mac behind an alarm that was already open reaches the owner the same day: a second line and a second comment", async () => {
    const alarm = (now: number) => fresh(now, { ledger: { state: "ok", at: now - MINUTE, alarm: true } });
    const target = fakeIssue({ telegram: true });
    await checks(target, standing, [alarm, alarm, alarm, alarm, stale, stale, stale, stale]);
    expect(target.issue.telegrams).toEqual([
      "The factory needs a look: the ledger job reports an alarm (its reason is in its heartbeat file on the Mac). This comes from GitHub, not from the Mac.",
      "The factory has another problem, on top of the one open since 2026-11-11 10:30: no heartbeat from the Mac for 60 minutes (Mac down, or its GitHub access blocked). This comes from GitHub, not from the Mac.",
    ]);
    expect(target.issue.comments).toHaveLength(2);
    expect(target.issue.comments[1]).toContain("**Another problem**, on top of the one open since 2026-11-11 10:30.");
    expect(target.issue.comments[1]).toContain("- no heartbeat from the Mac for 60 minutes");
    expect(target.issue.comments[1]).toContain("Owner: fixture-owner (told on Telegram).");
    // Without Telegram the second comment mentions the owner, like the first.
    const plain = fakeIssue();
    await checks(plain, standing, [alarm, alarm, stale, stale]);
    expect(plain.issue.comments).toHaveLength(2);
    expect(plain.issue.comments[1]).toContain("Owner: @fixture-owner");
    expect(readCheckState(plain.issue.body)).toMatchObject({ open: { told: ["mac", "ledger"], rising: [] } });
  });

  test("a problem that comes back within 24 hours says so, in the comment, the Telegram line and the issue text", async () => {
    const target = fakeIssue({ telegram: true });
    await checks(target, standing, [stale, stale, fresh, fresh, stale, stale, fresh, fresh]);
    expect(target.issue.telegrams).toHaveLength(2);
    expect(target.issue.telegrams[1]).toStartWith("The factory needs a look again: no heartbeat from the Mac for 60 minutes");
    expect(target.issue.comments).toHaveLength(3);
    expect(target.issue.comments[1]).toContain("clean on 2 checks in a row");
    expect(target.issue.comments[2]).toContain("**Problem, back within 24 hours of a recovery.**");
    expect(target.issue.comments[2]).toContain("counts as recovered only after 12 clean checks in a row");
    expect(target.issue.body).toContain("**Status: PROBLEM since 2026-11-11 12:30.** It came back within 24 hours of a recovery, so it counts as recovered after 12 clean checks in a row; 2 so far.");
    await checks(target, standing, Array.from({ length: 10 }, () => fresh));
    expect(target.issue.comments).toHaveLength(4);
    expect(target.issue.comments[3]).toContain("**Recovered.** The heartbeat was clean on 12 checks in a row.");
    expect(target.issue.body).toContain("**Status: OK.**");
  });

  test("if Telegram cannot send, the owner is mentioned on GitHub instead, so the notice is never lost", async () => {
    const target = fakeIssue({ telegram: "fails" });
    await checks(target, standing, [stale, stale]);
    expect(target.issue.comments).toHaveLength(1);
    expect(target.issue.comments[0]).toContain("Owner: @fixture-owner");
  });

  test("a drill issue never notifies anyone, even with the Telegram secret stored", async () => {
    const target = fakeIssue({ telegram: true });
    await checks(target, drill, [stale, stale, fresh, fresh]);
    expect(target.issue.telegrams).toEqual([]);
    expect(target.issue.comments).toHaveLength(2);
    expect(target.issue.comments.join("\n")).not.toContain("@");
    expect(target.issue.comments[0]).toContain("Owner: nobody is notified (this is a drill issue).");
  });

  test("a drill cannot touch the real issue, an issue follows one variable, and an ordinary issue is never overwritten", async () => {
    const real = fakeIssue();
    await expect(runCheck({ ...standing, variable: DRILL, value: fresh(T0) }, real.io)).rejects.toThrow("only takes the real variable");
    const bound = fakeIssue();
    await runCheck({ ...drill, value: fresh(T0) }, bound.io);
    await expect(runCheck({ ...drill, variable: HEARTBEAT_VARIABLE, value: fresh(T0) }, bound.io)).rejects.toThrow(`follows ${DRILL}`);
    // The check's own settings share the prefix; they are never read as a heartbeat.
    for (const setting of [`${HEARTBEAT_VARIABLE}_OWNER`, `${HEARTBEAT_VARIABLE}_ISSUE`, `${HEARTBEAT_VARIABLE}_OTHER`]) await expect(runCheck({ ...drill, variable: setting, value: fresh(T0) }, fakeIssue().io)).rejects.toThrow("refused: the variable must be");
    const ordinary = fakeIssue({ body: "A product ticket somebody cares about." });
    await expect(runCheck({ ...drill, value: stale(T0) }, ordinary.io)).rejects.toThrow("not a heartbeat issue");
    await expect(runCheck({ ...drill, variable: "OTHER_SETTING", value: stale(T0) }, ordinary.io)).rejects.toThrow("refused");
    expect([real.issue.saves, ordinary.issue.saves, ordinary.issue.comments.length]).toEqual([0, 0, 0]);
    expect(ordinary.issue.body).toBe("A product ticket somebody cares about.");
  });

  test("a notice that could not be posted is kept and sent first by the next run, once", async () => {
    const target = fakeIssue({ failComment: 1 });
    await runCheck({ ...standing, value: stale(target.issue.now) }, target.io);
    target.issue.now += 30 * MINUTE;
    await expect(runCheck({ ...standing, value: stale(target.issue.now) }, target.io)).rejects.toThrow("HTTP 502");
    expect(target.issue.comments).toEqual([]);
    expect(readCheckState(target.issue.body)).toMatchObject({ pending: { kind: "open" }, open: { since: T0 + 30 * MINUTE } });
    target.issue.now += 30 * MINUTE;
    await checks(target, standing, [stale, stale, stale]);
    expect(target.issue.comments).toHaveLength(1);
    expect(target.issue.comments[0]).toContain("**Problem.**");
    expect(readCheckState(target.issue.body)).toMatchObject({ pending: null });
  });

  test("an owner name that is not a login is never turned into a mention", async () => {
    const target = fakeIssue();
    await checks(target, { ...standing, owner: "someone else\n@everyone" }, [stale, stale]);
    expect(target.issue.comments[0]).toContain("Owner: not set");
    expect(target.issue.comments[0]).not.toContain("@");
  });

  test("the state line survives a round trip and cannot be closed early by its own content", () => {
    const state: CheckState = { ...initialCheckState(DRILL), checkedAt: T0, bad: 3, recoveredAt: T0 - MINUTE, open: { since: T0, noticeAt: T0, problems: ["a --> b"], told: ["mac", "tick"], rising: ["sender"], returned: true }, seen: ["tick"] };
    const body = renderIssue(state, judgeHeartbeat(fresh(T0), T0), T0);
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(readCheckState(body)).toEqual(state);
    expect(readCheckState("no marker here")).toBe("no-marker");
    expect(readCheckState(marker)).toBeNull();
    expect(readCheckState('<!-- factory-heartbeat-state {"version":1} -->')).toBeNull();
  });
});

// ------------------------------------------------ the drills as written
describe("the drills in docs/dead-man.md, run in the written order on one drill issue", () => {
  const doc = readFileSync(join(repo, "docs/dead-man.md"), "utf8");
  const drills = [...doc.matchAll(/^\d+\. \*\*(.+?)\*\* (.*)$/gm)].filter((m) => doc.indexOf(m[0]) > doc.indexOf("## Drills"));

  /** The doc's shell helpers, against a fixture folder and a stand-in issue. */
  function bench() {
    const target = fakeIssue();
    let f = folders({ tickAt: T0 }),
      pushed: string | undefined;
    const at = () => target.issue.now;
    const file = (path: () => string) => (extra: object = {}) => writeFileSync(path(), JSON.stringify({ at: at(), ...extra }));
    const b = {
      target,
      comments: () => target.issue.comments.length,
      wait: (minutes: number) => void (target.issue.now += minutes * MINUTE),
      tick(minutesAgo: number) {
        const db = new Database(join(f.dir, "controller.sqlite"), { strict: true });
        db.query("UPDATE kv SET value=? WHERE key='last-successful-heartbeat'").run(JSON.stringify({ at: at() - minutesAgo * MINUTE, status: "ok" }));
        db.close();
      },
      /** A new, empty drill folder with a current tick, and a drill issue with no memory. */
      reset() {
        f = folders({ tickAt: at() });
        target.issue.body = marker;
      },
      sender: file(() => join(f.mailDir, SENDER_HEARTBEAT_FILE)),
      ledger: file(() => join(f.dir, LOOP_FILES.ledgerHeartbeat)),
      push: async () => void (pushed = JSON.stringify(await collectHeartbeat(f.dir, f.mailDir, at()))),
      check: () => runCheck({ variable: DRILL, issue: 8, standingIssue: 7, owner: "fixture-owner", value: pushed }, target.io),
      /** One round: the files the drill names with current times, push, check, then 15 minutes. */
      async rounds(count: number, files: (round: number) => void) {
        for (let round = 0; round < count; round++) {
          files(round);
          await b.push();
          await b.check();
          b.wait(15);
        }
      },
    };
    return b;
  }

  test("every drill starts from a reset, so no drill inherits an open problem, a remembered job or a recent recovery", () => {
    expect(drills.map((m) => m[1])).toEqual(["Stale tick.", "Held hard stop.", "Ledger alarm.", "Pusher stopped for 100 minutes.", "Flapping.", "A worse problem behind an open one.", "A problem that comes back."]);
    for (const m of drills) expect(m[2]).toStartWith("`reset`.");
    expect(doc).toContain('gh issue edit "$DRILL_ISSUE" --repo "$R" --body "<!-- factory-heartbeat-state -->"');
  });

  test("all seven give their stated comments, one after the other", async () => {
    const b = bench(),
      last = () => b.target.issue.comments.at(-1)!;
    // 1. Stale tick.
    b.reset();
    await b.rounds(2, () => b.tick(60));
    expect(b.comments()).toBe(1);
    expect(last()).toContain("- the tick last succeeded 60 minutes ago");
    await b.rounds(2, () => b.tick(0));
    expect(b.comments()).toBe(2);
    expect(last()).toContain("**Recovered.**");
    // 2. Held hard stop.
    b.reset();
    await b.rounds(2, () => (b.tick(0), b.sender({ behindMs: 1_500_000 })));
    expect(b.comments()).toBe(3);
    expect(last()).toContain("**Problem.**");
    expect(last()).toContain("- the Telegram sender has held a hard stop unsent for 25 minutes");
    await b.rounds(2, () => (b.tick(0), b.sender()));
    expect(b.comments()).toBe(4);
    expect(last()).toContain("**Recovered.**");
    // 3. Ledger alarm.
    b.reset();
    await b.rounds(2, () => (b.tick(0), b.ledger({ alarm: "canary words" })));
    expect(b.comments()).toBe(5);
    expect(last()).toContain("**Problem.**");
    expect(last()).toContain("- the ledger job reports an alarm");
    expect(b.target.issue.body + b.target.issue.comments.join()).not.toContain("canary");
    await b.rounds(2, () => (b.tick(0), b.ledger()));
    expect(b.comments()).toBe(6);
    expect(last()).toContain("**Recovered.**");
    // 4. Pusher stopped for 100 minutes: push at T, checks at T+50 and T+80, push at T+100, checks at T+105 and T+120.
    b.reset();
    await b.push();
    b.wait(50);
    await b.check();
    expect(b.comments()).toBe(6);
    b.wait(30);
    await b.check();
    expect(b.comments()).toBe(7);
    expect(last()).toContain("**Problem.**");
    expect(last()).toContain("- no heartbeat from the Mac for 80 minutes");
    b.wait(20);
    b.tick(0);
    await b.push();
    b.wait(5);
    await b.check();
    b.wait(15);
    await b.check();
    expect(b.comments()).toBe(8);
    expect(last()).toContain("**Recovered.**");
    // 5. Flapping: no comment at all, and "watching" after each bad round.
    b.reset();
    for (let round = 0; round < 6; round++) {
      await b.rounds(1, () => b.tick(round % 2 ? 0 : 60));
      expect(b.target.issue.body).toContain(round % 2 ? "**Status: OK.**" : "**Status: watching.**");
    }
    expect(b.comments()).toBe(8);
    // 6. A worse problem behind an open one: checks 50 and 80 minutes after the last push.
    b.reset();
    await b.rounds(2, () => (b.tick(0), b.ledger({ alarm: "canary words" })));
    expect(b.comments()).toBe(9);
    b.wait(35);
    await b.check();
    b.wait(30);
    await b.check();
    expect(b.comments()).toBe(10);
    expect(last()).toContain("**Another problem**");
    expect(last()).toContain("- no heartbeat from the Mac for 80 minutes");
    b.wait(15);
    await b.rounds(2, () => (b.tick(0), b.ledger()));
    expect(b.comments()).toBe(11);
    expect(last()).toContain("**Recovered.**");
    // 7. A problem that comes back: drill 1 in full, then the stale tick again.
    b.reset();
    await b.rounds(2, () => b.tick(60));
    await b.rounds(2, () => b.tick(0));
    expect(b.comments()).toBe(13);
    await b.rounds(2, () => b.tick(60));
    expect(b.comments()).toBe(14);
    expect(last()).toContain("**Problem, back within 24 hours of a recovery.**");
    await b.rounds(2, () => b.tick(0));
    expect(b.comments()).toBe(14);
    expect(b.target.issue.body).toContain("12 clean checks in a row; 2 so far.");
    // Nobody was notified by any of it.
    expect(b.target.issue.comments.join("\n")).not.toContain("@");
  });
});

// -------------------------------------------------- the runner's side
describe("the workflow and the bare runner", () => {
  const source = readFileSync(join(repo, "scripts/push-heartbeat.ts"), "utf8");
  const workflow = readFileSync(join(repo, ".github/workflows/dead-man.yml"), "utf8");

  test("the check needs nothing installed: every static import is a Node built-in", () => {
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((from) => !from.startsWith("node:"))).toEqual([]);
  });

  test("the file alone, with no node_modules beside it, runs the check far enough to refuse a missing issue number", async () => {
    const bare = mkdtempSync(join(tmpdir(), "bare-runner-"));
    copyFileSync(join(repo, "scripts/push-heartbeat.ts"), join(bare, "push-heartbeat.ts"));
    const p = Bun.spawn([process.execPath, join(bare, "push-heartbeat.ts"), "check"], { cwd: bare, env: { PATH: "/usr/bin:/bin", HEARTBEAT_VALUE: "" }, stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).not.toBe(0);
    expect(err).toContain("HEARTBEAT_ISSUE must be the heartbeat issue's number");
  });

  test("the workflow runs on a schedule and by hand only, with the least permissions, and passes values through the environment", () => {
    expect(workflow).toContain('- cron: "13,43 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/pull_request|push:/);
    expect(workflow.match(/permissions:\n((?:  .+\n)+)/)![1]).toBe("  contents: read\n  issues: write\n");
    expect(workflow).toContain("run: bun scripts/push-heartbeat.ts check");
    expect(workflow).not.toContain("bun install");
    // Expressions appear only in `if`, `concurrency` and `env`, never inside a shell line.
    for (const line of workflow.split("\n").filter((l) => l.includes("${{"))) expect(line).toMatch(/^\s+(?:if|group|[A-Z_]+): /);
    // The job is skipped, at no cost, until the standing issue's number is stored.
    expect(workflow).toContain("if: ${{ inputs.issue != '' || vars.FACTORY_HEARTBEAT_ISSUE != '' }}");
    expect(workflow).toContain("HEARTBEAT_STANDING_ISSUE: ${{ vars.FACTORY_HEARTBEAT_ISSUE }}");
    // By hand, only the real variable or the drill variable can be read: a choice, not free text.
    expect(workflow).toContain(`        type: choice\n        options:\n          - ${HEARTBEAT_VARIABLE}\n          - ${DRILL}\n        default: ${HEARTBEAT_VARIABLE}\n`);
  });
});
