// The loop contract: every format two loop packages must agree on, in one file.
// Types, constants and pure functions only. Importing it opens no file,
// database or network connection, and nothing here can read or change a limit
// (usage gates, capacity, wallet, release schedule). docs/loop-contract.md is
// the plain-language copy; a change here is its own small operator pull request.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleaseOwner } from "./release-actions";
import { gapOwner } from "./release-rehearsal";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------- files
/** Loop files, relative to the private factory directory. Each has one writer. */
export const LOOP_FILES = {
  healthHeartbeat: "health/heartbeat.json",
  ledger: "health/ledger.sqlite",
  ledgerHeartbeat: "health/ledger-heartbeat.json",
  ledgerInbox: "health/ledger-inbox",
  ledgerExport: "health/ledger-export.json",
  switches: "loop-flags.json",
  switchHistory: "loop-flags.history.jsonl",
} as const;
/** The Telegram sender's heartbeat sits beside the mail store, not in the factory directory. */
export const SENDER_HEARTBEAT_FILE = "sender-heartbeat.json";
/** Repository paths that go on protected_paths when this installs (see the doc for the data file). */
export const LOOP_PROTECTED_PATHS = [
  "launcher/loop-contract.ts",
  "launcher/loop-flags.ts",
  "scripts/loop-flag.ts",
  LOOP_FILES.switches,
] as const;

// ------------------------------------------------------------ heartbeat
/**
 * What every watched job writes each run. `at` alone proves only that the job
 * ran; `behindMs` says how far behind its newest input it is, and `alarm` is a
 * plain reason someone must look. A job may add its own fields beside these.
 */
export const LoopHeartbeatSchema = z.looseObject({
  at: z.number().int().nonnegative(),
  behindMs: z.number().int().nonnegative().optional(),
  alarm: z.string().min(1).max(500).optional(),
});
export type LoopHeartbeat = z.infer<typeof LoopHeartbeatSchema>;
/** A heartbeat older than this, or one carrying an alarm, is a problem with that job. */
export const HEARTBEAT_STALE_MS = 15 * MINUTE;

// ------------------------------------------------------ classes and owners
export const CLASS_KINDS = [
  "failure",
  "limit",
  "limit-review",
  "evidence-gap",
  "release-input",
  "safeguard-not-proven",
  "instrumentation",
  "proof-owed",
  "operator-overdue",
] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];
/** A limit doing its job is counted and shown; it is never ticketed, held or diagnosed as a defect. */
export const COUNTED_ONLY_KINDS: readonly ClassKind[] = ["limit", "limit-review"];
export const CLASS_STATES = [
  "open",
  "ticketed",
  "fix-installed",
  "verifying",
  "closed-with-proof",
  "recurred",
  "resolved-no-fix",
  "deferred",
  "waiting-on-human",
] as const;
export type ClassState = (typeof CLASS_STATES)[number];
/** Stable, lower-case and safe as a folder name: issue links, regression folders and lesson rows hang on it. */
export const CLASS_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const classId = z.string().regex(CLASS_ID);
export const FIX_HOMES = ["launcher", "product"] as const;
export type FixHome = (typeof FIX_HOMES)[number];

export type OwnerRole = ReleaseOwner;
export const OWNER_ROLES = ["Release", "Quality", "Platform", "Product", "Coordinator"] as const satisfies readonly OwnerRole[];
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** One class per release input, whichever job noticed it missing. */
export function releaseInputClassId(input: string): string {
  const id = `release-input-${slug(input)}`.slice(0, 64).replace(/-+$/, "");
  if (id === "release-input" || !CLASS_ID.test(id)) throw Error(`release input has no usable name: ${JSON.stringify(input)}`);
  return id;
}

export type OwnerQuestion =
  | { kind: "release-input"; input: string; reason?: string }
  | { kind: "failure"; fixLivesIn?: FixHome }
  | { kind: "proof-owed"; role?: OwnerRole }
  | { kind: Exclude<ClassKind, "release-input" | "failure" | "proof-owed"> };
