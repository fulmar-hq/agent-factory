// The morning release-inputs check. Everything tonight's release needs is
// looked at hours before the 19:00 preflight: at 09:00, 12:00, 16:45 and 17:35.
// It asks the same readiness collection the preflight uses, then adds what
// that cannot say early: is the Quality proof for the installed revision, are
// the night's batch and acceptance ticket today's, does the install freeze
// cover tonight, and does any qualification lapse before tomorrow morning.
//
// What it may do: write one action mail a day per missing input to the role
// the loop contract names, drop one ledger inbox record per input, ask Quality
// once per installed revision for a fresh proof, and put one ask a day in front
// of Vincent for a step only he can do. It changes no gate, pause, wallet,
// schedule or freeze. For the freeze it only reports: it never writes, moves,
// shortens or removes one.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "../tracking/store";
import { mailPath } from "./alerts";
import { optionalJSON } from "./config";
import { healthBridge } from "./factory-health-runtime";
import { integrationFreeze } from "./integration-freeze";
import {
  LOOP_FILES,
  SHARED_SUBJECTS,
  actionRole,
  inboxFileName,
  ownerMessageId,
  parseInboxRecord,
  releaseInputClassId,
  releaseInputHumanStep,
  roleActionId,
  type InboxRecord,
} from "./loop-contract";
import { deadlineAt, toronto } from "./release";
import { releaseAction } from "./release-actions";
import type { ReleaseReadiness } from "./release-readiness";
import { queueWake } from "./wake";

const MINUTE = 60_000;
const at = (hour: number, minute: number) => hour * 60 + minute;
/** When the job runs, Toronto time. The last run is five minutes into the install freeze. */
export const MORNING_RUNS = [
  { hour: 9, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 16, minute: 45 },
  { hour: 17, minute: 35 },
] as const;
export const MORNING_LABEL = "com.agent-factory.release-morning";
export type MorningSlot = "09:00" | "12:00" | "16:45" | "17:35";
const NOON = at(12, 0);
const LATE = at(16, 45);
export const FREEZE_FROM = at(17, 30);
export const FREEZE_UNTIL = at(22, 35);
const PROOF_DUE = at(18, 30);
const VALID_THROUGH = at(22, 30);
const TOMORROW_MORNING = at(24 + 9, 0);
/** The slot is read from the clock, so a run that launchd delivers late still behaves as its time of day. */
export const morningSlot = (minute: number): MorningSlot => (minute < NOON ? "09:00" : minute < LATE ? "12:00" : minute < FREEZE_FROM ? "16:45" : "17:35");

// Input names. The first three are the preflight's own, so the morning check,
// the rehearsal and the preflight feed one class per input.
const PROOF_INPUT = "hosted acceptance path";
const BATCH_INPUT = "PR checks";
const TICKET_INPUT = "quality qualification";
const FREEZE_INPUT = "install freeze configuration";
const EXPIRY_INPUT = "qualification expiry";
const SOURCE = "release-morning";

