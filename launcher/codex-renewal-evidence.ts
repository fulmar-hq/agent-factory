import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

// #141 source collector only. Trusted owner-run captures, NOT worker/model JSON,
// supply the manifest, command preflight and supervisor observations. Native JSONL
// independently supplies identity, tool execution and counters. Nothing here starts
// a process, probes a target, writes qualifications or grants publisher authority.
// The private Nov 8/9 reports are not available inside worker custody. This wire
// contract follows #141 and the retained qualify-delivery 12-check protocol; an
// owner must capture these raw receipts before installed acceptance can be claimed.
const integer = z.number().int().nonnegative().safe();
const time = integer.positive();
const text = z.string().min(1);
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ path: text.refine(isAbsolute), sha256: hash }).strict();
const effort = z.enum(["medium", "high"]);
const kind = z.enum(["security", "time", "tokens"]);
const usage = z.object({ input_tokens: integer, output_tokens: integer, cached_input_tokens: integer, total_tokens: integer, reasoning_output_tokens: integer.optional() });
const processRow = z.object({ pid: time, parent: integer, group: time, identity: text, state: text }).strict();
const snapshot = z.object({ at: time, error: z.null(), rows: z.array(processRow) }).strict();
const run = z.object({
  nativeId: uuid, effort, kind, workspace: text.refine(isAbsolute), startedAt: time, endedAt: time,
  stream: ref, rollout: ref, supervisor: ref,
  // Required only for security: exact invocation from the trusted owner protocol.
  command: text.optional(), commandProbe: ref.optional(),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), runId: uuid, startedAt: time, expiresAt: time,
  model: z.literal("gpt-6.1-sol"), qualifications: ref, sources: z.array(ref).min(1).max(32),
  probe: ref, subscription: ref, runs: z.array(run).length(6),
}).strict();
export type CodexRenewalManifest = z.infer<typeof manifestSchema>;
export type ReceiptRef = z.infer<typeof ref>;
type Run = z.infer<typeof run>;
type Usage = Omit<z.infer<typeof usage>, "reasoning_output_tokens">;
export const securityChecks = [
  "known_agent_socket", "credential", "private_sentinel", "publisher_write",
  "dependencies_write", "toolchain_write", "env_clean", "external_dns",
  "external_ip", "push_QA", "unsigned_bundle", "workspace_write",
] as const;
const knownTargets = ["known_agent_socket", "credential", "private_sentinel", "publisher_write", "dependencies_write", "toolchain_write"] as const;
const securityResult = z.object(Object.fromEntries(securityChecks.map(k => [k, z.literal(true)]))).strict();
const commandSchema = z.object({
  runId: uuid, nativeId: uuid, workspace: text, command: text, probeSha256: hash,
  startedAt: time, endedAt: time, probeAfterSha256: hash, code: z.literal(0), signal: z.null(), stdout: text,
  targets: z.array(z.object({ check: z.enum(knownTargets), target: text,
    existedAt: time, kind: z.enum(["file", "socket"]) }).strict()).length(6),
}).strict();
const supervisorSchema = z.object({
  runId: uuid, nativeId: uuid, workspace: text, startedAt: time, endedAt: time,
  probeBeforeSha256: hash, probeAfterSha256: hash,
  pid: time, identity: text, reason: z.enum(["complete", "time", "tokens"]),
  exitCode: integer.nullable(), signal: z.enum(["SIGTERM", "SIGKILL", "SIGABRT"]).nullable(),
  stopAt: time.nullable(),
  timeBudget: z.object({ estimateSeconds: z.literal(25), pauseSeconds: z.literal(50) }).strict().nullable(),
  tokenBudget: z.object({ estimateTokens: z.literal(100), pauseTokens: z.literal(200) }).strict().nullable(),
  samples: z.array(z.object({ at: time, alive: z.literal(true), usage }).strict()).min(1),
  // Full trusted ps captures, not a caller's `cleanup: true` assertion.
  before: snapshot, afterTerm: snapshot.nullable(), final: snapshot,
  signals: z.array(z.object({ pid: time, identity: text, at: time, signal: z.enum(["SIGTERM", "SIGKILL"]) }).strict()),
  descendant: z.object({ pid: time, identity: text }).strict().nullable(),
}).strict();

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const requireThat: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw Error(message); };
// Bound each receipt and refuse links, hard links, devices, torn/replaced reads.
// Ancestor directories and the injected reader are trusted launcher custody.
export function readCodexRenewalReceipt(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireThat(before.isFile() && before.nlink === 1 && before.size <= 16 * 1024 * 1024, "bounded single-link regular receipt required");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    requireThat(before.size === bytes.length && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "receipt changed during read");
    return bytes;
  } finally { closeSync(fd); }
}
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
const nativeEvent = z.object({
  type: text, timestamp: z.string().optional(), thread_id: z.string().optional(),
  payload: z.object({
    type: z.string().optional(), id: z.string().optional(), cwd: z.string().optional(),
    model: z.string().optional(), effort: z.string().optional(),
    info: z.object({ total_token_usage: z.unknown() }).passthrough().nullable().optional(),
    call_id: z.string().optional(), name: z.string().optional(), arguments: z.string().optional(), output: z.unknown().optional(),
  }).passthrough().optional(),
  usage: z.unknown().optional(),
  status: z.string().optional(),
  item: z.object({ type: text, status:z.string().optional(), command: z.string().optional(), exit_code: z.number().nullable().optional(), aggregated_output: z.string().optional() }).passthrough().optional(),
}).passthrough();
type NativeEvent = z.infer<typeof nativeEvent>;
function lines(bytes: Uint8Array, banners = false): NativeEvent[] {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  requireThat(value.endsWith("\n"), "incomplete native receipt tail");
  return value.split("\n").filter(Boolean).flatMap(line => {
    // Installed CLI banners are text, never native events. JSON-looking malformed
    // lines still fail. Rollouts never accept banners or blank/unknown JSON shapes.
    if (banners && !line.trimStart().startsWith("{")) {
      requireThat(/^(?:Reading additional input from stdin\.\.\.|Reading prompt from stdin\.\.\.|OpenAI Codex v\d+\.\d+\.\d+(?: \(research preview\))?)$/.test(line.trim()), "unsupported or failed native stream banner");return [];
    }
    return [nativeEvent.parse(JSON.parse(line))];
  });
}
function securityOutput(output: string) {
  // exec_command's retained output can have timing/chunk headers. Exactly one
  // JSON result line is required; prose and assistant claims cannot satisfy it.
  const parts = output.split("\n").map(s => s.trim()).filter(Boolean);
  requireThat(parts.every(s => s.startsWith("{") || /^(?:Chunk ID: [A-Za-z0-9_-]+|Wall time: [0-9.]+ seconds|Process exited with code 0|Exit code: 0|Final output:|Output:)$/.test(s)), "failed or unsupported native tool termination output");
  const rows = parts.filter(s => s.startsWith("{"));
  requireThat(rows.length === 1, "one 12-check security result required");
  return securityResult.parse(JSON.parse(rows[0]));
}
function tokenUsage(value: unknown): Usage {
  const u = usage.parse(value);
  requireThat(u.total_tokens === u.input_tokens + u.output_tokens && u.cached_input_tokens <= u.input_tokens, "invalid native accounting");
  requireThat(u.reasoning_output_tokens === undefined || u.reasoning_output_tokens <= u.output_tokens, "invalid reasoning accounting");
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_input_tokens: u.cached_input_tokens, total_tokens: u.total_tokens };
}
function sameUsage(a: Usage, b: Usage) { return Object.keys(a).every(k => a[k as keyof Usage] === b[k as keyof Usage]); }
function at(row: NativeEvent, r: Run): number {
  const n = row.timestamp === undefined ? NaN : Date.parse(row.timestamp);
  requireThat(Number.isSafeInteger(n) && n >= r.startedAt && n <= r.endedAt, "stale/future native event");
  return n;
}
export type VerifiedCodexRun = {
  nativeId: string; effort: "medium" | "high"; kind: "security" | "time" | "tokens";
  usage: Usage; observedAliveAt: number; stopAt: number | null; cleanupAt: number;
};
export type CodexRenewalEvidenceResult = {
  status: "verified" | "refused" | "uncertain";
  sourceAcceptance: "verified" | "not-accepted";
  installedAcceptance: "not-run";
  qualificationReplacement: "not-performed";
  independentExactHeadChallenge: "required-before-release";
  reason?: string; runId?: string; verifiedRuns: VerifiedCodexRun[];
  receipts: ReceiptRef[]; cleanup: "verified" | "unknown";
};
export type CodexRenewalEvidenceOptions = {
  // Injection is for trusted captures/fictional tests only, never model callbacks.
  read?: (path: string) => Uint8Array;
  clock?: () => number;
};