const CODED_OWNERS: Record<Exclude<ClassKind, "release-input">, OwnerRole> = {
  failure: "Platform",
  limit: "Platform",
  "limit-review": "Platform",
  "evidence-gap": "Platform",
  "safeguard-not-proven": "Quality",
  instrumentation: "Platform",
  "proof-owed": "Quality",
  "operator-overdue": "Platform",
};
/**
 * The one place an owner is decided. A release input gets exactly what the
 * installed rehearsal's gapOwner returns, so the morning check and the
 * rehearsal can never name different owners for the same input.
 */
export function ownerRole(q: OwnerQuestion): OwnerRole {
  if (q.kind === "release-input") return gapOwner(q.input, q.reason ?? "");
  if (q.kind === "failure" && q.fixLivesIn === "product") return "Product";
  if (q.kind === "proof-owed" && q.role) return q.role;
  return CODED_OWNERS[q.kind];
}
/**
 * The role that receives the action. The Coordinator is told, never asked to
 * act, so a Coordinator-owned class (a release input blocked by usage, a pause
 * or a sign-in) acts through Platform. This is never "Coordinator".
 */
export function actionRole(q: OwnerQuestion): Exclude<OwnerRole, "Coordinator"> {
  const owner = ownerRole(q);
  return owner === "Coordinator" ? "Platform" : owner;
}

// ------------------------------------------------- steps only Vincent can do
export const HUMAN_ONLY_STEPS = {
  "sign-in": "a sign-in only Vincent can complete (password, passkey or MFA)",
  "switch-decision": "his decision on a named operator-only switch",
  "operator-session": "starting an operator session",
} as const;
export type HumanStep = keyof typeof HUMAN_ONLY_STEPS;
export const isHumanOnlyStep = (step: string): step is HumanStep => Object.hasOwn(HUMAN_ONLY_STEPS, step);
/** A release input that waits on his sign-in is an ask for him, not work for a role. */
export const releaseInputHumanStep = (input: string, reason = ""): HumanStep | null =>
  /AWS sign-in|password|MFA|passkey/i.test(`${input} ${reason}`) ? "sign-in" : null;

// ------------------------------------------------ messages to Vincent: ids
// The mail gate tiers a message by its id prefix alone, so a writer must build
// the id here: it cannot invent one the gate does not know, or claim a tier.
export const HARD_STOP_KINDS = {
  "factory-down": "the factory cannot start or supervise work",
  disk: "disk hard stop",
  spend: "spend or wallet stop",
  "human-step": "a step only Vincent can do is already broken, or still blocks tonight's release at 16:45",
} as const;
export type HardStopKind = keyof typeof HARD_STOP_KINDS;
/** Subjects several writers share. Use these exact names, so one condition is one message whoever raises it. */
export const SHARED_SUBJECTS = {
  tickDead: "tick-dead",
  configInvalid: "config-invalid",
  noHeartbeat: "no-heartbeat",
  dataVolume: "data-volume",
  awsWallet: "aws-wallet",
  awsSignIn: "aws-sign-in",
} as const;
/** Noon-line order. */
export const ASK_KINDS = ["release-step", "dated-step", "operator-queue", "decision"] as const;
export type AskKind = (typeof ASK_KINDS)[number];
/** Routine order: what is kept when the day's count runs out. */
export const ROUTINE_KINDS = ["fix-failed", "release-at-risk", "idle", "other"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];
export type OwnerMessage =
  | { tier: "hard-stop"; kind: HardStopKind; subject: string; day: string }
  | { tier: "night-result"; day: string }
  | { tier: "ask"; kind: AskKind; subject: string; day: string }
  | { tier: "routine"; kind: RoutineKind; subject: string; day: string }
  | { tier: "cleared"; kind: RoutineKind; subject: string; day: string };
export type OwnerMessageTier = OwnerMessage["tier"];
/**
 * Every id prefix the mail gate must know, with its tier. The 22:00 result
 * keeps the id its writer already uses, so it holds its fixed slot unchanged.
 */