export type Finding = {
  input: string;
  reason: string;
  /** "informational" is shown but not acted on yet: the input is not due this early in the day. */
  level: "missing" | "informational";
};
export type MorningAction = { input: string; did: "mailed" | "proof-requested" | "proof-already-requested" | "asked" | "hard-stop"; to: string; id: string };
export type MorningReport = {
  day: string;
  at: number;
  slot: MorningSlot;
  installed: string | null;
  frozen: boolean;
  /** True when nothing is missing. Informational findings do not count. */
  ready: boolean;
  findings: Finding[];
  actions: MorningAction[];
  /** Effects that could not be completed. Their ids are stable, so the next run retries them. */
  failures: string[];
  evidence?: Record<string, unknown>;
};
export type MorningOptions = {
  /** The private factory directory. */
  dir: string;
  store: Store;
  /** The readiness report the preflight would produce now. Reads only. */
  collect: (now: number) => Promise<ReleaseReadiness>;
  /** The installed factory revision. A failure is reported, not fatal. */
  installed: () => string;
  now?: number;
  /** The Alido Mail store. */
  mail?: string;
  send?: typeof releaseAction;
  freeze?: typeof integrationFreeze;
  readJSON?: typeof optionalJSON;
  /** Carried into the report unchanged, for example the usage reading beside the release gate. */
  evidence?: Record<string, unknown>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const short = (sha: unknown) => (typeof sha === "string" && sha ? sha.slice(0, 12) : "no revision");
const pad = (n: number) => String(n).padStart(2, "0");
const eastern = (time: number) => {
  const { day, minute } = toronto(time);
  return `${day} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
};

/** The checkout's current commit, read from its own files so the job starts no other program. */
export function installedRevision(checkout: string): string {
  let git = join(checkout, ".git");
  // In a linked worktree ".git" is a file that points at the real folder.
  const pointer = statSync(git).isFile() ? readFileSync(git, "utf8").match(/^gitdir: (.+)$/m)?.[1] : undefined;
  if (pointer) git = resolve(checkout, pointer);
  const shared = existsSync(join(git, "commondir")) ? resolve(git, readFileSync(join(git, "commondir"), "utf8").trim()) : git;
  const head = readFileSync(join(git, "HEAD"), "utf8").trim();
  const ref = head.match(/^ref: (.+)$/)?.[1];
  let sha: string | undefined = ref ? undefined : head;
  if (ref) {
    const loose = [git, shared].map((folder) => join(folder, ref)).find((file) => existsSync(file));
    if (loose) sha = readFileSync(loose, "utf8").trim();
    else if (existsSync(join(shared, "packed-refs"))) sha = readFileSync(join(shared, "packed-refs"), "utf8").match(new RegExp(`^([a-f0-9]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))?.[1];
  }
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw Error("installed factory revision unavailable");
  return sha;
}

/** Why the Quality proof on disk will not serve tonight, or null. The preflight needs it to name the installed revision and outlast 22:30. */
export function proofProblem(raw: unknown, installed: string, validThrough: number): string | null {
  if (!isRecord(raw)) return "release-quality-path.json is missing or unreadable";
  if (raw.source !== installed) return `the Quality proof names ${short(raw.source)}, but the installed revision is ${short(installed)}`;
  if (!Number.isSafeInteger(raw.expiresAt)) return "the Quality proof has no expiry time";
  if ((raw.expiresAt as number) <= validThrough) return `the Quality proof expires at ${eastern(raw.expiresAt as number)}, before 22:30 tonight`;
  return null;
}

/**
 * Report-only. Asks the installed freeze reader about every five minutes of
 * today's 17:30–22:35 window that is still ahead, and says where it is not
 * covered. A freeze file that cannot be read refuses every install, which is
 * also said. Nothing here writes the freeze file.
 */
export function freezeProblem(dir: string, now: number, active: typeof integrationFreeze = integrationFreeze): string | null {
  const from = Math.max(now, deadlineAt(now, FREEZE_FROM));
  const until = deadlineAt(now, FREEZE_UNTIL);
  const times: number[] = [];
  for (let time = from; time < until; time += 5 * MINUTE) times.push(time);
  if (from < until) times.push(until - 1);
  try {
    for (const time of times) if (!active(dir, time)) return `no install freeze covers ${eastern(time)}; an install then would move the revision Quality proves`;
  } catch (error) {
    return `the install freeze file cannot be read, so every install is refused until it is corrected: ${String(error)}`.slice(0, 600);
  }
  return null;
}

/** Qualification keys that lapse between now and 09:00 tomorrow. A key that has already lapsed is a limit in force, not something about to run out. */
export function expiringQualifications(raw: unknown, now: number): string | null {
  if (!isRecord(raw)) return null;
  const through = deadlineAt(now, TOMORROW_MORNING);
  const lapsing = Object.entries(raw)
    .filter(([, q]) => isRecord(q) && Number.isSafeInteger(q.expiresAt) && (q.expiresAt as number) > now && (q.expiresAt as number) <= through)
    .map(([key, q]) => `${key} at ${eastern((q as { expiresAt: number }).expiresAt)}`);
  return lapsing.length ? `qualifications lapse before 09:00 tomorrow: ${lapsing.join(", ")}`.slice(0, 600) : null;
}

