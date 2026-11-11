// The failure ledger: one list of named problem classes. This file holds the
// whole schema, every transition and the loader for rule and after-ingest
// files, so later packages add files beside it and never edit it.
//
// It records only. Nothing here sends mail, opens an issue, holds work or
// touches a limit. One program writes the ledger: the ledger job
// (scripts/ledger-ingest.ts). Everyone else reads the export file it writes.
// docs/ledger.md is the plain-language copy.
import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NORMALISER, classIdFor, sampleOf, signatureOf, type Normaliser } from "./fingerprint";
import {
  CLASS_ID,
  CLASS_KINDS,
  COUNTED_ONLY_KINDS,
  FIX_HOMES,
  LedgerExportSchema,
  OWNER_ROLES,
  PROOF_SUBJECTS,
  REDUCING_TRANSITIONS,
  isHumanOnlyStep,
  ownerRole,
  proofFor,
  type ClassKind,
  type ClassState,
  type FixHome,
  type InboxRecord,
  type LedgerExport,
  type OwnerRole,
  type ProofSubject,
} from "./loop-contract";
import { LOOP_SWITCH_NAMES, loopActing, type LoopFlags, type LoopSwitch } from "./loop-flags";

const DAY_MS = 86_400_000;
export const EXCERPT_BYTES = 4096;
export const EXCERPTS_PER_CLASS = 20;
/** Nothing stays parked longer than this without being parked again by name. A starting value. */
export const MAX_PARK_MS = 30 * DAY_MS;
/** Where the operator command drops its signed requests. Only the ledger job reads them. */
export const LEDGER_COMMANDS_DIR = "health/ledger-commands";
/** A rule or step file whose import has not returned after this long is reported and left out of the run. */
export const LOAD_LIMIT_MS = 10_000;
/**
 * Repository paths that go on protected_paths before the ledger job is ever
 * loaded. The two folders are imported into an unsandboxed job, so no
 * automatic-lane change may add a file there.
 */
export const LEDGER_PROTECTED_PATHS = [
  "launcher/ledger.ts",
  "launcher/fingerprint.ts",
  "scripts/ledger-ingest.ts",
  "launcher/rules",
  "launcher/ledger-steps",
  "scripts/ledger.ts",
  "scripts/install-ledger.ts",
] as const;

// ------------------------------------------------------------ what is stored
export type ClassRow = {
  id: string;
  kind: ClassKind;
  state: ClassState;
  summary: string;
  ownerRole: OwnerRole;
  fixLivesIn: FixHome;
  /** The loop switch that decides whether this class is record-only; null means no switch governs it. */
  switch: LoopSwitch | null;
  shadow: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  needsOperatorSince: number | null;
  dueAt: number | null;
  parkedUntil: number | null;
  parkedReason: string | null;
  humanStep: string | null;
  mergedInto: string | null;
};

/** One thing a source or a rule saw. Recording the same `source` and `ref` twice changes nothing. */
export type Finding = {
  kind: ClassKind;
  /** The text the signature is made from, usually the error message. */
  text: string;
  /** One plain line for people. Defaults to the text. */
  summary?: string;
  at: number;
  source: string;
  ref: string;
  /**
   * Names the class outright (a release input, a declared proof, a rule's own error). The finding is filed
   * under this id whatever its text says, so two names that differ only by a number or a date stay two classes.
   */
  classId?: string;
  fixLivesIn?: FixHome;
  /** For a release input: lets the contract decide the owner. */
  releaseInput?: { input: string; reason: string };
  /** For a proof still owed: the role the record names. */
  proofRole?: OwnerRole;
  switch?: LoopSwitch | null;
  dueAt?: number;
  evidence?: { ref: string; excerpt?: string };
};
const when = z.number().int().positive();
/** Checked before anything is stored: one unusable finding is refused by itself and can never spoil the export. */
const FindingSchema = z.object({
  kind: z.enum(CLASS_KINDS),
  text: z.string(),
  summary: z.string().optional(),
  at: when,
  source: z.string().min(1),
  ref: z.string().min(1),
  classId: z.string().regex(CLASS_ID).optional(),
  fixLivesIn: z.enum(FIX_HOMES).optional(),
  releaseInput: z.object({ input: z.string(), reason: z.string() }).optional(),
  proofRole: z.enum(OWNER_ROLES).optional(),
  switch: z.enum(LOOP_SWITCH_NAMES).nullish(),
  dueAt: when.optional(),
  evidence: z.object({ ref: z.string(), excerpt: z.string().optional() }).optional(),
});
/** Signatures given by class id are made by no normaliser: they sit under this version and are never re-mapped. */
const NAMED = -1;
const ended = (state: ClassState) => state === "closed-with-proof" || state === "resolved-no-fix";
export type Recorded = { classId: string; created: boolean; duplicate: boolean; reopened: boolean; fallback: boolean };

