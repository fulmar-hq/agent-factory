// What the factory does when its config file does not pass ConfigSchema.
//
// A valid file is used as it is and a copy is kept as the last good config.
// An invalid file never stops the caller with an error and is never used for
// new work. The caller gets `hold: true` (start nothing new) and a config to
// supervise existing work with: the last good config, changed only where the
// bad file asks for something tighter on a safety field (a lower capacity, a
// lower usage gate, a wallet stop). Nothing looser is ever taken from a
// rejected file. docs/config-guard.md is the plain-language copy.
//
// Nothing here can raise or bypass a limit, and nothing here writes the live
// config; scripts/set-config.ts is the supported way to change it.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "../tracking/store";
import { mailPath } from "./alerts";
import { ConfigSchema, root, type Config } from "./config";
import { SHARED_SUBJECTS, ownerMessageId } from "./loop-contract";

/** What a tick result reads, every tick, while the live config is rejected. */
export const CONFIG_REJECTED_STATUS = "degraded: config rejected";
/** Still invalid after this long: a hard stop for Vincent. */
export const CONFIG_HARD_STOP_AFTER_MS = 15 * 60_000;
/** While it stays invalid, the hard stop is raised again each later day from this local hour. */
export const CONFIG_HARD_STOP_REPEAT_HOUR = 9;
/** Files in the private factory directory. This file is their only writer. */
export const CONFIG_GUARD_FILES = { live: "config.yaml", lastGood: "config.last-good.yaml", state: "health/config-guard.json" } as const;
/** Repository paths to add to protected_paths when this installs (launcher/config.ts is already there). */
export const CONFIG_GUARD_PROTECTED_PATHS = ["launcher/config-guard.ts", "scripts/set-config.ts", "scripts/validate-config.ts"] as const;

// ---------------------------------------------------------------- checking
const WHOLE_FILE = "(whole file)";
export type ConfigProblem = { field: string; message: string };
export type ConfigCheck = { ok: true; config: Config; raw: unknown } | { ok: false; problems: ConfigProblem[]; raw: unknown };

const at = (value: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<PropertyKey, unknown>)[key] : undefined), value);
const found = (value: unknown) => (["number", "string", "boolean"].includes(typeof value) ? ` (found ${JSON.stringify(value).slice(0, 80)})` : "");

/** Checks config text against ConfigSchema. Every failing field is named; nothing is thrown. */
export function checkConfig(text: string): ConfigCheck {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (error) {
    return { ok: false, raw: undefined, problems: [{ field: WHOLE_FILE, message: `not valid YAML: ${String(error).slice(0, 200)}` }] };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data, raw };
  return { ok: false, raw, problems: parsed.error.issues.map((issue) => ({ field: issue.path.join(".") || WHOLE_FILE, message: issue.message + found(at(raw, issue.path)) })) };
}

// -------------------------------------------------------------- tightening
// The safety fields, which direction is tighter, and what a value must be to
// "parse on its own". A field not listed here always keeps its last good value.
const count = z.number().int().positive(),
  ratio = z.number().finite().nonnegative().max(1),
  money = z.number().finite().nonnegative();
const SAFETY_NUMBERS: readonly (readonly [field: string, tighter: "lower" | "higher", own: z.ZodType<number>])[] = [
  ["capacity.start_parallel", "lower", count],
  ["capacity.heavy_test_slots", "lower", z.number().int().nonnegative()],
  ["capacity.controller.start", "lower", count],
  ["capacity.controller.max", "lower", count],
  ["usage_gates.admit_below", "lower", ratio],
  ["usage_gates.high_benefit_only_below", "lower", ratio],
  ["usage_gates.stop_at", "lower", ratio],
  ["usage_gates.max_meter_age_minutes", "lower", z.number().finite().positive().max(15)],
  ["wallet.aws.ceiling_usd_month", "lower", money],
  ["wallet.aws.hold_at_projected", "lower", money],
  ["wallet.aws.stop_at_actual", "lower", money],
  ["wallet.aws.reserve_usd", "higher", money],
  ["wallet.other.default_usd", "lower", money],
  ["autonomy.restart.causes_per_hour", "lower", z.number().int().min(1).max(10)],
  ["operator_switches.fix_ups_per_pull_request", "lower", z.number().int().min(0).max(2)],
];
const OFF_IS_TIGHTER = ["operator_switches.failure_class_admission", "operator_switches.release_headroom"] as const;
const PROTECTED_PATHS = "autonomy.auto_approval.protected_paths";
/** Every field a rejected file can tighten. */
export const SAFETY_FIELDS: readonly string[] = [...SAFETY_NUMBERS.map(([field]) => field), ...OFF_IS_TIGHTER, PROTECTED_PATHS];

