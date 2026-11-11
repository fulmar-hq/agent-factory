import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyRefusal } from "../launcher/autonomy";
import { ConfigSchema } from "../launcher/config";
import { NORMALISER, type Normaliser } from "../launcher/fingerprint";
import { EXCERPTS_PER_CLASS, EXCERPT_BYTES, LEDGER_COMMANDS_DIR, LEDGER_PROTECTED_PATHS, Ledger, MAX_PARK_MS, RULES_DIR, STEPS_DIR, loadFolder, signCommand, verifyCommand, type Finding, type OperatorCommand } from "../launcher/ledger";
import { CLASS_ID, LOOP_FILES, LoopHeartbeatSchema, PROOFS, REDUCING_TRANSITIONS, inboxFileName, ownerRole, regressionFolder, releaseInputClassId, usableLedgerExport, type InboxRecord } from "../launcher/loop-contract";
import { Store } from "../tracking/store";
import { BATCH_ROWS, HARD_STOP_SECONDS, REPLAY_RUNS, RUN_LIMIT_MS, ingestOnce, type IngestOptions } from "../scripts/ledger-ingest";
import { queueOperatorCommand, reconcile } from "../scripts/ledger";
import { TestEngine, config, ticket } from "./fixtures";
import { MINUTE, OWNER_TOKEN, T0, addEvents, addIncident, appendTick, bundleError, factoryDir, fullDisk, roomyDisk, session, workerFailure } from "./helpers/ledger-fixture";

const repo = join(import.meta.dir, "..");
const failure = (n: number, text = bundleError(n), extra: Partial<Finding> = {}): Finding => ({ kind: "failure", text, at: T0 + n, source: "worker-failure", ref: `failure:${session(n)}`, ...extra });
/** A distinct word per number, with no digits for the normaliser to fold together. */
const word = (n: number) => [...String(n).padStart(3, "0")].map((d) => "abcdefghij"[Number(d)]).join("") + "zz";
const memory = () => new Ledger(":memory:");
/** A signed operator command, as scripts/ledger.ts would queue it. */
function operator(ledger: Ledger, command: Partial<OperatorCommand> & Pick<OperatorCommand, "action" | "classId">, now = T0) {
  const signed = signCommand({ version: 1, id: `${command.action}-${command.classId}-${now}`, at: now, actor: "Vincent (fixture)", reason: "fixture reason", ...command }, OWNER_TOKEN);
  const checked = verifyCommand(JSON.parse(JSON.stringify(signed)), OWNER_TOKEN);
  if (!checked.ok) throw Error(checked.reason);
  return ledger.reduce(checked.command, now);
}
/** Runs the job on a fixture directory with a healthy disk and no rule files, capturing what it logs. */
async function ingest(dir: string, options: Partial<IngestOptions> = {}) {
  const logged: string[] = [],
    none = join(dir, "no-such-folder");
  const report = await ingestOnce({ dir, disk: roomyDisk, rulesDir: none, stepsDir: none, log: (line) => logged.push(line), ...options });
  return { report, logged, heartbeat: LoopHeartbeatSchema.parse(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerHeartbeat), "utf8"))) };
}
const open = (dir: string) => new Ledger(join(dir, LOOP_FILES.ledger), { readonly: true });
function drop(dir: string, record: Record<string, unknown>, name = inboxFileName(record as Pick<InboxRecord, "type" | "id">)) {
  mkdirSync(join(dir, LOOP_FILES.ledgerInbox), { recursive: true });
  writeFileSync(join(dir, LOOP_FILES.ledgerInbox, name), JSON.stringify(record));
}

