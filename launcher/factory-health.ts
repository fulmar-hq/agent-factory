import { z } from "zod";
import { createHash } from "node:crypto";

const MINUTE = 60_000;
export const HEALTH_TIMING = Object.freeze({
  evidenceMaxAge: 5 * MINUTE,
  qualificationBefore: 3 * 60 * MINUTE,
  tickMaxAge: 10 * MINUTE,
  notificationCooldown: 2 * 60 * MINUTE,
  deliveryLease: MINUTE,
});
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const text = z.string().trim().min(1);
const evidence = <T extends z.ZodType>(value: T) => z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), observedAt: timestamp, receipt: text, value }),
  z.object({ state: z.enum(["unavailable", "error"]), observedAt: timestamp, reason: text }),
]);

/** PID alone, a queued wake, or a model's assertion is never live process custody. */
export const HealthProcessSchema = z.object({
  sessionId: text,
  nativeSessionId: text,
  provider: text,
  purpose: z.enum(["work", "qualification-renewal"]),
  qualificationId: text.nullable(),
  qualificationExpiresAt: timestamp.nullable(),
  wakeId: text.nullable(),
  pid: z.number().int().positive(),
  startedAt: timestamp,
  observedAt: timestamp,
  recordedIdentity: text,
  observedIdentity: text,
  receipt: text,
  state: z.enum(["running", "queued", "stopped", "unknown"]),
});
const qualificationSchema = z.object({
  required: z.array(text).min(1),
  records: z.array(z.object({
    provider: text,
    qualificationId: text,
    verified: z.boolean(),
    expiresAt: timestamp,
    receipt: text,
    renewal: z.object({
      qualificationId: text,
      expiresAt: timestamp,
      wakeId: text,
      sessionId: text,
      nativeSessionId: text,
      receipt: text,
      process: HealthProcessSchema,
    }).nullable(),
  })),
});
const diskSchema = z.object({ usedFraction: z.number().min(0).max(1) });
const controllerSchema = z.object({
  paused: z.boolean(),
  actor: z.enum(["Vincent", "Coordinator", "other"]).nullable(),
  actorVerified: z.boolean(),
  changedAt: timestamp,
  changeReceipt: text,
});
const tickSchema = z.object({ lastSuccessAt: timestamp, lastAttemptAt: timestamp, result: z.enum(["success", "failure"]) });
/**
 * Collector/bridge contract (version 1). JSON only; all times are epoch ms.
 * Each source is independently observed. Omission/null/error is UNKNOWN, never an
 * empty successful read. Snapshot and source freshness are <=5 minutes; future
 * observations are unknown. Source observation times must never regress.
 * Different evidence at the same observation time is contradictory until a
 * strictly newer observation arrives. Collectors must verify qualification flags,
 * configured model/effort and native evidence before setting verified.
 * Persist the entire returned HealthState atomically BEFORE attempting delivery.
 * Retired 2026-11-14: work-supply, nightly release, release AWS/billing/hold
 * checks. The ticket queue and nightly release no longer run from this factory.
 */
export const FactoryHealthSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: timestamp,
  controller: evidence(controllerSchema).nullish(),
  tick: evidence(tickSchema).nullish(),
  disk: evidence(diskSchema).nullish(),
  qualifications: evidence(qualificationSchema).nullish(),
});
export type FactoryHealthSnapshot = z.infer<typeof FactoryHealthSnapshotSchema>;
export type HealthClock = () => number;
export const HEALTH_CONDITIONS = ["controller", "tick", "pause", "disk", "qualification"] as const;
export type HealthCondition = typeof HEALTH_CONDITIONS[number];
export type HealthStatus = "healthy" | "pending" | "incident" | "unknown";
export type HealthFinding = { condition: HealthCondition; status: HealthStatus; message: string; reasons: string[]; evidenceAt: number | null };
const HEALTH_SOURCES = ["controller", "tick", "disk", "qualifications"] as const;
type HealthSource = typeof HEALTH_SOURCES[number];
const observationSchema = z.object({ observedAt: timestamp, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), conflicted: z.boolean() });
export const HealthMemorySchema = z.object({
  observations: z.partialRecord(z.enum(HEALTH_SOURCES), observationSchema),
});
export type HealthMemory = z.infer<typeof HealthMemorySchema>;
export type HealthEvaluation = { at: number; findings: HealthFinding[]; memory: HealthMemory };