export type ConfigChange = { field: string; lastGood: unknown; offered: unknown };
function put(config: Config, field: string, value: unknown) {
  const keys = field.split("."),
    last = keys.pop()!;
  (at(config, keys) as Record<string, unknown>)[last] = value;
}

/**
 * The last good config, changed only where the rejected file offers a tighter
 * value on a safety field. `ignored` names every safety value the rejected
 * file offered that was looser or unusable, so the record shows it was seen
 * and not taken.
 */
export function tighten(lastGood: Config, rejected: unknown): { config: Config; honoured: ConfigChange[]; ignored: ConfigChange[] } {
  const config = structuredClone(lastGood),
    honoured: ConfigChange[] = [],
    ignored: ConfigChange[] = [];
  const decide = (field: string, kept: unknown, offered: unknown, tighter: boolean, value: unknown = offered) => {
    if (tighter) (put(config, field, value), honoured.push({ field, lastGood: kept, offered }));
    else ignored.push({ field, lastGood: kept, offered });
  };
  for (const [field, direction, own] of SAFETY_NUMBERS) {
    const kept = at(lastGood, field.split(".")),
      offered = at(rejected, field.split("."));
    if (typeof kept !== "number" || offered === undefined || offered === kept) continue;
    const usable = own.safeParse(offered);
    decide(field, kept, offered, usable.success && (direction === "lower" ? usable.data < kept : usable.data > kept));
  }
  for (const field of OFF_IS_TIGHTER) {
    const kept = at(lastGood, field.split(".")),
      offered = at(rejected, field.split("."));
    if (offered !== undefined && offered !== kept) decide(field, kept, offered, offered === "off");
  }
  const keptPaths = at(lastGood, PROTECTED_PATHS.split(".")) as string[] | undefined,
    offeredPaths = z.array(z.string().min(1)).safeParse(at(rejected, PROTECTED_PATHS.split(".")));
  if (keptPaths && offeredPaths.success) {
    // Protecting one more path is tighter; dropping one is looser.
    const added = offeredPaths.data.filter((path) => !keptPaths.includes(path)),
      dropped = keptPaths.filter((path) => !offeredPaths.data.includes(path));
    if (added.length) decide(PROTECTED_PATHS, keptPaths, { added }, true, [...keptPaths, ...added]);
    if (dropped.length) ignored.push({ field: PROTECTED_PATHS, lastGood: keptPaths, offered: { dropped } });
  }
  // With a capacity controller the slot limit comes from the controller alone,
  // so a lowered start_parallel also caps it, and start never sits above max.
  const controller = config.capacity.controller as { start: number; max: number } | undefined;
  if (controller) {
    const cap = honoured.some((change) => change.field === "capacity.start_parallel") ? config.capacity.start_parallel : Infinity;
    controller.max = Math.min(controller.max, cap);
    controller.start = Math.min(controller.start, controller.max);
  }
  return { config, honoured, ignored };
}