export const OWNER_MESSAGE_PREFIXES: Record<OwnerMessageTier, string> = {
  "hard-stop": "loop:hard-stop:",
  "night-result": "release-window-result:",
  ask: "loop:ask:",
  routine: "loop:routine:",
  cleared: "loop:cleared:",
};
const KINDS_BY_TIER: Record<Exclude<OwnerMessageTier, "night-result">, readonly string[]> = {
  "hard-stop": Object.keys(HARD_STOP_KINDS),
  ask: ASK_KINDS,
  routine: ROUTINE_KINDS,
  cleared: ROUTINE_KINDS,
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SUBJECT = /^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/;
/** Builds the id. Two writers raising the same condition on one day get the same id, so one message. */
export function ownerMessageId(m: OwnerMessage): string {
  if (!DAY.test(m.day)) throw Error("owner message needs a YYYY-MM-DD day");
  if (m.tier === "night-result") return OWNER_MESSAGE_PREFIXES[m.tier] + m.day;
  if (!KINDS_BY_TIER[m.tier]?.includes(m.kind)) throw Error(`unknown ${m.tier} kind: ${String(m.kind)}`);
  if (!SUBJECT.test(m.subject)) throw Error("owner message subject must be a short lower-case name");
  return `${OWNER_MESSAGE_PREFIXES[m.tier]}${m.kind}:${m.subject}:${m.day}`;
}
/** Reads an id back. Null means the gate does not know it (it is then routine and counted as unknown). */
export function parseOwnerMessageId(id: string): (OwnerMessage & { conditionKey: string }) | null {
  const night = OWNER_MESSAGE_PREFIXES["night-result"];
  if (id.startsWith(night)) return DAY.test(id.slice(night.length)) ? { tier: "night-result", day: id.slice(night.length), conditionKey: "night-result" } : null;
  for (const tier of ["hard-stop", "ask", "routine", "cleared"] as const) {
    if (!id.startsWith(OWNER_MESSAGE_PREFIXES[tier])) continue;
    const [kind, subject, day, ...rest] = id.slice(OWNER_MESSAGE_PREFIXES[tier].length).split(":");
    if (rest.length || !kind || !subject || !day || !KINDS_BY_TIER[tier].includes(kind) || !SUBJECT.test(subject) || !DAY.test(day)) return null;
    return { tier, kind, subject, day, conditionKey: `${kind}:${subject}` } as OwnerMessage & { conditionKey: string };
  }
  return null;
}
/** One action mail per role, class and episode (a day, or a longer episode's own key). */
export function roleActionId(role: OwnerRole, forClass: string, episode: string): string {
  if (!OWNER_ROLES.includes(role) || !CLASS_ID.test(forClass) || !SUBJECT.test(episode)) throw Error("role action needs a known role, a class id and an episode");
  return `loop:action:${role.toLowerCase()}:${forClass}:${episode}`;
}

// ---------------------------------------------------------------- proof
// How many real successes close a class. Chosen here before the work starts;
// a fixer may raise the number, never lower it.
export const PROOFS = {
  publication: { successes: 20, inARow: false, what: "successful publications in the same repository" },
  "scheduled-job": { successes: 3, inARow: true, what: "on-schedule successes of the same scheduled job" },
  "release-input": { successes: 3, inARow: true, what: "present at the next morning check, present at the rehearsal, then passed by the real preflight" },
  alarm: { successes: 2, inARow: false, what: "one drill replay and one real delivery" },
} as const;
export type ProofSubject = keyof typeof PROOFS;
export type Proof = { subject: ProofSubject; successes: number; inARow: boolean; what: string };
/** Which proofs a kind may use. An empty list means the class ends when its condition ends, not by proof. */
export const PROOF_SUBJECTS: Record<ClassKind, readonly ProofSubject[]> = {
  failure: ["publication", "scheduled-job", "alarm"],
  "evidence-gap": ["scheduled-job"],
  "release-input": ["release-input"],
  "safeguard-not-proven": ["alarm"],
  instrumentation: ["scheduled-job"],
  limit: [],
  "limit-review": [],
  "proof-owed": [],
  "operator-overdue": [],
};
export function proofFor(kind: ClassKind, subject?: ProofSubject, raisedTo = 0): Proof | null {
  const allowed = PROOF_SUBJECTS[kind];
  if (!allowed.length) return null;
  const chosen = subject ?? (allowed.length === 1 ? allowed[0] : undefined);
  if (!chosen || !allowed.includes(chosen)) throw Error(`a ${kind} class must name one of: ${allowed.join(", ")}`);
  const proof = PROOFS[chosen];
  return { subject: chosen, ...proof, successes: Math.max(proof.successes, Number.isSafeInteger(raisedTo) ? raisedTo : 0) };
}

// --------------------------------------------------------------- limits
// Names a limit so it can be counted, and says how long it normally lasts. A
// limit still active past that opens one "limit-review" question for its
// owner. No threshold lives here and nothing here lifts or shortens a limit.
type Expected = { for: number } | { until: "usage-reset" | "freeze-end" | "wallet-month-end"; plus: number };
export const LIMIT_KINDS = {
  paused: { what: "paused with ready work and nothing running", expected: { for: 30 * MINUTE } },
  "usage-stop": { what: "usage stop", expected: { until: "usage-reset", plus: 30 * MINUTE } },
  "disk-refused": { what: "disk admission refused", expected: { for: 2 * HOUR } },
  "install-freeze": { what: "install freeze", expected: { until: "freeze-end", plus: 0 } },
  // The plan gives no duration for the next three; these are starting values.
  "worker-unqualified": { what: "worker unqualified", expected: { for: 2 * HOUR } },
  "usage-window-missing": { what: "usage window missing", expected: { for: 30 * MINUTE } },
  "wallet-stop": { what: "wallet stop", expected: { until: "wallet-month-end", plus: 0 } },
} as const satisfies Record<string, { what: string; expected: Expected }>;
export type LimitKind = keyof typeof LIMIT_KINDS;
/**
 * When a limit that began at `since` is due its review. A limit that lasts
 * "until" something needs that time (`until`); without it this throws, so an
 * unknown end is seen as an error and never read as "not due".
 */
export function limitReviewAt(limit: LimitKind, since: number, until?: number): number {
  const expected: Expected = LIMIT_KINDS[limit].expected;
  if ("for" in expected) return since + expected.for;
  if (until === undefined || !Number.isFinite(until)) throw Error(`${limit} needs its ${expected.until} time`);
  return until + expected.plus;
}

// ------------------------------------------------- fix lines and regressions
export const REGRESSION_CHECK = "prove-regression";
export const REGRESSION_FOLDER = "regressions";
const known = (forClass: string) => {
  if (!CLASS_ID.test(forClass)) throw Error("a class id is required");
  return forClass;
};
/** The line a fixing pull request carries, alone on its own line. */
export const fixesFailureLine = (forClass: string) => `fixes-failure: ${known(forClass)}`;
/** Every class a pull-request body says it fixes. */
export const fixesFailureClasses = (text: string) =>
  [...new Set([...text.matchAll(/^fixes-failure: (\S+)[ \t]*$/gm)].map((m) => m[1]!).filter((id) => CLASS_ID.test(id)))];
export const regressionFolder = (forClass: string) => `${REGRESSION_FOLDER}/${known(forClass)}`;

// ---------------------------------------------------------- ledger inbox
// Any job may drop one JSON file per record into the inbox folder (write a
// temporary name, then rename). The ledger job is the only reader. The inbox
// can only add: nothing dropped here can merge, split, defer or dismiss.
export const INBOX_RECORD_TYPES = [
  "declare",
  "issue-link",
  "fix-link",
  "release-input",
  "drill-result",
  "proof-owed",
  "proof-attached",
  "human-step-request",
] as const;
export type InboxRecordType = (typeof INBOX_RECORD_TYPES)[number];
/** Transitions that reduce. They need a named actor through the ledger's own command, never the inbox. */
export const REDUCING_TRANSITIONS = ["merge", "split", "defer", "accept-risk", "dismiss"] as const;
const base = {
  version: z.literal(1),
  /** Stable per fact: dropping the same record twice changes nothing. */
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  at: z.number().int().positive(),
  /** The writer, for example "release-morning". */
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
};
const text = (max: number) => z.string().trim().min(1).max(max);
const role = z.enum(OWNER_ROLES);
export const InboxRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("declare"), kind: z.enum(CLASS_KINDS), signature: text(500), summary: text(300), evidence: text(500).optional(), fixLivesIn: z.enum(FIX_HOMES).optional() }),
  z.strictObject({ ...base, type: z.literal("issue-link"), classId, repo: text(140), issue: z.number().int().positive() }),
  z.strictObject({ ...base, type: z.literal("fix-link"), classId, repo: text(140), pr: z.number().int().positive(), actor: text(120) }),
  z.strictObject({ ...base, type: z.literal("release-input"), classId, input: text(120), reason: text(800), day: z.string().regex(DAY) }),
  z.strictObject({ ...base, type: z.literal("drill-result"), drill: text(120), ok: z.boolean(), evidence: text(500), classId: classId.optional() }),
  z.strictObject({ ...base, type: z.literal("proof-owed"), proofId: classId, what: text(300), dueAt: z.number().int().positive(), role }),
  z.strictObject({ ...base, type: z.literal("proof-attached"), proofId: classId, evidence: text(500), actor: text(120) }),
  z.strictObject({ ...base, type: z.literal("human-step-request"), classId, step: z.enum(Object.keys(HUMAN_ONLY_STEPS) as [HumanStep, ...HumanStep[]]), what: text(300), dueAt: z.number().int().positive().optional() }),
]);
export type InboxRecord = z.infer<typeof InboxRecordSchema>;
export function parseInboxRecord(raw: unknown): { ok: true; record: InboxRecord } | { ok: false; reason: string } {
  const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
  if ((REDUCING_TRANSITIONS as readonly unknown[]).includes(type)) return { ok: false, reason: `the inbox can only add; "${String(type)}" needs a named actor through the ledger command` };
  const parsed = InboxRecordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `not an inbox record: ${parsed.error.issues[0]?.path.join(".") || "type"}` };
  const r = parsed.data;
  if (r.type === "release-input" && r.classId !== releaseInputClassId(r.input)) return { ok: false, reason: "a release-input record must carry the contract's class id for its input" };
  return { ok: true, record: r };
}
/** The file name for a record: the same fact always lands on the same name. */
export const inboxFileName = (r: Pick<InboxRecord, "type" | "id">) => `${r.type}-${createHash("sha256").update(r.id).digest("hex").slice(0, 20)}.json`;

