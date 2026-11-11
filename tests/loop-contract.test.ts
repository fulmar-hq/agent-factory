import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../launcher/config";
import { healthBridge } from "../launcher/factory-health-runtime";
import {
  CLASS_KINDS,
  HARD_STOP_KINDS,
  HUMAN_ONLY_STEPS,
  LEDGER_EXPORT_MAX_AGE_MS,
  LIMIT_KINDS,
  LOOP_FILES,
  LOOP_PROTECTED_PATHS,
  LoopHeartbeatSchema,
  OWNER_MESSAGE_PREFIXES,
  PROOF_SUBJECTS,
  SHARED_SUBJECTS,
  actionRole,
  fixesFailureClasses,
  fixesFailureLine,
  inboxFileName,
  limitReviewAt,
  ownerMessageId,
  ownerRole,
  parseInboxRecord,
  parseOwnerMessageId,
  proofFor,
  regressionFolder,
  releaseInputClassId,
  releaseInputHumanStep,
  roleActionId,
  usableLedgerExport,
  type OwnerMessage,
} from "../launcher/loop-contract";
import { LOOP_SWITCH_NAMES, loopActing, readLoopFlags } from "../launcher/loop-flags";
import { releaseAction } from "../launcher/release-actions";
import { gapOwner } from "../launcher/release-rehearsal";
import { flipLoopSwitch } from "../scripts/loop-flag";
import { openRealMailStore, realMailSource } from "./helpers/real-mail-store";

const source = (file: string) => readFileSync(new URL(`../launcher/${file}`, import.meta.url), "utf8");
const day = "2026-11-11";
const at = Date.parse("2026-11-11T14:00:00-05:00");