// The transitions that add. Any rule, step or inbox record may cause these.
type Move = { from: readonly ClassState[]; to: ClassState };
export const ADDING_MOVES = {
  ticket: { from: ["open", "recurred"], to: "ticketed" },
  "fix-installed": { from: ["open", "ticketed", "recurred"], to: "fix-installed" },
  verify: { from: ["fix-installed"], to: "verifying" },
  "close-with-proof": { from: ["verifying"], to: "closed-with-proof" },
  recur: { from: ["fix-installed", "verifying", "closed-with-proof", "resolved-no-fix"], to: "recurred" },
  reopen: { from: ["resolved-no-fix"], to: "open" },
  "resolve-no-fix": { from: ["open", "ticketed", "recurred", "waiting-on-human"], to: "resolved-no-fix" },
  "wait-on-human": { from: ["open", "ticketed", "recurred"], to: "waiting-on-human" },
  "park-expired": { from: ["deferred", "waiting-on-human"], to: "open" },
} as const satisfies Record<string, Move>;
export type AddingAction = keyof typeof ADDING_MOVES;
/** A limit is counted. It is never ticketed, fixed, verified or said to have recurred. */
const NOT_FOR_LIMITS: readonly AddingAction[] = ["ticket", "fix-installed", "verify", "close-with-proof", "recur", "wait-on-human"];
export type AdvanceDetail = {
  now: number;
  reason: string;
  proof?: { subject?: ProofSubject; successes: number; evidence: string };
  human?: { step: string; until: number; dueAt?: number };
};

// The transitions that reduce. Only a signed request from the operator
// command (scripts/ledger.ts) can cause these; the inbox cannot.
const classId = z.string().regex(CLASS_ID);
export const OperatorCommandSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  at: z.number().int().positive(),
  actor: z.string().trim().min(2).max(120),
  action: z.enum(REDUCING_TRANSITIONS),
  classId,
  reason: z.string().trim().min(3).max(500),
  /** defer, accept-risk: when the parking ends. */
  until: z.number().int().positive().optional(),
  /** merge: the other class. */
  other: classId.optional(),
  /** split: the signatures that become their own class, and that part's summary. */
  signatures: z.array(z.string().min(1).max(400)).min(1).max(50).optional(),
  summary: z.string().trim().min(1).max(300).optional(),
});
export type OperatorCommand = z.infer<typeof OperatorCommandSchema>;
export type SignedCommand = { command: OperatorCommand; mac: string };
const macOf = (c: OperatorCommand, token: string) =>
  createHmac("sha256", token)
    .update(JSON.stringify([c.version, c.id, c.at, c.actor, c.action, c.classId, c.reason, c.until ?? null, c.other ?? null, c.signatures ?? null, c.summary ?? null]))
    .digest("hex");
/** Signs a request with the local owner token, which workers and owner wakes are never given. */
export function signCommand(raw: OperatorCommand, token: string): SignedCommand {
  if (token.length < 16) throw Error("owner token required");
  const parsed = OperatorCommandSchema.safeParse(raw);
  if (!parsed.success) throw Error(`refused: an operator command needs a valid ${parsed.error.issues[0]?.path.join(".") || "shape"}; a named actor and a reason are always required`);
  return { command: parsed.data, mac: macOf(parsed.data, token) };
}
const verified = new WeakSet<OperatorCommand>();
/** The only way to get a command the ledger will act on. Without the owner token everything is refused. */
export function verifyCommand(raw: unknown, token: string | null): { ok: true; command: OperatorCommand } | { ok: false; reason: string } {
  if (!token || token.length < 16) return { ok: false, reason: "owner token unavailable; every operator command is refused" };
  const parsed = z.strictObject({ command: OperatorCommandSchema, mac: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `not an operator command: ${parsed.error.issues[0]?.path.join(".") || "shape"}` };
  if (!timingSafeEqual(Buffer.from(parsed.data.mac), Buffer.from(macOf(parsed.data.command, token)))) return { ok: false, reason: "signature does not match the owner token" };
  verified.add(parsed.data.command);
  return { ok: true, command: parsed.data.command };
}

// ------------------------------------------------- rule and step files
export type SourceName = "controller" | "controller-alerts" | "idle-queue" | "health-state";
export type SourceEvent = { seq: number; id: string; kind: string; at: number; /** At most the first 4 KB. */ data: string };
export type TickLine = { offset: number; at: number; status: string; error?: string; raw: string };
export type SourceIncident = { source: "controller-alerts" | "idle-queue"; seq: number; id: string; at: number; summary: string | null; detail: string | null };
export type RuleInput = {
  now: number;
  /** New controller events this run, of the kinds the rule asked for. */
  events: readonly SourceEvent[];
  tickLines: readonly TickLine[];
  incidents: readonly SourceIncident[];
  classes: readonly ClassRow[];
  flags: LoopFlags;
  /** One bounded, read-only statement against a source database. Nothing stays open afterwards. */
  query<T>(source: SourceName, sql: string, params?: (string | number | null)[]): T[];
};
export type RuleOutput = Finding[] | { findings: Finding[]; nightsMissed?: number };
/** A file in launcher/rules/ default-exports one of these. It returns findings; it never writes anything. */
export type LedgerRule = {
  id: string;
  /** Classes this rule opens are record-only until this loop switch is acting. */
  switch?: LoopSwitch;
  eventKinds?: readonly string[];
  run(input: RuleInput): RuleOutput | Promise<RuleOutput>;
};
/** What a step may do to the ledger: read it and add to it. Reducing is not on this list. */
export type LedgerAdditions = Pick<Ledger, "classes" | "classOf" | "linksOf" | "record" | "advance" | "link" | "addEvidence" | "needsOperator" | "meta" | "setMeta">;
export type StepContext = { now: number; dir: string; ledger: LedgerAdditions; flags: LoopFlags; countsOnly: boolean };
export type StepOutput = void | { nightsMissed?: number };
/** A file in launcher/ledger-steps/ default-exports one of these. It runs inside the ledger job after ingest. */
export type LedgerStep = { id: string; run(context: StepContext): StepOutput | Promise<StepOutput> };

export const RULES_DIR = join(import.meta.dir, "rules");
export const STEPS_DIR = join(import.meta.dir, "ledger-steps");
const MODULE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Loads every .ts file in a folder, in name order. A file that fails to load is reported, never fatal. */
export async function loadFolder<T extends { id: string; run: unknown }>(dir: string, limitMs = LOAD_LIMIT_MS): Promise<{ loaded: T[]; errors: { id: string; error: string }[] }> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => /^[a-z0-9][a-z0-9-]*\.ts$/.test(name)).sort();
  } catch {
    return { loaded: [], errors: [] };
  }
  const loaded: T[] = [], errors: { id: string; error: string }[] = [];
  for (const file of files) {
    const id = file.slice(0, -3).slice(0, 41);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // An import that never returns (a top-level await on something that never happens) must not hold the run.
      const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Error(`its import had not returned after ${limitMs} ms`)), limitMs)));
      const found = (await Promise.race([import(join(dir, file)), late])).default as T | undefined;
      if (!found || typeof found.id !== "string" || !MODULE_ID.test(found.id) || typeof found.run !== "function") throw Error("default export must be { id, run }");
      if (loaded.some((other) => other.id === found.id)) throw Error(`duplicate id "${found.id}"`);
      loaded.push(found);
    } catch (error) {
      errors.push({ id, error: `${file} did not load: ${String(error)}` });
    } finally {
      clearTimeout(timer);
    }
  }
  return { loaded, errors };
}

