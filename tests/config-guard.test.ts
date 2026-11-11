import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotLimit } from "../launcher/capacity";
import { ConfigSchema } from "../launcher/config";
import {
  CONFIG_GUARD_FILES,
  CONFIG_GUARD_PROTECTED_PATHS,
  CONFIG_HARD_STOP_AFTER_MS,
  CONFIG_REJECTED_STATUS,
  SAFETY_FIELDS,
  checkConfig,
  configHardStopId,
  configHardStopText,
  guardConfig,
  hardStopDue,
  reportConfigRejection,
  tighten,
  type RejectedConfig,
} from "../launcher/config-guard";
import { LoopHeartbeatSchema, parseOwnerMessageId } from "../launcher/loop-contract";
import { setConfig } from "../scripts/set-config";
import { Store } from "../tracking/store";
import { TestEngine as Engine, admission, now as t0, ticket } from "./fixtures";
import { openRealMailStore, realMailSource } from "./helpers/real-mail-store";

const MINUTE = 60_000;
// Synthetic, in the shape of the installed config: a capacity controller, the
// fixed usage gates and an autonomy block. JSON is valid YAML.
const good = () => ({
  timezone: "America/Toronto",
  schedule: { qa_window: "20:00", production_window: "21:30", missed_window: "next_day" },
  owners: { builder: { harness: "codex", model: "gpt-6.1-sol", effort: "medium" } },
  usage_gates: { admit_below: 0.7, high_benefit_only_below: 0.9, stop_at: 0.9, max_meter_age_minutes: 15 },
  overrun: { checkpoint_at: 1.8, pause_at: 2 },
  autonomy: { intake_owner: "builder", ready_buffer: 3, auto_approval: { max_minutes: 30, max_docs_per_round: 1, protected_paths: ["launcher/config.ts", "wallet"] }, restart: { max_retries: 1, causes_per_hour: 3 } },
  capacity: { start_parallel: 6, heavy_test_slots: 1, controller: { start: 6, max: 12, interval_minutes: 60, busy_above: 0.8, failure_below: 0.3 } },
  wallet: { aws: { ceiling_usd_month: 75, reserve_usd: 15, hold_at_projected: 60, stop_at_actual: 65 }, other: { default_usd: 1 } },
  projects: { demo: { repo: "example/demo", owners: ["builder"], tests: "bun test" } },
});
type Draft = ReturnType<typeof good> & Record<string, unknown>;
const yaml = (edit: (draft: Draft) => void = () => {}) => {
  const draft = good() as Draft;
  edit(draft);
  return JSON.stringify(draft, null, 1) + "\n";
};
// The config pushed on 8 Nov: capacity 16 and a usage gate of 0.97. The six
// failing fields are the six the tick error log recorded that night; values
// other than 16 and 0.97 are stand-ins.
const NOV_8_FIELDS = ["usage_gates.admit_below", "usage_gates.high_benefit_only_below", "usage_gates.stop_at", "capacity.controller.start", "capacity.controller.max", "capacity.controller.interval_minutes"];
const nov8 = () =>
  yaml((draft) => {
    Object.assign(draft.usage_gates, { admit_below: 0.97, high_benefit_only_below: 0.99, stop_at: 0.99 });
    Object.assign(draft.capacity, { start_parallel: 16 });
    Object.assign(draft.capacity.controller, { start: 16, max: 24, interval_minutes: 30 });
  });
const malformed = (draft: Draft) => Object.assign(draft.owners.builder, { effort: "extreme" });