function time(clock: HealthClock) { return timestamp.parse(clock()); }

type Reading<T> = { ok: true; value: T; observedAt: number } | { ok: false };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function read<T extends z.ZodType>(schema: T, raw: unknown, now: number, capturedAt: number,
  observations: HealthMemory["observations"], source: HealthSource, age = HEALTH_TIMING.evidenceMaxAge): Reading<z.infer<T>> {
  const parsed = evidence(z.unknown()).safeParse(raw);
  if (!parsed.success || parsed.data.observedAt > capturedAt) return { ok: false };
  const value = schema.safeParse(parsed.data.state === "ok" ? parsed.data.value : undefined);
  const payload = parsed.data.state === "ok" ? { ...parsed.data, value: value.success ? value.data : "invalid" } : parsed.data;
  const fingerprint = createHash("sha256").update(canonical(payload)).digest("hex");
  const previous = observations[source];
  if (previous && parsed.data.observedAt < previous.observedAt) return { ok: false };
  if (previous && parsed.data.observedAt === previous.observedAt && (previous.conflicted || previous.fingerprint !== fingerprint)) {
    previous.conflicted = true;
    return { ok: false };
  }
  observations[source] = { observedAt: parsed.data.observedAt, fingerprint, conflicted: false };
  if (parsed.data.state !== "ok" || !value.success || now - parsed.data.observedAt > age) return { ok: false };
  return { ok: true, value: value.data, observedAt: parsed.data.observedAt };
}
function live(p: z.infer<typeof HealthProcessSchema>, at: number, observedAt: number) {
  return p.state === "running" && p.recordedIdentity === p.observedIdentity &&
    p.startedAt <= p.observedAt && p.observedAt <= observedAt && at - p.observedAt <= HEALTH_TIMING.evidenceMaxAge;
}
type Issue = { status: "incident" | "unknown"; reason: string };
const issue = (reason: string, status: Issue["status"] = "incident"): Issue => ({ status, reason });
function finding(condition: HealthCondition, issues: Issue[], healthy: string, pending = false): HealthFinding {
  const status = issues.some(i => i.status === "unknown") ? "unknown" : issues.length ? "incident" : pending ? "pending" : "healthy";
  return { condition, status, message: issues.length ? `${issues[0].reason}.` : healthy, reasons: issues.map(i => i.reason), evidenceAt: null };
}
const unavailable = (source: string) => issue(`Factory ${source} evidence is unavailable or unreliable`, "unknown");

