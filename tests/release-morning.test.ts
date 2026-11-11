import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationFreeze } from "../launcher/integration-freeze";
import { plistEnvironment } from "../launcher/job-environment";
import { actionRole, inboxFileName, parseInboxRecord, parseOwnerMessageId, releaseInputClassId, roleActionId, type InboxRecord } from "../launcher/loop-contract";
import { toronto } from "../launcher/release";
import { readReleaseBatch } from "../launcher/release-batch";
import { MORNING_LABEL, expiringQualifications, freezeProblem, installedRevision, morningJobDefinition, morningSlot, proofProblem, runMorningCheck, type MorningOptions } from "../launcher/release-morning";
import { collectReleaseReadiness } from "../launcher/release-readiness";
import { Store } from "../tracking/store";
import { config, meter, qualification } from "./fixtures";
import { openRealMailStore, realMailSource } from "./helpers/real-mail-store";

const repo = join(import.meta.dir, "..");
const DAY = "2026-11-12";
const at = (time: string, day = DAY) => Date.parse(`${day}T${time}:00-05:00`);
const A = "a".repeat(40);
const B = "b".repeat(40);
const RUNS = ["09:00", "12:00", "16:45", "17:35"] as const;
const MESSAGES = "CREATE TABLE messages(id TEXT PRIMARY KEY,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)";
const signIn = "Error: original AWS sign-in does not remain valid through 22:30";
type Gap = { input: string; reason: string };
type Mail = { id: string; recipient: string; kind: string; summary: string; body: string };

/** A healthy day in a temporary private directory: a proof for the installed revision, today's batch, tonight's freeze. */
function day(mailPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), "release-morning-"));
  const mail = mailPath ?? join(dir, "mail.sqlite");
  const db = new Database(mail);
  if (!mailPath) db.exec(MESSAGES);
  const store = new Store(":memory:");
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  write("release-quality-path.json", { source: A, expiresAt: at("23:00") });
  write("release-batch.json", { day: DAY });
  write("integration-freeze.json", { version: 1, from: `${DAY}T17:30:00-05:00`, until: `${DAY}T22:35:00-05:00`, reason: "evening freeze" });
  write("qualifications.json", { codex: { expiresAt: at("12:00", "2026-11-14") } });
  const state = { installed: A, missing: [] as Gap[], collect: undefined as undefined | (() => never) };
  return {
    dir,
    mail,
    store,
    state,
    write,
    run: (time: string, extra: Partial<MorningOptions> = {}) =>
      runMorningCheck({
        dir,
        store,
        mail,
        now: at(time),
        installed: () => state.installed,
        collect: async (now) => state.collect?.() ?? { day: DAY, at: now, validThrough: at("22:30"), ready: !state.missing.length, missing: state.missing, evidence: {} },
        ...extra,
      }),
    mails: (to?: string) => (db.query("SELECT id,recipient,kind,summary,body FROM messages ORDER BY id").all() as Mail[]).filter((m) => !to || m.recipient === to),
    wakes: () => (store.db.query("SELECT value FROM kv WHERE key LIKE 'owner-wake:%'").all() as { value: string }[]).map((r) => JSON.parse(r.value) as { id: string; owner: string; kind: string; state: string; payload: { source: string } }),
    inbox: () => {
      const folder = join(dir, "health/ledger-inbox");
      return existsSync(folder) ? readdirSync(folder).map((name) => ({ name, record: JSON.parse(readFileSync(join(folder, name), "utf8")) as InboxRecord })) : [];
    },
    close: () => (db.close(), store.close()),
  };
}
const finding = (report: Awaited<ReturnType<typeof runMorningCheck>>, input: string) => report.findings.find((f) => f.input === input);
const classOf = (file: { record: InboxRecord }) => ("classId" in file.record ? file.record.classId : undefined);