const live = (dir: string) => join(dir, CONFIG_GUARD_FILES.live);
function sandbox(text = yaml()) {
  const dir = mkdtempSync(join(tmpdir(), "config-guard-"));
  writeFileSync(live(dir), text);
  return dir;
}
/** A directory whose good config has been seen once, then replaced by `text`. */
function rejecting(text: string, at = t0): { dir: string; guard: RejectedConfig } {
  const dir = sandbox();
  expect(guardConfig(dir, at - MINUTE).ok).toBe(true);
  writeFileSync(live(dir), text);
  const guard = guardConfig(dir, at);
  if (guard.ok) throw Error("expected the config to be rejected");
  return { dir, guard };
}
const script = (name: string) => new URL(`../scripts/${name}`, import.meta.url).pathname;
async function run(name: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, script(name), ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

describe("validating and setting the config", () => {
  test("the 8 Nov config makes the validator exit non-zero naming each field, and set-config refuses to write it", async () => {
    const dir = sandbox(),
      before = readFileSync(live(dir), "utf8"),
      proposed = join(dir, "proposed.yaml");
    writeFileSync(proposed, nov8());
    writeFileSync(join(dir, "owner-token"), "synthetic-owner-token\n");

    const validated = await run("validate-config.ts", [proposed]);
    expect(validated.code).toBe(1);
    for (const field of NOV_8_FIELDS) expect(validated.err).toContain(`${field}: `);
    expect(validated.err).toContain("usage_gates.admit_below: Invalid input: expected 0.7 (found 0.97)");
    expect(validated.err).toContain("capacity.controller.start: Invalid input: expected 6 (found 16)");
    // With no file named it checks the live config, which is still the good one.
    expect(await run("validate-config.ts", [], { FACTORY_PRIVATE_DIR: dir })).toMatchObject({ code: 0, err: "" });

    expect(() => setConfig({ dir, source: proposed, actor: "Platform operator" })).toThrow(/nothing was written[\s\S]*usage_gates\.admit_below[\s\S]*capacity\.controller\.start/);
    const env = { FACTORY_PRIVATE_DIR: dir, FACTORY_OWNER_TOKEN: "synthetic-owner-token" };
    const refused = await run("set-config.ts", [proposed, "--actor", "Platform operator"], env);
    expect(refused.code).toBe(1);
    for (const field of NOV_8_FIELDS) expect(refused.err).toContain(field);
    // The owner token is needed even for a valid file.
    writeFileSync(proposed, yaml((draft) => (draft.capacity.heavy_test_slots = 0)));
    expect(await run("set-config.ts", [proposed, "--actor", "Platform operator"], { ...env, FACTORY_OWNER_TOKEN: "wrong-token" })).toMatchObject({ code: 1, err: expect.stringContaining("owner authorization required") });
    expect(readFileSync(live(dir), "utf8")).toBe(before);
    expect(existsSync(join(dir, "archive"))).toBe(false);
  }, 20000);

  test("set-config replaces the live file in one step, keeps what it replaced and needs a named actor", () => {
    const dir = sandbox(),
      before = readFileSync(live(dir), "utf8"),
      proposed = join(dir, "proposed.yaml"),
      next = yaml((draft) => (draft.capacity.heavy_test_slots = 0));
    writeFileSync(proposed, next);
    // Run on the file that is already live, it changes nothing and gives the guard its last-good copy.
    expect(setConfig({ dir, source: live(dir), actor: "Platform operator" })).toMatchObject({ changed: false, archive: null });
    expect(readFileSync(join(dir, CONFIG_GUARD_FILES.lastGood), "utf8")).toBe(before);
    expect(() => setConfig({ dir, source: proposed })).toThrow("needs --actor");
    expect(() => setConfig({ dir, source: join(dir, "absent.yaml"), actor: "Platform operator" })).toThrow("cannot be read");
    expect(readFileSync(live(dir), "utf8")).toBe(before);

    const result = setConfig({ dir, source: proposed, actor: "Platform operator", reason: "free the heavy slot", now: t0 });
    expect(result).toMatchObject({ changed: true, actor: "Platform operator", reason: "free the heavy slot" });
    expect(readFileSync(live(dir), "utf8")).toBe(next);
    expect(readFileSync(join(dir, CONFIG_GUARD_FILES.lastGood), "utf8")).toBe(next);
    expect(readFileSync(join(result.archive!, "config.before.yaml"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(result.archive!, "receipt.json"), "utf8"))).toMatchObject({ at: t0, actor: "Platform operator", afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(setConfig({ dir, source: proposed, actor: "Platform operator" })).toMatchObject({ changed: false });
    expect(guardConfig(dir, t0).ok).toBe(true);
  });

  test("set-config repairs a live config that is already invalid", () => {
    const { dir } = rejecting(nov8()),
      proposed = join(dir, "proposed.yaml");
    writeFileSync(proposed, yaml());
    const result = setConfig({ dir, source: proposed, actor: "Platform operator", now: t0 + MINUTE });
    expect(readFileSync(join(result.archive!, "config.before.yaml"), "utf8")).toBe(nov8());
    expect(guardConfig(dir, t0 + 2 * MINUTE)).toMatchObject({ ok: true, hold: false, status: null, alarm: null });
  });
});

describe("operator-only switches", () => {
  test("they default to off, 0 and off, and 3 fix-ups is rejected by the schema", () => {
    expect(ConfigSchema.parse(good()).operator_switches).toEqual({ failure_class_admission: "off", fix_ups_per_pull_request: 0, release_headroom: "off" });
    const set = (switches: Record<string, unknown>) => checkConfig(yaml((draft) => (draft.operator_switches = switches)));
    expect(set({ failure_class_admission: "on", fix_ups_per_pull_request: 2, release_headroom: "on" }).ok).toBe(true);
    expect(set({ fix_ups_per_pull_request: 3 })).toMatchObject({ ok: false, problems: [{ field: "operator_switches.fix_ups_per_pull_request" }] });
    expect(set({ fix_ups_per_pull_request: -1 }).ok).toBe(false);
    // "on" is the only way to turn one on; a misspelt name is refused, not ignored.
    expect(set({ release_headroom: true }).ok).toBe(false);
    expect(set({ fix_ups: 2 }).ok).toBe(false);
  });
});

describe("a rejected config", () => {
  test("the 8 Nov config live: no error, new work held, existing work supervised on the last good values, and the result reads degraded every tick", () => {
    const dir = sandbox(),
      accepted = guardConfig(dir, t0);
    if (!accepted.ok) throw Error("the good config was rejected");
    const s = new Store(join(dir, "controller.sqlite"));
    try {
      const before = new Engine(s, accepted.config);
      before.pause(false, "owner");
      const session = before.admit(ticket(), admission());

      writeFileSync(live(dir), nov8());
      const guard = guardConfig(dir, t0 + MINUTE);
      if (guard.ok || !guard.config) throw Error("expected a rejected config with something to supervise on");
      expect(guard).toMatchObject({ hold: true, status: "degraded: config rejected", honoured: [], rejectedSince: t0 + MINUTE });
      expect(guard.status).toBe(CONFIG_REJECTED_STATUS);
      expect(guard.problems.map((problem) => problem.field)).toEqual(NOV_8_FIELDS);
      // Nothing looser was taken: capacity 16 and the 0.97 gate are named and ignored.
      expect(guard.config).toEqual(accepted.config);
      expect(guard.ignored).toContainEqual({ field: "capacity.controller.start", lastGood: 6, offered: 16 });
      expect(guard.ignored).toContainEqual({ field: "usage_gates.admit_below", lastGood: 0.7, offered: 0.97 });
      expect(slotLimit(s, guard.config)).toBe(6);
      expect(LoopHeartbeatSchema.safeParse({ at: t0, alarm: guard.alarm }).success).toBe(true);
      expect(guard.alarm).toContain("new work is held");

      // The existing session is still supervised, on the effective config.
      const during = new Engine(s, guard.config);
      during.account(session.id, 30, 100, t0 + MINUTE);
      expect(during.active().map((x) => [x.id, x.actual_seconds])).toEqual([[session.id, 30]]);

      // One event per distinct bad file, however many ticks see it.
      const report = (g: RejectedConfig, at: number) => reportConfigRejection(dir, g, { store: s, mail: join(dir, "no-mail.sqlite"), now: at });
      expect(report(guard, t0 + MINUTE)).toEqual({ recorded: true, hardStop: "not-due" });
      const next = guardConfig(dir, t0 + 2 * MINUTE);
      if (next.ok) throw Error("still rejected");
      expect(next).toMatchObject({ status: CONFIG_REJECTED_STATUS, hold: true, rejectedSince: t0 + MINUTE });
      expect(report(next, t0 + 2 * MINUTE)).toEqual({ recorded: false, hardStop: "not-due" });
      // A second, different bad file is a second event and does not restart the clock.
      writeFileSync(live(dir), yaml(malformed));
      const other = guardConfig(dir, t0 + 3 * MINUTE);
      if (other.ok) throw Error("still rejected");
      expect(other.rejectedSince).toBe(t0 + MINUTE);
      expect(report(other, t0 + 3 * MINUTE).recorded).toBe(true);
      expect((s.rows("events") as { kind: string }[]).filter((event) => event.kind === "config-rejected")).toHaveLength(2);
    } finally {
      s.close();
    }
  });

  test("capacity lowered beside an unrelated malformed value: new work is held and the lower capacity applies at once", () => {
    const { guard } = rejecting(yaml((draft) => (malformed(draft), (draft.capacity.start_parallel = 3)))),
      s = new Store(":memory:");
    expect(guard).toMatchObject({ hold: true, status: CONFIG_REJECTED_STATUS, honoured: [{ field: "capacity.start_parallel", lastGood: 6, offered: 3 }] });
    expect(guard.problems.map((problem) => problem.field)).toEqual(["owners.builder.effort"]);
    expect(guard.config!.capacity).toMatchObject({ start_parallel: 3, controller: { start: 3, max: 3 } });
    expect(slotLimit(s, guard.config!)).toBe(3);
    // A lower controller ceiling is honoured as well, and without a controller the plain number is.
    const capped = rejecting(yaml((draft) => (malformed(draft), Object.assign(draft.capacity.controller, { max: 4 })))).guard;
    expect(capped.config!.capacity.controller).toMatchObject({ start: 4, max: 4 });
    expect(slotLimit(s, capped.config!)).toBe(4);
    const plain = ConfigSchema.parse({ ...good(), capacity: { start_parallel: 2, heavy_test_slots: 1 } });
    expect(slotLimit(s, tighten(plain, { capacity: { start_parallel: 1 } }).config)).toBe(1);
    s.close();
  });

  test("capacity raised beside a malformed value: the raise is ignored", () => {
    const { guard } = rejecting(yaml((draft) => (malformed(draft), (draft.capacity.start_parallel = 16), Object.assign(draft.capacity.controller, { start: 16, max: 24 })))),
      s = new Store(":memory:");
    expect(guard.honoured).toEqual([]);
    expect(guard.ignored.map((change) => [change.field, change.offered])).toEqual([["capacity.start_parallel", 16], ["capacity.controller.start", 16], ["capacity.controller.max", 24]]);
    expect(guard.config).toEqual(ConfigSchema.parse(good()));
    expect(slotLimit(s, guard.config!)).toBe(6);
    s.close();
  });

  test("a tighter gate, wallet stop, protected path or switch is honoured; nothing looser ever is", () => {
    const lastGood = ConfigSchema.parse({ ...good(), operator_switches: { failure_class_admission: "on", fix_ups_per_pull_request: 2, release_headroom: "off" } });
    const tighter = tighten(lastGood, {
      usage_gates: { admit_below: 0.5, stop_at: 0.8 },
      wallet: { aws: { stop_at_actual: 0, reserve_usd: 20 } },
      autonomy: { auto_approval: { protected_paths: ["launcher/config.ts", "launcher/config-guard.ts"] } },
      operator_switches: { failure_class_admission: "off", fix_ups_per_pull_request: 1 },
    });
    expect(tighter.config).toMatchObject({
      usage_gates: { admit_below: 0.5, high_benefit_only_below: 0.9, stop_at: 0.8 },
      wallet: { aws: { stop_at_actual: 0, reserve_usd: 20, ceiling_usd_month: 75 } },
      autonomy: { auto_approval: { protected_paths: ["launcher/config.ts", "wallet", "launcher/config-guard.ts"] } },
      operator_switches: { failure_class_admission: "off", fix_ups_per_pull_request: 1, release_headroom: "off" },
    });
    // Dropping "wallet" from the protected paths was looser, so it stayed.
    expect(tighter.ignored).toEqual([{ field: "autonomy.auto_approval.protected_paths", lastGood: ["launcher/config.ts", "wallet"], offered: { dropped: ["wallet"] } }]);

    // A file that loosens every safety field, or offers values of the wrong kind, changes nothing.
    const base = ConfigSchema.parse(good());
    const looser = {
      capacity: { start_parallel: 60, heavy_test_slots: 5, controller: { start: 12, max: 60 } },
      usage_gates: { admit_below: 0.97, high_benefit_only_below: 1, stop_at: 1, max_meter_age_minutes: 600 },
      wallet: { aws: { ceiling_usd_month: 500, hold_at_projected: 500, stop_at_actual: 500, reserve_usd: 0 }, other: { default_usd: 100 } },
      autonomy: { restart: { causes_per_hour: 10 }, auto_approval: { protected_paths: [] } },
      operator_switches: { failure_class_admission: "on", fix_ups_per_pull_request: 2, release_headroom: "on" },
    };
    const wrongKind = { capacity: { start_parallel: 0, controller: { max: "3" } }, usage_gates: { admit_below: -1, stop_at: null }, wallet: { aws: { stop_at_actual: "none" } }, operator_switches: { release_headroom: false } };
    for (const rejected of [looser, wrongKind, undefined, null, "not a config", []]) {
      const result = tighten(base, rejected);
      expect(result.honoured).toEqual([]);
      expect(result.config).toEqual(base);
    }
    // Every safety field was offered a looser value above and named as ignored.
    expect(new Set(tighten(base, looser).ignored.map((change) => change.field))).toEqual(new Set(SAFETY_FIELDS));
  });

  test("a file that is not YAML, is missing, or has no earlier good config never throws and still holds", () => {
    const broken = rejecting("capacity: [unclosed\n").guard;
    expect(broken).toMatchObject({ hold: true, status: CONFIG_REJECTED_STATUS, honoured: [], problems: [{ field: "(whole file)", message: expect.stringContaining("not valid YAML") }] });
    expect(broken.config).toEqual(ConfigSchema.parse(good()));

    const empty = mkdtempSync(join(tmpdir(), "config-guard-")),
      missing = guardConfig(empty, t0);
    expect(missing).toMatchObject({ ok: false, hold: true, config: null, problems: [{ message: "the config file is missing" }] });
    // Nothing to supervise on is "factory down" now, not in 15 minutes.
    if (missing.ok) throw Error("expected a rejected config");
    expect(reportConfigRejection(empty, missing, { mail: join(empty, "no-mail.sqlite"), now: t0 })).toMatchObject({ hardStop: "failed", id: configHardStopId("2026-11-07") });
  });
});

describe("the hard stop for Vincent", () => {
  const since = Date.parse("2026-11-08T23:48:00-05:00");
  test("it is due after 15 minutes, once a day, and again from 09:00 each later day while the config stays invalid", () => {
    expect(hardStopDue(since, since + CONFIG_HARD_STOP_AFTER_MS - 1)).toBeNull();
    // 23:48 plus 15 minutes is the next local day.
    expect(hardStopDue(since, since + CONFIG_HARD_STOP_AFTER_MS)).toBe("2026-11-09");
    expect(hardStopDue(since, Date.parse("2026-11-09T12:00:00-05:00"), "2026-11-09")).toBeNull();
    expect(hardStopDue(since, Date.parse("2026-11-10T08:59:00-05:00"), "2026-11-09")).toBeNull();
    expect(hardStopDue(since, Date.parse("2026-11-10T09:00:00-05:00"), "2026-11-09")).toBe("2026-11-10");
    // A first attempt that failed (mail down) is retried at once, whatever the hour.
    expect(hardStopDue(since, Date.parse("2026-11-10T02:00:00-05:00"))).toBe("2026-11-10");
  });

  test("its id is the contract's factory-down hard stop, and its text fits one short message", () => {
    expect(configHardStopId("2026-11-09")).toBe("loop:hard-stop:factory-down:config-invalid:2026-11-09");
    expect(parseOwnerMessageId(configHardStopId("2026-11-09"))).toMatchObject({ tier: "hard-stop", kind: "factory-down", conditionKey: "factory-down:config-invalid" });
    for (const supervising of [true, false]) {
      expect(configHardStopText(supervising)).toStartWith("Factory down: config invalid, no new work");
      expect(configHardStopText(supervising).length).toBeLessThanOrEqual(120);
    }
  });

  test("a mail store that is away is reported, never thrown, and retried with the same id", () => {
    const { dir, guard } = rejecting(nov8(), since),
      s = new Store(":memory:"),
      report = (at: number) => reportConfigRejection(dir, guard, { store: s, mail: join(dir, "no-mail.sqlite"), now: at });
    expect(report(since + CONFIG_HARD_STOP_AFTER_MS)).toMatchObject({ hardStop: "failed", id: configHardStopId("2026-11-09"), error: expect.stringContaining("unavailable") });
    expect(report(since + CONFIG_HARD_STOP_AFTER_MS + MINUTE)).toMatchObject({ hardStop: "failed", id: configHardStopId("2026-11-09") });
    expect((s.rows("events") as { kind: string }[]).filter((event) => event.kind === "config-hard-stop-failure")).toHaveLength(1);
    s.close();
  });

  test("the files to protect at install are the guard and the two scripts", () => {
    expect([...CONFIG_GUARD_PROTECTED_PATHS]).toEqual(["launcher/config-guard.ts", "scripts/set-config.ts", "scripts/validate-config.ts"]);
    for (const path of CONFIG_GUARD_PROTECTED_PATHS) expect(existsSync(new URL(`../${path}`, import.meta.url).pathname)).toBe(true);
  });

  // This runs the mail checkout's own code. That checkout is a separate
  // repository and is absent in this repository's CI, where it is skipped.
  test.skipIf(!realMailSource())("real mail store: no row before 15 minutes, one row after, sent by Alido Mail's own send function, one more the next morning", async () => {
    const mail = await openRealMailStore();
    try {
      const { dir, guard } = rejecting(nov8(), since),
        report = (at: number) => reportConfigRejection(dir, guard, { mail: mail.path, now: at }),
        first = configHardStopId("2026-11-09"),
        due = since + CONFIG_HARD_STOP_AFTER_MS;
      expect(report(due - MINUTE)).toEqual({ recorded: false, hardStop: "not-due" });
      expect(mail.row(first)).toBeNull();

      expect(report(due)).toEqual({ recorded: false, hardStop: "raised", id: first });
      expect(mail.row(first)).toMatchObject({ sender: "Factory Desk", recipient: "Vincent", recipient_app: "telegram", kind: "blocker", state: "unread", summary: configHardStopText(true), body: "" });
      expect(await mail.sendToVincent(due + MINUTE)).toEqual([`Factory Desk: ${configHardStopText(true)}`]);
      expect(mail.telegramSentAt(first)).toBe(due + MINUTE);

      // Still invalid: nothing more that day, then one row from 09:00 the next day.
      expect(report(due + 5 * MINUTE).hardStop).toBe("not-due");
      expect(report(Date.parse("2026-11-10T08:30:00-05:00")).hardStop).toBe("not-due");
      const second = configHardStopId("2026-11-10");
      expect(report(Date.parse("2026-11-10T09:00:00-05:00"))).toMatchObject({ hardStop: "raised", id: second });
      expect(report(Date.parse("2026-11-10T09:01:00-05:00")).hardStop).toBe("not-due");
      expect(mail.db.query("select id from messages where recipient='Vincent' order by created_at").all()).toEqual([{ id: first }, { id: second }]);

      // Fixed: the guard accepts, and a later bad file starts a fresh 15 minutes.
      writeFileSync(live(dir), yaml());
      expect(guardConfig(dir, Date.parse("2026-11-10T10:00:00-05:00")).ok).toBe(true);
      writeFileSync(live(dir), nov8());
      const again = guardConfig(dir, Date.parse("2026-11-10T11:00:00-05:00"));
      if (again.ok) throw Error("expected a rejected config");
      expect(again.rejectedSince).toBe(Date.parse("2026-11-10T11:00:00-05:00"));
      expect(reportConfigRejection(dir, again, { mail: mail.path, now: Date.parse("2026-11-10T11:05:00-05:00") }).hardStop).toBe("not-due");
    } finally {
      mail.close();
    }
  });
});