/** Pure deterministic evaluator. Retain memory even when all source reads fail. */
export function evaluateFactoryHealth(snapshot: FactoryHealthSnapshot, clock: HealthClock, prior: HealthMemory = { observations: {} }): HealthEvaluation {
  const now = time(clock), memory = HealthMemorySchema.parse(prior);
  const validSnapshot = snapshot.version === 1 && timestamp.safeParse(snapshot.capturedAt).success && snapshot.capturedAt <= now && now - snapshot.capturedAt <= HEALTH_TIMING.evidenceMaxAge;
  const capturedAt = validSnapshot ? snapshot.capturedAt : -1;
  const source = <T extends z.ZodType>(name: HealthSource, schema: T) =>
    read(schema, snapshot[name], now, capturedAt, memory.observations, name);
  const controller = source("controller", controllerSchema);
  const tick = source("tick", tickSchema);
  const disk = source("disk", diskSchema);
  const qualifications = source("qualifications", qualificationSchema);
  const findings: HealthFinding[] = [];
  const controllerValid = controller.ok && controller.value.changedAt <= controller.observedAt;
  findings.push(finding("controller", controllerValid ? [] : [unavailable("controller")], "Factory controller evidence is available."));
  const pauseIssues: Issue[] = [];
  if (!controllerValid) pauseIssues.push(unavailable("pause"));
  else if (controller.value.paused) {
    if (!controller.value.actorVerified || !controller.value.actor) pauseIssues.push(unavailable("pause ownership"));
    else if (controller.value.actor !== "Vincent") pauseIssues.push(issue("Factory was paused by someone other than Vincent"));
  }
  findings.push(finding("pause", pauseIssues, "Factory pause ownership is clear."));
  // Only a sustained outage pages. One failed tick that the next tick repairs is
  // ordinary noise; ten minutes without any successful tick is not.
  const tickIssues: Issue[] = [];
  if (!tick.ok || tick.value.lastSuccessAt > tick.value.lastAttemptAt || tick.value.lastAttemptAt > tick.observedAt ||
    (tick.value.result === "success" && tick.value.lastSuccessAt !== tick.value.lastAttemptAt)) tickIssues.push(unavailable("tick"));
  else if (now - tick.value.lastSuccessAt > HEALTH_TIMING.tickMaxAge) tickIssues.push(issue("Factory has not completed a tick for over ten minutes"));
  findings.push(finding("tick", tickIssues, "Factory ticks are working again."));
  findings.push(finding("disk", !disk.ok ? [unavailable("disk")] : disk.value.usedFraction > 0.85 ? [issue("Factory disk use is above 85%; free space safely")] : [], "Factory disk use is back within its limit."));

  function qualificationIssues(): Issue[] {
    if (!qualifications.ok) return [unavailable("qualification")];
    const q = qualifications.value;
    const renewals = q.records.flatMap(r => r.renewal ? [r.renewal.process] : []);
    if (new Set(q.required).size !== q.required.length || new Set(q.records.map(r => r.provider)).size !== q.records.length ||
      q.records.some(r => !q.required.includes(r.provider)) ||
      new Set(renewals.map(p => p.pid)).size !== renewals.length ||
      new Set(renewals.map(p => p.nativeSessionId)).size !== renewals.length ||
      new Set(renewals.map(p => p.sessionId)).size !== renewals.length ||
      new Set(renewals.map(p => p.wakeId)).size !== renewals.length) return [unavailable("qualification inventory")];
    const issues: Issue[] = [];
    for (const provider of q.required) {
      const record = q.records.find(r => r.provider === provider);
      if (!record?.verified) { issues.push(unavailable("required qualification")); continue; }
      if (record.expiresAt <= now) { issues.push(issue("A required factory qualification has expired; renew it")); continue; }
      if (record.expiresAt - now <= HEALTH_TIMING.qualificationBefore) {
        const r = record.renewal;
        if (r && r.qualificationId === record.qualificationId && r.expiresAt === record.expiresAt &&
          r.sessionId === r.process.sessionId && r.nativeSessionId === r.process.nativeSessionId && r.wakeId === r.process.wakeId &&
          r.process.provider === provider && r.process.purpose === "qualification-renewal" &&
          r.process.qualificationId === record.qualificationId && r.process.qualificationExpiresAt === record.expiresAt &&
          live(r.process, now, qualifications.observedAt)) continue;
        issues.push(issue("A required qualification expires within three hours without verified renewal custody", r ? "unknown" : "incident"));
      }
    }
    return issues;
  }
  findings.push(finding("qualification", qualificationIssues(), "Factory qualifications have verified coverage or renewal custody."));
  const proof: Record<HealthCondition, Reading<unknown>[]> = {
    controller: [controller], pause: [controller], tick: [tick], disk: [disk], qualification: [qualifications],
  };
  for (const f of findings) {
    const times = proof[f.condition].map(r => r.ok ? r.observedAt : null);
    f.evidenceAt = times.every((at): at is number => at !== null) ? Math.min(...times) : null;
  }
  return { at: now, findings, memory: { observations: memory.observations } };
}