// --------------------------------------------------------- ledger export
// The tick, the health job and the morning check never open the ledger. The
// ledger job, and only it, writes this small file (temporary name, then
// rename) at the end of every run; everyone else reads it.
export const LEDGER_EXPORT_MAX_AGE_MS = 30 * MINUTE;
export const LedgerExportSchema = z.strictObject({
  version: z.literal(1),
  at: z.number().int().positive(),
  /** Scheduled nights missed since the last shipped night; null until its one producer has run. */
  nightsMissed: z.number().int().nonnegative().nullable(),
  classes: z.array(
    z.strictObject({
      id: classId,
      kind: z.enum(CLASS_KINDS),
      state: z.enum(CLASS_STATES),
      ownerRole: role,
      shadow: z.boolean(),
      needsOperatorSince: z.number().int().positive().nullable(),
      lastSeenAt: z.number().int().positive(),
    }),
  ),
});
export type LedgerExport = z.infer<typeof LedgerExportSchema>;
/**
 * A reader's one check. A missing, unreadable, future-dated or stale export is
 * "unknown": the reader keeps what it already holds and clears nothing from it.
 */
export function usableLedgerExport(raw: unknown, now: number): LedgerExport | null {
  const parsed = LedgerExportSchema.safeParse(raw);
  return parsed.success && parsed.data.at <= now && now - parsed.data.at <= LEDGER_EXPORT_MAX_AGE_MS ? parsed.data : null;
}