describe("classes", () => {
  test("a class gets its id at first sight, and the same failure on 33 sessions is one class", () => {
    const ledger = memory();
    const first = ledger.record(failure(1), T0);
    expect(first).toMatchObject({ created: true, duplicate: false });
    expect(first.classId).toMatch(CLASS_ID);
    for (let n = 2; n <= 33; n++) expect(ledger.record(failure(n), T0)).toMatchObject({ classId: first.classId, created: false });
    expect(ledger.record(failure(33), T0)).toMatchObject({ duplicate: true });
    expect(ledger.classes()).toHaveLength(1);
    expect(ledger.classOf(first.classId)).toMatchObject({ kind: "failure", state: "open", occurrences: 33, ownerRole: "Platform", fixLivesIn: "launcher", firstSeenAt: T0 + 1, lastSeenAt: T0 + 33, shadow: false, needsOperatorSince: null });
    expect(ledger.record(failure(40, "SQLiteError: database is locked"), T0).classId).not.toBe(first.classId);
  });

  test("the owner comes only from the contract's function", () => {
    const ledger = memory();
    const product = ledger.record(failure(1, "product build broke", { fixLivesIn: "product" }), T0).classId;
    expect(ledger.classOf(product)!.ownerRole).toBe(ownerRole({ kind: "failure", fixLivesIn: "product" }));
    for (const [input, reason] of [["AWS sign-in", "expired"], ["Quality proof", "stale for the installed revision"], ["usage", "gated at 0.70"]] as const) {
      const id = ledger.record({ kind: "release-input", text: `release input ${input}`, summary: reason, classId: releaseInputClassId(input), releaseInput: { input, reason }, at: T0, source: "rule:fixture", ref: input }, T0).classId;
      expect(id).toBe(releaseInputClassId(input));
      expect(ledger.classOf(id)!.ownerRole).toBe(ownerRole({ kind: "release-input", input, reason }));
    }
    // No caller can pass an owner: a finding has no such field, and the stored one ignores anything extra.
    const sneaky = ledger.record({ ...failure(9, "something else broke"), ownerRole: "Coordinator" } as Finding, T0).classId;
    expect(ledger.classOf(sneaky)!.ownerRole).toBe("Platform");
  });

  test("a finding that names its class is filed under that name, whatever its text folds to", () => {
    const ledger = memory();
    const base = { version: 1 as const, at: T0, source: "fixture" };
    // Each pair differs only by a number or a date, which the normaliser folds away.
    for (const [first, second] of [["cl-20-first-night", "cl-21-first-night"], ["nightly-proof-2026-11-12", "nightly-proof-2026-11-13"]] as const) {
      ledger.applyInbox({ ...base, id: `owed:${first}`, type: "proof-owed", proofId: first, what: `first: ${first}`, dueAt: T0 + 60 * MINUTE, role: "Release" }, T0);
      ledger.applyInbox({ ...base, id: `owed:${second}`, type: "proof-owed", proofId: second, what: `second: ${second}`, dueAt: T0 + 120 * MINUTE, role: "Quality" }, T0);
      expect(ledger.classOf(first)).toMatchObject({ occurrences: 1, summary: `first: ${first}`, dueAt: T0 + 60 * MINUTE, ownerRole: "Release" });
      expect(ledger.classOf(second)).toMatchObject({ occurrences: 1, summary: `second: ${second}`, dueAt: T0 + 120 * MINUTE, ownerRole: "Quality" });
      // The second proof closes under its own id and leaves the first one owed.
      ledger.applyInbox({ ...base, id: `attached:${second}`, type: "proof-attached", proofId: second, evidence: "seen on the night", actor: "Quality" }, T0);
      expect([ledger.classOf(first)!.state, ledger.classOf(second)!.state]).toEqual(["open", "resolved-no-fix"]);
    }
    const ruleError = (rule: string, ref: string): Finding => ({ kind: "instrumentation", text: `ledger rule or step failed: ${rule}`, classId: `rule-error-${rule}`, at: T0, source: "rule-error", ref });
    expect(ledger.record(ruleError("check-1", "a"), T0)).toMatchObject({ classId: "rule-error-check-1", created: true });
    expect(ledger.record(ruleError("check-2", "b"), T0)).toMatchObject({ classId: "rule-error-check-2", created: true });
    expect(ledger.record(ruleError("check-2", "c"), T0)).toMatchObject({ classId: "rule-error-check-2", created: false });
    expect(ledger.classes()).toHaveLength(6);
    // A name is not a text signature: a retune has nothing to re-map, and the name still leads to its class.
    expect(ledger.remapSignatures({ version: 2, normalise: (text) => `v2 ${text}` }, T0 + 1)).toEqual({ remapped: 0, conflicts: 0 });
    ledger.applyInbox({ ...base, id: "owed-again:cl-20-first-night", type: "proof-owed", proofId: "cl-20-first-night", what: "still owed", dueAt: T0 + 60 * MINUTE, role: "Release" }, T0 + 2);
    expect(ledger.classOf("cl-20-first-night")).toMatchObject({ occurrences: 2, summary: "first: cl-20-first-night" });
    expect(() => ledger.remapSignatures({ version: -1, normalise: (text) => text }, T0 + 3)).toThrow("never negative");
    expect(ledger.classes()).toHaveLength(6);
    // A name that already belongs to a class of another kind is refused, and nothing is counted.
    expect(() => ledger.record({ kind: "failure", text: "something else", classId: "cl-20-first-night", at: T0, source: "rule:fixture", ref: "x" }, T0)).toThrow("already names a proof-owed class");
    expect(ledger.classOf("cl-20-first-night")!.occurrences).toBe(2);
  });

  test("an unusable finding is refused by itself and never reaches the export", () => {
    const ledger = memory();
    const good = ledger.record(failure(1), T0).classId;
    for (const at of [0, -5, 1.5, "abc", null, Number.NaN]) expect(() => ledger.record({ ...failure(2, "some failure words"), at } as unknown as Finding, T0)).toThrow("not a usable finding (at)");
    expect(() => ledger.record({ ...failure(3), kind: "not-a-kind" } as unknown as Finding, T0)).toThrow("not a usable finding (kind)");
    expect(() => ledger.record({ ...failure(4), dueAt: "tomorrow" } as unknown as Finding, T0)).toThrow("not a usable finding (dueAt)");
    for (const since of [0, 1.5, "abc"]) expect(() => ledger.needsOperator(good, since as number)).toThrow("needs the time it began");
    expect(ledger.classes().map((c) => c.id)).toEqual([good]);
    expect(usableLedgerExport(JSON.parse(JSON.stringify(ledger.export(T0 + 10, null))), T0 + 11)?.classes).toHaveLength(1);
  });

  test("changing the normaliser version re-maps 100 stored signatures and no class id, issue link or regression folder changes", () => {
    const ledger = memory();
    const texts = Array.from({ length: 100 }, (_, n) => `Error: ${word(n)} step failed for session ${session(n + 1)}`);
    texts.forEach((text, n) => {
      const id = ledger.record(failure(n + 1, text), T0).classId;
      ledger.link(id, "issue", `example/demo#${n + 1}`, T0);
      ledger.link(id, "regression", regressionFolder(id), T0);
    });
    const snapshot = () => ledger.classes().map((c) => ({ id: c.id, occurrences: c.occurrences, links: ledger.linksOf(c.id).map((l) => `${l.type}:${l.ref}`) }));
    const before = snapshot();
    expect(before).toHaveLength(100);
    expect(new Set(before.map((c) => c.id)).size).toBe(100);

    const retuned: Normaliser = { version: 2, normalise: (text) => "v2 " + text.replace(/session \w+/, "session").toUpperCase() };
    expect(ledger.remapSignatures(retuned, T0 + 1)).toEqual({ remapped: 100, conflicts: 0 });
    expect(snapshot()).toEqual(before);
    expect(ledger.meta<number>("normaliser-version")).toBe(2);
    expect((ledger.db.query("SELECT count(*) AS n FROM signatures WHERE normaliser_version=2").get() as { n: number }).n).toBe(100);
    // The retuned signatures lead to the same classes: a new sighting of each is counted, never a new class.
    texts.forEach((text, n) => expect(ledger.record(failure(500 + n, text.replace(session(n + 1), session(900 + n))), T0 + 2)).toMatchObject({ classId: before[n]!.id, created: false }));
    expect(ledger.classes()).toHaveLength(100);
    expect(snapshot().map((c) => [c.id, c.links])).toEqual(before.map((c) => [c.id, c.links]));
    expect(ledger.remapSignatures(retuned, T0 + 3)).toEqual({ remapped: 0, conflicts: 0 });

    // A retune that makes two classes look alike merges nothing: both ids stand, the older keeps the signature.
    const collapsing: Normaliser = { version: 3, normalise: (text) => (text.includes(word(0)) || text.includes(word(1)) ? "one signature" : "v3 " + text.replace(/session \w+/, "session")) };
    expect(ledger.remapSignatures(collapsing, T0 + 4)).toEqual({ remapped: 100, conflicts: 1 });
    expect(ledger.classes().map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(ledger.transitions().filter((t) => t.action === "remap-conflict")).toMatchObject([{ classId: before[1]!.id, actor: null }]);
    expect(ledger.record(failure(990, texts[1]!), T0 + 5)).toMatchObject({ classId: before[0]!.id, created: false });
  });

  test("a limit is counted, never ticketed, fixed or held", () => {
    const ledger = memory();
    const limit = ledger.record({ kind: "limit", text: "usage stop", at: T0, source: "rule:limits", ref: "1" }, T0).classId;
    for (let n = 2; n <= 5; n++) ledger.record({ kind: "limit", text: "usage stop", at: T0 + n, source: "rule:limits", ref: String(n) }, T0);
    expect(ledger.classOf(limit)).toMatchObject({ kind: "limit", state: "open", occurrences: 5, ownerRole: "Platform" });
    for (const action of ["ticket", "fix-installed", "verify", "close-with-proof", "recur", "wait-on-human"] as const) expect(() => ledger.advance(limit, action, { now: T0, reason: "fixture" })).toThrow("a limit is counted");
    expect(() => ledger.applyInbox({ version: 1, id: "link-1", at: T0, source: "fixture", type: "issue-link", classId: limit, repo: "example/demo", issue: 4 }, T0)).toThrow("never ticketed");
    expect(ledger.linksOf(limit)).toEqual([]);
    // It ends when its condition ends, and is simply open again when the limit is next hit.
    ledger.advance(limit, "resolve-no-fix", { now: T0, reason: "usage reset" });
    expect(ledger.record({ kind: "limit", text: "usage stop", at: T0 + 9, source: "rule:limits", ref: "9" }, T0)).toMatchObject({ reopened: true });
    expect(ledger.classOf(limit)!.state).toBe("open");
  });

  test("states move only along the listed transitions, and a close needs the contract's proof", () => {
    const ledger = memory();
    const id = ledger.record(failure(1), T0).classId;
    expect(() => ledger.advance(id, "verify", { now: T0, reason: "too early" })).toThrow('"verify" needs fix-installed');
    expect(() => ledger.advance(id, "close-with-proof", { now: T0, reason: "too early" })).toThrow("needs verifying");
    expect(() => ledger.advance(id, "ticket", { now: T0, reason: " " })).toThrow("needs a reason");
    ledger.advance(id, "ticket", { now: T0, reason: "issue opened" });
    ledger.advance(id, "fix-installed", { now: T0, reason: "fix merged and installed" });
    ledger.advance(id, "verify", { now: T0, reason: "watching the real job" });
    const need = PROOFS.publication.successes;
    expect(() => ledger.advance(id, "close-with-proof", { now: T0, reason: "done", proof: { subject: "publication", successes: need - 1, evidence: "events" } })).toThrow(`needs ${need} successful publications`);
    expect(() => ledger.advance(id, "close-with-proof", { now: T0, reason: "done", proof: { successes: 999, evidence: "events" } })).toThrow("must name one of");
    expect(ledger.advance(id, "close-with-proof", { now: T0, reason: "done", proof: { subject: "publication", successes: need, evidence: "20 launcher-publish events" } }).state).toBe("closed-with-proof");
    // A closed class that is seen again reopens by itself.
    expect(ledger.record(failure(2), T0 + 1)).toMatchObject({ classId: id, reopened: true });
    expect(ledger.classOf(id)!.state).toBe("recurred");
    expect(ledger.transitions().map((t) => t.action)).toEqual(["open", "ticket", "fix-installed", "verify", "close-with-proof", "recur"]);
    expect(() => ledger.db.exec("UPDATE transitions SET reason='rewritten'")).toThrow("append-only");
    expect(() => ledger.db.exec("DELETE FROM transitions")).toThrow("append-only");
  });

  test("only a step on the coded list can wait on a person, and every wait expires", () => {
    const ledger = memory();
    const id = ledger.record(failure(1), T0).classId;
    expect(() => ledger.advance(id, "wait-on-human", { now: T0, reason: "ask him", human: { step: "review-the-code", until: T0 + MINUTE } })).toThrow("coded list");
    expect(() => ledger.advance(id, "wait-on-human", { now: T0, reason: "ask him", human: { step: "sign-in", until: T0 + MAX_PARK_MS + 1 } })).toThrow("expiry within 30 days");
    expect(ledger.advance(id, "wait-on-human", { now: T0, reason: "AWS sign-in expired", human: { step: "sign-in", until: T0 + 60 * MINUTE } })).toMatchObject({ state: "waiting-on-human", humanStep: "sign-in", parkedUntil: T0 + 60 * MINUTE });
    expect(ledger.expireParked(T0 + 59 * MINUTE)).toEqual([]);
    expect(ledger.expireParked(T0 + 60 * MINUTE)).toEqual([id]);
    expect(ledger.classOf(id)).toMatchObject({ state: "open", humanStep: null, parkedUntil: null });
  });

  test("evidence is a reference plus at most 4 KB, 20 per class, and nothing at all under a disk refusal", () => {
    const ledger = memory();
    let id = "";
    for (let n = 1; n <= 30; n++) id = ledger.record(failure(n, bundleError(n), { evidence: { ref: `events ${n}`, excerpt: "é".repeat(5000) } }), T0).classId;
    const held = ledger.evidenceOf(id);
    expect(held).toHaveLength(EXCERPTS_PER_CLASS);
    for (const e of held) expect(Buffer.byteLength(e.excerpt!)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(held[0]!.excerpt!.endsWith("é")).toBe(true);
    expect(ledger.classOf(id)!.occurrences).toBe(30);

    const counting = memory();
    counting.countsOnly = true;
    const counted = counting.record(failure(1, bundleError(1), { evidence: { ref: "events 1", excerpt: "kept nowhere" } }), T0).classId;
    counting.record(failure(2, bundleError(2), { evidence: { ref: "events 2", excerpt: "kept nowhere" } }), T0);
    expect(counting.classOf(counted)!.occurrences).toBe(2);
    expect(counting.evidenceOf(counted)).toEqual([]);
  });

  test("the export is what the contract's readers accept, without classes merged away", () => {
    const ledger = memory();
    const a = ledger.record(failure(1), T0).classId,
      b = ledger.record(failure(2, "SQLiteError: database is locked"), T0 + 5).classId;
    ledger.needsOperator(a, T0 + 7);
    operator(ledger, { action: "merge", classId: a, other: b });
    const exported = usableLedgerExport(JSON.parse(JSON.stringify(ledger.export(T0 + 10, null))), T0 + 11);
    expect(exported).toEqual({ version: 1, at: T0 + 10, nightsMissed: null, classes: [{ id: a, kind: "failure", state: "open", ownerRole: "Platform", shadow: false, needsOperatorSince: T0 + 7, lastSeenAt: T0 + 2 }] });
  });
});

describe("reducing transitions", () => {
  test("they need a signed operator command: nothing else can merge, split, defer, accept a risk or dismiss", () => {
    const ledger = memory();
    const id = ledger.record(failure(1), T0).classId;
    const unsigned: OperatorCommand = { version: 1, id: "x", at: T0, actor: "a builder", action: "dismiss", classId: id, reason: "not a real problem" };
    expect(() => ledger.reduce(unsigned, T0)).toThrow("needs a signed operator command");
    const signed = signCommand(unsigned, OWNER_TOKEN);
    expect(verifyCommand(signed, null)).toMatchObject({ ok: false, reason: expect.stringContaining("owner token unavailable") });
    expect(verifyCommand(signed, "another-token-0123456789abcdef")).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
    expect(verifyCommand({ ...signed, command: { ...signed.command, classId: "some-other-class" } }, OWNER_TOKEN)).toMatchObject({ ok: false });
    expect(verifyCommand({ ...signed, command: { ...signed.command, actor: "Vincent" } }, OWNER_TOKEN)).toMatchObject({ ok: false });
    for (const missing of [{ actor: "" }, { reason: "" }]) expect(() => signCommand({ ...unsigned, ...missing }, OWNER_TOKEN)).toThrow("a named actor and a reason are always required");
    expect(ledger.classOf(id)!.state).toBe("open");
    expect(operator(ledger, { action: "dismiss", classId: id })).toBe(`${id} dismissed`);
    expect(ledger.classOf(id)!.state).toBe("resolved-no-fix");
    expect(ledger.transitions(true)).toEqual([{ classId: id, at: T0, action: "dismiss", from: "open", to: "resolved-no-fix", actor: "Vincent (fixture)", reason: "fixture reason" }]);
    expect([...REDUCING_TRANSITIONS]).toEqual(["merge", "split", "defer", "accept-risk", "dismiss"]);
  });

  test("a merge keeps the older id, whichever way round it is asked for", () => {
    for (const askNewerFirst of [true, false]) {
      const ledger = memory();
      const older = ledger.record(failure(1, "SQLiteError: database is locked", { evidence: { ref: "events 1" } }), T0).classId;
      const newer = ledger.record(failure(2, "controller lock timeout while claiming", { at: T0 + 50 }), T0).classId;
      for (let n = 3; n <= 6; n++) ledger.record(failure(n, "controller lock timeout while claiming", { at: T0 + 50 + n }), T0);
      ledger.link(older, "issue", "example/demo#1", T0);
      ledger.link(newer, "issue", "example/demo#2", T0);
      ledger.link(newer, "regression", regressionFolder(newer), T0);
      operator(ledger, askNewerFirst ? { action: "merge", classId: newer, other: older } : { action: "merge", classId: older, other: newer });
      expect(ledger.classOf(older)).toMatchObject({ occurrences: 6, mergedInto: null, firstSeenAt: T0 + 1, lastSeenAt: T0 + 56 });
      expect(ledger.classOf(newer)).toMatchObject({ mergedInto: older, state: "resolved-no-fix", occurrences: 0 });
      expect(ledger.linksOf(older).map((l) => l.ref)).toEqual(["example/demo#1", "example/demo#2", regressionFolder(newer)]);
      // The id that was merged away still leads somewhere: a later sighting counts against the class that stands.
      expect(ledger.record(failure(7, "controller lock timeout while claiming"), T0)).toMatchObject({ classId: older, created: false });
      expect(ledger.transitions(true).map((t) => [t.classId, t.action, t.actor])).toEqual([[newer, "merge", "Vincent (fixture)"], [older, "merge", "Vincent (fixture)"]]);
    }
    const ledger = memory();
    const a = ledger.record(failure(1), T0).classId,
      limit = ledger.record({ kind: "limit", text: "usage stop", at: T0, source: "rule:limits", ref: "1" }, T0).classId;
    expect(() => operator(ledger, { action: "merge", classId: a, other: limit })).toThrow("is a failure and");
  });

  test("a split keeps the id, and its links, on the larger part", () => {
    for (const namedIsLarger of [false, true]) {
      const ledger = memory();
      const big = "publish failed: bundle missing",
        small = "publish failed: review label missing";
      // One class holding two signatures, the way an operator's merge leaves it.
      const id = ledger.record(failure(1, big), T0).classId;
      for (let n = 3; n <= 8; n++) ledger.record(failure(n, big), T0);
      operator(ledger, { action: "merge", classId: id, other: ledger.record(failure(2, small, { at: T0 + 50 }), T0).classId });
      ledger.link(id, "issue", "example/demo#1", T0);
      expect(ledger.classOf(id)!.occurrences).toBe(8);
      const message = operator(ledger, { action: "split", classId: id, signatures: [namedIsLarger ? big : small], summary: "named part" });
      const created = message.split(" ")[0]!;
      expect(created).toMatch(CLASS_ID);
      expect(ledger.classOf(id)).toMatchObject({ occurrences: 7, summary: namedIsLarger ? "named part" : big });
      expect(ledger.classOf(created)).toMatchObject({ occurrences: 1, kind: "failure", state: "open", ownerRole: "Platform", summary: namedIsLarger ? big : "named part" });
      expect(ledger.signaturesOf(id).map((s) => s.signature)).toEqual([big]);
      expect(ledger.signaturesOf(created).map((s) => s.signature)).toEqual([small]);
      expect(ledger.linksOf(id)).toHaveLength(1);
      expect(ledger.linksOf(created)).toEqual([]);
      expect(ledger.record(failure(20, small), T0).classId).toBe(created);
      expect(() => operator(ledger, { action: "split", classId: id, signatures: [big], summary: "all of it" }, T0 + 1)).toThrow("leave at least one signature");
      expect(() => operator(ledger, { action: "split", classId: id, signatures: ["no such signature"], summary: "x" }, T0 + 2)).toThrow("does not have");
    }
  });

  test("after a retune a split still counts each occurrence once, so the larger part keeps the id", () => {
    const ledger = memory();
    const big = "big failure words",
      small = "small failure words";
    const id = ledger.record(failure(1, big), T0).classId;
    for (const n of [2, 3]) ledger.record(failure(n, big), T0);
    const other = ledger.record(failure(4, small, { at: T0 + 50 }), T0).classId;
    ledger.record(failure(5, small, { at: T0 + 51 }), T0);
    operator(ledger, { action: "merge", classId: id, other });
    ledger.link(id, "issue", "example/demo#1", T0);
    // The retune changes only the big signature, so the small one is now on file under both versions with the same text.
    expect(ledger.remapSignatures({ version: 2, normalise: (text) => (text.startsWith("big") ? "BIG FAILURE WORDS" : NORMALISER.normalise(text)) }, T0 + 1)).toEqual({ remapped: 2, conflicts: 0 });
    expect(ledger.signaturesOf(id).filter((s) => s.signature === small)).toHaveLength(2);
    const created = operator(ledger, { action: "split", classId: id, signatures: [small], summary: "small part" }, T0 + 2).split(" ")[0]!;
    expect(ledger.classOf(id)).toMatchObject({ occurrences: 3, summary: big });
    expect(ledger.linksOf(id).map((l) => l.ref)).toEqual(["example/demo#1"]);
    expect(ledger.classOf(created)).toMatchObject({ occurrences: 2, summary: "small part" });
    expect(ledger.linksOf(created)).toEqual([]);
    expect(ledger.record(failure(9, small), T0 + 3).classId).toBe(created);
    expect(ledger.record(failure(10, big), T0 + 3).classId).toBe(id);
  });

  test("a merge never leaves a live problem reading as ended", () => {
    const ledger = memory();
    const closed = ledger.record(failure(1, "SQLiteError: database is locked"), T0).classId;
    ledger.advance(closed, "fix-installed", { now: T0, reason: "fix merged and installed" });
    ledger.advance(closed, "verify", { now: T0, reason: "watching the real job" });
    ledger.advance(closed, "close-with-proof", { now: T0, reason: "done", proof: { subject: "publication", successes: PROOFS.publication.successes, evidence: "launcher-publish events" } });
    const live = ledger.record(failure(2, "controller lock timeout while claiming", { at: T0 + 50 }), T0).classId;
    for (let n = 3; n <= 7; n++) ledger.record(failure(n, "controller lock timeout while claiming", { at: T0 + 50 + n }), T0);
    ledger.needsOperator(live, T0 + 60);
    operator(ledger, { action: "merge", classId: live, other: closed });
    // The older id stands, holding the open class's occurrences, and it is live again with the flag the open class carried.
    expect(ledger.classOf(closed)).toMatchObject({ state: "recurred", occurrences: 7, needsOperatorSince: T0 + 60 });
    expect(ledger.export(T0 + 100, null).classes).toMatchObject([{ id: closed, state: "recurred", needsOperatorSince: T0 + 60 }]);
    expect(ledger.transitions().filter((t) => t.classId === closed).map((t) => t.action).slice(-2)).toEqual(["merge", "recur"]);

    // A kind that ends without proof comes back as open; two ended classes stay ended.
    const ended = ledger.record({ kind: "limit", text: "usage stop", at: T0, source: "rule:limits", ref: "1" }, T0).classId;
    ledger.advance(ended, "resolve-no-fix", { now: T0, reason: "usage reset" });
    const hit = ledger.record({ kind: "limit", text: "disk admission refused", at: T0 + 5, source: "rule:limits", ref: "2" }, T0).classId;
    operator(ledger, { action: "merge", classId: ended, other: hit });
    expect(ledger.classOf(ended)).toMatchObject({ state: "open", occurrences: 2 });
    const one = ledger.record(failure(20, "first ended failure"), T0).classId,
      two = ledger.record(failure(21, "second ended failure", { at: T0 + 90 }), T0).classId;
    for (const id of [one, two]) operator(ledger, { action: "dismiss", classId: id });
    operator(ledger, { action: "merge", classId: one, other: two }, T0 + 1);
    expect(ledger.classOf(one)!.state).toBe("resolved-no-fix");
  });

  test("parking always has an expiry, and the class comes back when it passes", () => {
    const ledger = memory();
    const id = ledger.record(failure(1), T0).classId;
    expect(() => operator(ledger, { action: "defer", classId: id })).toThrow("expiry within 30 days");
    expect(() => operator(ledger, { action: "accept-risk", classId: id, until: T0 + MAX_PARK_MS + 1 })).toThrow("expiry within 30 days");
    operator(ledger, { action: "accept-risk", classId: id, until: T0 + 7 * 24 * 60 * MINUTE, reason: "rare, cheap to retry" });
    expect(ledger.classOf(id)).toMatchObject({ state: "deferred", parkedUntil: T0 + 7 * 24 * 60 * MINUTE, parkedReason: "accept-risk: rare, cheap to retry" });
    // Still counted while parked, and not quietly reopened by a sighting.
    ledger.record(failure(2), T0 + 1);
    expect(ledger.classOf(id)).toMatchObject({ state: "deferred", occurrences: 2 });
    expect(ledger.expireParked(T0 + 7 * 24 * 60 * MINUTE)).toEqual([id]);
    expect(ledger.classOf(id)).toMatchObject({ state: "open", parkedUntil: null, parkedReason: null });
    expect(ledger.transitions().map((t) => [t.action, t.actor])).toEqual([["open", null], ["accept-risk", "Vincent (fixture)"], ["park-expired", null]]);
  });
});

describe("the ledger job", () => {
  test("every worker-failure event and every failed tick becomes exactly one occurrence", async () => {
    const dir = factoryDir();
    addEvents(dir, [
      ...Array.from({ length: 33 }, (_, n) => workerFailure(n + 1, T0 + n)),
      workerFailure(40, T0 + 40, "Error: commit paths outside approved scope"),
      workerFailure(41, T0 + 41, "Error: " + "long ".repeat(3000)),
      { id: "publish:1", kind: "launcher-publish", at: T0 + 42, data: { id: session(50) } },
      { id: "exit:1", kind: "worker-exit", at: T0 + 43, data: { id: session(51), ok: false } },
    ]);
    appendTick(dir, { at: T0 + 1, status: "ok", ready: 0 }, { at: T0 + 2, status: "error", error: "SQLiteError: database is locked" }, "this line was torn mid-wri", { at: T0 + 3, status: "degraded", ready: null }, '{"status":"error"}', { at: T0 + 4, status: "error", error: "SQLiteError: database is locked" }, { at: T0 + 5, status: "error", error: "SQLiteError: database or disk is full" });
    addIncident(dir, "controller-alerts", `factory-tick-error:${T0 + 2}`, T0 + 2, "Factory launcher tick failed; inspect it and restore task claims.");
    addIncident(dir, "controller-alerts", "factory-paused-ready:pause-1", T0 + 6, "Factory is paused with ready tasks and no running builders.");
    addIncident(dir, "idle-queue", `factory-idle-queue:${T0 + 7}`, T0 + 7, "empty queue and stopped builders");
    addIncident(dir, "idle-queue", `factory-queue-observation:${T0 + 8}`, T0 + 8, "queue not freshly confirmed empty");
    addIncident(dir, "idle-queue", `factory-brand-new-detector:${T0 + 9}`, T0 + 9, "something this ledger has never heard of");

    const { report, heartbeat } = await ingest(dir, { startAt: "beginning", now: () => T0 + MINUTE });
    expect(report).toMatchObject({ occurrences: 43, classesOpened: 10, corruptLines: 2, ruleErrors: [], sourceErrors: [], stoppedAtLimit: false, countsOnly: false, behindMs: 0, newestIngestedAt: T0 + 41 });
    expect(report.alarm).toBeUndefined();
    expect(heartbeat).toMatchObject({ at: T0 + MINUTE, behindMs: 0, newestIngestedAt: T0 + 41 });
    expect(heartbeat.alarm).toBeUndefined();
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 35, ledger: 35, missing: [] }, tickErrors: { source: 3, ledger: 3, missing: [] }, difference: 0 });

    const ledger = open(dir);
    try {
      const classes = ledger.classes();
      const bundle = classes.find((c) => c.occurrences === 33)!;
      expect(bundle).toMatchObject({ kind: "failure", state: "open", ownerRole: "Platform", shadow: true, switch: "ledger-rules-silent-failures" });
      expect(ledger.evidenceOf(bundle.id)).toHaveLength(20);
      expect(ledger.evidenceOf(bundle.id)[0]).toMatchObject({ ref: `controller.sqlite events failure:${session(1)}` });
      expect(classes.map((c) => [c.kind, c.occurrences]).sort()).toEqual([["evidence-gap", 1], ["failure", 1], ["failure", 1], ["failure", 1], ["failure", 1], ["failure", 1], ["failure", 2], ["failure", 33], ["instrumentation", 1], ["limit", 1]]);
      // The paused-with-ready incident is a limit; an incident type nobody listed is a gap in the ledger, not a guess.
      expect(classes.find((c) => c.kind === "limit")!.summary).toContain("paused with ready tasks");
      expect(classes.find((c) => c.kind === "instrumentation")!.summary).toContain("factory-brand-new-detector");
      // An event too long to read whole still gets its error text, not a hash of JSON.
      expect(classes.some((c) => c.summary.startsWith("Error: long long"))).toBe(true);
    } finally {
      ledger.close();
    }
    const exported = usableLedgerExport(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerExport), "utf8")), T0 + 2 * MINUTE);
    expect(exported?.classes).toHaveLength(10);
    expect(exported?.classes.every((c) => c.shadow)).toBe(true);

    // A second run with nothing new adds nothing; new events are added once.
    expect((await ingest(dir, { now: () => T0 + 6 * MINUTE })).report).toMatchObject({ occurrences: 0, classesOpened: 0, corruptLines: 0, behindMs: 0 });
    addEvents(dir, [workerFailure(60, T0 + 7 * MINUTE)]);
    appendTick(dir, { at: T0 + 7 * MINUTE, status: "error", error: "SQLiteError: database is locked" });
    expect((await ingest(dir, { now: () => T0 + 11 * MINUTE })).report).toMatchObject({ occurrences: 2, classesOpened: 0 });
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 36, ledger: 36 }, tickErrors: { source: 4, ledger: 4 }, difference: 0 });
    // The reconciliation has teeth: an event the ledger never recorded shows as a difference.
    const tamper = new Ledger(join(dir, LOOP_FILES.ledger));
    tamper.db.exec("DELETE FROM occurrences WHERE source='worker-failure' AND source_ref='failure:" + session(60) + "'");
    tamper.close();
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 36, ledger: 35, missing: [`failure:${session(60)}`] }, difference: 1 });
  });

  test("an installed ledger starts at the present: history is left to the backfill", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0), workerFailure(2, T0 + 1)]);
    appendTick(dir, { at: T0, status: "error", error: "old failure" });
    expect((await ingest(dir, { now: () => T0 + MINUTE })).report).toMatchObject({ occurrences: 0, behindMs: 0 });
    addEvents(dir, [workerFailure(3, T0 + 2 * MINUTE)]);
    appendTick(dir, { at: T0 + 2 * MINUTE, status: "error", error: "new failure" });
    expect((await ingest(dir, { now: () => T0 + 6 * MINUTE })).report).toMatchObject({ occurrences: 2, classesOpened: 2 });
    expect(reconcile(dir)).toMatchObject({ since: T0 + MINUTE, workerFailures: { source: 1, ledger: 1 }, tickErrors: { source: 1, ledger: 1 }, difference: 0 });
  });

  test("a job that runs every five minutes but ingests nothing for 20 minutes while events keep arriving raises its alarm", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0)]);
    expect((await ingest(dir, { startAt: "beginning", now: () => T0 })).report).toMatchObject({ occurrences: 1, behindMs: 0 });
    // The job starts on schedule and writes a fresh heartbeat every time, but each run uses up its 60 seconds
    // before it has read anything. Failures keep arriving in the controller and in tick.log.
    const seen: { minute: number; ingested: number; fresh: boolean; behind: number; alarm?: string }[] = [];
    for (const minute of [5, 10, 15, 20]) {
      addEvents(dir, [workerFailure(100 + minute, T0 + minute * MINUTE - 2)]);
      appendTick(dir, { at: T0 + minute * MINUTE - 1, status: "error", error: "SQLiteError: database is locked" });
      let calls = 0;
      const { report, heartbeat } = await ingest(dir, { now: () => T0 + minute * MINUTE + (calls++ ? RUN_LIMIT_MS : 0) });
      expect(report).toMatchObject({ stoppedAtLimit: true, sourceErrors: [] });
      seen.push({ minute, ingested: report.occurrences, fresh: heartbeat.at === T0 + minute * MINUTE + RUN_LIMIT_MS, behind: heartbeat.behindMs! / MINUTE, alarm: heartbeat.alarm });
    }
    expect(seen.map((s) => [s.minute, s.ingested, s.fresh, s.behind])).toEqual([[5, 0, true, 6], [10, 0, true, 11], [15, 0, true, 16], [20, 0, true, 21]]);
    // A fresh heartbeat alone proved nothing; the lag and the alarm say the ledger is not caught up.
    expect(seen[0]!.alarm).toBeUndefined();
    expect(seen[1]!.alarm).toBeUndefined();
    expect(seen[2]!.alarm).toBe("the ledger is 16 minutes behind its sources and has not caught up in 3 runs; 3 runs in a row stopped at the 60-second limit");
    expect(seen[3]!.alarm).toBe("the ledger is 21 minutes behind its sources and has not caught up in 3 runs; 3 runs in a row stopped at the 60-second limit");
    // The first run that gets through catches up on everything that arrived, once, and the alarm clears by itself.
    const after = await ingest(dir, { now: () => T0 + 25 * MINUTE });
    expect(after.report).toMatchObject({ occurrences: 8, behindMs: 0, stoppedAtLimit: false });
    expect(after.heartbeat.alarm).toBeUndefined();
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 5, ledger: 5 }, tickErrors: { source: 4, ledger: 4 }, difference: 0 });
  });

  test("a source that cannot be read counts as behind, and the alarm clears when it can be read again", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0)]);
    expect((await ingest(dir, { startAt: "beginning", now: () => T0 })).report).toMatchObject({ occurrences: 1, behindMs: 0 });
    const controller = join(dir, "controller.sqlite"),
      good = readFileSync(controller);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(controller + suffix)) writeFileSync(controller + suffix, "");
    writeFileSync(controller, "not a database, for 20 minutes");
    const seen: { behind: number; alarm?: string }[] = [];
    for (const minute of [5, 10, 15, 20]) {
      appendTick(dir, { at: T0 + minute * MINUTE - 1, status: "error", error: "SQLiteError: database is locked" });
      const { report, heartbeat } = await ingest(dir, { now: () => T0 + minute * MINUTE });
      // The other sources carry on: the failed tick is still recorded.
      expect(report).toMatchObject({ occurrences: 1, stoppedAtLimit: false });
      expect(report.sourceErrors).toHaveLength(1);
      seen.push({ behind: heartbeat.behindMs! / MINUTE, alarm: heartbeat.alarm });
    }
    expect(seen).toEqual([{ behind: 5 }, { behind: 10 }, { behind: 15 }, { behind: 20, alarm: "the ledger is 20 minutes behind its sources and has not caught up in 3 runs" }]);
    writeFileSync(controller, good);
    addEvents(dir, [workerFailure(2, T0 + 21 * MINUTE)]);
    const after = await ingest(dir, { now: () => T0 + 25 * MINUTE });
    expect(after.report).toMatchObject({ occurrences: 1, behindMs: 0, sourceErrors: [] });
    expect(after.heartbeat.alarm).toBeUndefined();
    expect(reconcile(dir).difference).toBe(0);
  });

  test("the job re-maps stored signatures by itself when the normaliser version has changed", async () => {
    const dir = factoryDir();
    // A ledger written by an older normaliser, which told sessions apart and so made a class for each of two sightings.
    const older = new Ledger(join(dir, LOOP_FILES.ledger), { normaliser: { version: 0, normalise: (text) => text.toUpperCase() } });
    const ids = [1, 2].map((n) => older.record(failure(n), T0).classId);
    ids.forEach((id, n) => older.link(id, "issue", `example/demo#${n + 1}`, T0));
    expect(new Set(ids).size).toBe(2);
    older.close();
    addEvents(dir, [workerFailure(3, T0 + MINUTE), workerFailure(4, T0 + MINUTE + 1, "SQLiteError: database is locked")]);
    expect((await ingest(dir, { startAt: "beginning", now: () => T0 + 2 * MINUTE })).report).toMatchObject({ occurrences: 2, classesOpened: 1 });
    const ledger = open(dir);
    try {
      expect(ledger.meta<number>("normaliser-version")).toBe(1);
      // Both old ids still stand with their links. Today's signature belongs to the older one, and the new sighting counted there.
      expect(ledger.classes().map((c) => [c.id, c.occurrences]).slice(0, 2)).toEqual([[ids[0]!, 2], [ids[1]!, 1]]);
      expect(ids.map((id) => ledger.linksOf(id).map((l) => l.ref))).toEqual([["example/demo#1"], ["example/demo#2"]]);
      expect(ledger.transitions().filter((t) => t.action === "remap-conflict")).toMatchObject([{ classId: ids[1]! }]);
      expect(ledger.classes()).toHaveLength(3);
    } finally {
      ledger.close();
    }
  });

  test("a run that exceeds 60 seconds stops itself, loses nothing and carries on next time", async () => {
    const dir = factoryDir();
    addEvents(dir, Array.from({ length: 7 * BATCH_ROWS }, (_, n) => workerFailure(n + 1, T0 + n, `Error: ${word(n % 7)} failed`)));
    appendTick(dir, { at: T0 + 1, status: "error", error: "SQLiteError: database is locked" });
    // Each source batch takes 25 seconds on this slow day.
    const slow = (start: number) => {
      let elapsed = 0;
      return { now: () => start + elapsed, betweenBatches: () => void (elapsed += 25_000) };
    };
    const first = await ingest(dir, { startAt: "beginning", ...slow(T0 + MINUTE) });
    expect(first.report).toMatchObject({ stoppedAtLimit: true, occurrences: 2 * BATCH_ROWS, sourceErrors: [] });
    expect(first.report.at - (T0 + MINUTE)).toBeGreaterThanOrEqual(RUN_LIMIT_MS);
    expect(first.heartbeat.behindMs).toBeGreaterThan(0);
    expect(first.heartbeat.alarm).toBeUndefined();
    const second = await ingest(dir, slow(T0 + 6 * MINUTE));
    expect(second.report).toMatchObject({ stoppedAtLimit: true, occurrences: 2 * BATCH_ROWS });
    const third = await ingest(dir, slow(T0 + 11 * MINUTE));
    expect(third.report).toMatchObject({ stoppedAtLimit: true, occurrences: 2 * BATCH_ROWS });
    expect(third.heartbeat.alarm).toBe("3 runs in a row stopped at the 60-second limit");
    // An ordinary run finishes the rest; nothing was lost or counted twice along the way.
    const last = await ingest(dir, { now: () => T0 + 16 * MINUTE });
    expect(last.report).toMatchObject({ stoppedAtLimit: false, occurrences: BATCH_ROWS + 1, behindMs: 0 });
    expect(last.heartbeat.alarm).toBeUndefined();
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 7 * BATCH_ROWS, ledger: 7 * BATCH_ROWS }, tickErrors: { source: 1, ledger: 1 }, difference: 0 });
  });

  test("a throwing rule yields one rule-error class while the other rules still run", async () => {
    const dir = factoryDir(),
      rules = mkdtempSync(join(tmpdir(), "ledger-rules-")),
      steps = mkdtempSync(join(tmpdir(), "ledger-steps-"));
    writeFileSync(join(rules, "a-throws.ts"), `export default { id: "a-throws", run() { throw Error("rule bug: cannot read undefined"); } };`);
    writeFileSync(join(rules, "b-not-a-rule.ts"), `export default { name: "no id and no run" };`);
    writeFileSync(join(rules, "c-hangs.ts"), `export default { id: "c-hangs", run: () => new Promise(() => {}) };`);
    writeFileSync(join(rules, "d-good.ts"), `export default { id: "d-good", switch: "ledger-rules-stuck-work", eventKinds: ["worker-exit"], run: (input) => ({ nightsMissed: 4, findings: input.events.map((e) => ({ kind: "failure", text: "worker exited without publishing", at: e.at, source: "ignored", ref: e.id })).concat(input.query("controller", "SELECT count(*) AS n FROM events").map((row) => ({ kind: "evidence-gap", text: "rule read the controller read-only", summary: "events: " + row.n, at: input.now, source: "ignored", ref: "count" }))) }) };`);
    writeFileSync(join(rules, "e-bad-finding.ts"), `export default { id: "e-bad-finding", run: () => [{ kind: "not-a-kind", text: "x", at: 1, ref: "1" }] };`);
    writeFileSync(join(rules, "notes.md"), "not a rule file");
    writeFileSync(join(steps, "a-step-throws.ts"), `export default { id: "a-step-throws", run() { throw Error("step bug"); } };`);
    writeFileSync(join(steps, "b-step-good.ts"), `export default { id: "b-step-good", run: (context) => { context.ledger.link(context.ledger.classes().find((c) => c.summary.startsWith("worker exited"))!.id, "lesson", "docs/lessons.md#fixture", context.now); } };`);
    addEvents(dir, [workerFailure(1, T0), { id: "exit:1", kind: "worker-exit", at: T0 + 1, data: { ok: false } }, { id: "exit:2", kind: "worker-exit", at: T0 + 2, data: { ok: false } }]);

    // The clock is within 20 ms of the limit by the time the rules run, so the hanging rule is cut off quickly.
    let late = false;
    const clock = (start: number) => () => (late ? start + RUN_LIMIT_MS - 20 : start);
    const options = (start: number): Partial<IngestOptions> => ({ rulesDir: rules, stepsDir: steps, now: clock(start), betweenBatches: () => void (late = true) });
    const first = await ingest(dir, { startAt: "beginning", ...options(T0 + MINUTE) });
    expect(first.report.ruleErrors.sort()).toEqual(["a-step-throws", "a-throws", "b-not-a-rule", "c-hangs", "e-bad-finding"]);
    expect(first.heartbeat.alarm).toBe("a ledger rule or step failed: b-not-a-rule, a-throws, c-hangs, e-bad-finding, a-step-throws");
    expect(first.logged.join("\n")).toContain("ledger rule error a-throws: Error: rule bug: cannot read undefined");
    late = false;
    addEvents(dir, [{ id: "exit:3", kind: "worker-exit", at: T0 + 2 * MINUTE, data: { ok: false } }]);
    const second = await ingest(dir, options(T0 + 6 * MINUTE));
    expect(second.report.ruleErrors).toHaveLength(5);

    const ledger = open(dir);
    try {
      const byId = Object.fromEntries(ledger.classes().map((c) => [c.id, c]));
      // One class per failing rule, counted once per run; never one per throw.
      for (const id of ["a-throws", "b-not-a-rule", "c-hangs", "e-bad-finding", "a-step-throws"]) expect(byId[`rule-error-${id}`]).toMatchObject({ kind: "instrumentation", occurrences: 2, ownerRole: "Platform" });
      expect(ledger.evidenceOf("rule-error-a-throws")[0]!.excerpt).toContain("rule bug: cannot read undefined");
      expect(ledger.evidenceOf("rule-error-c-hangs")[0]!.excerpt).toContain("60-second limit");
      // The good rule ran both times: it saw only the kinds it asked for, read a source read-only, and handed over its value.
      const exited = Object.values(byId).find((c) => c.summary === "worker exited without publishing")!;
      expect(exited).toMatchObject({ occurrences: 3, shadow: true, switch: "ledger-rules-stuck-work" });
      expect(Object.values(byId).find((c) => c.kind === "evidence-gap")!.summary).toBe("events: 3");
      expect((ledger.db.query("SELECT DISTINCT source FROM occurrences ORDER BY source").all() as { source: string }[]).map((r) => r.source)).toEqual(["rule-error", "rule:d-good", "worker-failure"]);
      // The good step ran after the failing one.
      expect(ledger.linksOf(exited.id)).toEqual([{ type: "lesson", ref: "docs/lessons.md#fixture", at: T0 + MINUTE, actor: null }]);
      expect(Object.keys(byId)).toHaveLength(8);
    } finally {
      ledger.close();
    }
    expect(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerExport), "utf8")).nightsMissed).toBe(4);
    // With the rule files gone the alarm clears; the classes stay on file.
    const calm = await ingest(dir, { now: () => T0 + 11 * MINUTE });
    expect(calm.heartbeat.alarm).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerExport), "utf8")).nightsMissed).toBe(4);
  });

  test("a rule that returns findings with unusable times is recorded against itself, and the export is still written", async () => {
    const dir = factoryDir(),
      rules = mkdtempSync(join(tmpdir(), "ledger-rules-"));
    writeFileSync(join(rules, "bad-times.ts"), `export default { id: "bad-times", run: (input) => [0, 1.5, -5, "abc"].map((at, n) => ({ kind: "failure", text: "some failure words", at, ref: "bad-" + n })).concat([{ kind: "failure", text: "a real failure", at: input.now, ref: "good" }]) };`);
    const usable = (now: number) => usableLedgerExport(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerExport), "utf8")), now);
    const first = await ingest(dir, { rulesDir: rules, now: () => T0 + MINUTE });
    expect(first.report).toMatchObject({ ruleErrors: ["bad-times"], occurrences: 2, classesOpened: 2 });
    expect(first.heartbeat.alarm).toBe("a ledger rule or step failed: bad-times");
    expect(usable(T0 + MINUTE)?.classes.map((c) => c.id).sort()).toEqual([expect.stringContaining("a-real-failure"), "rule-error-bad-times"]);
    // With the rule gone the next run is clean: nothing unusable was left behind to break it.
    const second = await ingest(dir, { now: () => T0 + 6 * MINUTE });
    expect(second.report.alarm).toBeUndefined();
    expect(usable(T0 + 6 * MINUTE)?.classes).toHaveLength(2);
  });

  test("a rule the run had no time left for is not blamed, and is shown the same batch on the next run", async () => {
    const dir = factoryDir(),
      rules = mkdtempSync(join(tmpdir(), "ledger-rules-")),
      steps = mkdtempSync(join(tmpdir(), "ledger-steps-"));
    writeFileSync(join(steps, "c-step.ts"), `export default { id: "c-step", run: (context) => { context.ledger.setMeta("c-step-ran-at", context.now); } };`);
    writeFileSync(join(rules, "a-hangs.ts"), `export default { id: "a-hangs", run: () => new Promise(() => {}) };`);
    writeFileSync(join(rules, "b-good.ts"), `export default { id: "b-good", eventKinds: ["worker-exit"], run: (input) => input.events.map((e) => ({ kind: "failure", text: "worker exited without publishing", at: e.at, ref: e.id })) };`);
    addEvents(dir, [workerFailure(1, T0), { id: "exit:1", kind: "worker-exit", at: T0 + 1, data: { ok: false } }]);
    // 20 ms are left when the rules begin; the hanging rule uses them up, and the clock is past the limit once it has been cut off.
    const start = T0 + MINUTE;
    let late = false,
      past = false;
    const first = await ingest(dir, { startAt: "beginning", rulesDir: rules, stepsDir: steps, now: () => (past ? start + RUN_LIMIT_MS + 1 : late ? start + RUN_LIMIT_MS - 20 : start), betweenBatches: () => void (late = true), log: (line) => void (past ||= line.includes("a-hangs")) });
    expect(first.report).toMatchObject({ ruleErrors: ["a-hangs"], notRun: ["b-good", "c-step"], stoppedAtLimit: true, occurrences: 2 });
    expect(first.heartbeat.alarm).toBe("a ledger rule or step failed: a-hangs");
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 1, ledger: 1 }, difference: 0 });
    // The healthy rule lost nothing: with the hanging one removed it gets the batch it was not reached for.
    rmSync(join(rules, "a-hangs.ts"));
    const second = await ingest(dir, { rulesDir: rules, stepsDir: steps, now: () => T0 + 6 * MINUTE });
    expect(second.report).toMatchObject({ ruleErrors: [], notRun: [], occurrences: 1, classesOpened: 1 });
    expect(second.heartbeat.alarm).toBeUndefined();
    const ledger = open(dir);
    try {
      expect(ledger.meta<number>("c-step-ran-at")).toBe(T0 + 6 * MINUTE);
      expect(ledger.classes().map((c) => [c.summary.slice(0, 32), c.occurrences]).sort()).toEqual([["Error: exact tested tree require", 1], ['Ledger rule or step "a-hangs" fa', 1], ["worker exited without publishing", 1]]);
      expect(ledger.classOf("rule-error-b-good")).toBeNull();
    } finally {
      ledger.close();
    }
    expect(reconcile(dir).difference).toBe(0);
  });

  test("a rule that failed sees its batch again, for two more runs at most, and nothing is counted twice", async () => {
    const dir = factoryDir(),
      rules = mkdtempSync(join(tmpdir(), "ledger-rules-")),
      broken = join(rules, "broken-for-now");
    writeFileSync(join(rules, "flaky.ts"), `import { existsSync } from "node:fs";\nexport default { id: "flaky", eventKinds: ["worker-exit"], run: (input) => { if (existsSync(${JSON.stringify(broken)})) throw Error("not today"); return input.events.map((e) => ({ kind: "failure", text: "worker exited without publishing", at: e.at, ref: e.id })); } };`);
    const exit = (n: number) => ({ id: `exit:${n}`, kind: "worker-exit", at: T0 + n, data: { ok: false } });
    const seenByRule = () => {
      const ledger = open(dir);
      try {
        return (ledger.db.query("SELECT source_ref FROM occurrences WHERE source='rule:flaky' ORDER BY source_ref").all() as { source_ref: string }[]).map((row) => row.source_ref);
      } finally {
        ledger.close();
      }
    };
    // It throws once. The next run hands it the same events, and the failure the job itself recorded is not counted again.
    writeFileSync(broken, "");
    addEvents(dir, [workerFailure(1, T0), exit(1)]);
    expect((await ingest(dir, { startAt: "beginning", rulesDir: rules, now: () => T0 + MINUTE })).report).toMatchObject({ ruleErrors: ["flaky"], occurrences: 2 });
    rmSync(broken);
    expect((await ingest(dir, { rulesDir: rules, now: () => T0 + 6 * MINUTE })).report).toMatchObject({ ruleErrors: [], occurrences: 1 });
    expect(seenByRule()).toEqual(["exit:1"]);
    expect(reconcile(dir)).toMatchObject({ workerFailures: { source: 1, ledger: 1 }, difference: 0 });

    // It stays broken. Its batch is kept for two more runs, then the job moves on rather than fall behind for good.
    writeFileSync(broken, "");
    for (let run = 0; run <= REPLAY_RUNS; run++) {
      addEvents(dir, [exit(10 + run)]);
      expect((await ingest(dir, { rulesDir: rules, now: () => T0 + (11 + 5 * run) * MINUTE })).report.ruleErrors).toEqual(["flaky"]);
    }
    rmSync(broken);
    addEvents(dir, [exit(20)]);
    await ingest(dir, { rulesDir: rules, now: () => T0 + 30 * MINUTE });
    expect(seenByRule()).toEqual(["exit:1", "exit:20"]);
    expect(reconcile(dir).difference).toBe(0);
  });

  test("a rule file whose import never returns is reported and left out; the others load", async () => {
    const dir = factoryDir(),
      rules = mkdtempSync(join(tmpdir(), "ledger-rules-"));
    writeFileSync(join(rules, "a-never-loads.ts"), `await new Promise(() => {});\nexport default { id: "a-never-loads", run: () => [] };`);
    writeFileSync(join(rules, "b-loads.ts"), `export default { id: "b-loads", run: (input) => [{ kind: "evidence-gap", text: "the second rule ran", at: input.now, ref: "ran" }] };`);
    expect(await loadFolder(rules, 50)).toMatchObject({ loaded: [{ id: "b-loads" }], errors: [{ id: "a-never-loads", error: expect.stringContaining("its import had not returned after 50 ms") }] });
    // In the job the import limit is whatever is left of the run, here 50 ms.
    let calls = 0;
    const { report, heartbeat } = await ingest(dir, { rulesDir: rules, now: () => T0 + (calls++ ? RUN_LIMIT_MS - 50 : 0) });
    expect(report).toMatchObject({ ruleErrors: ["a-never-loads"], notRun: [], occurrences: 2 });
    expect(heartbeat.alarm).toBe("a ledger rule or step failed: a-never-loads");
  });

  test("the operating system ends a run that cannot stop itself", async () => {
    // A stand-in for a rule that blocks without yielding: nothing inside the process can interrupt this loop.
    const script = join(mkdtempSync(join(tmpdir(), "ledger-blocked-")), "blocked.ts");
    writeFileSync(script, `import { armHardStop } from ${JSON.stringify(join(repo, "scripts/ledger-ingest.ts"))};\nif (!armHardStop(1)) process.exit(3);\nfor (;;) {}\n`);
    const began = Date.now();
    const child = Bun.spawn([process.execPath, script], { env: { PATH: process.env.PATH ?? "", FACTORY_PRIVATE_DIR: factoryDir() }, stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: null, signal: "SIGALRM" });
    expect(Date.now() - began).toBeLessThan(15_000);
    // The job arms the same stop at two run limits, which is also when a later run may take over the lock. Run as
    // its own process on a fixture directory it says nothing on stderr, where it would report a stop it could not arm.
    expect(HARD_STOP_SECONDS * 1000).toBe(2 * RUN_LIMIT_MS);
    const dir = factoryDir();
    appendTick(dir, { at: Date.now(), status: "error", error: "SQLiteError: database is locked" });
    const job = Bun.spawn([process.execPath, join(repo, "scripts/ledger-ingest.ts")], { env: { PATH: process.env.PATH ?? "", FACTORY_PRIVATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(job.stdout).text(), new Response(job.stderr).text(), job.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toMatchObject({ occurrences: 0, behindMs: 0, ruleErrors: [], notRun: [], stoppedAtLimit: false });
    expect(LoopHeartbeatSchema.parse(JSON.parse(readFileSync(join(dir, LOOP_FILES.ledgerHeartbeat), "utf8"))).alarm).toBeUndefined();
  }, 30_000);

  test("when tick.log is cut short the job starts it again and the reconciliation still balances", async () => {
    const dir = factoryDir();
    appendTick(dir, { at: T0, status: "ok", ready: 0 }, { at: T0 + 1, status: "error", error: "SQLiteError: database is locked" });
    expect((await ingest(dir, { startAt: "beginning", now: () => T0 + MINUTE })).report).toMatchObject({ occurrences: 1 });
    writeFileSync(join(dir, "tick.log"), "");
    appendTick(dir, { at: T0 + 2 * MINUTE, status: "error", error: "SQLiteError: database is locked" });
    expect((await ingest(dir, { now: () => T0 + 6 * MINUTE })).report).toMatchObject({ occurrences: 1, sourceErrors: [] });
    // Both failed ticks were recorded once each. What the old log held is gone, so the comparison covers the new one.
    expect(reconcile(dir)).toMatchObject({ tickErrors: { source: 1, ledger: 1, missing: [], restartedAt: T0 + 6 * MINUTE }, difference: 0 });
    appendTick(dir, { at: T0 + 7 * MINUTE, status: "error", error: "SQLiteError: database is locked" });
    await ingest(dir, { now: () => T0 + 11 * MINUTE });
    expect(reconcile(dir)).toMatchObject({ tickErrors: { source: 2, ledger: 2, missing: [] }, difference: 0 });
    const ledger = open(dir);
    try {
      expect((ledger.db.query("SELECT count(*) AS n FROM occurrences WHERE source='tick-error'").get() as { n: number }).n).toBe(3);
    } finally {
      ledger.close();
    }
  });

  test("the repository ships no rule or step file yet, and a missing folder is simply empty", async () => {
    for (const folder of [RULES_DIR, STEPS_DIR]) {
      expect(folder.startsWith(join(repo, "launcher"))).toBe(true);
      if (!existsSync(folder)) expect(await loadFolder(folder)).toEqual({ loaded: [], errors: [] });
    }
  });

  test("when disk admission is refused the job writes counts only", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0), workerFailure(2, T0 + 1)]);
    const { report, heartbeat } = await ingest(dir, { startAt: "beginning", disk: fullDisk, now: () => T0 + MINUTE });
    expect(report).toMatchObject({ countsOnly: true, occurrences: 2, classesOpened: 1 });
    // A limit doing its job is not an alarm.
    expect(heartbeat.alarm).toBeUndefined();
    const ledger = open(dir);
    try {
      const [only] = ledger.classes();
      expect(only).toMatchObject({ occurrences: 2 });
      expect(ledger.evidenceOf(only!.id)).toEqual([]);
    } finally {
      ledger.close();
    }
    expect(reconcile(dir).difference).toBe(0);
  });

  test("a broken ledger file is loud: the heartbeat carries the reason", async () => {
    const dir = factoryDir();
    writeFileSync(join(dir, LOOP_FILES.ledger), "this is not a database");
    const { report, heartbeat } = await ingest(dir, { now: () => T0 });
    expect(report.alarm).toContain("ledger run failed");
    expect(heartbeat).toMatchObject({ at: T0, alarm: report.alarm });
  });
});