const recipientSchema = z.enum(["Vincent", "Coordinator"]);
export type HealthRecipient = z.infer<typeof recipientSchema>;
const attemptSchema = z.object({
  id: text, at: timestamp, result: z.enum(["in-flight", "failed", "delivered"]),
  finishedAt: timestamp.nullable(), receipt: text.nullable(),
});
const deliverySchema = z.object({ attempts: z.array(attemptSchema) });
const notificationSchema = z.object({
  id: text, incidentId: text, condition: z.enum(HEALTH_CONDITIONS), kind: z.enum(["opening", "recovery"]),
  createdAt: timestamp, message: text,
  deliveries: z.object({ Vincent: deliverySchema, Coordinator: deliverySchema }),
});
export type HealthNotification = z.infer<typeof notificationSchema>;
const episodeSchema = z.object({
  id: text, openingId: text, recoveryId: text, openedAt: timestamp, lastActionableAt: timestamp, clearedAt: timestamp.nullable(),
});
const stateSchema = z.object({
  version: z.literal(1), lastAt: timestamp.nullable(), memory: HealthMemorySchema,
  episodes: z.record(z.enum(HEALTH_CONDITIONS), z.array(episodeSchema)),
  outbox: z.array(notificationSchema),
});
function checkState(state: z.infer<typeof stateSchema>) {
  const fail = () => { throw Error("Contradictory health state"); };
  const within = (at: number) => state.lastAt !== null && at <= state.lastAt;
  if (Object.values(state.memory.observations).some(o => !within(o.observedAt))) fail();
  if (new Set(state.outbox.map(n => n.id)).size !== state.outbox.length) fail();
  let expectedCount = 0;
  for (const condition of HEALTH_CONDITIONS) {
    const expected: { id: string; incidentId: string; kind: "opening" | "recovery"; at: number }[] = [];
    const episodes = state.episodes[condition];
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i], previous = episodes[i - 1];
      const id = `factory-health:${condition}:${i + 1}:${e.openedAt}`;
      if (e.id !== id || e.openingId !== `${id}:opening` || e.recoveryId !== `${id}:recovery` || !within(e.openedAt) ||
        !within(e.lastActionableAt) || e.lastActionableAt < e.openedAt ||
        (previous && (previous.clearedAt === null || e.openedAt < previous.clearedAt))) fail();
      expected.push({ id: e.openingId, incidentId: id, kind: "opening", at: e.openedAt });
      if (e.clearedAt !== null) {
        if (!within(e.clearedAt) || e.clearedAt < e.lastActionableAt) fail();
        expected.push({ id: e.recoveryId, incidentId: id, kind: "recovery", at: e.clearedAt });
      }
    }
    const actual = state.outbox.filter(n => n.condition === condition);
    if (actual.length !== expected.length) fail();
    expectedCount += expected.length;
    actual.forEach((n, i) => {
      const e = expected[i];
      if (!e || n.id !== e.id || n.incidentId !== e.incidentId || n.kind !== e.kind || n.createdAt !== e.at ||
        /[\r\n]/.test(n.message) || n.message.length > 180) fail();
      for (const recipient of ["Vincent", "Coordinator"] as const) {
        const attempts = n.deliveries[recipient].attempts;
        attempts.forEach((a, j) => {
          if (a.id !== `${n.id}:${recipient}:attempt:${j + 1}` || a.at < n.createdAt || !within(a.at) || (j > 0 && a.at < attempts[j - 1].at)) fail();
          if (a.result === "in-flight") {
            if (a.finishedAt !== null || a.receipt !== null) fail();
          } else if (a.finishedAt === null || a.receipt === null || a.finishedAt < a.at || !within(a.finishedAt)) fail();
        });
      }
    });
  }
  if (state.outbox.length !== expectedCount) fail();
}
export const FactoryHealthStateSchema = stateSchema.superRefine((state, context) => {
  try { checkState(state); }
  catch { context.addIssue({ code: "custom", message: "Contradictory health state; retain it for reconciliation" }); }
});
export type FactoryHealthState = z.infer<typeof FactoryHealthStateSchema>;