describe("owner table", () => {
  // Every input name the readiness collector can report, read from its source
  // so a new input cannot be added without meeting this test.
  const readiness = source("release-readiness.ts");
  const inputs = [
    ...new Set(
      [...readiness.matchAll(/(?:missing\(|check\(|input:)\s*(['`])([^'`]+)\1/g)].flatMap(([, , name]) =>
        name!.includes("${owner}") ? ["release", "quality"].map((owner) => name!.replace("${owner}", owner)) : [name!],
      ),
    ),
  ];
  const reasons = ["", "expired", "factory is paused", "AWS stop remains latched", "owner decision required", "usage window missing", "billing reading stale", "password and MFA needed", "wrong source"];

  test("every release input gets exactly what the installed rehearsal's gapOwner returns", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(15);
    for (const input of inputs) for (const reason of reasons) expect([input, reason, ownerRole({ kind: "release-input", input, reason })]).toEqual([input, reason, gapOwner(input, reason)]);
    expect(ownerRole({ kind: "release-input", input: "AWS sign-in" })).toBe(gapOwner("AWS sign-in", ""));
  });

  test("today's routing is written down, so a change to it is seen as a contract change", () => {
    const owner = (input: string, reason = "") => ownerRole({ kind: "release-input", input, reason });
    expect(Object.fromEntries(inputs.sort().map((input) => [input, owner(input)]))).toEqual({
      "AWS sign-in": "Coordinator",
      "PR checks": "Release",
      "Quality runner": "Quality",
      "billing and factory state": "Platform",
      "disk space": "Platform",
      "factory state": "Release",
      "fresh billing": "Platform",
      "hosted acceptance path": "Quality",
      "owner qualification": "Quality",
      "owner usage": "Coordinator",
      "quality qualification": "Quality",
      "quality usage": "Coordinator",
      "release holds": "Release",
      "release qualification": "Release",
      "release usage": "Coordinator",
    });
    expect(owner("factory state", "factory is paused")).toBe("Coordinator");
    expect(owner("factory state", "AWS stop remains latched")).toBe("Coordinator");
  });

  test("the Coordinator is never the role asked to act", () => {
    for (const input of inputs) for (const reason of reasons) expect(actionRole({ kind: "release-input", input, reason })).not.toBe("Coordinator");
    expect(actionRole({ kind: "release-input", input: "release usage" })).toBe("Platform");
    expect(actionRole({ kind: "release-input", input: "factory state", reason: "factory is paused" })).toBe("Platform");
    expect(actionRole({ kind: "proof-owed", role: "Coordinator" })).toBe("Platform");
    for (const kind of CLASS_KINDS) if (kind !== "release-input") expect(actionRole({ kind } as Parameters<typeof actionRole>[0])).not.toBe("Coordinator");
    expect(ownerRole({ kind: "failure" })).toBe("Platform");
    expect(ownerRole({ kind: "failure", fixLivesIn: "product" })).toBe("Product");
    expect(ownerRole({ kind: "operator-overdue" })).toBe("Platform");
    expect(ownerRole({ kind: "proof-owed", role: "Release" })).toBe("Release");
  });

  test("a sign-in is the only release input that is a step for Vincent, and only coded steps are human-only", () => {
    expect(inputs.filter((input) => releaseInputHumanStep(input))).toEqual(["AWS sign-in"]);
    expect(releaseInputHumanStep("fresh billing", "password and MFA needed")).toBe("sign-in");
    expect(Object.keys(HUMAN_ONLY_STEPS)).toEqual(["sign-in", "switch-decision", "operator-session"]);
  });

  test("one class id per release input, safe as a folder name", () => {
    expect(releaseInputClassId("AWS sign-in")).toBe("release-input-aws-sign-in");
    expect(new Set(inputs.map(releaseInputClassId)).size).toBe(inputs.length);
    expect(() => releaseInputClassId(" ? ")).toThrow();
  });
});

describe("messages to Vincent", () => {
  const samples: OwnerMessage[] = [
    ...Object.keys(HARD_STOP_KINDS).map((kind) => ({ tier: "hard-stop", kind, subject: SHARED_SUBJECTS.tickDead, day }) as OwnerMessage),
    ...Object.values(SHARED_SUBJECTS).map((subject) => ({ tier: "hard-stop", kind: "human-step", subject, day }) as OwnerMessage),
    { tier: "night-result", day },
    { tier: "ask", kind: "release-step", subject: "aws-sign-in", day },
    { tier: "ask", kind: "operator-queue", subject: "summary", day },
    { tier: "routine", kind: "idle", subject: "paused", day },
    { tier: "cleared", kind: "idle", subject: "paused", day },
  ];

  test("every id the contract builds reads back to its own tier and nothing else", () => {
    for (const message of samples) {
      const id = ownerMessageId(message);
      expect(parseOwnerMessageId(id)).toMatchObject(message);
      expect(Object.values(OWNER_MESSAGE_PREFIXES).filter((prefix) => id.startsWith(prefix))).toEqual([OWNER_MESSAGE_PREFIXES[message.tier]]);
    }
    expect(ownerMessageId({ tier: "hard-stop", kind: "disk", subject: "data-volume", day })).toBe("loop:hard-stop:disk:data-volume:2026-11-11");
    expect(parseOwnerMessageId("loop:routine:idle:paused:2026-11-11")?.conditionKey).toBe(parseOwnerMessageId("loop:cleared:idle:paused:2026-11-11")?.conditionKey);
  });

  test("the 22:00 result keeps the id its writer already uses", () => {
    expect(ownerMessageId({ tier: "night-result", day })).toBe(`release-window-result:${day}`);
    expect(source("release-result.ts")).toContain("id=`release-window-result:${day}`");
  });

  test("a writer cannot invent a kind, claim a tier in the subject, or pass an unknown id as known", () => {
    expect(() => ownerMessageId({ tier: "hard-stop", kind: "urgent" as "disk", subject: "x", day })).toThrow("unknown hard-stop kind");
    expect(() => ownerMessageId({ tier: "routine", kind: "disk" as "idle", subject: "x", day })).toThrow("unknown routine kind");
    expect(() => ownerMessageId({ tier: "routine", kind: "idle", subject: "x:hard-stop", day })).toThrow("subject");
    expect(() => ownerMessageId({ tier: "ask", kind: "decision", subject: "x", day: "today" })).toThrow("day");
    for (const id of ["loop:hard-stop:urgent:x:2026-11-11", "loop:hard-stop:disk:x:2026-11-11:extra", "loop:hard-stop:disk:x", "factory-tick-error:1", "release-window-result:tonight", "qualification-expiry:codex:1"]) expect(parseOwnerMessageId(id)).toBeNull();
  });

  test("role action ids are one per role, class and episode", () => {
    expect(roleActionId("Platform", "release-input-aws-sign-in", day)).toBe("loop:action:platform:release-input-aws-sign-in:2026-11-11");
    expect(() => roleActionId("Vincent" as "Platform", "x", day)).toThrow();
    expect(parseOwnerMessageId(roleActionId("Quality", "x1", day))).toBeNull();
  });
});

describe("proof, limits and fix lines", () => {
  test("the proof comes from the table and can only be raised", () => {
    expect(proofFor("failure", "publication")).toMatchObject({ successes: 20, inARow: false });
    expect(proofFor("failure", "scheduled-job")).toMatchObject({ successes: 3, inARow: true });
    expect(proofFor("release-input")).toMatchObject({ subject: "release-input", successes: 3 });
    expect(proofFor("safeguard-not-proven")).toMatchObject({ subject: "alarm", successes: 2 });
    expect(proofFor("failure", "scheduled-job", 5)?.successes).toBe(5);
    expect(proofFor("failure", "scheduled-job", 1)?.successes).toBe(3);
    expect(proofFor("failure", "publication", Number.NaN)?.successes).toBe(20);
    expect(() => proofFor("failure")).toThrow("must name one of");
    expect(() => proofFor("release-input", "alarm")).toThrow();
    for (const kind of ["limit", "limit-review", "proof-owed", "operator-overdue"] as const) expect(proofFor(kind)).toBeNull();
    expect(Object.keys(PROOF_SUBJECTS).sort()).toEqual([...CLASS_KINDS].sort());
  });

  test("each limit has an expected duration, and an unknown end is an error, not 'not due'", () => {
    expect(limitReviewAt("paused", at)).toBe(at + 30 * 60_000);
    expect(limitReviewAt("disk-refused", at)).toBe(at + 2 * 3_600_000);
    expect(limitReviewAt("usage-stop", at, at + 3_600_000)).toBe(at + 90 * 60_000);
    expect(limitReviewAt("install-freeze", at, at + 5 * 3_600_000)).toBe(at + 5 * 3_600_000);
    expect(() => limitReviewAt("usage-stop", at)).toThrow("usage-reset");
    expect(Object.keys(LIMIT_KINDS).sort()).toEqual(["disk-refused", "install-freeze", "paused", "usage-stop", "usage-window-missing", "wallet-stop", "worker-unqualified"]);
    // The table names limits; it holds no threshold a caller could loosen.
    expect(JSON.stringify(LIMIT_KINDS)).not.toMatch(/0\.7|0\.9|"max"|ceiling|stop_at/);
  });

  test("fixes-failure lines, the regression folder and the check's name", () => {
    expect(fixesFailureLine("controller-lock")).toBe("fixes-failure: controller-lock");
    expect(regressionFolder("controller-lock")).toBe("regressions/controller-lock");
    expect(fixesFailureClasses("Body\nfixes-failure: controller-lock\n fixes-failure: indented\nfixes-failure: Not_An_Id\nsee fixes-failure: inline\nfixes-failure: owner-wake-e2big  \nfixes-failure: controller-lock")).toEqual(["controller-lock", "owner-wake-e2big"]);
    expect(() => fixesFailureLine("../escape")).toThrow();
    expect(() => regressionFolder("")).toThrow();
  });
});

describe("heartbeat, inbox and export formats", () => {
  test("the heartbeat shape accepts today's health heartbeat and a job's own extra fields", () => {
    expect(LoopHeartbeatSchema.safeParse({ at }).success).toBe(true);
    expect(LoopHeartbeatSchema.parse({ at, behindMs: 0, alarm: "ledger 20 minutes behind", oldestUnsentHardStopMs: 5 })).toMatchObject({ oldestUnsentHardStopMs: 5 });
    for (const bad of [{}, { at: "now" }, { at, behindMs: -1 }, { at, alarm: "" }]) expect(LoopHeartbeatSchema.safeParse(bad).success).toBe(false);
  });

  const record = { version: 1, id: `release-morning:${day}:aws-sign-in`, at, source: "release-morning" };
  test("the inbox takes each adding record type", () => {
    const records = [
      { ...record, type: "declare", kind: "failure", signature: "publisher: bundle missing", summary: "Delivery bundle missing" },
      { ...record, type: "issue-link", classId: "controller-lock", repo: "fulmar-hq/agent-factory", issue: 201 },
      { ...record, type: "fix-link", classId: "controller-lock", repo: "fulmar-hq/alido", pr: 12, actor: "Platform operator" },
      { ...record, type: "release-input", classId: releaseInputClassId("AWS sign-in"), input: "AWS sign-in", reason: "expired", day },
      { ...record, type: "drill-result", drill: "disk-alarm", ok: true, evidence: "drills/2026-11-11/disk.json" },
      { ...record, type: "proof-owed", proofId: "idle-repeat-live", what: "First idle episode after install", dueAt: at + 86_400_000, role: "Quality" },
      { ...record, type: "proof-attached", proofId: "idle-repeat-live", evidence: "issue comment 1", actor: "Quality" },
      { ...record, type: "human-step-request", classId: releaseInputClassId("AWS sign-in"), step: "sign-in", what: "AWS sign-in before 22:30" },
    ];
    for (const r of records) expect([r.type, parseInboxRecord(r).ok]).toEqual([r.type, true]);
    expect(inboxFileName(records[0] as never)).toBe(inboxFileName({ ...records[0], at: at + 5 } as never));
    expect(inboxFileName(records[0] as never)).toMatch(/^declare-[a-f0-9]{20}\.json$/);
  });

  test("the inbox can only add: reducing, unknown and malformed records are refused with a reason", () => {
    for (const type of ["merge", "split", "defer", "accept-risk", "dismiss"]) expect(parseInboxRecord({ ...record, type, classId: "controller-lock" })).toMatchObject({ ok: false, reason: expect.stringContaining("can only add") });
    expect(parseInboxRecord({ ...record, type: "close", classId: "controller-lock" }).ok).toBe(false);
    expect(parseInboxRecord({ ...record, type: "declare", kind: "failure", signature: "x", summary: "y", state: "closed-with-proof" }).ok).toBe(false);
    expect(parseInboxRecord({ ...record, type: "human-step-request", classId: "controller-lock", step: "review my pull request", what: "review" }).ok).toBe(false);
    expect(parseInboxRecord({ ...record, type: "release-input", classId: "controller-lock", input: "AWS sign-in", reason: "expired", day })).toMatchObject({ ok: false, reason: expect.stringContaining("class id") });
    expect(parseInboxRecord("declare").ok).toBe(false);
    expect(parseInboxRecord(null).ok).toBe(false);
  });

  test("a ledger export is usable only when it parses and is fresh", () => {
    const exported = { version: 1, at, nightsMissed: 2, classes: [{ id: "controller-lock", kind: "failure", state: "verifying", ownerRole: "Platform", shadow: false, needsOperatorSince: null, lastSeenAt: at }] };
    expect(usableLedgerExport(exported, at + LEDGER_EXPORT_MAX_AGE_MS)?.nightsMissed).toBe(2);
    expect(usableLedgerExport(exported, at + 40 * 60_000)).toBeNull();
    expect(usableLedgerExport(exported, at - 1)).toBeNull();
    expect(usableLedgerExport({ ...exported, classes: [{ ...exported.classes[0], state: "fixed" }] }, at)).toBeNull();
    expect(usableLedgerExport(null, at)).toBeNull();
  });
});

describe("loop switches", () => {
  const sandbox = () => mkdtempSync(join(tmpdir(), "loop-flags-"));
  const report = (dir: string) => {
    const path = join(dir, "parity.md");
    writeFileSync(path, "would have opened: 3 classes\n");
    return path;
  };
  const allRecordOnly = Object.fromEntries(LOOP_SWITCH_NAMES.map((name) => [name, "record-only"]));

  test("never flipped means every switch is record-only, with no alarm", () => {
    expect(readLoopFlags(sandbox())).toEqual({ modes: allRecordOnly, entries: {}, alarm: null, source: "default" } as never);
  });

  test("a flip with no actor or no parity report path is refused and changes nothing", () => {
    const dir = sandbox();
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", parityReport: report(dir) })).toThrow("needs --actor");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: " " , parityReport: report(dir) })).toThrow("needs --actor");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: "Platform operator" })).toThrow("needs --parity-report");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: "Platform operator", parityReport: join(dir, "absent.md") })).toThrow("cannot be read");
    writeFileSync(join(dir, "empty.md"), "");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: "Platform operator", parityReport: join(dir, "empty.md") })).toThrow("is empty");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "sending", actor: "Platform operator", parityReport: report(dir) })).toThrow("mode must be");
    expect(readLoopFlags(dir)).toMatchObject({ modes: allRecordOnly, alarm: null, source: "default" });
  });

  test("a flip with both is recorded with who and what, and can be turned back with a reason", () => {
    const dir = sandbox();
    expect(flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: "Platform operator", parityReport: report(dir), now: at })).toMatchObject({ from: "record-only", to: "acting" });
    const flags = readLoopFlags(dir);
    expect(flags).toMatchObject({ alarm: null, source: "file" });
    expect(loopActing(flags, "idle-observation-gap")).toBe(true);
    expect(loopActing(flags, "class-restart-hold")).toBe(false);
    expect(flags.entries["idle-observation-gap"]).toMatchObject({ actor: "Platform operator", at, parityReport: join(dir, "parity.md"), parityReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "acting", actor: "Platform operator", parityReport: report(dir) })).toThrow("already acting");
    expect(() => flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "record-only", actor: "Platform operator" })).toThrow("needs --reason");
    flipLoopSwitch({ dir, name: "idle-observation-gap", mode: "record-only", actor: "Platform operator", reason: "false alarms overnight", now: at + 1 });
    expect(readLoopFlags(dir).modes).toEqual(allRecordOnly as never);
    const history = readFileSync(join(dir, LOOP_FILES.switchHistory), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(history.map((h) => [h.actor, h.switch, h.from, h.to])).toEqual([
      ["Platform operator", "idle-observation-gap", "record-only", "acting"],
      ["Platform operator", "idle-observation-gap", "acting", "record-only"],
    ]);
  });

  test("a malformed switch file changes no switch and sets an alarm reason", () => {
    const dir = sandbox(),
      file = join(dir, LOOP_FILES.switches);
    flipLoopSwitch({ dir, name: "health-blind-state", mode: "acting", actor: "Platform operator", parityReport: report(dir), now: at });
    const good = readLoopFlags(dir).modes;
    const valid = readFileSync(file, "utf8");
    const damaged = [
      "{ not json",
      "",
      JSON.stringify({ version: 2, switches: {} }),
      JSON.stringify({ version: 1, switches: { "health-blind-state": { mode: "record-only" } } }),
      JSON.stringify({ version: 1, switches: { "class-restart-hold": { mode: "acting", actor: "someone", at } } }),
      JSON.stringify({ version: 1, switches: {}, usage_gates: { admit_below: 0.97 } }),
      JSON.stringify({ ...JSON.parse(valid), switches: { ...JSON.parse(valid).switches, "made-up-switch": { mode: "acting", actor: "someone", at } } }),
    ];
    for (const text of damaged) {
      writeFileSync(file, text);
      const flags = readLoopFlags(dir);
      expect([text, flags.modes]).toEqual([text, good]);
      expect(flags.source).toBe("last-good");
      expect(flags.alarm).toContain("the last good switches stand");
    }
    // A torn last history line does not lose the earlier good record.
    appendFileSync(join(dir, LOOP_FILES.switchHistory), '{"after":{"version":1,"switch');
    expect(readLoopFlags(dir).modes).toEqual(good);
    // The next recorded flip repairs the file.
    expect(flipLoopSwitch({ dir, name: "health-blind-state", mode: "acting", actor: "Platform operator", parityReport: report(dir), now: at + 2 }).repaired).toContain("the last good switches stand");
    expect(readLoopFlags(dir)).toMatchObject({ modes: good, alarm: null, source: "file" });
  });

  test("a malformed file with no recorded flip turns nothing on and still raises the alarm", () => {
    const dir = sandbox();
    writeFileSync(join(dir, LOOP_FILES.switches), JSON.stringify({ version: 1, switches: { "class-restart-hold": { mode: "acting" } } }));
    expect(readLoopFlags(dir)).toMatchObject({ modes: allRecordOnly, source: "default", alarm: expect.stringContaining("every switch is record-only") });
  });

  test("no switch name maps to a config limit, and the switch file cannot carry one", () => {
    // Every field name in the config schema, including the usage gates,
    // capacity, the wallet and the release schedule.
    const fields = new Set<string>();
    const walk = (schema: any, path: string[]) => {
      const def = schema?.def;
      if (!def) return;
      if (def.type === "object") for (const [key, value] of Object.entries(def.shape)) (fields.add(key), fields.add([...path, key].join(".")), walk(value, [...path, key]));
      else for (const inner of [def.innerType, def.valueType, def.element]) walk(inner, path);
    };
    walk(ConfigSchema, []);
    for (const limit of ["usage_gates", "admit_below", "high_benefit_only_below", "stop_at", "capacity", "start_parallel", "capacity.controller.max", "wallet", "ceiling_usd_month", "stop_at_actual", "schedule", "qa_window", "production_window", "max_retries", "protected_paths"]) expect([limit, fields.has(limit)]).toEqual([limit, true]);
    const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const limitNames = new Set([...fields].flatMap((field) => [plain(field), ...field.split(".").map(plain)]));
    for (const name of LOOP_SWITCH_NAMES) {
      expect([name, limitNames.has(plain(name))]).toEqual([name, false]);
      expect(name).not.toMatch(/usage|capacity|wallet|spend|budget|schedule|window|admission|headroom|fix-?up|gate|protected/);
    }
    const dir = sandbox();
    for (const field of fields) {
      expect(() => flipLoopSwitch({ dir, name: field, mode: "acting", actor: "Platform operator", parityReport: report(dir) })).toThrow("unknown loop switch");
      writeFileSync(join(dir, LOOP_FILES.switches), JSON.stringify({ version: 1, switches: { [field]: { mode: "acting", actor: "Platform operator", at, parityReport: "/x", parityReportSha256: "a".repeat(64) } } }));
      expect(readLoopFlags(dir)).toMatchObject({ modes: allRecordOnly, alarm: expect.stringContaining("rejected") });
    }
  });

  test("the command line needs the owner token to flip, and shows the switches without it", async () => {
    const dir = sandbox(),
      script = new URL("../scripts/loop-flag.ts", import.meta.url).pathname;
    writeFileSync(join(dir, "owner-token"), "synthetic-owner-token\n");
    const run = async (args: string[], token?: string) => {
      const child = Bun.spawn([process.execPath, script, ...args], { env: { PATH: process.env.PATH ?? "", FACTORY_PRIVATE_DIR: dir, ...(token ? { FACTORY_OWNER_TOKEN: token } : {}) }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    const flip = ["set", "ledger-rules-stuck-work", "acting", "--actor", "Platform operator", "--parity-report", report(dir)];
    for (const token of [undefined, "wrong-token"]) {
      const refused = await run(flip, token);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("owner authorization required");
    }
    expect(readLoopFlags(dir).source).toBe("default");
    expect((await run(flip.slice(0, 5), "synthetic-owner-token")).err).toContain("needs --parity-report");
    expect(await run(flip, "synthetic-owner-token")).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse((await run(["show"])).out).modes["ledger-rules-stuck-work"]).toBe("acting");
    expect((await run(["flip-everything"])).code).not.toBe(0);
  }, 20000);

  test("the files to protect at install are the two launcher files, the flip script and the switch data file", () => {
    expect([...LOOP_PROTECTED_PATHS]).toEqual(["launcher/loop-contract.ts", "launcher/loop-flags.ts", "scripts/loop-flag.ts", "loop-flags.json"]);
  });
});

// These run the mail checkout's own code. That checkout is a separate
// repository and is absent in this repository's CI, where they are skipped.
describe.skipIf(!realMailSource())("real mail store helper", () => {
  test("an fyi written by the launcher ends 'digested' through Alido Mail's own code, with no hand-set state", async () => {
    const mail = await openRealMailStore();
    try {
      const bridge = healthBridge(mail.path);
      try {
        bridge.send("factory-health:disk:1:opening:Coordinator", "Coordinator", "Factory disk is low.");
      } finally {
        bridge.close();
      }
      expect(mail.row("factory-health:disk:1:opening:Coordinator")).toMatchObject({ kind: "fyi", state: "unread", wake_state: "pending" });
      expect(await mail.wakeClaude("Coordinator")).toBe(true);
      expect(mail.row("factory-health:disk:1:opening:Coordinator")).toMatchObject({ state: "unread", wake_state: "digested", wake_id: expect.stringMatching(/^w_/) });
      expect(mail.revision).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      mail.close();
    }
  });

  test("a Vincent row has a Telegram sent time only after the real send function ran, through a stand-in connection", async () => {
    const mail = await openRealMailStore();
    try {
      const id = ownerMessageId({ tier: "hard-stop", kind: "disk", subject: "data-volume", day });
      const bridge = healthBridge(mail.path);
      try {
        bridge.send(id, "Vincent", "Factory disk is full; new work is stopped.");
      } finally {
        bridge.close();
      }
      expect(mail.telegramSentAt(id)).toBeNull();
      expect(await mail.sendToVincent(at)).toEqual(["Factory Desk: Factory disk is full; new work is stopped."]);
      expect(mail.telegramSentAt(id)).toBe(at);
      expect(await mail.sendToVincent(at + 1)).toEqual([]);
    } finally {
      mail.close();
    }
  });

  test("a role action is woken only when the role has a Codex thread; without one it fails as it does live", async () => {
    const mail = await openRealMailStore({ codexThreads: { Quality: "thread-quality" } });
    try {
      releaseAction("gap-quality", "Quality", "Release gap: hosted acceptance path.", "Due 18:30", at, mail.path);
      releaseAction("gap-platform", "Platform", "Release gap: disk space.", "Due 18:30", at, mail.path);
      expect(await mail.ringCodex(at + 10_000)).toBe(1);
      expect(mail.row("gap-quality")).toMatchObject({ wake_state: "woken" });
      expect(mail.row("gap-platform")).toMatchObject({ wake_state: "failed", state: "unread" });
      expect(mail.db.query("select detail from wakes where recipient='Platform'").get()).toEqual({ detail: "no thread in the Codex map" });
    } finally {
      mail.close();
    }
  });
});