// ------------------------------------------------------------------- guard
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function replaceFile(path: string, text: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
/** Keeps the exact bytes of a config that passed, so the guard has something to fall back on. */
export function rememberGoodConfig(dir: string, text: string) {
  const path = join(dir, CONFIG_GUARD_FILES.lastGood);
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {
    // No copy yet.
  }
  replaceFile(path, text);
}

type GuardState = { rejectedSince: number; fileSha256: string; hardStopDay?: string };
const GuardStateSchema = z.object({ rejectedSince: z.number().int().positive(), fileSha256: z.string().min(1), hardStopDay: z.string().optional() });
function readState(dir: string): GuardState | null {
  try {
    const parsed = GuardStateSchema.safeParse(JSON.parse(readFileSync(join(dir, CONFIG_GUARD_FILES.state), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** Null marks the end of a rejected stretch; the file is kept, never deleted. */
function writeState(dir: string, state: GuardState | null) {
  mkdirSync(join(dir, "health"), { recursive: true, mode: 0o700 });
  replaceFile(join(dir, CONFIG_GUARD_FILES.state), JSON.stringify(state));
}

export type AcceptedConfig = { ok: true; hold: false; status: null; config: Config; alarm: string | null };
export type RejectedConfig = {
  ok: false;
  /** Start nothing new: no claim, no auto-approval, no supply, no owner wake. */
  hold: true;
  status: typeof CONFIG_REJECTED_STATUS;
  /** What to supervise existing work with. Null only when no earlier good config exists. */
  config: Config | null;
  /** A plain reason, in the shape the loop heartbeat's `alarm` takes. */
  alarm: string;
  problems: ConfigProblem[];
  honoured: ConfigChange[];
  ignored: ConfigChange[];
  fileSha256: string;
  /** When the config was first seen invalid in this unbroken stretch. A second bad file does not restart it. */
  rejectedSince: number;
};
export type ConfigGuard = AcceptedConfig | RejectedConfig;

/**
 * Reads the live config for a caller that must keep running. Never throws on
 * a bad or missing file. Compare `configAt`, which stays strict: a job that
 * should refuse to run on an invalid config (the release, a worker) keeps
 * using that.
 */
export function guardConfig(dir: string = root, now = Date.now()): ConfigGuard {
  const live = join(dir, CONFIG_GUARD_FILES.live);
  let text: string | null = null,
    check: ConfigCheck;
  try {
    text = readFileSync(live, "utf8");
    check = checkConfig(text);
  } catch (error) {
    check = { ok: false, raw: undefined, problems: [{ field: WHOLE_FILE, message: (error as NodeJS.ErrnoException).code === "ENOENT" ? "the config file is missing" : `the config file cannot be read: ${String(error)}` }] };
  }
  if (check.ok) {
    let alarm: string | null = null;
    try {
      rememberGoodConfig(dir, text!);
      if (readState(dir)) writeState(dir, null);
    } catch (error) {
      alarm = `config accepted, but its last-good copy could not be kept: ${String(error)}`;
    }
    return { ok: true, hold: false, status: null, config: check.config, alarm };
  }

  const fileSha256 = sha256(text ?? check.problems[0]!.message),
    state = readState(dir);
  let rejectedSince = state && state.rejectedSince <= now ? state.rejectedSince : now,
    stateProblem = "";
  if (!state || state.fileSha256 !== fileSha256 || state.rejectedSince !== rejectedSince) {
    try {
      writeState(dir, { rejectedSince, fileSha256, hardStopDay: state?.hardStopDay });
    } catch (error) {
      // Without a kept start time every tick would look like the first, and
      // the hard stop would never come due. Fall back to when the file changed.
      stateProblem = ` The guard could not keep its own state (${String(error)}).`;
      try {
        if (!state) rejectedSince = Math.min(now, Math.floor(statSync(live).mtimeMs));
      } catch {
        // No file either: the start time stays now.
      }
    }
  }

  let base: Config | null = null;
  try {
    const kept = checkConfig(readFileSync(join(dir, CONFIG_GUARD_FILES.lastGood), "utf8"));
    if (kept.ok) base = kept.config;
  } catch {
    // No last good copy.
  }
  const tightened = base ? tighten(base, check.raw) : { config: null, honoured: [], ignored: [] };
  const fields = check.problems.map((problem) => problem.field).join(", ");
  // At most 500 characters, the loop heartbeat's limit for an alarm reason.
  const alarm = (
    "config rejected; new work is held. " +
    (base ? `Existing work is supervised on the last good config${tightened.honoured.length ? `, tightened on ${tightened.honoured.map((change) => change.field).join(", ")}` : ""}.` : "There is no earlier good config, so existing work cannot be supervised.") +
    stateProblem +
    ` Rejected: ${fields}`
  ).slice(0, 500);
  return { ok: false, hold: true, status: CONFIG_REJECTED_STATUS, config: tightened.config, alarm, problems: check.problems, honoured: tightened.honoured, ignored: tightened.ignored, fileSha256, rejectedSince };
}

// ----------------------------------------------------------------- telling
const clock = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function localTime(time: number) {
  const part = Object.fromEntries(clock.formatToParts(time).map((p) => [p.type, p.value]));
  return { day: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) };
}
/**
 * The local day a hard stop is due for, or null. The first is due once the
 * config has been invalid for `after` ms. While it stays invalid, one more is
 * due each later day from 09:00, so the message repeats for as long as a tick
 * is running to call this. `raisedDay` is the last day already raised.
 */
export function hardStopDue(rejectedSince: number, now: number, raisedDay?: string, after = CONFIG_HARD_STOP_AFTER_MS): string | null {
  if (now - rejectedSince < after) return null;
  const today = localTime(now);
  if (!raisedDay) return today.day;
  return raisedDay < today.day && today.hour >= CONFIG_HARD_STOP_REPEAT_HOUR ? today.day : null;
}
/** The contract's id for the day, so the mail gate knows it is a hard stop and any other writer of the same condition lands on the same row. */
export const configHardStopId = (day: string) => ownerMessageId({ tier: "hard-stop", kind: "factory-down", subject: SHARED_SUBJECTS.configInvalid, day });
export const configHardStopText = (supervising: boolean) =>
  supervising
    ? "Factory down: config invalid, no new work. Running work is still supervised. An operator has to fix the config."
    : "Factory down: config invalid, no new work, and running work is unsupervised. An operator has to fix the config.";

// One row for Vincent in the existing Alido Mail store; never a second store or bot.
function queueHardStop(mail: string, id: string, summary: string, now: number) {
  if (!existsSync(mail)) throw Error("existing Alido Mail store unavailable");
  const db = new Database(mail, { readwrite: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=10000");
    db.query(
      `INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
       VALUES(?,?,?,'Factory Desk','codex','factory-config-guard','Vincent','telegram','blocker','none',?,'',?,0,?,'unread','pending')`,
    ).run(id, id, now, summary, id, sha256(summary));
    // OR IGNORE is not a receipt. Another writer may already have raised this
    // condition today under the same id, which is fine; a row for anyone else is not.
    const row = db.query("SELECT recipient,recipient_app FROM messages WHERE id=?").get(id) as { recipient: string; recipient_app: string } | null;
    if (row?.recipient !== "Vincent" || row.recipient_app !== "telegram") throw Error("config hard stop readback missing or conflicting");
  } finally {
    db.close();
  }
}

export type ConfigRejectionReport = { recorded: boolean; hardStop: "not-due" | "raised" | "failed"; id?: string; error?: string };
/**
 * Call once per tick while the guard is rejecting. It records one
 * `config-rejected` event per distinct bad file and raises the hard stop for
 * Vincent when it is due. It never throws: a mail or store failure is
 * returned and retried on the next tick with the same id.
 */
export function reportConfigRejection(dir: string, guard: RejectedConfig, o: { store?: Store; mail?: string; now?: number } = {}): ConfigRejectionReport {
  const now = o.now ?? Date.now();
  const event = (id: string, kind: string, data: unknown, undo: string) => {
    try {
      return o.store?.event(id, kind, data, undo, now) ?? false;
    } catch {
      return false;
    }
  };
  const recorded = event(
    `config-rejected:${guard.fileSha256}`,
    "config-rejected",
    { fileSha256: guard.fileSha256, problems: guard.problems, honoured: guard.honoured, ignored: guard.ignored, supervising: guard.config !== null },
    "Fix the file and apply it with scripts/set-config.ts, or restore config.last-good.yaml the same way; retain this event",
  );
  // With nothing to supervise on, the factory is down now, not in 15 minutes.
  const day = hardStopDue(guard.rejectedSince, now, readState(dir)?.hardStopDay, guard.config ? CONFIG_HARD_STOP_AFTER_MS : 0);
  if (!day) return { recorded, hardStop: "not-due" };
  const id = configHardStopId(day);
  try {
    queueHardStop(o.mail ?? mailPath(), id, configHardStopText(guard.config !== null), now);
  } catch (error) {
    event(`config-hard-stop-failure:${day}`, "config-hard-stop-failure", { id, error: String(error) }, "Restore the Alido Mail store; the next tick retries the same id");
    return { recorded, hardStop: "failed", id, error: String(error) };
  }
  event(`config-hard-stop:${day}`, "config-hard-stop-queued", { id, rejectedSince: guard.rejectedSince, fileSha256: guard.fileSha256 }, "Retain the mail row; it is not resent for this day");
  try {
    writeState(dir, { rejectedSince: guard.rejectedSince, fileSha256: guard.fileSha256, hardStopDay: day });
  } catch {
    // The row is in the mail store. Without the note the next tick repeats an insert the store ignores.
  }
  return { recorded, hardStop: "raised", id };
}