export function initialFactoryHealthState(): FactoryHealthState {
  return {
    version: 1, lastAt: null, memory: { observations: {} }, outbox: [],
    episodes: { controller: [], tick: [], pause: [], disk: [], qualification: [] },
  };
}
function copyState(raw: FactoryHealthState, at: number): FactoryHealthState {
  // Invalid/unsupported persisted state is an error, never a silent dedup reset.
  const state = FactoryHealthStateSchema.parse(raw);
  if (state.lastAt !== null && at < state.lastAt) throw Error("Health clock moved backwards");
  state.lastAt = at;
  return state;
}

/**
 * Serializable incident/outbox transition; no I/O. Every actionable condition opens
 * one episode; only fresh, positive healthy evidence clears it. Pending/unknown
 * never clears. Clearing evidence must be strictly newer than the last actionable
 * evaluation, including one with wholly missing inputs. Source watermarks and
 * contradiction latches survive restart. IDs are distinct after every reopen.
 * Opening and recovery intents are retained per condition. Only the latest
 * transition of a condition is delivered; superseded ones stay as history.
 * Repeated openings AND repeated recoveries wait two hours after the preceding
 * same-kind delivery, including reopen. A recovery may follow its opening promptly
 * and is sent only where its opening was attempted. No periodic reminders.
 */
export function transitionFactoryHealth(raw: FactoryHealthState, snapshot: FactoryHealthSnapshot, clock: HealthClock): { state: FactoryHealthState; evaluation: HealthEvaluation } {
  const now = time(clock), state = copyState(raw, now);
  const evaluation = evaluateFactoryHealth(snapshot, () => now, state.memory);
  state.memory = evaluation.memory;
  const enqueue = (condition: HealthCondition, episode: z.infer<typeof episodeSchema>, kind: "opening" | "recovery", message: string) => {
    state.outbox.push({ id: kind === "opening" ? episode.openingId : episode.recoveryId, incidentId: episode.id, condition, kind, createdAt: now, message,
      deliveries: { Vincent: { attempts: [] }, Coordinator: { attempts: [] } } });
  };
  for (const f of evaluation.findings) {
    const episodes = state.episodes[f.condition], current = episodes.at(-1);
    if (f.status === "incident" || f.status === "unknown") {
      if (current?.clearedAt === null) { current.lastActionableAt = now; continue; }
      const id = `factory-health:${f.condition}:${episodes.length + 1}:${now}`;
      const episode = { id, openingId: `${id}:opening`, recoveryId: `${id}:recovery`, openedAt: now, lastActionableAt: now, clearedAt: null };
      episodes.push(episode);
      enqueue(f.condition, episode, "opening", f.message);
    } else if (f.status === "healthy" && current?.clearedAt === null) {
      if (f.evidenceAt === null || f.evidenceAt <= current.lastActionableAt) {
        f.status = "unknown";
        f.message = "Factory recovery needs newer verified evidence.";
        f.reasons = ["Recovery evidence does not follow the last actionable observation"];
        continue;
      }
      current.clearedAt = now;
      enqueue(f.condition, current, "recovery", f.message);
    }
  }
  return { state, evaluation };
}