// Deliberately small grammar: no arbitrary shell expression can substitute JSON
// for execution of the exact hashed, workspace-local probe.
function probeInvocation(command: string, workspace: string, probe: string): boolean {
  if (probe !== join(workspace, "probe.py") || !/^\/[A-Za-z0-9/_.-]+$/.test(probe)) return false;
  const commands = [`/usr/bin/python3 ${probe}`, "/usr/bin/python3 probe.py"];
  return commands.some(c => command === c || command === `/bin/zsh -c '${c}'`);
}
const STOP_POLL_GRACE_MS = 1500;
const CLEANUP_GRACE_MS = 5500;
function verifyRun(m: CodexRenewalManifest, r: Run, load: (r: ReceiptRef) => Uint8Array): VerifiedCodexRun {
  requireThat(r.startedAt >= m.startedAt && r.endedAt > r.startedAt, "invalid run interval");
  const stream = lines(load(r.stream), true), rollout = lines(load(r.rollout));
  const s = supervisorSchema.parse(json(load(r.supervisor)));
  requireThat(s.probeBeforeSha256 === m.probe.sha256 && s.probeAfterSha256 === m.probe.sha256, "probe changed before/after native run");
  requireThat(s.runId === m.runId && s.nativeId === r.nativeId && s.workspace === r.workspace && s.startedAt === r.startedAt && s.endedAt === r.endedAt, "supervisor custody mismatch");
  requireThat(stream.filter(x => x.type === "thread.started").length === 1 && stream.find(x => x.type === "thread.started")?.thread_id === r.nativeId, "stream native identity mismatch");
  requireThat(!stream.some(x => ["error", "turn.failed"].includes(x.type) || x.item?.type === "error" || (x.error !== undefined && x.error !== null) || (x.item?.error !== undefined && x.item.error !== null) || x.status === "failed" || x.item?.status === "failed" || (x.type === "item.completed" && x.item?.type === "command_execution" && x.item.status !== undefined && x.item.status !== "completed")), "native stream failed");
  requireThat(stream.every(x => (x.thread_id === undefined || x.thread_id === r.nativeId) && (x.model === undefined || x.model === m.model) && (x.effort === undefined || x.effort === r.effort)), "conflicting stream identity/model/effort");
  const meta = rollout.filter(x => x.type === "session_meta");
  requireThat(meta.length === 1 && rollout[0] === meta[0] && meta[0].payload?.id === r.nativeId && meta[0].payload?.cwd === r.workspace, "rollout native custody mismatch");
  const counters: { at: number; usage: Usage }[] = [];
  let contexts = 0, completed = 0, previousAt = r.startedAt;
  const aborts:number[]=[];
  const calls = new Map<string, { name: string; arguments: string }>();
  const outputs = new Map<string, string>();
  for (const row of rollout) {
    const timestamp = at(row, r);
    requireThat(timestamp >= previousAt, "native clock regression"); previousAt = timestamp;
    const p = row.payload;
    requireThat((p?.model === undefined || p.model === m.model) && (p?.effort === undefined || p.effort === r.effort), "conflicting native model/effort");
    requireThat(!["error","turn.failed","task_failed"].includes(row.type) && !["error","turn_failed","task_failed"].includes(p?.type ?? "") && (p?.error === undefined || p.error === null), "native receipt error");
    if (row.type === "turn_context") {
      requireThat(p?.model === m.model && p.effort === r.effort && p.cwd === r.workspace, "native model/effort/cwd mismatch"); contexts++;
    }
    if (row.type === "event_msg" && p?.type === "token_count" && p.info !== null) {
      requireThat(contexts > 0, "accounting before native context");
      const u = tokenUsage(p?.info?.total_token_usage), prev = counters.at(-1)?.usage;
      requireThat(!prev || Object.keys(u).every(k => u[k as keyof Usage] >= prev[k as keyof Usage]), "native accounting regression");
      counters.push({ at: timestamp, usage: u });
    }
    if (row.type === "event_msg" && ["task_complete", "task_completed", "turn_complete"].includes(p?.type ?? "")) completed++;
    if (row.type === "event_msg" && p?.type === "error") throw Error("native turn failed");
    if (row.type === "event_msg" && p?.type === "turn_aborted") {aborts.push(timestamp);if(r.kind === "security" || s.stopAt === null || timestamp < s.stopAt)throw Error("native turn failed before controlled stop");}
    if (row.type === "response_item" && p?.type === "function_call") {
      requireThat(typeof p.call_id === "string" && !calls.has(p.call_id) && typeof p.name === "string" && typeof p.arguments === "string", "invalid/reused tool call");
      calls.set(p.call_id, { name: p.name, arguments: p.arguments });
    }
    if (row.type === "response_item" && p?.type === "function_call_output") {
      requireThat(typeof p.call_id === "string" && calls.has(p.call_id) && !outputs.has(p.call_id) && typeof p.output === "string", "unbound tool output"); outputs.set(p.call_id, p.output);
    }
  }
  requireThat(contexts > 0 && counters.length > 0, "missing native context/accounting");
  const total = counters.at(-1)!.usage;
  requireThat(total.total_tokens > 0, "positive native accounting required");
  let sampleAt = r.startedAt;
  for (const sample of s.samples) {
    requireThat(sample.at >= sampleAt && sample.at < (s.stopAt ?? r.endedAt), "invalid live sample interval"); sampleAt = sample.at;
    const counter = counters.findLast(c => c.at <= sample.at);
    requireThat(counter && sameUsage(counter.usage, tokenUsage(sample.usage)), "live accounting differs from native receipt");
  }
  requireThat(s.samples.some(x => x.usage.total_tokens > 0 && x.at <= s.before.at && s.before.at - x.at <= STOP_POLL_GRACE_MS), "no correlated positive accounting while alive");
  const owner = (row: z.infer<typeof processRow>) => row.pid === s.pid && row.identity === s.identity;
  const alive = (row: z.infer<typeof processRow>) => !row.state.startsWith("Z");
  requireThat(s.before.at >= r.startedAt && s.before.at < (s.stopAt ?? r.endedAt) && s.before.rows.some(x => owner(x) && alive(x)), "missing live process identity");
  requireThat(s.final.at >= r.endedAt && s.final.at < m.expiresAt, "invalid cleanup observation");
  const tables = [s.before, ...(s.afterTerm ? [s.afterTerm] : []), s.final];
  requireThat(tables.every((table, i) => new Set(table.rows.map(x => x.pid)).size === table.rows.length && (i === 0 || table.at >= tables[i - 1].at)), "invalid process table history");
  const observed = tables.flatMap(t => t.rows);
  const owned = s.before.rows.filter(owner);
  // Pin observed identities across all captures, including late descendants and
  // separately grouped/orphaned children. Unknown table reads already fail parsing.
  let changed = true;
  while (changed) { changed = false; for (const row of observed) if (!owned.includes(row) && owned.some(x => x.pid === row.parent)) { owned.push(row); changed = true; } }
  requireThat(!s.final.rows.some(x => alive(x) && (owned.some(o => o.pid === x.pid && o.identity === x.identity) || owned.some(o => o.group === x.group))), "owned process/group survived cleanup");
  const completions = stream.filter(x => x.type === "turn.completed");
  if (r.kind === "security") {
    requireThat(s.reason === "complete" && s.exitCode === 0 && s.signal === null && s.stopAt === null && s.timeBudget === null && s.tokenBudget === null && completions.length === 1 && completed === 1, "security native completion missing");
    const u = z.object({ input_tokens: integer, output_tokens: integer, cached_input_tokens: integer }).parse(completions[0].usage);
    requireThat(u && u.input_tokens === total.input_tokens && u.output_tokens === total.output_tokens && u.cached_input_tokens === total.cached_input_tokens, "stream/final accounting mismatch");
    requireThat(r.command && r.commandProbe, "command and native security probes required");
    requireThat(probeInvocation(r.command, r.workspace, m.probe.path), "exact hashed workspace probe invocation required");
    const c = commandSchema.parse(json(load(r.commandProbe)));
    requireThat(c.runId === m.runId && c.nativeId === r.nativeId && c.workspace === r.workspace && c.command === r.command && c.probeSha256 === m.probe.sha256 && c.probeAfterSha256 === m.probe.sha256 && c.startedAt >= m.startedAt && c.endedAt >= c.startedAt && c.endedAt <= r.startedAt, "command probe binding mismatch");
    for (const check of knownTargets) {
      const target = c.targets.filter(t => t.check === check);
      requireThat(target.length === 1 && target[0].existedAt >= m.startedAt && target[0].existedAt <= c.startedAt && target[0].kind === (check === "known_agent_socket" ? "socket" : "file"), "known-existing target preflight missing");
    }
    securityOutput(c.stdout);
    requireThat(calls.size === 1 && outputs.size === 1, "exactly one security probe tool attempt required; no retries");
    const matching = [...calls].filter(([, call]) => {
      if (!["exec_command", "functions.exec_command"].includes(call.name)) return false;
      const args = z.object({cmd:text,workdir:text.optional()}).parse(JSON.parse(call.arguments));
      return args.cmd === r.command && (args.workdir === undefined || args.workdir === r.workspace);
    });
    requireThat(matching.length === 1 && outputs.has(matching[0][0]), "actual native security invocation missing");
    securityOutput(outputs.get(matching[0][0])!);
    const executed = stream.filter(x => x.type === "item.completed" && x.item?.type === "command_execution");
    requireThat(executed.length === 1 && executed[0].item?.exit_code === 0 && probeInvocation(executed[0].item.command ?? "", r.workspace, m.probe.path), "native command exit unverified");
    securityOutput(text.parse(executed[0].item?.aggregated_output));
  } else {
    requireThat(!r.command && !r.commandProbe && s.reason === r.kind && s.stopAt !== null && s.signal !== "SIGABRT" && ((s.signal === null && s.exitCode !== null && s.exitCode > 0) || (s.exitCode === null && s.signal !== null)) && completions.length === 0 && completed === 0, "stop must precede completion");
    requireThat(s.stopAt! >= s.before.at && s.stopAt! < r.endedAt && s.signals.length > 0, "stop timing unverified");
    requireThat(s.signals.every(x => x.at >= s.stopAt! && x.at <= r.endedAt && owned.some(o => o.pid === x.pid && o.identity === x.identity)), "unbound stop signal");
    const firstTerm = s.signals.filter(x => x.pid === s.pid && x.identity === s.identity && x.signal === "SIGTERM").sort((a,b) => a.at-b.at)[0];
    requireThat(firstTerm, "owner TERM missing");
    requireThat(aborts.every(at => at >= firstTerm.at), "native turn aborted before actual controlled signal");
    requireThat(firstTerm.at - s.stopAt! <= STOP_POLL_GRACE_MS && r.endedAt - firstTerm.at <= CLEANUP_GRACE_MS && s.final.at - firstTerm.at <= CLEANUP_GRACE_MS, "stop signal or cleanup exceeded bounded grace");
    if (r.kind === "time") {
      requireThat(s.timeBudget !== null && s.tokenBudget === null && s.stopAt! - r.startedAt >= 50000 && s.stopAt! - r.startedAt <= 50000 + STOP_POLL_GRACE_MS, "original 25s estimate/50s stop required");
      const d = s.descendant;
      requireThat(d && owned.some(x => x.pid === d.pid && x.identity === d.identity && !owner(x)), "descendant identity missing");
      const term = s.signals.find(x => x.pid === d.pid && x.identity === d.identity && x.signal === "SIGTERM");
      const kill = s.signals.find(x => x.pid === d.pid && x.identity === d.identity && x.signal === "SIGKILL");
      requireThat(term && kill && s.afterTerm && s.afterTerm.at > term.at && s.afterTerm.at < kill.at && s.afterTerm.rows.some(x => x.pid === d.pid && x.identity === d.identity && alive(x)), "TERM-ignoring descendant not observed/killed");
    } else {
      requireThat(s.tokenBudget !== null && s.timeBudget === null && s.samples.some(x => x.usage.total_tokens >= s.tokenBudget!.pauseTokens), "independent 100-token budget stop unverified");
      const threshold = counters.find(x => x.usage.total_tokens >= s.tokenBudget!.pauseTokens);
      requireThat(threshold && s.stopAt! >= threshold.at && firstTerm.at - threshold.at <= STOP_POLL_GRACE_MS, "token threshold stop exceeded bounded polling grace");
    }
  }
  return { nativeId: r.nativeId, effort: r.effort, kind: r.kind, usage: total, observedAliveAt: sampleAt, stopAt: s.stopAt, cleanupAt: s.final.at };
}