describe("the inbox and the operator command", () => {
  const declare = { version: 1, id: "declare:fixture:1", at: T0, source: "release-morning", type: "declare", kind: "failure", signature: "Nightly rehearsal could not reach the QA host", summary: "Rehearsal cannot reach QA", evidence: "rehearsal log line 12" } as const;

  test("a dropped record of a reducing type is refused and logged; a declare record yields exactly one row", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0)]);
    await ingest(dir, { startAt: "beginning", now: () => T0 });
    const victim = (() => {
      const ledger = open(dir);
      try {
        return ledger.classes()[0]!.id;
      } finally {
        ledger.close();
      }
    })();
    drop(dir, declare);
    for (const type of REDUCING_TRANSITIONS) drop(dir, { version: 1, id: `sneaky:${type}`, at: T0, source: "builder", type, classId: victim, actor: "Vincent", reason: "close it", until: T0 + MINUTE }, `${type}-sneaky.json`);
    // A real, signed operator command is still refused when it arrives through the inbox.
    drop(dir, signCommand({ version: 1, id: "signed-but-misplaced", at: T0, actor: "Vincent", action: "dismiss", classId: victim, reason: "wrong door" }, OWNER_TOKEN) as unknown as Record<string, unknown>, "signed-command.json");
    drop(dir, { nonsense: true }, "garbage.json");
    writeFileSync(join(dir, LOOP_FILES.ledgerInbox, "torn.json"), '{"version":1,"id":');

    const first = await ingest(dir, { now: () => T0 + 5 * MINUTE });
    expect(first.report).toMatchObject({ inboxApplied: 1, inboxRefused: 8, occurrences: 0 });
    for (const type of REDUCING_TRANSITIONS) expect(first.logged).toContain(`ledger inbox record refused (${type}-sneaky.json, ${type}): the inbox can only add; "${type}" needs a named actor through the ledger command`);
    expect(first.logged.filter((line) => line.includes("refused"))).toHaveLength(8);
    expect(readdirSync(join(dir, LOOP_FILES.ledgerInbox, "refused")).sort()).toEqual([...REDUCING_TRANSITIONS.map((type) => `${type}-sneaky.json`), "garbage.json", "signed-command.json", "torn.json"].sort());
    expect(readdirSync(join(dir, LOOP_FILES.ledgerInbox, "applied"))).toEqual([inboxFileName(declare)]);

    // The same declare dropped again, and again under another file name, changes nothing.
    drop(dir, declare);
    drop(dir, declare, "the-same-fact-again.json");
    const again = await ingest(dir, { now: () => T0 + 10 * MINUTE });
    expect(again.report).toMatchObject({ inboxApplied: 0, inboxRefused: 0 });
    const ledger = open(dir);
    try {
      const declared = ledger.classes().filter((c) => c.summary === "Rehearsal cannot reach QA");
      expect(declared).toHaveLength(1);
      expect(declared[0]).toMatchObject({ kind: "failure", state: "open", occurrences: 1, shadow: false, ownerRole: "Platform" });
      expect((ledger.db.query("SELECT count(*) AS n FROM occurrences WHERE source='inbox'").get() as { n: number }).n).toBe(1);
      expect(ledger.evidenceOf(declared[0]!.id)).toEqual([{ at: T0, ref: "inbox:release-morning:declare:fixture:1", excerpt: "rehearsal log line 12" }]);
      // Nothing was reduced: the class the sneaky records aimed at is untouched.
      expect(ledger.classOf(victim)).toMatchObject({ state: "open", mergedInto: null, parkedUntil: null });
      expect(ledger.transitions(true)).toEqual([]);
      expect((ledger.db.query("SELECT count(*) AS n FROM received WHERE channel='inbox' AND outcome='refused'").get() as { n: number }).n).toBe(8);
    } finally {
      ledger.close();
    }
  });

  test("records dropped between two runs are applied in the order things happened", async () => {
    const dir = factoryDir();
    const base = { version: 1, source: "fixture" },
      input = "AWS sign-in",
      release = releaseInputClassId(input);
    // By file name the evidence sorts before the proof it belongs to, and the issue before the input it is about.
    drop(dir, { ...base, id: "owed-1", at: T0, type: "proof-owed", proofId: "first-night-ships", what: "A scheduled night ships", dueAt: T0 + 24 * 60 * MINUTE, role: "Release" });
    drop(dir, { ...base, id: "attached-1", at: T0 + 1, type: "proof-attached", proofId: "first-night-ships", evidence: "release-window-result 2026-11-12", actor: "Release" });
    drop(dir, { ...base, id: "input-1", at: T0, type: "release-input", classId: release, input, reason: "expired at 23:24", day: "2026-11-10" });
    drop(dir, { ...base, id: "issue-1", at: T0, type: "issue-link", classId: release, repo: "example/demo", issue: 7 });
    // Owed again after its evidence arrived: time order decides, so this proof ends up open.
    drop(dir, { ...base, id: "owed-2", at: T0, type: "proof-owed", proofId: "second-night-ships", what: "The next night ships too", dueAt: T0 + 48 * 60 * MINUTE, role: "Release" });
    drop(dir, { ...base, id: "attached-2", at: T0 + 1, type: "proof-attached", proofId: "second-night-ships", evidence: "release-window-result 2026-11-13", actor: "Release" });
    drop(dir, { ...base, id: "owed-3", at: T0 + 2, type: "proof-owed", proofId: "second-night-ships", what: "The next night ships too", dueAt: T0 + 48 * 60 * MINUTE, role: "Release" });
    const { report, logged } = await ingest(dir, { now: () => T0 + 5 * MINUTE });
    expect(logged).toEqual([]);
    expect(report).toMatchObject({ inboxApplied: 7, inboxRefused: 0 });
    const ledger = open(dir);
    try {
      expect(ledger.classOf("first-night-ships")).toMatchObject({ state: "resolved-no-fix", occurrences: 1 });
      expect(ledger.evidenceOf("first-night-ships").map((e) => e.excerpt)).toEqual(["release-window-result 2026-11-12"]);
      expect(ledger.classOf(release)).toMatchObject({ state: "ticketed", occurrences: 1 });
      expect(ledger.linksOf(release).map((l) => l.ref)).toEqual(["example/demo#7"]);
      expect(ledger.classOf("second-night-ships")).toMatchObject({ state: "open", occurrences: 2 });
    } finally {
      ledger.close();
    }
  });

  test("the adding record types each do one thing", () => {
    const ledger = memory();
    const base = { version: 1 as const, at: T0, source: "fixture" };
    ledger.applyInbox({ ...base, ...declare }, T0);
    const id = ledger.classes()[0]!.id;
    ledger.applyInbox({ ...base, id: "i1", type: "issue-link", classId: id, repo: "example/demo", issue: 12 }, T0);
    ledger.applyInbox({ ...base, id: "f1", type: "fix-link", classId: id, repo: "example/demo", pr: 14, actor: "Platform" }, T0);
    expect(ledger.classOf(id)!.state).toBe("ticketed");
    expect(ledger.linksOf(id).map((l) => [l.type, l.ref, l.actor])).toEqual([["issue", "example/demo#12", "fixture"], ["fix", "example/demo#14", "Platform"]]);

    const input = "AWS sign-in", release = releaseInputClassId(input);
    ledger.applyInbox({ ...base, id: "r1", type: "release-input", classId: release, input, reason: "expired at 23:24", day: "2026-11-10" }, T0);
    ledger.applyInbox({ ...base, id: "r2", type: "release-input", classId: release, input, reason: "still expired", day: "2026-11-11" }, T0);
    expect(ledger.classOf(release)).toMatchObject({ kind: "release-input", occurrences: 2, ownerRole: ownerRole({ kind: "release-input", input, reason: "expired at 23:24" }) });
    ledger.applyInbox({ ...base, id: "h1", type: "human-step-request", classId: release, step: "sign-in", what: "Sign in to AWS", dueAt: T0 + 60 * MINUTE }, T0);
    expect(ledger.classOf(release)).toMatchObject({ state: "waiting-on-human", humanStep: "sign-in", dueAt: T0 + 60 * MINUTE, parkedUntil: T0 + 60 * MINUTE });

    ledger.applyInbox({ ...base, id: "p1", type: "proof-owed", proofId: "first-scheduled-night-ships", what: "A scheduled night ships end to end", dueAt: T0 + 3 * 24 * 60 * MINUTE, role: "Release" }, T0);
    expect(ledger.classOf("first-scheduled-night-ships")).toMatchObject({ kind: "proof-owed", ownerRole: "Release", dueAt: T0 + 3 * 24 * 60 * MINUTE, state: "open" });
    expect(() => ledger.applyInbox({ ...base, id: "p2", type: "proof-owed", proofId: id, what: "hijack", dueAt: T0 + 1, role: "Quality" }, T0)).toThrow("already names a failure class");
    expect(() => ledger.applyInbox({ ...base, id: "p3", type: "proof-attached", proofId: id, evidence: "x", actor: "Quality" }, T0)).toThrow("not a proof still owed");
    ledger.applyInbox({ ...base, id: "p4", type: "proof-attached", proofId: "first-scheduled-night-ships", evidence: "release-window-result 2026-11-12", actor: "Release" }, T0);
    expect(ledger.classOf("first-scheduled-night-ships")!.state).toBe("resolved-no-fix");

    ledger.applyInbox({ ...base, id: "d1", type: "drill-result", drill: "health-alarm-replay", ok: true, evidence: "delivered", classId: id }, T0);
    expect(ledger.classes().filter((c) => c.kind === "safeguard-not-proven")).toEqual([]);
    ledger.applyInbox({ ...base, id: "d2", type: "drill-result", drill: "health-alarm-replay", ok: false, evidence: "no wake recorded" }, T0);
    expect(ledger.classes().filter((c) => c.kind === "safeguard-not-proven")).toMatchObject([{ ownerRole: "Quality", occurrences: 1, summary: 'Drill "health-alarm-replay" did not pass' }]);
    expect(ledger.evidenceOf(id).map((e) => e.excerpt)).toContain("drill health-alarm-replay passed: delivered");
  });

  test("an operator command is carried out by the job, once, and only when its signature is good", async () => {
    const dir = factoryDir();
    addEvents(dir, [workerFailure(1, T0), workerFailure(2, T0 + 1, "SQLiteError: database is locked")]);
    await ingest(dir, { startAt: "beginning", now: () => T0 });
    const ids = (() => {
      const ledger = open(dir);
      try {
        return ledger.classes().map((c) => c.id);
      } finally {
        ledger.close();
      }
    })();
    const queued = queueOperatorCommand(dir, OWNER_TOKEN, { action: "defer", classId: ids[0]!, actor: "Vincent", reason: "after the release window", until: T0 + 24 * 60 * MINUTE }, T0);
    expect(queued.startsWith(join(dir, LEDGER_COMMANDS_DIR))).toBe(true);
    // Forged: signed with a guessed token, and an unsigned copy of a real command aimed at another class.
    const forged = signCommand({ version: 1, id: "forged-1", at: T0, actor: "Vincent", action: "dismiss", classId: ids[1]!, reason: "not a problem" }, "guessed-token-0123456789abcdef");
    writeFileSync(join(dir, LEDGER_COMMANDS_DIR, "forged.json"), JSON.stringify(forged));
    writeFileSync(join(dir, LEDGER_COMMANDS_DIR, "unsigned.json"), JSON.stringify({ command: forged.command }));
    expect(() => queueOperatorCommand(dir, OWNER_TOKEN, { action: "dismiss", classId: ids[1]!, actor: "", reason: "no name" })).toThrow("a named actor and a reason are always required");

    const { report, logged } = await ingest(dir, { now: () => T0 + 5 * MINUTE });
    expect(report).toMatchObject({ commandsApplied: 1, commandsRefused: 2 });
    expect(logged.filter((line) => line.includes("refused")).map((line) => line.replace(/.*\): /, ""))).toEqual(["signature does not match the owner token", "not an operator command: mac"]);
    const ledger = open(dir);
    try {
      expect(ledger.classOf(ids[0]!)).toMatchObject({ state: "deferred", parkedUntil: T0 + 24 * 60 * MINUTE });
      expect(ledger.classOf(ids[1]!)).toMatchObject({ state: "open" });
      expect(ledger.transitions(true)).toMatchObject([{ classId: ids[0], action: "defer", actor: "Vincent", reason: "after the release window" }]);
    } finally {
      ledger.close();
    }
    // Without the owner token file the job refuses every command, including a correctly signed one.
    queueOperatorCommand(dir, OWNER_TOKEN, { action: "dismiss", classId: ids[1]!, actor: "Vincent", reason: "duplicate of another class" }, T0 + 6 * MINUTE);
    chmodSync(join(dir, "owner-token"), 0o000);
    try {
      expect((await ingest(dir, { now: () => T0 + 10 * MINUTE })).report).toMatchObject({ commandsApplied: 0, commandsRefused: 1 });
    } finally {
      chmodSync(join(dir, "owner-token"), 0o600);
    }
    // The parked class comes back by itself when its expiry passes.
    await ingest(dir, { now: () => T0 + 24 * 60 * MINUTE });
    const later = open(dir);
    try {
      expect(later.classOf(ids[0]!)!.state).toBe("open");
      expect(later.classOf(ids[1]!)!.state).toBe("open");
    } finally {
      later.close();
    }
  });
});