const dayOf = (raw: unknown) => (isRecord(raw) && typeof raw.day === "string" ? raw.day : null);

async function morningFindings(o: { dir: string; now: number; readiness: ReleaseReadiness; installed: string | null; frozen: boolean; freeze: typeof integrationFreeze; readJSON: typeof optionalJSON }) {
  const { day, minute } = toronto(o.now);
  const found = new Map<string, Finding>();
  const set = (input: string, reason: string, level: Finding["level"] = "missing") => found.set(input, { input, reason, level });
  const add = (input: string, reason: string) => set(input, found.has(input) ? `${found.get(input)!.reason}; ${reason}` : reason);
  const note = (input: string) => {
    const finding = found.get(input);
    if (finding) finding.level = "informational";
  };
  for (const gap of o.readiness.missing) add(gap.input, gap.reason);
  if (!o.installed) add("release configuration", "the installed factory revision could not be read");

  const [batch, ticket, proof, qualifications] = await Promise.all(["release-batch.json", "release-acceptance-ticket.json", "release-quality-path.json", "qualifications.json"].map((name) => o.readJSON(join(o.dir, name))));
  // The night's batch and acceptance ticket are made during the day. Before
  // noon a file that is not yet today's is only noted; from noon it is missing.
  const early = minute < NOON;
  if (dayOf(batch) !== day) set(BATCH_INPUT, batch === null ? "release-batch.json is missing or unreadable" : `release-batch.json is dated ${dayOf(batch) ?? "with no day"}, not today`, early ? "informational" : "missing");
  // The ticket is an optional override: with none, the configured Quality role applies.
  if (ticket !== null && dayOf(ticket) !== day) {
    set(TICKET_INPUT, `release-acceptance-ticket.json is dated ${dayOf(ticket) ?? "with no day"}, not today`, early ? "informational" : "missing");
    // Until today's ticket exists, Quality's usage is judged against the configured role, not tonight's.
    if (early) note("quality usage");
  }
  const staleProof = o.installed ? proofProblem(proof, o.installed, o.readiness.validThrough) : null;
  if (staleProof) set(PROOF_INPUT, staleProof);
  // Quality proves the installed revision once the freeze holds it still.
  // Before that an install would undo the proof, so a stale one is only noted.
  if (!o.frozen) note(PROOF_INPUT);
  const freeze = freezeProblem(o.dir, o.now, o.freeze);
  if (freeze) set(FREEZE_INPUT, freeze);
  const expiring = expiringQualifications(qualifications, o.now);
  if (expiring) set(EXPIRY_INPUT, expiring);
  return { findings: [...found.values()], staleProof };
}