// ------------------------------------------------------------------ helpers
/** At most `bytes` bytes of UTF-8, never cut inside a character. */
export function clip(text: string, bytes = EXCERPT_BYTES): string {
  let out = text.slice(0, bytes);
  while (Buffer.byteLength(out) > bytes) out = out.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(out) - bytes) / 4)));
  return out;
}
/** The one place a class gets its owner: the contract's function, never a caller's argument. */
function ownerFor(f: Finding): OwnerRole {
  if (f.kind === "release-input") return ownerRole({ kind: "release-input", input: f.releaseInput?.input ?? f.text, reason: f.releaseInput?.reason });
  if (f.kind === "failure") return ownerRole({ kind: "failure", fixLivesIn: f.fixLivesIn });
  if (f.kind === "proof-owed") return ownerRole({ kind: "proof-owed", role: f.proofRole });
  return ownerRole({ kind: f.kind });
}
type RawClass = { id: string; kind: ClassKind; state: ClassState; summary: string; owner_role: OwnerRole; fix_lives_in: FixHome; switch: LoopSwitch | null; shadow: number; first_seen_at: number; last_seen_at: number; occurrences: number; needs_operator_since: number | null; due_at: number | null; parked_until: number | null; parked_reason: string | null; human_step: string | null; merged_into: string | null };
const toClass = (r: RawClass): ClassRow => ({ id: r.id, kind: r.kind, state: r.state, summary: r.summary, ownerRole: r.owner_role, fixLivesIn: r.fix_lives_in, switch: r.switch, shadow: !!r.shadow, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, occurrences: r.occurrences, needsOperatorSince: r.needs_operator_since, dueAt: r.due_at, parkedUntil: r.parked_until, parkedReason: r.parked_reason, humanStep: r.human_step, mergedInto: r.merged_into });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS classes(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,owner_role TEXT NOT NULL,fix_lives_in TEXT NOT NULL,switch TEXT,shadow INTEGER NOT NULL,first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,occurrences INTEGER NOT NULL DEFAULT 0,needs_operator_since INTEGER,due_at INTEGER,parked_until INTEGER,parked_reason TEXT,human_step TEXT,merged_into TEXT REFERENCES classes(id));
  CREATE TABLE IF NOT EXISTS signatures(normaliser_version INTEGER NOT NULL,signature TEXT NOT NULL,class_id TEXT NOT NULL REFERENCES classes(id),sample TEXT NOT NULL,first_seen_at INTEGER NOT NULL,PRIMARY KEY(normaliser_version,signature));
  CREATE TABLE IF NOT EXISTS occurrences(id INTEGER PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classes(id),normaliser_version INTEGER NOT NULL,signature TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,at INTEGER NOT NULL,ingested_at INTEGER NOT NULL,UNIQUE(source,source_ref));
  CREATE INDEX IF NOT EXISTS occurrences_by_class ON occurrences(class_id,at);
  CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classes(id),at INTEGER NOT NULL,ref TEXT NOT NULL,excerpt TEXT);
  CREATE TABLE IF NOT EXISTS links(class_id TEXT NOT NULL REFERENCES classes(id),type TEXT NOT NULL,ref TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT,PRIMARY KEY(class_id,type,ref));
  CREATE TABLE IF NOT EXISTS transitions(id INTEGER PRIMARY KEY,class_id TEXT NOT NULL,at INTEGER NOT NULL,action TEXT NOT NULL,from_state TEXT,to_state TEXT,actor TEXT,reason TEXT);
  CREATE TRIGGER IF NOT EXISTS no_transition_update BEFORE UPDATE ON transitions BEGIN SELECT RAISE(ABORT,'transition history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS no_transition_delete BEFORE DELETE ON transitions BEGIN SELECT RAISE(ABORT,'transition history is append-only'); END;
  CREATE TABLE IF NOT EXISTS received(id TEXT PRIMARY KEY,channel TEXT NOT NULL,type TEXT,at INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT);
  CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,behind_ms INTEGER NOT NULL,stopped_at_limit INTEGER NOT NULL,rule_errors INTEGER NOT NULL,stats TEXT NOT NULL);
