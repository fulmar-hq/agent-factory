// The loop's own switches: is a new detector acting, or only recording what it
// would have done? This file only reads. A switch is flipped by
// scripts/loop-flag.ts, which needs a named actor and a parity report.
//
// These switches cannot touch a limit. Usage gates, capacity, the wallet, the
// release schedule, failure-class admission, the fix-up allowance and release
// headroom live in the private factory config, which only the operator edits.
// The switch file accepts nothing but the names below and the two modes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { root } from "./config";
import { LOOP_FILES } from "./loop-contract";

export const LOOP_SWITCHES = {
  "idle-observation-gap": "the changed idle observation-gap rule may send",
  "health-blind-state": "the health evaluator's 'blind' state replaces the old result",
  "health-reason-change": "an open health episode speaks when its reasons change, and missed nights stay visible",
  "ledger-rules-silent-failures": "classes from the silent-failure, job-log and deadline rules may open issues and mail",
  "ledger-rules-stuck-work": "classes from the stuck-work and outcome rules may open issues and mail",
  "ledger-rules-limit-reviews": "a limit running past its expected duration may ask its owner",
  "ledger-rules-running-out": "classes that warn before something runs out may open issues and mail",
  "class-restart-hold": "restart holds are keyed on the failure class and clear only by the three recorded routes",
} as const;
export type LoopSwitch = keyof typeof LOOP_SWITCHES;
export const LOOP_SWITCH_NAMES = Object.keys(LOOP_SWITCHES) as [LoopSwitch, ...LoopSwitch[]];
export const LOOP_MODES = ["record-only", "acting"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

/** A switch is acting only with who flipped it and the parity report they attached. */
const Entry = z
  .strictObject({
    mode: z.enum(LOOP_MODES),
    actor: z.string().trim().min(2).max(120),
    at: z.number().int().positive(),
    parityReport: z.string().min(1).max(1000).optional(),
    parityReportSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((e) => e.mode !== "acting" || (!!e.parityReport && !!e.parityReportSha256), "an acting switch needs its parity report");
export type LoopSwitchEntry = z.infer<typeof Entry>;
export const LoopFlagsFileSchema = z.strictObject({ version: z.literal(1), switches: z.partialRecord(z.enum(LOOP_SWITCH_NAMES), Entry) });
export type LoopFlagsFile = z.infer<typeof LoopFlagsFileSchema>;

export type LoopFlags = {
  /** Every switch has a mode; one never flipped is record-only. */
  modes: Record<LoopSwitch, LoopMode>;
  entries: LoopFlagsFile["switches"];
  /** A plain reason for the caller's heartbeat when the file could not be trusted; otherwise null. */
  alarm: string | null;
  source: "file" | "last-good" | "default";
};
const modesOf = (entries: LoopFlagsFile["switches"]) =>
  Object.fromEntries(LOOP_SWITCH_NAMES.map((name) => [name, entries[name]?.mode ?? "record-only"])) as Record<LoopSwitch, LoopMode>;

/** The newest state the flip script recorded that still parses. The history file is append-only. */
function lastGood(dir: string): LoopFlagsFile["switches"] | null {
  let lines: string[];
  try {
    lines = readFileSync(join(dir, LOOP_FILES.switchHistory), "utf8").split("\n");
  } catch {
    return null;
  }
  for (const line of lines.reverse()) {
    if (!line.trim()) continue;
    try {
      const after = LoopFlagsFileSchema.safeParse(JSON.parse(line).after);
      if (after.success) return after.data.switches;
    } catch {
      // A torn or hand-edited line is skipped; an older good line still counts.
    }
  }
  return null;
}

/**
 * Reads the switches. No file and no history means nothing was ever flipped:
 * every switch is record-only, which is today's behaviour. A file that is
 * missing after a flip, unreadable or malformed changes no switch: the last
 * good state stands and `alarm` says why.
 */
export function readLoopFlags(dir: string = root): LoopFlags {
  let problem: string;
  try {
    const parsed = LoopFlagsFileSchema.safeParse(JSON.parse(readFileSync(join(dir, LOOP_FILES.switches), "utf8")));
    if (parsed.success) return { modes: modesOf(parsed.data.switches), entries: parsed.data.switches, alarm: null, source: "file" };
    const issue = parsed.error.issues[0];
    problem = `rejected at ${issue?.path.join(".") || "top level"}: ${issue?.message ?? "invalid"}`;
  } catch (error) {
    problem = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "not valid JSON" : `unreadable: ${String(error)}`;
  }
  const kept = lastGood(dir);
  if (kept) return { modes: modesOf(kept), entries: kept, alarm: `loop switch file ${problem}; the last good switches stand`, source: "last-good" };
  if (problem === "missing") return { modes: modesOf({}), entries: {}, alarm: null, source: "default" };
  return { modes: modesOf({}), entries: {}, alarm: `loop switch file ${problem}; no good record exists, so every switch is record-only`, source: "default" };
}

export const loopActing = (flags: Pick<LoopFlags, "modes">, name: LoopSwitch) => flags.modes[name] === "acting";