describe("the morning release-inputs check", () => {
  test("the slot follows the clock, and a healthy day reports nothing, mails nothing and writes nothing", async () => {
    expect([8 * 60, 9 * 60, 12 * 60, 16 * 60 + 44, 16 * 60 + 45, 17 * 60 + 29, 17 * 60 + 35, 23 * 60].map(morningSlot)).toEqual(["09:00", "09:00", "12:00", "12:00", "16:45", "16:45", "17:35", "17:35"]);
    const d = day();
    try {
      const before = readdirSync(d.dir).sort();
      for (const time of RUNS) expect(await d.run(time)).toMatchObject({ day: DAY, slot: time, ready: true, findings: [], actions: [], failures: [], installed: A });
      expect(d.mails()).toEqual([]);
      expect(d.wakes()).toEqual([]);
      expect(readdirSync(d.dir).sort()).toEqual(before);
      expect(d.store.db.query("SELECT count(*) AS n FROM events WHERE kind='release-morning'").get()).toEqual({ n: 4 });
      expect(d.store.get(`release-morning:${DAY}:12:00`)).toMatchObject({ slot: "12:00", ready: true });
    } finally {
      d.close();
    }
  });

  test("a proof bound to an older revision is reported at 09:00 and requested exactly once after the freeze starts", async () => {
    const d = day();
    try {
      d.state.installed = B;
      const morning = await d.run("09:00");
      expect(finding(morning, "hosted acceptance path")).toEqual({ input: "hosted acceptance path", level: "informational", reason: `the Quality proof names ${A.slice(0, 12)}, but the installed revision is ${B.slice(0, 12)}` });
      // Before the freeze an install would undo a proof, so nothing is requested yet.
      await d.run("12:00");
      await d.run("16:45");
      expect(d.mails()).toEqual([]);
      expect(d.wakes()).toEqual([]);

      const late = await d.run("17:35");
      expect(late.frozen).toBe(true);
      expect(finding(late, "hosted acceptance path")?.level).toBe("missing");
      const id = roleActionId("Quality", releaseInputClassId("hosted acceptance path"), `${DAY}.${B.slice(0, 12)}`);
      expect(late.actions).toEqual([{ input: "hosted acceptance path", did: "proof-requested", to: "Quality", id }]);
      expect((await d.run("17:35")).actions).toEqual([{ input: "hosted acceptance path", did: "proof-already-requested", to: "Quality", id }]);
      expect(d.mails()).toHaveLength(1);
      expect(d.mails()[0]).toMatchObject({ id, recipient: "Quality", kind: "action" });
      expect(d.mails()[0]!.body).toContain(B);
      expect(d.mails()[0]!.body).toContain("No source install, activation, real-person send or gate exception is authorized.");
      expect(d.wakes()).toEqual([expect.objectContaining({ id: `mail:${id}`, owner: "quality", kind: "release-path-proof-request", state: "queued", payload: expect.objectContaining({ source: B }) })]);
    } finally {
      d.close();
    }
  });

  test("a proof for the installed revision that expires at 21:00 is reported and requested exactly once", async () => {
    const d = day();
    try {
      d.write("release-quality-path.json", { source: A, expiresAt: at("21:00") });
      expect(finding(await d.run("09:00"), "hosted acceptance path")).toMatchObject({ level: "informational", reason: `the Quality proof expires at ${DAY} 21:00, before 22:30 tonight` });
      await d.run("17:35");
      await d.run("17:35");
      expect(d.mails()).toHaveLength(1);
      expect(d.mails()[0]).toMatchObject({ recipient: "Quality" });
      expect(d.wakes()).toHaveLength(1);
      expect(proofProblem({ source: A, expiresAt: at("22:30") + 1 }, A, at("22:30"))).toBeNull();
      expect(proofProblem(null, A, at("22:30"))).toContain("missing");
    } finally {
      d.close();
    }
  });

  test("an install at 17:10 leaves the proof stale at 17:35 and exactly one fresh request names the new revision", async () => {
    const d = day();
    try {
      expect((await d.run("16:45")).findings).toEqual([]);
      d.state.installed = B; // the 17:10 install
      const late = await d.run("17:35");
      expect(late.actions.map((a) => a.did)).toEqual(["proof-requested"]);
      await d.run("17:35");
      expect(d.mails()).toHaveLength(1);
      expect(d.mails()[0]!.summary).toContain(B.slice(0, 12));
      expect(d.wakes().map((w) => w.payload.source)).toEqual([B]);
    } finally {
      d.close();
    }
    // Where the freeze-start job has already asked for this exact revision, the check does not ask twice.
    const e = day();
    try {
      e.state.installed = B;
      e.store.set(`release-freeze-proof-request:${DAY}`, { source: B, summary: "", body: "" });
      expect((await e.run("17:35")).actions).toEqual([{ input: "hosted acceptance path", did: "proof-already-requested", to: "Quality", id: `release-freeze-proof:${DAY}` }]);
      expect(e.mails()).toEqual([]);
      expect(e.wakes()).toEqual([]);
    } finally {
      e.close();
    }
  });

  test("an expired sign-in at all four runs is one ask row that day, one hard stop from 16:45, and never role mail", async () => {
    const d = day();
    try {
      d.state.missing = [
        { input: "AWS sign-in", reason: signIn },
        { input: "fresh billing", reason: signIn },
      ];
      expect((await d.run("09:00")).actions).toEqual([]);
      expect(d.mails()).toEqual([]);
      for (const time of RUNS.slice(1)) await d.run(time);
      const ask = `loop:ask:release-step:aws-sign-in:${DAY}`;
      const stop = `loop:hard-stop:human-step:aws-sign-in:${DAY}`;
      expect(d.mails().map((m) => [m.id, m.recipient])).toEqual([
        [ask, "Vincent"],
        [stop, "Vincent"],
      ]);
      expect(parseOwnerMessageId(ask)).toMatchObject({ tier: "ask", kind: "release-step" });
      expect(parseOwnerMessageId(stop)).toMatchObject({ tier: "hard-stop", kind: "human-step" });
      expect(d.mails()[0]!.summary).toBe("Tonight's release needs your AWS sign-in before 6:30 PM. Can you do that?");
      expect(d.wakes()).toEqual([]);
      const records = d.inbox().map((f) => f.record);
      expect(records.filter((r) => r.type === "human-step-request")).toEqual([expect.objectContaining({ step: "sign-in", classId: "release-input-aws-sign-in", dueAt: at("18:30") })]);
      expect(records.filter((r) => r.type === "release-input").map((r) => r.classId).sort()).toEqual(["release-input-aws-sign-in", "release-input-fresh-billing"]);
    } finally {
      d.close();
    }
    // First seen at 16:45, it goes straight to the hard stop: one message, not two.
    const late = day();
    try {
      late.state.missing = [{ input: "AWS sign-in", reason: signIn }];
      await late.run("16:45");
      await late.run("17:35");
      expect(late.mails().map((m) => m.id)).toEqual([`loop:hard-stop:human-step:aws-sign-in:${DAY}`]);
    } finally {
      late.close();
    }
  });

  test("a qualification that lapses at 23:47 tonight is reported at 09:00; Platform is asked only when no renewal is on schedule", async () => {
    const expiry = "worker environment qualifications";
    const mail = roleActionId("Platform", releaseInputClassId(expiry), DAY);
    // The contract's own owner rule answers Platform for this input: renewal is Platform's, not Release's.
    expect(actionRole({ kind: "release-input", input: expiry, reason: "qualifications lapse before 09:00 tomorrow: codex at 2026-11-12 23:47" })).toBe("Platform");
    // Codex keys renew by themselves six hours before they lapse. On schedule they are reported, and nobody is mailed.
    const scheduled = day();
    try {
      scheduled.write("qualifications.json", { codex: { expiresAt: at("23:47") }, "codex:high": { expiresAt: at("08:59", "2026-11-13") }, "codex:medium": { expiresAt: at("09:01", "2026-11-13") }, claude: { expiresAt: at("08:00") } });
      const report = await scheduled.run("09:00");
      expect(report.findings).toEqual([{ input: expiry, level: "informational", reason: `qualifications lapse before 09:00 tomorrow: codex at ${DAY} 23:47, codex:high at 2026-11-13 08:59; the automatic renewal is due six hours before each lapse` }]);
      expect(report.ready).toBe(true);
      for (const time of RUNS.slice(1)) await scheduled.run(time);
      expect(scheduled.mails()).toEqual([]);
      expect(scheduled.inbox()).toEqual([]);
      expect(expiringQualifications(null, at("09:00"))).toBeNull();
    } finally {
      scheduled.close();
    }
    // A renewal that has not happened with under five hours left is late: one mail to Platform, one ledger record.
    const late = day();
    try {
      late.write("qualifications.json", { codex: { expiresAt: at("21:44") }, "codex:high": { expiresAt: at("21:44") } });
      expect(finding(await late.run("12:00"), expiry)?.level).toBe("informational");
      expect(late.mails()).toEqual([]);
      expect(finding(await late.run("16:45"), expiry)).toEqual({ input: expiry, level: "missing", reason: `qualifications lapse before 09:00 tomorrow: codex at ${DAY} 21:44, codex:high at ${DAY} 21:44` });
      await late.run("17:35");
      expect(late.mails().map((m) => [m.id, m.recipient])).toEqual([[mail, "Platform"]]);
      expect(late.inbox().map(classOf)).toEqual([releaseInputClassId(expiry)]);
    } finally {
      late.close();
    }
    // A key with no automatic renewal is acted on as soon as it is seen.
    const manual = day();
    try {
      manual.write("qualifications.json", { claude: { expiresAt: at("23:47") } });
      expect(finding(await manual.run("09:00"), expiry)).toEqual({ input: expiry, level: "missing", reason: `qualifications lapse before 09:00 tomorrow: claude at ${DAY} 23:47` });
      expect(manual.mails().map((m) => [m.id, m.recipient])).toEqual([[mail, "Platform"]]);
    } finally {
      manual.close();
    }
  });

  test("the freeze is report-only: an uncovered evening or an unreadable file is told to Platform, and the file is never written", async () => {
    const fileOnly: typeof integrationFreeze = (dir, now = 0) => {
      const f = JSON.parse(readFileSync(join(dir, "integration-freeze.json"), "utf8"));
      return now >= Date.parse(f.from) && now < Date.parse(f.until) ? f.reason : null;
    };
    const platformMail = roleActionId("Platform", releaseInputClassId("install freeze configuration"), DAY);
    // No freeze at all.
    const none = day();
    try {
      rmSync(join(none.dir, "integration-freeze.json"));
      for (const time of RUNS) expect(finding(await none.run(time, { freeze: () => null }), "install freeze configuration")).toMatchObject({ level: "missing", reason: expect.stringContaining("no install freeze covers") });
      expect(none.mails().map((m) => [m.id, m.recipient])).toEqual([[platformMail, "Platform"]]);
      expect(existsSync(join(none.dir, "integration-freeze.json"))).toBe(false);
    } finally {
      none.close();
    }
    // An operator's morning hold that does not reach the evening: reported, and left exactly as it is.
    const hold = day();
    try {
      const operator = JSON.stringify({ version: 1, from: `${DAY}T08:00:00-05:00`, until: `${DAY}T12:00:00-05:00`, reason: "risky change" });
      hold.write("integration-freeze.json", operator);
      for (const time of RUNS) expect(finding(await hold.run(time, { freeze: fileOnly }), "install freeze configuration")?.reason).toContain(`no install freeze covers ${DAY} 17:3`);
      expect(readFileSync(join(hold.dir, "integration-freeze.json"), "utf8")).toBe(operator);
      expect(hold.mails("Platform")).toHaveLength(1);
    } finally {
      hold.close();
    }
    // A file the installed reader refuses.
    const broken = day();
    try {
      broken.write("integration-freeze.json", "{}");
      for (const time of RUNS) expect(finding(await broken.run(time), "install freeze configuration")?.reason).toContain("cannot be read");
      expect(readFileSync(join(broken.dir, "integration-freeze.json"), "utf8")).toBe("{}");
      expect(broken.mails().map((m) => m.recipient)).toEqual(["Platform"]);
    } finally {
      broken.close();
    }
    // A covering file is left byte for byte, and the window is checked to its last instant.
    const covered = day();
    try {
      const original = readFileSync(join(covered.dir, "integration-freeze.json"), "utf8");
      for (const time of RUNS) await covered.run(time);
      expect(readFileSync(join(covered.dir, "integration-freeze.json"), "utf8")).toBe(original);
      covered.write("integration-freeze.json", { version: 1, from: `${DAY}T17:30:00-05:00`, until: `${DAY}T22:34:00-05:00`, reason: "one minute short" });
      expect(freezeProblem(covered.dir, at("09:00"), fileOnly)).toContain(`${DAY} 22:34`);
      expect(freezeProblem(covered.dir, at("23:00"), fileOnly)).toBeNull();
    } finally {
      covered.close();
    }
    // The check has no way to write a freeze: its source never names the file and never imports a writer for it.
    const source = readFileSync(join(repo, "launcher/release-morning.ts"), "utf8") + readFileSync(join(repo, "scripts/release-morning.ts"), "utf8");
    expect(source).not.toContain("integration-freeze.json");
  });

  test("the night's batch and acceptance ticket are only noted at 09:00 and are missing from 12:00", async () => {
    const d = day();
    try {
      d.write("release-batch.json", { day: "2026-11-11" });
      d.write("release-acceptance-ticket.json", { day: "2026-11-11" });
      d.state.missing = [
        { input: "PR checks", reason: "Error: current-day accepted batch carrier is missing" },
        { input: "quality qualification", reason: "Error: acceptance ticket is expired or for another day" },
        { input: "quality usage", reason: "Error: usage unknown" },
      ];
      const morning = await d.run("09:00");
      expect(morning.findings.map((f) => [f.input, f.level])).toEqual([
        ["PR checks", "informational"],
        ["quality qualification", "informational"],
        ["quality usage", "informational"],
      ]);
      expect(morning.ready).toBe(true);
      expect(d.mails()).toEqual([]);
      expect(d.inbox()).toEqual([]);
      const noon = await d.run("12:00");
      expect(noon.findings.map((f) => [f.input, f.level, f.reason])).toEqual([
        ["PR checks", "missing", "release-batch.json is dated 2026-11-11, not today"],
        ["quality qualification", "missing", "release-acceptance-ticket.json is dated 2026-11-11, not today"],
        ["quality usage", "missing", "Error: usage unknown"],
      ]);
      expect(Object.fromEntries(d.mails().map((m) => [m.summary, m.recipient]))).toEqual({
        [`Release input missing: PR checks. Due ${DAY} 18:30 Eastern.`]: "Release",
        [`Release input missing: quality qualification. Due ${DAY} 18:30 Eastern.`]: "Quality",
        [`Release input missing: quality usage. Due ${DAY} 18:30 Eastern.`]: "Platform",
      });
      // No ticket at all is fine: the configured Quality role applies. No batch at all is missing.
      rmSync(join(d.dir, "release-acceptance-ticket.json"));
      rmSync(join(d.dir, "release-batch.json"));
      d.state.missing = [];
      expect((await d.run("16:45")).findings).toEqual([{ input: "PR checks", level: "missing", reason: "release-batch.json is missing or unreadable" }]);
    } finally {
      d.close();
    }
  });

  test("each missing input is one action mail and one ledger record a day, to the contract's role and never the Coordinator", async () => {
    const d = day();
    try {
      for (const [index, time] of RUNS.entries()) {
        d.state.missing = [
          { input: "disk space", reason: `Error: only ${50 - index} GiB free` },
          { input: "release usage", reason: "Error: high benefit only" },
          { input: "factory state", reason: "factory is paused" },
        ];
        const report = await d.run(time);
        expect(report.failures).toEqual([]);
        expect(report.actions.map((a) => a.did)).toEqual(["mailed", "mailed", "mailed"]);
      }
      const mails = d.mails();
      expect(mails.map((m) => [m.id, m.recipient])).toEqual(["disk space", "factory state", "release usage"].map((input) => [roleActionId("Platform", releaseInputClassId(input), DAY), "Platform"]));
      expect(mails.every((m) => m.kind === "action" && m.summary.length <= 120 && m.body.length <= 800 && m.body.endsWith("No pause, gate, spending or release-time exception is granted."))).toBe(true);
      // The first reason of the day is the one that was mailed and recorded; a later reason does not conflict with it.
      expect(mails[0]!.body).toStartWith("Error: only 50 GiB free");
      const inbox = d.inbox();
      expect(inbox.map((f) => f.record.type === "release-input" && f.record.input).sort()).toEqual(["disk space", "factory state", "release usage"]);
      for (const { name, record } of inbox) {
        expect(parseInboxRecord(record)).toEqual({ ok: true, record });
        expect(name).toBe(inboxFileName(record));
        expect(record).toMatchObject({ source: "release-morning", day: DAY, at: at("09:00") });
      }
      expect(d.wakes()).toEqual([]);
    } finally {
      d.close();
    }
  });

  test("a failed collection or an unreadable revision is itself reported to Platform, and a mail outage is retried by the next run", async () => {
    const d = day();
    try {
      d.state.collect = () => {
        throw Error("config.yaml: invalid");
      };
      const report = await d.run("09:00", {
        installed: () => {
          throw Error("no checkout");
        },
      });
      expect(report).toMatchObject({ ready: false, installed: null, findings: [{ input: "release configuration", level: "missing", reason: "Error: config.yaml: invalid; the installed factory revision could not be read" }] });
      expect(d.mails().map((m) => m.recipient)).toEqual(["Platform"]);

      d.state.collect = undefined;
      d.state.missing = [{ input: "disk space", reason: "low" }];
      const outage = await d.run("12:00", { mail: join(d.dir, "absent.sqlite") });
      expect(outage.failures).toEqual(["mail for disk space: Error: existing Alido Mail outbox unavailable"]);
      expect(d.store.get(`release-morning:${DAY}:12:00`)).toMatchObject({ failures: outage.failures });
      expect((await d.run("16:45")).actions).toEqual([expect.objectContaining({ input: "disk space", did: "mailed", to: "Platform" })]);
    } finally {
      d.close();
    }
  });

  // These three run the preflight's real collection, wired the way the entry
  // point wires it, so the findings are the ones the installed job would see.
  function realCollection(d: ReturnType<typeof day>) {
    const c = config();
    c.owners = { release: { harness: "codex", model: "gpt-6.1-sol", effort: "medium" }, quality: { harness: "claude", model: "opus-5.5", effort: "medium" } };
    const q = { ...qualification(), expiresAt: at("12:00", "2026-11-14") };
    const carrier = { day: DAY, base: "c".repeat(40), revision: "d".repeat(40), tree: "e".repeat(40), pr: 7, ref: "fix/fictional-batch", holdId: "fictional-off" };
    const batch = (on: string) => ({ version: 1, ...carrier, day: on, sources: [{ number: 5, head: "f".repeat(40), ref: "fix/fictional-source", title: "Fictional change" }], overlaps: [], review: "fictional review" });
    d.write("release-auth-session.json", { version: 1, kind: "original-password-mfa-session", signedInAt: `${DAY}T00:30:00-05:00`, expiresAt: `${DAY}T23:30:00-05:00`, receipt: "fictional original sign-in" });
    d.write("qualifications.json", { codex: q, claude: { ...q, model: "opus-5.5" } });
    d.write("release-quality-path.json", { version: 1, qualified: true, provider: "claude", model: "opus-5.5", effort: "medium", expiresAt: at("23:00"), source: A, evidence: "fictional hosted proof", hostedHttp: true, receiptIngestion: true });
    d.write("release-batch.json", batch(DAY));
    d.store.set("paused", false);
    d.store.set("owner-runtime:quality", { workspace: tmpdir() });
    const hold = { version: 1, id: carrier.holdId, held: false, legacy_issue: null, reason: "Fictional open batch", by: "fixture", at: "2026-11-12T12:00:00Z" };
    const remotes: Record<string, unknown> = {
      "actions/variables/QA_HOLD": { value: JSON.stringify(hold) },
      "issues/1192": { labels: [] },
      "pulls/7": { state: "open", draft: false, head: { sha: carrier.revision, ref: carrier.ref, repo: { full_name: "fulmar-hq/alido" } }, base: { ref: "QA", repo: { full_name: "fulmar-hq/alido" } }, mergeable: true, mergeable_state: "clean" },
      "git/ref/heads/QA": { object: { sha: carrier.base } },
      [`git/commits/${carrier.revision}`]: { tree: { sha: carrier.tree } },
      [`commits/${carrier.revision}/check-runs?per_page=100`]: { total_count: 3, check_runs: ["Verify", "Secret scan", "Release hold"].map((name, id) => ({ id, name, app: { slug: "github-actions" }, head_sha: carrier.revision, status: "completed", conclusion: "success" })) },
    };
    const identity = { of: (_pid: number): string | null => null };
    const collect: MorningOptions["collect"] = async (now) => {
      // As scripts/release-morning.ts does: no batch for today yet is a finding, not a crash.
      let today: ReturnType<typeof readReleaseBatch> | undefined;
      try {
        today = readReleaseBatch(d.dir, toronto(now).day);
      } catch {}
      const reading = { ...meter(0.2), observedAt: now, windows: [0.2, 0.3].map((used) => ({ used, resetsAt: now + 86400000 })) };
      return collectReleaseReadiness({
        dir: d.dir,
        config: c,
        store: d.store,
        brake: null,
        billingRefusal: null,
        carrier: today,
        factorySource: d.state.installed,
        readings: { codex: reading, claude: reading },
        now,
        disk: () => ({ freeGiB: 70, usedFraction: 0.7 }),
        identity: (pid) => identity.of(pid),
        execute: async (args) => {
          const key = args[4]!.split("repos/fulmar-hq/alido/")[1]!;
          if (!(key in remotes)) throw Error("unknown fictional source");
          return JSON.stringify(remotes[key]);
        },
      });
    };
    return { collect, batch, hold, remotes, identity };
  }
  const levels = (report: Awaited<ReturnType<typeof runMorningCheck>>) => Object.fromEntries(report.findings.map((f) => [f.input, f.level]));

  test("the real collection with no batch for today: one cause is one finding, noted at 09:00 and one mail from 12:00; a real hold later is still mailed", async () => {
    const d = day();
    try {
      const real = realCollection(d);
      // A complete day passes the preflight's own collection.
      expect(await d.run("09:00", { collect: real.collect })).toMatchObject({ ready: true, findings: [] });

      // Yesterday's batch is still on disk at 09:00. The QA hold itself is valid and off.
      d.write("release-batch.json", real.batch("2026-11-11"));
      const morning = await d.run("09:00", { collect: real.collect });
      expect(levels(morning)).toEqual({ "PR checks": "informational", "release holds": "informational" });
      expect(finding(morning, "release holds")?.reason).toBe("the QA hold cannot be compared with tonight's batch until there is one");
      expect(morning).toMatchObject({ ready: true, actions: [], failures: [] });
      expect(d.mails()).toEqual([]);
      expect(d.inbox()).toEqual([]);

      // From noon the missing batch is one mail to Release, not a second one about holds.
      const noon = await d.run("12:00", { collect: real.collect });
      expect(levels(noon)).toEqual({ "PR checks": "missing", "release holds": "informational" });
      expect(d.mails().map((m) => [m.id, m.recipient])).toEqual([[roleActionId("Release", releaseInputClassId("PR checks"), DAY), "Release"]]);
      expect(d.inbox().map(classOf)).toEqual(["release-input-pr-checks"]);

      // The batch arrives at 14:22 and the QA hold is switched on at 15:00: that is a real holds problem and gets its own mail.
      d.write("release-batch.json", real.batch(DAY));
      real.remotes["actions/variables/QA_HOLD"] = { value: JSON.stringify({ ...real.hold, held: true }) };
      const late = await d.run("16:45", { collect: real.collect });
      expect(late.findings).toEqual([{ input: "release holds", level: "missing", reason: "Error: QA hold is on" }]);
      const holds = d.mails().find((m) => m.id === roleActionId("Release", releaseInputClassId("release holds"), DAY));
      expect(holds).toMatchObject({ recipient: "Release" });
      expect(holds!.body).toStartWith("Error: QA hold is on");
      expect(d.mails()).toHaveLength(2);
    } finally {
      d.close();
    }
  });

  test("the real collection while Quality is mid-turn: a session in progress is only noted, a lost workspace is mailed", async () => {
    const d = day();
    try {
      const real = realCollection(d);
      d.store.set("owner-runtime:quality", { workspace: tmpdir(), pid: 4242, identity: "fictional start identity" });
      real.identity.of = () => "fictional start identity";
      for (const time of RUNS) {
        const report = await d.run(time, { collect: real.collect });
        expect(report.findings).toEqual([{ input: "Quality runner", level: "informational", reason: "Error: Quality owner is still running" }]);
        expect(report.ready).toBe(true);
      }
      expect(d.mails()).toEqual([]);
      expect(d.inbox()).toEqual([]);
      d.store.set("owner-runtime:quality", { workspace: join(d.dir, "absent") });
      expect((await d.run("17:35", { collect: real.collect })).findings).toEqual([{ input: "Quality runner", level: "missing", reason: "Error: Quality has no registered existing workspace" }]);
      expect(d.mails().map((m) => m.recipient)).toEqual(["Quality"]);
    } finally {
      d.close();
    }
  });

  test("his sign-in is asked for only while a release can still follow it tonight", async () => {
    const vincent = (d: ReturnType<typeof day>) => d.mails("Vincent").map((m) => m.id);
    const stop = `loop:hard-stop:human-step:aws-sign-in:${DAY}`;
    // The factory is paused: no ask, no hard stop. The pause and the sign-in are still reported and recorded.
    const paused = day();
    try {
      paused.state.missing = [
        { input: "AWS sign-in", reason: signIn },
        { input: "factory state", reason: "factory is paused" },
      ];
      for (const time of RUNS) expect((await paused.run(time)).ready).toBe(false);
      expect(vincent(paused)).toEqual([]);
      expect(paused.mails().map((m) => m.recipient)).toEqual(["Platform"]);
      expect(paused.inbox().map((f) => f.record.type).sort()).toEqual(["release-input", "release-input"]);
    } finally {
      paused.close();
    }
    // No batch for tonight: the noon ask still goes (the batch is normally made in the afternoon), the hard stop does not.
    const empty = day();
    try {
      rmSync(join(empty.dir, "release-batch.json"));
      empty.state.missing = [{ input: "AWS sign-in", reason: signIn }];
      for (const time of RUNS.slice(0, 3)) await empty.run(time);
      expect(vincent(empty)).toEqual([`loop:ask:release-step:aws-sign-in:${DAY}`]);
      // Once the batch exists the open sign-in blocks a real release, and the 17:35 run says so.
      empty.write("release-batch.json", { day: DAY });
      await empty.run("17:35");
      expect(vincent(empty)).toEqual([`loop:ask:release-step:aws-sign-in:${DAY}`, stop]);
    } finally {
      empty.close();
    }
    // A run after 18:30 (by hand, or launchd catching up after sleep) names no deadline that has passed: it reports and records only.
    for (const time of ["18:30", "23:30"]) {
      const after = day();
      try {
        after.state.installed = B;
        after.state.missing = [
          { input: "AWS sign-in", reason: signIn },
          { input: "disk space", reason: "Error: only 40 GiB free" },
        ];
        const report = await after.run(time);
        expect(report).toMatchObject({ slot: "17:35", ready: false, actions: [], failures: [] });
        expect(after.mails()).toEqual([]);
        expect(after.wakes()).toEqual([]);
        expect(after.inbox().map(classOf).sort()).toEqual(["release-input-aws-sign-in", "release-input-disk-space", ...(time === "18:30" ? ["release-input-hosted-acceptance-path"] : [])]);
        expect(after.store.get(`release-morning:${DAY}:17:35`)).toMatchObject({ at: at(time) });
      } finally {
        after.close();
      }
    }
    // The last moment in time still sends.
    const last = day();
    try {
      last.state.missing = [{ input: "AWS sign-in", reason: signIn }];
      await last.run("18:29");
      expect(vincent(last)).toEqual([stop]);
    } finally {
      last.close();
    }
    // Another input whose error text happens to mention a password is work for its role, not a sign-in for Vincent.
    const login = day();
    try {
      login.state.missing = [{ input: "release holds", reason: "Error: gh: password authentication is not supported" }];
      for (const time of RUNS) await login.run(time);
      expect(vincent(login)).toEqual([]);
      expect(login.mails().map((m) => [m.id, m.recipient])).toEqual([[roleActionId("Platform", releaseInputClassId("release holds"), DAY), "Platform"]]);
      expect(login.inbox().map((f) => f.record.type)).toEqual(["release-input"]);
    } finally {
      login.close();
    }
  });

  test("an operator's dated hold in the morning is not tonight's freeze: no proof is requested until 17:35, and the request says only what is known", async () => {
    const d = day();
    try {
      d.state.installed = B;
      d.write("integration-freeze.json", { version: 1, from: `${DAY}T08:00:00-05:00`, until: `${DAY}T12:00:00-05:00`, reason: "risky change" });
      expect(integrationFreeze(d.dir, at("09:00"))).toBe("risky change");
      const morning = await d.run("09:00");
      expect(morning.frozen).toBe(false);
      expect(finding(morning, "hosted acceptance path")?.level).toBe("informational");
      expect(d.mails("Quality")).toEqual([]);
      expect(d.wakes()).toEqual([]);
      // A hold that is active at 16:45 but is not the evening window does not count either.
      expect((await d.run("16:45", { freeze: () => "an afternoon hold" })).frozen).toBe(false);
      expect(d.mails("Quality")).toEqual([]);
      const late = await d.run("17:35", { freeze: () => "the evening freeze" });
      expect(late.frozen).toBe(true);
      expect(d.mails("Quality")).toHaveLength(1);
      expect(d.mails("Quality")[0]!.body).toContain("Tonight's 17:30–22:35 install freeze has begun, so the installed revision is held.");
      expect(d.wakes()).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  test("one input the contract cannot name does not cost the others their report, mail or hard stop", async () => {
    const d = day();
    try {
      d.state.missing = [
        { input: "???", reason: "a computed name went wrong" },
        { input: "AWS sign-in", reason: signIn },
        { input: "disk space", reason: "Error: only 40 GiB free" },
      ];
      const report = await d.run("16:45");
      expect(report.failures).toEqual([expect.stringContaining('class for "???": Error: release input has no usable name')]);
      expect(report.actions.map((a) => [a.did, a.to]).sort()).toEqual([
        ["hard-stop", "Vincent"],
        ["mailed", "Platform"],
      ]);
      expect(d.mails().map((m) => m.recipient).sort()).toEqual(["Platform", "Vincent"]);
      expect(d.store.get(`release-morning:${DAY}:16:45`)).toMatchObject({ ready: false, failures: report.failures });
      expect(d.store.db.query("SELECT count(*) AS n FROM events WHERE kind='release-morning'").get()).toEqual({ n: 1 });
    } finally {
      d.close();
    }
  });

  test("the installed revision is read from the checkout's own files", () => {
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(installedRevision(repo)).toBe(head);
    const checkout = mkdtempSync(join(tmpdir(), "morning-checkout-"));
    mkdirSync(join(checkout, ".git/refs/heads"), { recursive: true });
    writeFileSync(join(checkout, ".git/HEAD"), `${A}\n`);
    expect(installedRevision(checkout)).toBe(A);
    writeFileSync(join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(checkout, ".git/packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${A} refs/heads/main-old\n${B} refs/heads/main\n`);
    expect(installedRevision(checkout)).toBe(B);
    writeFileSync(join(checkout, ".git/refs/heads/main"), `${A}\n`);
    expect(installedRevision(checkout)).toBe(A);
    writeFileSync(join(checkout, ".git/HEAD"), "ref: refs/heads/absent\n");
    expect(() => installedRevision(checkout)).toThrow("unavailable");
  });
});

// The LaunchAgent and its installer. launchctl, plutil and readlink are
// stand-ins in a temporary folder: nothing is loaded and no real job is read.
describe("the morning job's definition and installer", () => {
  const program = "/Users/fictional/.bun/bin/bun";
  const path = "/Users/fictional/bin:/Users/fictional/.bun/bin:/usr/bin:/bin";
  const loaded = (label: string, args: string[], privateDir: string, directory = repo, jobPath = path) =>
    `gui/501/${label} = {\n\tactive count = 0\n\tpath = /fictional/${label}.plist\n\ttype = LaunchAgent\n\tstate = not running\n\n\tprogram = ${program}\n\targuments = {\n${args.map((a) => `\t\t${a}\n`).join("")}\t}\n\n\tworking directory = ${directory}\n\n\tinherited environment = {\n\t\tSSH_AUTH_SOCK => /fictional\n\t}\n\n\tenvironment = {\n\t\tTZ => America/Toronto\n\t\tFACTORY_PRIVATE_DIR => ${privateDir}\n\t\tPATH => ${jobPath}\n\t}\n}\n`;
  function machine(readback?: { directory?: string; path?: string }) {
    const base = mkdtempSync(join(tmpdir(), "morning-install-"));
    const [home, privateDir, shim, fixtures] = ["home", "private", "bin", "fixtures"].map((name) => join(base, name)) as [string, string, string, string];
    for (const folder of [home, privateDir, shim, fixtures]) mkdirSync(folder);
    const calls = join(base, "calls");
    writeFileSync(calls, "");
    writeFileSync(join(fixtures, "rehearsal.txt"), loaded("com.agent-factory.release.rehearsal-early", [program, join(repo, "scripts/release.ts"), "rehearsal", "14:00"], privateDir));
    writeFileSync(join(fixtures, "morning.txt"), loaded(MORNING_LABEL, [program, join(repo, "scripts/release-morning.ts")], privateDir, readback?.directory, readback?.path));
    writeFileSync(join(shim, "readlink"), "#!/bin/sh\nprintf /var/db/timezone/zoneinfo/America/Toronto\n", { mode: 0o700 });
    writeFileSync(join(shim, "plutil"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(
      join(shim, "launchctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1 $2" in
 "print gui/"*"/com.agent-factory.release.rehearsal-early") /bin/cat '${fixtures}/rehearsal.txt';;
 "print gui/"*"/${MORNING_LABEL}") if [ -f '${fixtures}/loaded' ]; then /bin/cat '${fixtures}/morning.txt'; else printf 'Could not find service' >&2; exit 113; fi;;
 "bootstrap gui/"*) : > '${fixtures}/loaded';;
 "bootout gui/"*) /bin/rm -f '${fixtures}/loaded';;
 *) exit 99;;
esac
`,
      { mode: 0o700 },
    );
    const run = async (time: string, ...args: string[]) => {
      const wrapper = join(base, "run.ts");
      writeFileSync(wrapper, `Date.now=()=>${at(time)}; process.argv=[process.argv[0],'install-release-morning.ts',...${JSON.stringify(args)}]; await import(${JSON.stringify(join(repo, "scripts/install-release-morning.ts"))});`);
      const p = Bun.spawn([process.execPath, wrapper], { env: { HOME: home, PATH: `${shim}:/usr/bin:/bin`, FACTORY_PRIVATE_DIR: privateDir }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
    };
    return { home, privateDir, run, loaded: () => existsSync(join(fixtures, "loaded")) };
  }

  test("the definition runs at the four times with the given program, folder and PATH", () => {
    const xml = morningJobDefinition({ program, directory: "/Users/fictional/agent-factory", path, privateDir: "/Users/fictional/.factory" });
    expect(plistEnvironment(xml)).toEqual({ FACTORY_PRIVATE_DIR: "/Users/fictional/.factory", PATH: path, TZ: "America/Toronto" });
    expect([...xml.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(["9:0", "12:0", "16:45", "17:35"]);
    expect(xml).toContain(`<key>Label</key><string>${MORNING_LABEL}</string>`);
    expect(xml).toContain(`<key>ProgramArguments</key><array><string>${program}</string><string>/Users/fictional/agent-factory/scripts/release-morning.ts</string></array><key>WorkingDirectory</key><string>/Users/fictional/agent-factory</string>`);
    expect(xml).toContain("<key>RunAtLoad</key><false/>");
  });

  test("preparing copies the loaded rehearsal job's PATH and working directory and loads nothing", async () => {
    const m = machine();
    const result = await m.run("10:00");
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ loaded: false, sameAsRehearsal: { program, directory: repo, path } });
    expect(result.calls).toEqual([expect.stringMatching(/^print gui\/\d+\/com\.agent-factory\.release\.rehearsal-early$/)]);
    const xml = readFileSync(join(m.privateDir, `${MORNING_LABEL}.plist`), "utf8");
    expect(plistEnvironment(xml)).toEqual({ FACTORY_PRIVATE_DIR: m.privateDir, PATH: path, TZ: "America/Toronto" });
    expect(xml).toContain(`<key>WorkingDirectory</key><string>${repo}</string>`);
    expect(existsSync(join(m.home, "Library/LaunchAgents"))).toBe(false);
  }, 20000);

  test("installing loads the job once, reads it back against the rehearsal job, and refuses during the 17:30–22:35 freeze", async () => {
    const m = machine();
    for (const time of ["17:30", "19:00", "22:34"]) {
      const refused = await m.run(time, "--install");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("not loaded during an install freeze");
      expect(refused.calls).toEqual([]);
    }
    expect(existsSync(join(m.home, "Library/LaunchAgents"))).toBe(false);
    const installed = await m.run("10:00", "--install");
    expect({ code: installed.code, err: installed.err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(installed.out)).toMatchObject({ loaded: true, sameAsRehearsal: { program, directory: repo, path } });
    expect(installed.calls.map((c) => c.split(" ")[0])).toEqual(["print", "print", "bootstrap", "print"]);
    expect(readFileSync(join(m.home, "Library/LaunchAgents", `${MORNING_LABEL}.plist`), "utf8")).toBe(readFileSync(join(m.privateDir, `${MORNING_LABEL}.plist`), "utf8"));
    // A second install replaces the idle job: bootout, then bootstrap.
    expect((await m.run("10:05", "--install")).calls.slice(4).map((c) => c.split(" ")[0])).toEqual(["print", "print", "bootout", "bootstrap", "print"]);
  }, 30000);

  test("a job whose loaded PATH or working directory differs from the rehearsal job is unloaded again, and installing fails", async () => {
    for (const readback of [{ path: "/usr/bin:/bin" }, { directory: "/Users/fictional/trial-copy" }]) {
      const m = machine(readback);
      const result = await m.run("10:00", "--install");
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("loaded definition differs from the rehearsal job");
      expect(result.err).toContain("it was unloaded again");
      // Nothing is left scheduled: the job is booted out and its definition moved out of LaunchAgents into the receipts.
      expect(result.calls.map((c) => c.split(" ")[0])).toEqual(["print", "print", "bootstrap", "print", "bootout"]);
      expect(m.loaded()).toBe(false);
      expect(readdirSync(join(m.home, "Library/LaunchAgents"))).toEqual([]);
      const [receipt] = readdirSync(join(m.privateDir, "receipts"));
      expect(readdirSync(join(m.privateDir, "receipts", receipt!)).sort()).toEqual([`${MORNING_LABEL}.refused.plist`, "undo.txt"]);
    }
  }, 20000);
});

test("the real entry point keeps no billing file, releases nothing, leaves the wallet and the freeze alone, and only notes the hold while there is no batch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-entry-"));
  const bin = join(dir, "bin");
  const mail = join(dir, "mail.sqlite");
  const log = join(dir, "commands");
  const now = Date.now();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(now);
  mkdirSync(bin);
  writeFileSync(join(dir, "config.yaml"), JSON.stringify(config()));
  writeFileSync(join(dir, "release-auth-session.json"), JSON.stringify({ version: 1, kind: "original-password-mfa-session", signedInAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 23 * 3600000).toISOString(), receipt: "synthetic original session" }));
  writeFileSync(join(dir, "release-billing-source.json"), JSON.stringify({ profile: "fixture", accountId: "123456789012", budgetName: "fixture" }));
  const budget = { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "75", Unit: "USD" }, CostTypes: { IncludeTax: true, IncludeSubscription: true, IncludeRefund: false, IncludeCredit: false }, TimePeriod: { Start: `${today.slice(0, 7)}-01T00:00:00Z` }, LastUpdatedTime: new Date(now).toISOString(), CalculatedSpend: { ActualSpend: { Amount: "1", Unit: "USD" }, ForecastedSpend: { Amount: "5", Unit: "USD" } } };
  writeFileSync(join(bin, "aws"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in 'budgets describe-budget '*) printf '%s' '${JSON.stringify({ Budget: budget })}';; *) exit 90;; esac\n`, { mode: 0o700 });
  // The QA hold is valid and off. There is no batch for today, so nothing to compare its identity with.
  const hold = JSON.stringify({ value: JSON.stringify({ version: 1, id: "fictional-off", held: false, legacy_issue: null, reason: "Fictional open batch", by: "fixture", at: "2026-11-12T12:00:00Z" }) });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in 'api --method GET repos/fulmar-hq/alido/actions/variables/QA_HOLD') printf '%s' '${hold}';; 'api --method GET '*) printf '{}';; *) exit 91;; esac\n`, { mode: 0o700 });
  const db = new Database(mail);
  db.exec(MESSAGES);
  db.close();
  const prepared = new Store(join(dir, "controller.sqlite"));
  prepared.set("paused", false);
  prepared.close();
  const before = readdirSync(dir);
  const run = Bun.spawn([process.execPath, join(repo, "scripts/release-morning.ts")], { env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, FACTORY_PRIVATE_DIR: dir, FACTORY_MAIL_DB: mail }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  const report = JSON.parse(out);
  expect(report).toMatchObject({ day: today, failures: [], installed: installedRevision(repo), evidence: { usage: { releaseGate: 0.7 } } });
  expect(report.findings.map((f: { input: string }) => f.input)).toEqual(expect.arrayContaining(["release qualification", "PR checks"]));
  // The billing read worked, so it is not a finding; and it is the one Budgets call the release itself makes.
  expect(report.findings.map((f: { input: string }) => f.input)).not.toContain("fresh billing");
  expect(report.findings.find((f: { input: string }) => f.input === "release holds")).toEqual({ input: "release holds", level: "informational", reason: "the QA hold cannot be compared with tonight's batch until there is one" });
  const sent = new Database(mail, { readonly: true });
  expect((sent.query("SELECT id FROM messages").all() as { id: string }[]).filter((m) => m.id.includes("release-holds"))).toEqual([]);
  sent.close();
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.filter((c) => c.startsWith("budgets describe-budget"))).toEqual(["budgets describe-budget --profile fixture --region us-east-1 --account-id 123456789012 --budget-name fixture --output json --no-cli-pager"]);
  // The file the health job reads as its billing reading is not written. All the run adds to the private
  // directory is the ledger inbox ("commands" is this test's own call log; "Library" is Bun's cache under the fixture HOME).
  expect(existsSync(join(dir, "release-billing.json"))).toBe(false);
  expect(readdirSync(dir).filter((name) => !before.includes(name) && !name.startsWith("controller.sqlite") && name !== "Library").sort()).toEqual(["commands", "health"]);
  expect(readdirSync(join(dir, "health"))).toEqual(["ledger-inbox"]);
  expect(calls.every((c) => c.startsWith("budgets describe-budget") || c.startsWith("api --method GET"))).toBe(true);
  const check = new Store(join(dir, "controller.sqlite"));
  try {
    expect(check.db.query("SELECT count(*) AS n FROM kv WHERE key LIKE 'executor:%'").get()).toEqual({ n: 0 });
    expect(check.db.query("SELECT count(*) AS n FROM debits").get()).toEqual({ n: 0 });
    expect(check.db.query("SELECT count(*) AS n FROM events WHERE kind IN ('billing-reading','billing-import')").get()).toEqual({ n: 0 });
    expect(check.get("aws-stop-latched")).toBeNull();
    expect(check.get("paused")).toBe(false);
    expect(check.db.query("SELECT count(*) AS n FROM events WHERE kind='release-morning'").get()).toEqual({ n: 1 });
  } finally {
    check.close();
  }
  expect(existsSync(join(dir, "integration-freeze.json"))).toBe(false);
}, 30000);

// These run the mail checkout's own code on a temporary store. That checkout
// is a separate repository and is absent in this repository's CI, where they
// are skipped; a skipped test is not proof.
describe.skipIf(!realMailSource())("the morning check through Alido Mail's own code", () => {
  test("the noon ask and the 16:45 hard stop are each sent to Vincent once; a role's mail is woken only where that role has a thread", async () => {
    const mail = await openRealMailStore({ codexThreads: { Quality: "thread-quality" } });
    const d = day(mail.path);
    try {
      d.state.installed = B;
      d.state.missing = [
        { input: "AWS sign-in", reason: signIn },
        { input: "disk space", reason: "Error: Data volume needs a verified reading with at least 60 GiB free" },
      ];
      const noon = await d.run("12:00");
      const ask = noon.actions.find((a) => a.did === "asked")!.id;
      expect(mail.telegramSentAt(ask)).toBeNull();
      expect(await mail.sendToVincent(at("12:01"))).toEqual(["Factory Desk: Tonight's release needs your AWS sign-in before 6:30 PM. Can you do that?"]);
      expect(mail.telegramSentAt(ask)).toBe(at("12:01"));
      const report = await d.run("17:35");
      expect(report.failures).toEqual([]);
      expect(report.actions.map((a) => [a.did, a.to]).sort()).toEqual([
        ["hard-stop", "Vincent"],
        ["mailed", "Platform"],
        ["proof-requested", "Quality"],
      ]);
      expect(await mail.sendToVincent(at("17:36"))).toEqual(["Factory Desk: Tonight's release is still blocked on your AWS sign-in. It is needed before 6:30 PM."]);
      await d.run("17:35");
      expect(await mail.sendToVincent(at("17:37"))).toEqual([]);
      // Quality has a thread and is woken. Platform has none, so its mail fails
      // to wake anyone, exactly as it does live: role mail alone is not delivery.
      expect(await mail.ringCodex(at("17:36"))).toBe(1);
      expect(mail.row(report.actions.find((a) => a.did === "proof-requested")!.id)).toMatchObject({ recipient: "Quality", kind: "action", wake_state: "woken" });
      expect(mail.row(report.actions.find((a) => a.did === "mailed")!.id)).toMatchObject({ recipient: "Platform", wake_state: "failed", state: "unread" });
    } finally {
      d.close();
      mail.close();
    }
  });
});