`;
export type LinkType = "issue" | "fix" | "regression" | "lesson";
export type Transition = { classId: string; at: number; action: string; from: ClassState | null; to: ClassState | null; actor: string | null; reason: string | null };

// ------------------------------------------------------------------ ledger
export class Ledger {
  readonly db: Database;
  /** Set by the job when disk admission is refused: occurrences are still counted, no evidence is stored. */
  countsOnly = false;
  fallbacks = 0;
  private normaliser: Normaliser;

  constructor(path: string, options: { readonly?: boolean; normaliser?: Normaliser } = {}) {
    this.normaliser = options.normaliser ?? NORMALISER;
    if (!(this.normaliser.version >= 0)) throw Error("a normaliser version is never negative");
    if (options.readonly) {
      this.db = new Database(path, { readonly: true, strict: true });
      this.db.exec("PRAGMA busy_timeout=1000");
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${SCHEMA}`);
    if (this.meta<number>("normaliser-version") === null) this.setMeta("normaliser-version", this.normaliser.version);
  }
  close() {
    this.db.close();
  }
  atomic<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
  meta<T>(key: string): T | null {
    const row = this.db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  setMeta(key: string, value: unknown) {
    this.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  // ------------------------------------------------------------- reading
  classes(): ClassRow[] {
    return (this.db.query("SELECT * FROM classes ORDER BY first_seen_at,id").all() as RawClass[]).map(toClass);
  }
  classOf(id: string): ClassRow | null {
    const row = this.db.query("SELECT * FROM classes WHERE id=?").get(id) as RawClass | null;
    return row ? toClass(row) : null;
  }
  linksOf(id: string) {
    return this.db.query("SELECT type,ref,at,actor FROM links WHERE class_id=? ORDER BY at,ref").all(id) as { type: LinkType; ref: string; at: number; actor: string | null }[];
  }
  signaturesOf(id: string) {
    return this.db.query("SELECT normaliser_version AS version,signature,sample FROM signatures WHERE class_id=? ORDER BY first_seen_at,signature").all(id) as { version: number; signature: string; sample: string }[];
  }
  evidenceOf(id: string) {
    return this.db.query("SELECT at,ref,excerpt FROM evidence WHERE class_id=? ORDER BY id").all(id) as { at: number; ref: string; excerpt: string | null }[];
  }
  transitions(reducingOnly = false): Transition[] {
    const rows = this.db.query("SELECT class_id AS classId,at,action,from_state AS 'from',to_state AS 'to',actor,reason FROM transitions ORDER BY id").all() as Transition[];
    return reducingOnly ? rows.filter((row) => (REDUCING_TRANSITIONS as readonly string[]).includes(row.action)) : rows;
  }
  /** Follows merges to the class that still stands. */
  private standing(id: string): RawClass {
    for (let hops = 0, at = id; hops < 20; hops++) {
      const row = this.db.query("SELECT * FROM classes WHERE id=?").get(at) as RawClass | null;
      if (!row) break;
      if (!row.merged_into) return row;
      at = row.merged_into;
    }
    throw Error(`no such class: ${id}`);
  }
  private note(id: string, at: number, action: string, from: ClassState | null, to: ClassState | null, reason: string | null, actor: string | null = null) {
    this.db.query("INSERT INTO transitions(class_id,at,action,from_state,to_state,actor,reason) VALUES(?,?,?,?,?,?,?)").run(id, at, action, from, to, actor, reason);
  }

  // -------------------------------------------------------------- adding
  /** Records one occurrence. A new signature opens a class with a stable id; a known one counts against its class. */
  record(f: Finding, now: number): Recorded {
    return this.atomic(() => {
      const usable = FindingSchema.safeParse(f);
      if (!usable.success) throw Error(`refused: not a usable finding (${usable.error.issues[0]?.path.join(".") || "shape"})`);
      const seen = this.db.query("SELECT class_id FROM occurrences WHERE source=? AND source_ref=?").get(f.source, f.ref) as { class_id: string } | null;
      if (seen) return { classId: seen.class_id, created: false, duplicate: true, reopened: false, fallback: false };
      const named = f.classId ? this.classOf(f.classId) : null;
      if (named && named.kind !== f.kind) throw Error(`refused: ${f.classId} already names a ${named.kind} class`);
      const sig = f.classId ? { signature: `id:${f.classId}`, version: NAMED, fallback: false } : signatureOf(f.text, this.normaliser);
      if (sig.fallback) this.fallbacks++;
      const mapped = this.db.query("SELECT class_id FROM signatures WHERE normaliser_version=? AND signature=?").get(sig.version, sig.signature) as { class_id: string } | null;
      let id = mapped?.class_id,
        created = false;
      if (!id) {
        id = f.classId ?? this.unusedId(classIdFor(sig.signature));
        if (!named) {
          const governed = f.switch ?? null;
          this.db
            .query("INSERT INTO classes(id,kind,state,summary,owner_role,fix_lives_in,switch,shadow,first_seen_at,last_seen_at,due_at) VALUES(?,?,'open',?,?,?,?,?,?,?,?)")
            .run(id, f.kind, clip((f.summary ?? f.text).replace(/\s+/g, " ").trim(), 300), ownerFor(f), f.fixLivesIn ?? "launcher", governed, governed ? 1 : 0, f.at, f.at, f.dueAt ?? null);
          this.note(id, now, "open", null, "open", `first seen from ${f.source}`);
          created = true;
        }
        id = this.standing(id).id;
        this.db.query("INSERT INTO signatures VALUES(?,?,?,?,?)").run(sig.version, sig.signature, id, sampleOf(f.text), f.at);
      }
      const row = this.standing(id);
      this.db.query("INSERT INTO occurrences(class_id,normaliser_version,signature,source,source_ref,at,ingested_at) VALUES(?,?,?,?,?,?,?)").run(row.id, sig.version, sig.signature, f.source, f.ref, f.at, now);
      this.db.query("UPDATE classes SET occurrences=occurrences+1,first_seen_at=min(first_seen_at,?),last_seen_at=max(last_seen_at,?) WHERE id=?").run(f.at, f.at, row.id);
      // A class that had ended and is seen again is open again. Nobody has to notice.
      let reopened = false;
      if (!created && ended(row.state)) {
        const again = PROOF_SUBJECTS[row.kind].length ? "recur" : "reopen";
        this.advance(row.id, again, { now, reason: `seen again from ${f.source}` });
        reopened = true;
      }
      if (f.evidence) this.addEvidence(row.id, f.at, f.evidence.ref, f.evidence.excerpt);
      return { classId: row.id, created, duplicate: false, reopened, fallback: sig.fallback };
    });
  }
  private unusedId(wanted: string): string {
    for (let n = 1, id = wanted; ; id = `${wanted.slice(0, 60)}-${++n}`) if (!this.classOf(id)) return id;
  }
  /** A reference plus an excerpt of at most 4 KB, 20 per class. Under a disk refusal nothing is stored. */
  addEvidence(id: string, at: number, ref: string, excerpt?: string) {
    if (this.countsOnly) return false;
    const row = this.standing(id);
    const held = (this.db.query("SELECT count(*) AS n FROM evidence WHERE class_id=?").get(row.id) as { n: number }).n;
    if (held >= EXCERPTS_PER_CLASS) return false;
    this.db.query("INSERT INTO evidence(class_id,at,ref,excerpt) VALUES(?,?,?,?)").run(row.id, at, clip(ref, 500), excerpt ? clip(excerpt) : null);
    return true;
  }
  /** Hangs an issue, a fix, a regression folder or a lesson row on the class id. */
  link(id: string, type: LinkType, ref: string, at: number, actor?: string) {
    return this.db.query("INSERT OR IGNORE INTO links VALUES(?,?,?,?,?)").run(this.standing(id).id, type, ref, at, actor ?? null).changes === 1;
  }
  needsOperator(id: string, since: number) {
    if (!Number.isSafeInteger(since) || since <= 0) throw Error("refused: needs-operator needs the time it began");
    this.db.query("UPDATE classes SET needs_operator_since=coalesce(needs_operator_since,?) WHERE id=?").run(since, this.standing(id).id);
  }
  /** One adding transition. It refuses a move the state does not allow, and anything that treats a limit as a defect. */
  advance(id: string, action: AddingAction, detail: AdvanceDetail): ClassRow {
    return this.atomic(() => {
      const row = this.standing(id),
        move: Move = ADDING_MOVES[action];
      if (!move) throw Error(`unknown transition: ${String(action)}`);
      if (COUNTED_ONLY_KINDS.includes(row.kind) && NOT_FOR_LIMITS.includes(action)) throw Error(`refused: ${row.id} is a ${row.kind}; a limit is counted, never ticketed, fixed or held`);
      if (!move.from.includes(row.state)) throw Error(`refused: ${row.id} is ${row.state}; "${action}" needs ${move.from.join(" or ")}`);
      if (!detail.reason.trim()) throw Error("a transition needs a reason");
      let parkedUntil: number | null = null,
        humanStep: string | null = null,
        dueAt = row.due_at;
      if (action === "close-with-proof") {
        const need = proofFor(row.kind, detail.proof?.subject);
        if (!need) throw Error(`refused: a ${row.kind} class ends when its condition ends, not by proof`);
        if (!detail.proof?.evidence.trim() || detail.proof.successes < need.successes) throw Error(`refused: closing ${row.id} needs ${need.successes} ${need.what}`);
      }
      if (action === "wait-on-human") {
        if (!detail.human || !isHumanOnlyStep(detail.human.step)) throw Error("refused: only a step on the coded list can wait on a person");
        if (!(detail.human.until > detail.now) || detail.human.until - detail.now > MAX_PARK_MS) throw Error("refused: a wait needs an expiry within 30 days");
        parkedUntil = detail.human.until;
        humanStep = detail.human.step;
        dueAt = detail.human.dueAt ?? dueAt;
      }
      this.db
        .query("UPDATE classes SET state=?,parked_until=?,parked_reason=?,human_step=?,due_at=?,needs_operator_since=CASE WHEN ? THEN NULL ELSE needs_operator_since END WHERE id=?")
        .run(move.to, parkedUntil, parkedUntil ? detail.reason : null, humanStep, dueAt, ended(move.to) ? 1 : 0, row.id);
      this.note(row.id, detail.now, action, row.state, move.to, detail.proof ? `${detail.reason} (${detail.proof.successes} successes: ${detail.proof.evidence})` : detail.reason);
      return this.classOf(row.id)!;
    });
  }
  /** Anything parked comes back when its expiry passes. */
  expireParked(now: number): string[] {
    const due = this.db.query("SELECT id FROM classes WHERE state IN ('deferred','waiting-on-human') AND merged_into IS NULL AND (parked_until IS NULL OR parked_until<=?)").all(now) as { id: string }[];
    for (const { id } of due) this.advance(id, "park-expired", { now, reason: "parking expired" });
    return due.map((row) => row.id);
  }
  /** Record-only marks follow the loop switches: a class is shadow while the switch that governs it is not acting. */
  refreshShadow(flags: Pick<LoopFlags, "modes">) {
    for (const row of this.db.query("SELECT id,switch,shadow FROM classes WHERE switch IS NOT NULL").all() as { id: string; switch: LoopSwitch; shadow: number }[]) {
      const shadow = loopActing(flags, row.switch) ? 0 : 1;
      if (shadow !== row.shadow) this.db.query("UPDATE classes SET shadow=? WHERE id=?").run(shadow, row.id);
    }
  }
  /**
   * A retuned normaliser re-maps every stored sample to its new signature and
   * points it at the class it already had. No class id is created, changed or
   * removed. Where two classes now share a signature the older class keeps it
   * and the newer class gets a note; joining them stays an operator's merge.
   */
  remapSignatures(next: Normaliser, now: number): { remapped: number; conflicts: number } {
    return this.atomic(() => {
      if (!(next.version >= 0)) throw Error("a normaliser version is never negative");
      const from = this.meta<number>("normaliser-version") ?? this.normaliser.version;
      let remapped = 0,
        conflicts = 0;
      if (next.version !== from) {
        const rows = this.db.query("SELECT s.class_id,s.sample,s.first_seen_at FROM signatures s JOIN classes c ON c.id=s.class_id WHERE s.normaliser_version=? ORDER BY c.first_seen_at,c.id,s.first_seen_at,s.signature").all(from) as { class_id: string; sample: string; first_seen_at: number }[];
        for (const row of rows) {
          const sig = signatureOf(row.sample, next);
          const taken = this.db.query("SELECT class_id FROM signatures WHERE normaliser_version=? AND signature=?").get(sig.version, sig.signature) as { class_id: string } | null;
          if (!taken) this.db.query("INSERT INTO signatures VALUES(?,?,?,?,?)").run(sig.version, sig.signature, row.class_id, row.sample, row.first_seen_at);
          else if (taken.class_id !== row.class_id) {
            conflicts++;
            this.note(row.class_id, now, "remap-conflict", null, null, `under normaliser ${next.version} a signature of this class now belongs to ${taken.class_id}`);
          }
          remapped++;
        }
        this.setMeta("normaliser-version", next.version);
      }
      this.normaliser = next;
      return { remapped, conflicts };
    });
  }

  // ------------------------------------------------------------- inbox
  /** Applies one inbox record. Every type here adds; the contract's parser has already refused the rest. */
  applyInbox(r: InboxRecord, now: number): void {
    this.atomic(() => {
      const base = { at: r.at, source: "inbox", ref: r.id },
        evidenceRef = `inbox:${r.source}:${r.id}`;
      if (r.type === "declare") this.record({ ...base, kind: r.kind, text: r.signature, summary: r.summary, fixLivesIn: r.fixLivesIn, evidence: { ref: evidenceRef, excerpt: r.evidence } }, now);
      else if (r.type === "release-input") this.record({ ...base, kind: "release-input", text: `release input ${r.input}`, summary: r.reason, classId: r.classId, releaseInput: { input: r.input, reason: r.reason }, evidence: { ref: evidenceRef, excerpt: `${r.day}: ${r.reason}` } }, now);
      else if (r.type === "issue-link") {
        const row = this.standing(r.classId);
        if (COUNTED_ONLY_KINDS.includes(row.kind)) throw Error(`refused: ${row.id} is a ${row.kind}; a limit is never ticketed`);
        this.link(row.id, "issue", `${r.repo}#${r.issue}`, r.at, r.source);
        if ((ADDING_MOVES.ticket.from as readonly ClassState[]).includes(row.state)) this.advance(row.id, "ticket", { now, reason: `issue ${r.repo}#${r.issue}` });
      } else if (r.type === "fix-link") this.link(r.classId, "fix", `${r.repo}#${r.pr}`, r.at, r.actor);
      else if (r.type === "drill-result") {
        if (r.classId) this.addEvidence(r.classId, r.at, evidenceRef, `drill ${r.drill} ${r.ok ? "passed" : "failed"}: ${r.evidence}`);
        if (!r.ok) this.record({ ...base, kind: "safeguard-not-proven", text: `drill ${r.drill} failed`, summary: `Drill "${r.drill}" did not pass`, evidence: { ref: evidenceRef, excerpt: r.evidence } }, now);
      } else if (r.type === "proof-owed") this.record({ ...base, kind: "proof-owed", text: `proof owed ${r.proofId}`, summary: r.what, classId: r.proofId, proofRole: r.role, dueAt: r.dueAt }, now);
      else if (r.type === "proof-attached") {
        const row = this.standing(r.proofId);
        if (row.kind !== "proof-owed") throw Error(`refused: ${r.proofId} is not a proof still owed`);
        this.addEvidence(row.id, r.at, evidenceRef, r.evidence);
        this.advance(row.id, "resolve-no-fix", { now, reason: `proof attached by ${r.actor}` });
      } else this.advance(r.classId, "wait-on-human", { now, reason: r.what, human: { step: r.step, until: r.dueAt && r.dueAt > now ? Math.min(r.dueAt, now + MAX_PARK_MS) : now + DAY_MS, dueAt: r.dueAt } });
    });
  }
  /** Remembers a dropped record or command, so the same one is never applied twice and a refusal is on file. */
  received(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM received WHERE id=?").get(id);
  }
  receive(id: string, channel: "inbox" | "command", type: string | null, at: number, outcome: "applied" | "refused", reason?: string) {
    this.db.query("INSERT OR IGNORE INTO received VALUES(?,?,?,?,?,?)").run(id, channel, type, at, outcome, reason ?? null);
  }

  // ------------------------------------------------------------ reducing
  /** merge, split, defer, accept-risk, dismiss: only for a command verifyCommand accepted, and always on file with who and why. */
  reduce(c: OperatorCommand, now: number): string {
    if (!verified.has(c)) throw Error("refused: a reducing transition needs a signed operator command");
    return this.atomic(() => {
      const row = this.standing(c.classId);
      if (c.action === "merge") return this.merge(row, c, now);
      if (c.action === "split") return this.split(row, c, now);
      if (c.action === "dismiss") {
        if (ended(row.state)) throw Error(`${row.id} has already ended`);
        this.db.query("UPDATE classes SET state='resolved-no-fix',parked_until=NULL,parked_reason=NULL,human_step=NULL,needs_operator_since=NULL WHERE id=?").run(row.id);
        this.note(row.id, now, "dismiss", row.state, "resolved-no-fix", c.reason, c.actor);
        return `${row.id} dismissed`;
      }
      // defer and accept-risk both park the class, with an expiry.
      if (!c.until || c.until <= now || c.until - now > MAX_PARK_MS) throw Error("parking needs an expiry within 30 days");
      if (ended(row.state)) throw Error(`${row.id} has already ended`);
      this.db.query("UPDATE classes SET state='deferred',parked_until=?,parked_reason=?,human_step=NULL WHERE id=?").run(c.until, `${c.action}: ${c.reason}`, row.id);
      this.note(row.id, now, c.action, row.state, "deferred", c.reason, c.actor);
      return `${row.id} parked until ${new Date(c.until).toISOString()}`;
    });
  }
  /**
   * The older class keeps its id. The newer one stays on file, pointing at it. If the older had ended and the
   * newer had not, the class that stands is live again: a merge never makes a live problem read as ended.
   */
  private merge(a: RawClass, c: OperatorCommand, now: number): string {
    if (!c.other) throw Error("merge needs the other class");
    const b = this.standing(c.other);
    if (a.id === b.id) throw Error("merge needs two different classes");
    if (a.kind !== b.kind) throw Error(`refused: ${a.id} is a ${a.kind} and ${b.id} is a ${b.kind}`);
    const [keep, gone] = a.first_seen_at < b.first_seen_at || (a.first_seen_at === b.first_seen_at && a.id < b.id) ? [a, b] : [b, a];
    for (const table of ["signatures", "occurrences", "evidence"]) this.db.query(`UPDATE ${table} SET class_id=? WHERE class_id=?`).run(keep.id, gone.id);
    this.db.query("INSERT OR IGNORE INTO links SELECT ?,type,ref,at,actor FROM links WHERE class_id=?").run(keep.id, gone.id);
    this.db
      .query("UPDATE classes SET occurrences=occurrences+?1,last_seen_at=max(last_seen_at,?2),needs_operator_since=coalesce(min(needs_operator_since,?3),needs_operator_since,?3) WHERE id=?4")
      .run(gone.occurrences, gone.last_seen_at, gone.needs_operator_since, keep.id);
    this.db.query("UPDATE classes SET merged_into=?,state='resolved-no-fix',occurrences=0,parked_until=NULL,parked_reason=NULL,needs_operator_since=NULL WHERE id=?").run(keep.id, gone.id);
    this.note(gone.id, now, "merge", gone.state, "resolved-no-fix", `merged into ${keep.id}: ${c.reason}`, c.actor);
    this.note(keep.id, now, "merge", keep.state, keep.state, `took in ${gone.id}: ${c.reason}`, c.actor);
    if (ended(keep.state) && !ended(gone.state)) this.advance(keep.id, PROOF_SUBJECTS[keep.kind].length ? "recur" : "reopen", { now, reason: `took in ${gone.id}, which had not ended` });
    return `${gone.id} merged into ${keep.id}`;
  }
  /** The part with more occurrences keeps the id, with its links. The other part becomes a new class. */
  private split(row: RawClass, c: OperatorCommand, now: number): string {
    if (!c.signatures?.length || !c.summary) throw Error("split needs the signatures to move and a summary for them");
    // One row per signature text: after a retune the same text is on file under two normaliser versions, and its occurrences count once.
    const all = this.db.query("SELECT signature,(SELECT count(*) FROM occurrences o WHERE o.class_id=?1 AND o.signature=s.signature) AS n FROM signatures s WHERE class_id=?1 GROUP BY signature").all(row.id) as { signature: string; n: number }[];
    const named = all.filter((s) => c.signatures!.includes(s.signature)),
      rest = all.filter((s) => !c.signatures!.includes(s.signature));
    if (named.length !== new Set(c.signatures).size) throw Error("split names a signature this class does not have");
    if (!rest.length) throw Error("split must leave at least one signature behind");
    const count = (part: typeof all) => part.reduce((sum, s) => sum + s.n, 0);
    const namedKeepsId = count(named) > count(rest),
      moving = namedKeepsId ? rest : named;
    const created = this.unusedId(classIdFor(moving[0]!.signature));
    this.db
      .query("INSERT INTO classes(id,kind,state,summary,owner_role,fix_lives_in,switch,shadow,first_seen_at,last_seen_at,occurrences) SELECT ?,kind,'open',?,owner_role,fix_lives_in,switch,shadow,first_seen_at,last_seen_at,0 FROM classes WHERE id=?")
      .run(created, namedKeepsId ? row.summary : c.summary, row.id);
    if (namedKeepsId) this.db.query("UPDATE classes SET summary=? WHERE id=?").run(c.summary, row.id);
    for (const s of moving) {
      this.db.query("UPDATE signatures SET class_id=? WHERE class_id=? AND signature=?").run(created, row.id, s.signature);
      this.db.query("UPDATE occurrences SET class_id=? WHERE class_id=? AND signature=?").run(created, row.id, s.signature);
    }
    for (const id of [row.id, created])
      this.db.query("UPDATE classes SET occurrences=(SELECT count(*) FROM occurrences WHERE class_id=?1),first_seen_at=coalesce((SELECT min(at) FROM occurrences WHERE class_id=?1),first_seen_at),last_seen_at=coalesce((SELECT max(at) FROM occurrences WHERE class_id=?1),last_seen_at) WHERE id=?1").run(id);
    this.note(row.id, now, "split", row.state, row.state, `${created} split off: ${c.reason}`, c.actor);
    this.note(created, now, "split", null, "open", `split from ${row.id}: ${c.reason}`, c.actor);
    return `${created} split from ${row.id}`;
  }

  // ------------------------------------------------------------- export
  /** The small file everyone else reads. Classes merged away are left out; their ids stay on file here. */
  export(now: number, nightsMissed: number | null): LedgerExport {
    return LedgerExportSchema.parse({
      version: 1,
      at: now,
      nightsMissed,
      classes: this.classes()
        .filter((c) => !c.mergedInto)
        .map((c) => ({ id: c.id, kind: c.kind, state: c.state, ownerRole: c.ownerRole, shadow: c.shadow, needsOperatorSince: c.needsOperatorSince, lastSeenAt: c.lastSeenAt })),
    });
  }
}