/** Adds one record to the ledger inbox: a temporary name, then a rename. Harmless before the ledger job exists. */
function dropInboxRecord(dir: string, record: InboxRecord) {
  const parsed = parseInboxRecord(record);
  if (!parsed.ok) throw Error(parsed.reason);
  const folder = join(dir, LOOP_FILES.ledgerInbox);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = inboxFileName(record);
  const temporary = join(folder, `.${name}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(temporary, join(folder, name));
}

/**
 * One run. Collects, decides what is missing, and performs the few effects
 * above. Every effect has a stable id for the day, and its first payload is
 * kept before it is sent, so a second run, a retry after a crash or a changed
 * reason repeats nothing and conflicts with nothing.
 */
export async function runMorningCheck(o: MorningOptions): Promise<MorningReport> {
  const now = o.now ?? Date.now();
  const { day, minute } = toronto(now);
  const s = o.store;
  const send = o.send ?? releaseAction;
  const mail = o.mail ?? mailPath();
  const freeze = o.freeze ?? integrationFreeze;
  const keep = <T>(key: string, fresh: T): T => {
    const kept = s.get<T>(key) ?? fresh;
    s.set(key, kept);
    return kept;
  };

  let installed: string | null = null;
  try {
    installed = o.installed();
  } catch {
    // Reported as a finding below.
  }
  let readiness: ReleaseReadiness;
  try {
    readiness = await o.collect(now);
  } catch (error) {
    readiness = { day, at: now, validThrough: deadlineAt(now, VALID_THROUGH), ready: false, missing: [{ input: "release configuration", reason: String(error) }], evidence: {} };
  }
  let frozen = false;
  try {
    frozen = freeze(o.dir, now) !== null;
  } catch {
    // An unreadable freeze file is a finding below.
  }
  const { findings, staleProof } = await morningFindings({ dir: o.dir, now, readiness, installed, frozen, freeze, readJSON: o.readJSON ?? optionalJSON });

  const actions: MorningAction[] = [];
  const failures: string[] = [];
  const attempt = (what: string, effect: () => void) => {
    try {
      effect();
    } catch (error) {
      failures.push(`${what}: ${String(error)}`);
    }
  };
  const due = `${day} 18:30 Eastern`;
  const standing = "No pause, gate, spending or release-time exception is granted.";
  const human: Finding[] = [];
  for (const f of findings) {
    if (f.level !== "missing") continue;
    const classId = releaseInputClassId(f.input);
    const reason = f.reason.trim().slice(0, 600) || "no reason given";
    attempt(`ledger record for ${f.input}`, () =>
      dropInboxRecord(o.dir, keep<InboxRecord>(`release-morning:record:${day}:${classId}`, { version: 1, id: `${SOURCE}:${day}:${classId}`, at: now, source: SOURCE, type: "release-input", classId, input: f.input, reason, day })),
    );
    // A step only Vincent can do is an ask for him, not work for a role.
    if (releaseInputHumanStep(f.input, f.reason)) {
      human.push(f);
      continue;
    }
    const role = actionRole({ kind: "release-input", input: f.input, reason: f.reason });
    if (f.input === PROOF_INPUT && staleProof && installed) {
      const revision = installed;
      attempt("Quality proof request", () => {
        // The freeze-start job asks for the same proof at 17:30 where it is installed. One request per revision is enough.
        if (s.get<{ source?: string }>(`release-freeze-proof-request:${day}`)?.source === revision) {
          actions.push({ input: f.input, did: "proof-already-requested", to: role, id: `release-freeze-proof:${day}` });
          return;
        }
        const id = roleActionId(role, classId, `${day}.${short(revision)}`);
        const request = keep(`release-morning:proof:${day}:${revision}`, {
          source: revision,
          summary: `${role}: prove the release path for installed ${short(revision)} by ${due}.`,
          body: `${reason.slice(0, 400)}\nThe install freeze is active, so this revision will not move tonight. Prove the hosted HTTP and trusted acceptance receipt path for exact installed factory source ${revision}, valid through 22:30 tonight, and retain release-quality-path.json. No source install, activation, real-person send or gate exception is authorized.`.slice(0, 800),
        });
        send(id, role, request.summary, request.body, now, mail);
        // Role mail alone does not reach a role that has no chat thread. The
        // guarded owner wake carries the same request to Quality's own runtime.
        const fresh = queueWake(s, { id: `mail:${id}`, owner: role.toLowerCase(), kind: "release-path-proof-request", payload: { mailId: id, ...request } }, now);
        actions.push({ input: f.input, did: fresh ? "proof-requested" : "proof-already-requested", to: role, id });
      });
      continue;
    }
    attempt(`mail for ${f.input}`, () => {
      const kept = keep(`release-morning:mail:${day}:${classId}`, {
        id: roleActionId(role, classId, day),
        role,
        summary: `Release input missing: ${f.input.slice(0, 60)}. Due ${due}.`,
        body: `${reason}\nSeen by the morning release check. Resolve before 18:30 America/Toronto; the fixed preflight is 19:00. ${standing}`,
      });
      send(kept.id, kept.role, kept.summary, kept.body, now, mail);
      actions.push({ input: f.input, did: "mailed", to: kept.role, id: kept.id });
    });
  }

  if (human.length) {
    const aws = human.some((f) => /AWS/i.test(`${f.input} ${f.reason}`));
    const subject = aws ? SHARED_SUBJECTS.awsSignIn : "sign-in";
    const what = aws ? "your AWS sign-in" : "a sign-in only you can do";
    const input = (human.find((f) => releaseInputHumanStep(f.input)) ?? human[0]!).input;
    const classId = releaseInputClassId(input);
    attempt("ledger record for the sign-in step", () =>
      dropInboxRecord(o.dir, keep<InboxRecord>(`release-morning:record:${day}:human-step:${subject}`, { version: 1, id: `${SOURCE}:${day}:human-step:${subject}`, at: now, source: SOURCE, type: "human-step-request", classId, step: "sign-in", what: `Tonight's release needs ${what} before 18:30 Eastern.`, dueAt: deadlineAt(now, PROOF_DUE) })),
    );
    const tell = (did: "asked" | "hard-stop", id: string, text: string) =>
      attempt(`${did} row for Vincent`, () => {
        const bridge = healthBridge(mail);
        try {
          bridge.send(id, "Vincent", text);
        } finally {
          bridge.close();
        }
        actions.push({ input, did, to: "Vincent", id });
      });
    // One ask a day, for the noon line. The 09:00 run only records it.
    if (minute >= NOON && minute < LATE) tell("asked", ownerMessageId({ tier: "ask", kind: "release-step", subject, day }), `Tonight's release needs ${what} before 6:30 PM. Can you do that?`);
    // Still open (or first seen) at 16:45: it now blocks tonight's release, which is a hard stop and replaces the ask.
    if (minute >= LATE) tell("hard-stop", ownerMessageId({ tier: "hard-stop", kind: "human-step", subject, day }), `Tonight's release is still blocked on ${what}. It is needed before 6:30 PM.`);
  }

  const report: MorningReport = { day, at: now, slot: morningSlot(minute), installed, frozen, ready: !findings.some((f) => f.level === "missing"), findings, actions, failures, ...(o.evidence ? { evidence: o.evidence } : {}) };
  s.event(`release-morning:${day}:${report.slot}:${now}`, "release-morning", report, "Retain the report and its mail, wake and inbox receipts; nothing here is replayed", now);
  s.set(`release-morning:${day}:${report.slot}`, report);
  return report;
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** The LaunchAgent definition. Program, working directory and PATH are the loaded rehearsal job's, passed in by the installer. */
export function morningJobDefinition(job: { program: string; directory: string; path: string; privateDir: string }): string {
  const runs = MORNING_RUNS.map((run) => `<dict><key>Hour</key><integer>${run.hour}</integer><key>Minute</key><integer>${run.minute}</integer></dict>`).join("");
  const text = (value: string) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key>${text(MORNING_LABEL)}<key>ProgramArguments</key><array>${text(job.program)}${text(join(job.directory, "scripts/release-morning.ts"))}</array><key>WorkingDirectory</key>${text(job.directory)}<key>EnvironmentVariables</key><dict><key>FACTORY_PRIVATE_DIR</key>${text(job.privateDir)}<key>PATH</key>${text(job.path)}<key>TZ</key><string>America/Toronto</string></dict><key>StartCalendarInterval</key><array>${runs}</array><key>RunAtLoad</key><false/><key>StandardOutPath</key>${text(join(job.privateDir, "release-morning.log"))}<key>StandardErrorPath</key>${text(join(job.privateDir, "release-morning.error.log"))}</dict></plist>
`;
}