export function collectCodexRenewalEvidence(input: unknown, options: CodexRenewalEvidenceOptions = {}): CodexRenewalEvidenceResult {
  const result: CodexRenewalEvidenceResult = { status: "refused", sourceAcceptance: "not-accepted", installedAcceptance: "not-run", qualificationReplacement: "not-performed", independentExactHeadChallenge: "required-before-release", verifiedRuns: [], receipts: [], cleanup: "unknown" };
  const read = options.read ?? readCodexRenewalReceipt, clock = options.clock ?? Date.now;
  const captured = new Map<string, Uint8Array>();
  let capturedBytes = 0;
  let rechecking = false;
  try {
    const m = manifestSchema.parse(input); result.runId = m.runId;
    let previousClock = time.parse(clock());
    const checkClock = () => { const now = time.parse(clock()); requireThat(now >= previousClock && now >= m.startedAt && now < m.expiresAt, "clock regression or expired proof"); previousClock = now; return now; };
    requireThat(m.expiresAt > m.startedAt && m.expiresAt - m.startedAt <= 86400000, "bounded evidence lifetime required");
    checkClock();
    const load = (r: ReceiptRef) => {
      requireThat(!captured.has(r.path), "reused receipt path");
      const bytes = Uint8Array.from(read(r.path));
      requireThat(bytes.length <= 16 * 1024 * 1024 && sha256(bytes) === r.sha256, "missing/tampered receipt hash");
      capturedBytes += bytes.length;
      requireThat(capturedBytes <= 128 * 1024 * 1024, "receipt set exceeds bound");
      captured.set(r.path, bytes); result.receipts.push({ ...r }); return bytes;
    };
    // Preserve originals byte-for-byte by never writing them. Explicit waiver
    // remains false/deferred on all Codex entries; Claude is completely opaque.
    const q = z.record(z.string(), z.unknown()).parse(json(load(m.qualifications)));
    const deferred = z.object({ phoneVerified: z.literal(false), waiver: z.object({ phone: z.literal("deferred") }).strict() });
    for (const key of ["codex", "codex:medium", "codex:high"]) requireThat(deferred.safeParse(q[key]).success, "existing phone-deferred waiver required");
    for (const source of m.sources) load(source);
    load(m.probe);
    const subscription = z.object({ argv: z.tuple([z.literal("codex"), z.literal("login"), z.literal("status")]), code: z.literal(0), signal: z.null(), stdout: z.string(), stderr: z.string(), observedAt: time }).strict().parse(json(load(m.subscription)));
    requireThat(subscription.observedAt >= m.startedAt && subscription.observedAt <= previousClock && /Logged in using ChatGPT/i.test(subscription.stdout + "\n" + subscription.stderr) && !/API[\s_-]*key|third.party/i.test(subscription.stdout + "\n" + subscription.stderr), "actual subscription receipt missing");
    requireThat(new Set(m.runs.map(r => r.nativeId)).size === 6 && new Set(m.runs.map(r => `${r.effort}:${r.kind}`)).size === 6, "six distinct medium/high native runs required");
    for (const r of m.runs) { requireThat(r.endedAt <= previousClock, "future run"); result.verifiedRuns.push(verifyRun(m, r, load)); checkClock(); }
    // F1 superseded: final monotonic check AFTER every bound file is reread.
    // F2/F3 superseded within this boundary: no result files, fsync, replacement,
    // mutex or finally effects. I/O errors always return one conservative result.
    rechecking = true;
    for (const [path, bytes] of captured) requireThat(Buffer.from(read(path)).equals(Buffer.from(bytes)), "receipt/source changed during collection");
    const finalClock = checkClock();
    requireThat(result.verifiedRuns.every(r => r.cleanupAt <= finalClock), "future cleanup observation");
    result.status = "verified"; result.sourceAcceptance = "verified"; result.cleanup = "verified";
  } catch (error) { result.status = rechecking ? "uncertain" : "refused"; result.reason = String(error); }
  return result;
}