export type HealthDeliveryCommand = {
  notificationId: string; recipient: HealthRecipient; idempotencyKey: string;
  attemptId: string; message: string; kind: "opening" | "recovery"; createdAt: number;
};
function delivered(n: HealthNotification, recipient: HealthRecipient) {
  return n.deliveries[recipient].attempts.find(a => a.result === "delivered");
}
function due(state: FactoryHealthState, n: HealthNotification, recipient: HealthRecipient, now: number) {
  const attempts = n.deliveries[recipient].attempts, last = attempts.at(-1);
  if (delivered(n, recipient) || n.createdAt > now || (last && now - (last.finishedAt ?? last.at) < HEALTH_TIMING.deliveryLease)) return false;
  // Only a condition's current transition is news. A superseded opening or
  // recovery stays in health/state.sqlite as history and is never drip-fed later.
  const same = state.outbox.filter(x => x.condition === n.condition);
  if (same.at(-1)?.id !== n.id) return false;
  // A recovery is sent only to someone we tried to tell about the opening.
  if (n.kind === "recovery" && !same.some(x => x.incidentId === n.incidentId && x.kind === "opening" && x.deliveries[recipient].attempts.length)) return false;
  const sent = same.filter(x => x.kind === n.kind).map(x => delivered(x, recipient)).filter(x => x !== undefined).at(-1);
  return !sent || now - sent.finishedAt! >= HEALTH_TIMING.notificationCooldown;
}

/** Eligible intents only. Begin and persist the attempt before handing it to a bridge. */
export function pendingHealthDeliveries(raw: FactoryHealthState, clock: HealthClock): { notificationId: string; recipient: HealthRecipient }[] {
  const now = time(clock), state = copyState(raw, now);
  return state.outbox.flatMap(n => (["Vincent", "Coordinator"] as const)
    .filter(r => due(state, n, r, now)).map(recipient => ({ notificationId: n.id, recipient })));
}

/**
 * Lease is durable, not proof of delivery. After a crash retry the SAME bridge
 * idempotencyKey. Part 2 must provide idempotent insertion/readback per destination;
 * this helper cannot guarantee exactly-once transport with a non-idempotent sender.
 * A bridge-queued receipt alone must not be acknowledged as delivered.
 */
export function beginHealthDelivery(raw: FactoryHealthState, notificationId: string, recipient: HealthRecipient, clock: HealthClock): { state: FactoryHealthState; command: HealthDeliveryCommand } {
  const now = time(clock), state = copyState(raw, now);
  recipientSchema.parse(recipient);
  const n = state.outbox.find(n => n.id === notificationId);
  if (!n || !due(state, n, recipient, now)) throw Error("Health delivery is not due");
  const attempts = n.deliveries[recipient].attempts, attemptId = `${n.id}:${recipient}:attempt:${attempts.length + 1}`;
  attempts.push({ id: attemptId, at: now, result: "in-flight", finishedAt: null, receipt: null });
  return { state, command: { notificationId, recipient, idempotencyKey: `${n.id}:${recipient}`, attemptId, message: n.message, kind: n.kind, createdAt: n.createdAt } };
}

/** Exact attempt acknowledgement. Separate receipts; failure is retained and retryable. */
export function acknowledgeHealthDelivery(raw: FactoryHealthState, command: HealthDeliveryCommand, result: { state: "delivered" | "failed"; receipt: string }, clock: HealthClock): FactoryHealthState {
  const now = time(clock), state = copyState(raw, now);
  recipientSchema.parse(command.recipient);
  z.enum(["delivered", "failed"]).parse(result.state);
  text.parse(result.receipt);
  const n = state.outbox.find(n => n.id === command.notificationId);
  if (!n || command.idempotencyKey !== `${n.id}:${command.recipient}`) throw Error("Unknown health delivery");
  const attempts = n.deliveries[command.recipient].attempts;
  const attempt = attempts.find(a => a.id === command.attemptId);
  if (!attempt) throw Error("Unknown health delivery attempt");
  if (attempt.result !== "in-flight") {
    if (attempt.result === result.state && attempt.receipt === result.receipt) return state;
    throw Error("Conflicting health delivery acknowledgement");
  }
  // Late positive readback is valid for the same stable bridge key. It stops retry,
  // but cannot overwrite another destination or turn a failure into delivery.
  attempt.result = result.state;
  attempt.finishedAt = now;
  attempt.receipt = result.receipt;
  return state;
}