describe("install", () => {
  const autonomy = (protectedPaths: readonly string[]) => ({ intake_mode: "build", intake_owner: "builder", ready_buffer: 3, auto_approval: { max_minutes: 30, max_docs_per_round: 1, protected_paths: protectedPaths }, restart: { max_retries: 1, causes_per_hour: 3 } });

  test("an automatic-lane change that adds a file under launcher/rules/ is refused auto-approval", () => {
    expect([...LEDGER_PROTECTED_PATHS]).toEqual(expect.arrayContaining(["launcher/ledger.ts", "launcher/fingerprint.ts", "scripts/ledger-ingest.ts", "launcher/rules", "launcher/ledger-steps"]));
    const engine = new TestEngine(new Store(":memory:"), ConfigSchema.parse({ ...config(), autonomy: autonomy(LEDGER_PROTECTED_PATHS) }));
    const raw = { estimateBasis: "Synthetic bounded change based on source inspection", estimateSeconds: 100, estimateTokens: 1000 };
    const refusal = (paths: string[]) => policyRefusal(engine, { ...ticket(1), area: "controller", kind: "fix", paths }, raw, "round-1", undefined, T0);
    for (const path of ["launcher/rules/brand-new-rule.ts", "launcher/rules", "launcher/ledger-steps/quietly-close-everything.ts", "launcher/ledger.ts", "launcher/fingerprint.ts", "scripts/ledger-ingest.ts", "scripts/ledger.ts", "scripts/install-ledger.ts", "launcher"]) expect([path, refusal([path])]).toEqual([path, "protected path"]);
    expect(refusal(["src/task-1.ts", "launcher/rules/hidden-among-others.ts"])).toBe("protected path");
    // The same ticket without a protected path is approved, so the refusal above is the path and nothing else.
    expect(refusal(["src/task-1.ts"])).toBeNull();
    expect(refusal(["launcher/rules-of-thumb.md"])).toBeNull();
    engine.s.close();
  });

  test("the installer prepares a five-minute job, loads nothing, and refuses to load before the paths are protected", async () => {
    const base = mkdtempSync(join(tmpdir(), "ledger-install-")),
      home = join(base, "home"),
      privateDir = join(base, "private"),
      shim = join(base, "commands"),
      calls = join(base, "launchctl-calls");
    for (const folder of [home, privateDir, shim]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(privateDir, "repositories.json"), JSON.stringify({ "fulmar-hq/agent-factory": repo }));
    writeFileSync(join(shim, "plutil"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(shim, "launchctl"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 93\n`, { mode: 0o700 });
    writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 92\n`, { mode: 0o700 });
    const run = async (protectedPaths: readonly string[], ...args: string[]) => {
      writeFileSync(join(privateDir, "config.yaml"), JSON.stringify({ ...config(), autonomy: autonomy(protectedPaths) }));
      const child = Bun.spawn([process.execPath, join(repo, "scripts/install-ledger.ts"), ...args], { env: { HOME: home, PATH: `${shim}:/usr/bin`, FACTORY_PRIVATE_DIR: privateDir }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };

    const prepared = await run([".github"]);
    expect({ code: prepared.code, err: prepared.err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(prepared.out.split("\n")[0]!).protectedPaths.missing).toEqual([...LEDGER_PROTECTED_PATHS]);
    const plist = readFileSync(join(privateDir, "com.agent-factory.ledger.plist"), "utf8");
    expect(plist).toContain(`<string>${join(repo, "scripts/ledger-ingest.ts")}</string>`);
    expect(plist).toContain(`<key>FACTORY_PRIVATE_DIR</key><string>${privateDir}</string>`);
    expect([...plist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]))).toEqual([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]);
    expect(plist).toContain("<key>RunAtLoad</key><false/>");
    expect(plist).not.toContain("KeepAlive");

    // Asked to load with the folders unprotected, or only partly protected: refused before any launchd or git call.
    for (const listed of [[".github"], LEDGER_PROTECTED_PATHS.filter((path) => path !== "launcher/rules")]) {
      const refused = await run(listed, "--install");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("refused: add these to autonomy.auto_approval.protected_paths");
      expect(refused.err).toContain("launcher/rules");
    }
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
    const receipts = readdirSync(join(privateDir, "receipts")).sort();
    expect(receipts).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(privateDir, "receipts", receipts[0]!, "protected-paths.json"), "utf8"))).toMatchObject({ protectedPaths: [".github"], missing: [...LEDGER_PROTECTED_PATHS] });
  }, 30_000);

  test("with the paths protected, loading reads the job back and files its two day-later proofs as dated ledger items", async () => {
    // Stand-ins only: launchd, git and plutil are scripts in a temporary folder, the home folder is temporary,
    // and /bin (where the real launchctl lives) is not on the PATH at all.
    const base = mkdtempSync(join(tmpdir(), "ledger-install-")),
      home = join(base, "home"),
      shim = join(base, "commands"),
      calls = join(base, "launchctl-calls"),
      state = join(base, "loaded"),
      dir = factoryDir();
    for (const folder of [home, shim]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(dir, "repositories.json"), JSON.stringify({ "fulmar-hq/agent-factory": repo }));
    writeFileSync(join(dir, "config.yaml"), JSON.stringify({ ...config(), autonomy: autonomy(LEDGER_PROTECTED_PATHS) }));
    writeFileSync(join(shim, "plutil"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(shim, "git"), '#!/bin/sh\ncase "$*" in "branch --show-current") printf main;; "status --porcelain") :;; *) exit 92;; esac\n', { mode: 0o700 });
    writeFileSync(join(shim, "launchctl"), `#!/bin/sh\necho "$1" >> "${calls}"\ncase "$1" in\n print) [ -f "${state}" ] || exit 113; echo "program = ${join(repo, "scripts/ledger-ingest.ts")}";;\n bootstrap) : > "${state}";;\n bootout) /bin/rm -f "${state}";;\n *) exit 64;;\nesac\n`, { mode: 0o700 });
    const PATH = `${shim}:/usr/bin`;
    expect(Bun.which("launchctl", { PATH })).toBe(join(shim, "launchctl"));
    const install = async () => {
      const child = Bun.spawn([process.execPath, join(repo, "scripts/install-ledger.ts"), "--install"], { env: { HOME: home, PATH, FACTORY_PRIVATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return out;
    };
    expect(await install()).toContain('"installed":"com.agent-factory.ledger"');
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["print", "bootstrap", "print"]);
    expect(readFileSync(join(home, "Library/LaunchAgents/com.agent-factory.ledger.plist"), "utf8")).toBe(readFileSync(join(dir, "com.agent-factory.ledger.plist"), "utf8"));
    // Installing again replaces the loaded job: out, then in, then read back.
    await install();
    expect(readFileSync(calls, "utf8").trim().split("\n").slice(3)).toEqual(["print", "bootout", "print", "bootstrap", "print"]);

    const started = Date.now();
    await ingest(dir);
    const ledger = open(dir);
    try {
      const owed = ledger.classes().filter((c) => c.kind === "proof-owed");
      expect(owed.map((c) => c.id).sort()).toEqual(["ledger-leaves-the-tick-alone", "ledger-reconciles-first-day"]);
      for (const c of owed) {
        expect(c).toMatchObject({ ownerRole: "Platform", state: "open", occurrences: 1 });
        expect(c.dueAt! - started).toBeGreaterThan(23 * 60 * MINUTE);
        expect(c.dueAt! - started).toBeLessThanOrEqual(24 * 60 * MINUTE);
      }
    } finally {
      ledger.close();
    }
  }, 30_000);
});
