import { z } from "zod";
import { createHash } from "node:crypto";

const MINUTE = 60_000;
export const HEALTH_TIMING = Object.freeze({
  evidenceMaxAge: 5 * MINUTE,
  billingMaxAge: 24 * 60 * MINUTE,
  stalledAfter: 20 * MINUTE,
  missedReleaseAfter: 5 * MINUTE,
  preflightBefore: 60 * MINUTE,
  qualificationBefore: 3 * 60 * MINUTE,
  tickMaxAge: 10 * MINUTE,
  deliveryLease: MINUTE,
  // A message nobody confirmed after this long is a fault of its own.
  unconfirmedAfter: 10 * MINUTE,
  // This many openings inside the window become one "keeps recurring" message,
  // which stays open until the condition has been quiet this long.
  recurringOpenings: 3,
  recurringWindow: 60 * MINUTE,
  recurringQuiet: 30 * MINUTE,
  // While Alido Mail's daily budget for Vincent is not running, the job spaces
  // its own routine openings for him this far apart, per condition.
  ungatedSpacing: 2 * 60 * MINUTE,
});
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const text = z.string().trim().min(1);
const count = z.number().int().nonnegative();
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
const workSchema = z.object({
  complete: z.literal(true),
  ready: count,
  building: count,
  claims: z.array(z.object({ id: text, heldSince: timestamp, receipt: text })),
  running: z.array(HealthProcessSchema),
  // Collector-proven continuous lack of claims/running work, not ticket age.
  inactiveSince: timestamp.nullable(),
  refusal: z.enum(["billing", "aws", "qualification", "disk", "hold", "capacity", "usage", "approval", "unknown"]).nullable(),
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
const awsSchema = z.object({ verified: z.boolean(), credentialId: text, expiresAt: timestamp });
const billingSchema = z.object({ verified: z.boolean(), month: z.string().regex(/^\d{4}-\d{2}$/), allowed: z.boolean(), billingObservedAt: timestamp.optional() });
const diskSchema = z.object({ usedFraction: z.number().min(0).max(1) });
const holdsSchema = z.object({ blocking: z.boolean() });
const controllerSchema = z.object({
  paused: z.boolean(),
  actor: z.enum(["Vincent", "Coordinator", "other"]).nullable(),
  actorVerified: z.boolean(),
  changedAt: timestamp,
  changeReceipt: text,
});
const tickSchema = z.object({ lastSuccessAt: timestamp, lastAttemptAt: timestamp, result: z.enum(["success", "failure"]) });
const readinessSchema=z.object({day:text,validThrough:timestamp,ready:z.boolean(),missing:z.array(text)});
const releaseSchema = z.object({
  // A complete readback must cover the obligation's start and this observation.
  completeFrom: timestamp,
  completeThrough: timestamp,
  windows: z.array(z.object({
    windowId: text,
    state: z.enum(["scheduled", "running", "success", "failed"]),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    receipt: text,
  })),
});

/**
 * Part 2 collector/bridge contract (version 1). JSON only; all times are epoch ms.
 * Each source is independently observed. Omission/null/error is UNKNOWN, never an
 * empty successful read. "ok" requires an authoritative receipt and a complete
 * readback, not fixtures, guessed defaults, queued work, or last known good data.
 * Snapshot and source freshness are <=5 minutes (billing <24h, current Toronto
 * month); future observations are unknown. Boundary timestamps are inclusive.
 * Source observation times must never regress. Different evidence at the same
 * observation time is contradictory until a strictly newer observation arrives.
 * Collectors must verify qualification flags, configured model/effort and native
 * evidence before setting verified. Renewal custody must bind the exact expiring
 * qualification to a live native session, wake and process start identity.
 * Work inactivity is a proven continuous interval. A reset of that interval alone
 * cannot clear a known work incident. Claims and process inventories are complete.
 * Billing/holds are effective existing policy decisions; this module sets no policy.
 * Releases are required daily at 20:00 and 21:30 America/Toronto, one-minute start
 * windows. AWS/qualification preflight validity must extend through the window end.
 * On bootstrap, release readback must include yesterday; thereafter unresolved
 * obligations remain in returned memory across midnight and DST until proven success.
 * A successful release must bind its window ID and a timely start; changing dates,
 * losing evidence, or merely passing a preflight never clears a missed release.
 * Persist the entire returned HealthState atomically BEFORE attempting delivery,
 * with an exclusive transaction or compare-and-swap across concurrent evaluators.
 * No collector, scheduler, filesystem, network, bridge or runtime is installed here.
 */
export const FactoryHealthSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: timestamp,
  controller: evidence(controllerSchema).nullish(),
  tick: evidence(tickSchema).nullish(),
  work: evidence(workSchema).nullish(),
  releases: evidence(releaseSchema).nullish(),
  readiness:evidence(readinessSchema).nullish(),
  disk: evidence(diskSchema).nullish(),
  qualifications: evidence(qualificationSchema).nullish(),
  aws: evidence(awsSchema).nullish(),
  billing: evidence(billingSchema).nullish(),
  holds: evidence(holdsSchema).nullish(),
});
export type FactoryHealthSnapshot = z.infer<typeof FactoryHealthSnapshotSchema>;
export type HealthClock = () => number;
export const HEALTH_CONDITIONS = ["controller", "tick", "pause", "work", "release", "disk", "qualification", "aws"] as const;
export type HealthCondition = typeof HEALTH_CONDITIONS[number];
export type HealthStatus = "healthy" | "pending" | "incident" | "unknown";
/** `hardStop` marks an incident Vincent must hear at once: disk over its limit, AWS access lost, tick not completing. */
export type HealthFinding = { condition: HealthCondition; status: HealthStatus; message: string; reasons: string[]; evidenceAt: number | null; hardStop?: true };
const windowSchema = z.object({
  id: text, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stage: z.enum(["qa", "production"]), startAt: timestamp, endAt: timestamp,
});
export type HealthReleaseWindow = z.infer<typeof windowSchema>;
const HEALTH_SOURCES = ["controller", "tick", "work", "releases", "readiness", "disk", "qualifications", "aws", "billing", "holds"] as const;
type HealthSource = typeof HEALTH_SOURCES[number];
const observationSchema = z.object({ observedAt: timestamp, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), conflicted: z.boolean() });
export const HealthMemorySchema = z.object({
  releaseObligations: z.array(windowSchema),
  releaseEvaluatedAt: timestamp.optional(),
  observations: z.partialRecord(z.enum(HEALTH_SOURCES), observationSchema),
});
export type HealthMemory = z.infer<typeof HealthMemorySchema>;
export type HealthEvaluation = { at: number; findings: HealthFinding[]; memory: HealthMemory };

function time(clock: HealthClock) { return timestamp.parse(clock()); }
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function local(at: number) {
  const parts = formatter.formatToParts(at);
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  return { year: part("year"), month: part("month"), date: part("day"), hour: part("hour"), minute: part("minute") };
}
function dayOf(at: number) {
  const p = local(at);
  return `${p.year.toString().padStart(4, "0")}-${p.month.toString().padStart(2, "0")}-${p.date.toString().padStart(2, "0")}`;
}
/** Convert each civil date separately: never add 24h across Toronto's DST change. */
export function healthReleaseWindows(at: number, dayOffset = 0): HealthReleaseWindow[] {
  timestamp.parse(at);
  const p = local(at), date = new Date(Date.UTC(p.year, p.month - 1, p.date + dayOffset));
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
  const civilDay = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  return ([ ["qa", 20, 0], ["production", 21, 30] ] as const).map(([stage, hour, minute]) => {
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let startAt = target;
    // These evening times are neither ambiguous nor absent on a DST transition.
    for (let i = 0; i < 3; i++) {
      const q = local(startAt);
      startAt += target - Date.UTC(q.year, q.month - 1, q.date, q.hour, q.minute);
    }
    if (dayOf(startAt) !== civilDay || local(startAt).hour !== hour || local(startAt).minute !== minute) throw Error("Toronto window conversion failed");
    return { id: `${civilDay}:${stage}`, day: civilDay, stage, startAt, endAt: startAt + MINUTE };
  });
}

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
type Issue = { status: "incident" | "unknown"; reason: string; hardStop?: true };
const issue = (reason: string, status: Issue["status"] = "incident"): Issue => ({ status, reason });
const hardStop = (reason: string): Issue => ({ status: "incident", reason, hardStop: true });
function finding(condition: HealthCondition, issues: Issue[], healthy: string, pending = false): HealthFinding {
  const status = issues.some(i => i.status === "unknown") ? "unknown" : issues.length ? "incident" : pending ? "pending" : "healthy";
  const found: HealthFinding = { condition, status, message: issues.length ? `${issues[0].reason}.` : healthy, reasons: issues.map(i => i.reason), evidenceAt: null };
  if (status === "incident" && issues.some(i => i.hardStop)) found.hardStop = true;
  return found;
}
const unavailable = (source: string) => issue(`Factory ${source} evidence is unavailable or unreliable`, "unknown");

/** Pure deterministic evaluator. Retain memory even when all source reads fail. */
export function evaluateFactoryHealth(snapshot: FactoryHealthSnapshot, clock: HealthClock, prior: HealthMemory = { releaseObligations: [], observations: {} }): HealthEvaluation {
  const now = time(clock), memory = HealthMemorySchema.parse(prior);
  const validSnapshot = snapshot.version === 1 && timestamp.safeParse(snapshot.capturedAt).success && snapshot.capturedAt <= now && now - snapshot.capturedAt <= HEALTH_TIMING.evidenceMaxAge;
  const capturedAt = validSnapshot ? snapshot.capturedAt : -1;
  const source = <T extends z.ZodType>(name: HealthSource, schema: T, age = HEALTH_TIMING.evidenceMaxAge) =>
    read(schema, snapshot[name], now, capturedAt, memory.observations, name, age);
  const controller = source("controller", controllerSchema);
  const tick = source("tick", tickSchema);
  const work = source("work", workSchema);
  const releases = source("releases", releaseSchema);
  const readiness=snapshot.readiness===undefined?undefined:source("readiness",readinessSchema);
  const disk = source("disk", diskSchema);
  const qualifications = source("qualifications", qualificationSchema);
  const aws = source("aws", awsSchema);
  const billing = source("billing", billingSchema, HEALTH_TIMING.billingMaxAge - 1);
  const holds = source("holds", holdsSchema);
  const releaseSources: Reading<unknown>[] = [releases];
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
  const tickIssues: Issue[] = [];
  if (!tick.ok || tick.value.lastSuccessAt > tick.value.lastAttemptAt || tick.value.lastAttemptAt > tick.observedAt ||
    (tick.value.result === "success" && tick.value.lastSuccessAt !== tick.value.lastAttemptAt)) tickIssues.push(unavailable("tick"));
  else if (tick.value.result === "failure") tickIssues.push(hardStop("Factory tick failed; the controller needs attention"));
  else if (now - tick.value.lastSuccessAt > HEALTH_TIMING.tickMaxAge) tickIssues.push(hardStop("Factory has not completed a tick for over ten minutes"));
  findings.push(finding("tick", tickIssues, "Factory ticks are working again."));

  const renewalProcesses = qualifications.ok ? qualifications.value.records.flatMap(r => r.renewal ? [r.renewal.process] : []) : [];
  const custodyConflict = work.ok && work.value.running.some(p => renewalProcesses.some(r => p.pid === r.pid || p.sessionId === r.sessionId || p.nativeSessionId === r.nativeSessionId));
  const workIssues: Issue[] = [];
  let workPending = false;
  if (!work.ok || custodyConflict || work.value.claims.some(c => c.heldSince > work.observedAt) ||
    new Set(work.value.claims.map(c => c.id)).size !== work.value.claims.length ||
    new Set(work.value.running.map(p => p.sessionId)).size !== work.value.running.length ||
    new Set(work.value.running.map(p => p.pid)).size !== work.value.running.length ||
    new Set(work.value.running.map(p => p.nativeSessionId)).size !== work.value.running.length ||
    work.value.running.some(p => p.purpose !== "work" || !live(p, now, work.observedAt)) ||
    (work.value.inactiveSince !== null && (work.value.inactiveSince > work.observedAt || work.value.claims.length > 0 || work.value.running.length > 0))) {
    workIssues.push(unavailable("work activity"));
  } else if (work.value.ready + work.value.building > 0 && !work.value.claims.length && !work.value.running.length) {
    if (work.value.inactiveSince === null) workIssues.push(unavailable("work inactivity"));
    else if (now - work.value.inactiveSince >= HEALTH_TIMING.stalledAfter) {
      const reasons = {
        billing: "billing has blocked it", aws: "AWS access is unavailable", qualification: "worker qualification is missing",
        disk: "disk space is too low", hold: "a hold is blocking it", capacity: "worker capacity is unavailable",
        usage: "the usage gate has blocked it", approval: "approval is missing", unknown: "the refusal reason is unavailable",
      };
      const refusal = work.value.refusal ?? "unknown";
      workIssues.push(issue(`Factory work has waited twenty minutes because ${reasons[refusal]}`, refusal === "unknown" ? "unknown" : "incident"));
    } else workPending = true;
  }
  findings.push(finding("work", workIssues, workPending ? "Factory work is waiting." : "Factory work is moving again or the queue is empty.", workPending));
  findings.push(finding("disk", !disk.ok ? [unavailable("disk")] : disk.value.usedFraction > 0.85 ? [hardStop("Factory disk use is above 85%; free space safely")] : [], "Factory disk use is back within its limit."));

  function qualificationIssues(through?: number): Issue[] {
    if (!qualifications.ok || custodyConflict) return [unavailable("qualification")];
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
      if (through !== undefined) {
        if (record.expiresAt < through) issues.push(issue("A required qualification will expire before the release window ends"));
      } else if (record.expiresAt - now <= HEALTH_TIMING.qualificationBefore) {
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
  const tonight = healthReleaseWindows(now);
  const finalEnd = tonight[1].endAt;
  const awsIssues = !aws.ok || !aws.value.verified ? [unavailable("AWS access")] :
    aws.value.expiresAt <= now ? [hardStop("Factory AWS access has expired; renew access")] :
    aws.value.expiresAt < finalEnd ? [issue("Factory AWS access expires before tonight's final release window ends")] : [];
  findings.push(finding("aws", awsIssues, "Factory AWS access covers tonight's final release window."));

  function preflight(window: HealthReleaseWindow): Issue[] {
    releaseSources.push(billing, aws, qualifications, disk, holds);
    const issues: Issue[] = [];
    if (!billing.ok || !billing.value.verified || billing.value.month !== window.day.slice(0, 7) || (billing.value.billingObservedAt!==undefined && (billing.value.billingObservedAt>billing.observedAt || now-billing.value.billingObservedAt>=HEALTH_TIMING.billingMaxAge))) issues.push(unavailable("release billing"));
    else if (!billing.value.allowed) issues.push(issue("Factory release is blocked by billing"));
    if (!aws.ok || !aws.value.verified) issues.push(unavailable("release AWS access"));
    else if (aws.value.expiresAt < window.endAt) issues.push(issue("Factory AWS access will not cover the release window"));
    issues.push(...qualificationIssues(window.endAt));
    if (!disk.ok) issues.push(unavailable("release disk"));
    else if (disk.value.usedFraction > 0.85) issues.push(issue("Factory release is blocked by low disk space"));
    if (!holds.ok) issues.push(unavailable("release holds"));
    else if (holds.value.blocking) issues.push(issue("Factory release is blocked by a hold"));
    if(readiness){
      if(!readiness.ok||readiness.value.day!==window.day||readiness.value.validThrough<window.endAt||readiness.value.ready!==(readiness.value.missing.length===0))issues.push(unavailable("effective release preflight"));
      else if(!readiness.value.ready)issues.push(issue("Factory release preflight has missing inputs; review its complete readiness report"));
      releaseSources.push(readiness);
    }
    return issues;
  }
  const candidates = new Map<string, HealthReleaseWindow>();
  if (memory.releaseEvaluatedAt !== undefined && memory.releaseEvaluatedAt > now) throw Error("Health evaluation clock regressed");
  const gapDays = memory.releaseEvaluatedAt === undefined ? 1 : Math.ceil((now - memory.releaseEvaluatedAt) / (24 * 60 * MINUTE)) + 1;
  // Refuse an unbounded gap rather than silently forgetting release obligations.
  if (gapDays > 366) throw Error("Release coverage gap needs retained-history reconciliation");
  const intervening = Array.from({length: gapDays}, (_, i) => healthReleaseWindows(now, -i - 1)).flat().filter(w => memory.releaseEvaluatedAt !== undefined && w.startAt > memory.releaseEvaluatedAt);
  for (const w of [...healthReleaseWindows(now, -1), ...intervening, ...tonight, ...memory.releaseObligations]) {
    // Validate retained obligations against civil time, never trust edited timestamps.
    const canonical = healthReleaseWindows(w.startAt).find(c => c.id === w.id);
    if (!canonical || canonical.day !== w.day || canonical.stage !== w.stage || canonical.startAt !== w.startAt || canonical.endAt !== w.endAt) throw Error("Invalid retained release obligation");
    if (now >= w.startAt - HEALTH_TIMING.preflightBefore) candidates.set(w.id, w);
  }
  const releaseIssues: Issue[] = [], unresolved: HealthReleaseWindow[] = [];
  let releasePending = false;
  const releaseValid = releases.ok && releases.value.completeFrom <= releases.value.completeThrough &&
    releases.value.completeThrough === releases.observedAt &&
    new Set(releases.value.windows.map(w => w.windowId)).size === releases.value.windows.length;
  for (const w of [...candidates.values()].sort((a, b) => a.startAt - b.startAt)) {
    const record = releases.ok ? releases.value.windows.find(r => r.windowId === w.id) : undefined;
    const validStart = record?.startedAt !== null && record?.startedAt !== undefined &&
      record.startedAt >= w.startAt && record.startedAt < w.endAt && record.startedAt <= (releases.ok ? releases.observedAt : now);
    const validRecord = !record || (record.state === "scheduled" ? record.startedAt === null && record.completedAt === null :
      record.state === "failed" ? (record.startedAt === null || validStart) && (record.completedAt === null || (record.completedAt >= (record.startedAt ?? w.startAt) && record.completedAt <= (releases.ok ? releases.observedAt : now))) :
      validStart && (record.state === "running" ? record.completedAt === null : record.completedAt !== null && record.completedAt >= record.startedAt! && record.completedAt <= (releases.ok ? releases.observedAt : now)));
    if (!releaseValid || !releases.ok || releases.value.completeFrom > w.startAt || !validRecord) {
      releaseIssues.push(unavailable("release readback")); unresolved.push(w); continue;
    }
    if (record?.state === "success") continue;
    unresolved.push(w);
    if (record?.state === "failed") releaseIssues.push(issue("Factory scheduled release failed; review the release evidence"));
    else if (now < w.startAt) releaseIssues.push(...preflight(w));
    else if (now - w.startAt >= HEALTH_TIMING.missedReleaseAfter && record?.state !== "running") releaseIssues.push(issue("Factory scheduled release has not started within five minutes"));
    else releasePending = true;
  }
  findings.push(finding("release", releaseIssues, "Factory release checks are clear and known failures have verified success.", releasePending));
  const proof: Record<HealthCondition, Reading<unknown>[]> = {
    controller: [controller], pause: [controller], tick: [tick], work: [work],
    disk: [disk], qualification: [qualifications], aws: [aws], release: releaseSources,
  };
  for (const f of findings) {
    const times = proof[f.condition].map(r => r.ok ? r.observedAt : null);
    f.evidenceAt = times.every((at): at is number => at !== null) ? Math.min(...times) : null;
  }
  return { at: now, findings, memory: { releaseObligations: unresolved, releaseEvaluatedAt: now, observations: memory.observations } };
}

const recipientSchema = z.enum(["Vincent", "Coordinator"]);
export type HealthRecipient = z.infer<typeof recipientSchema>;
const RECIPIENTS = recipientSchema.options;
const attemptSchema = z.object({
  id: text, at: timestamp, result: z.enum(["in-flight", "failed", "delivered"]),
  finishedAt: timestamp.nullable(), receipt: text.nullable(),
  // The last retry of an attempt still in flight. `at` stays the first time it was handed over.
  renewedAt: timestamp.optional(),
});
const deliverySchema = z.object({
  attempts: z.array(attemptSchema),
  // Archived, never sent. The reason says what replaced it.
  superseded: z.object({ at: timestamp, reason: text }).optional(),
});
// "recurring" is the one message for a condition that keeps opening; "settled" closes it.
const notificationSchema = z.object({
  id: text, incidentId: text, condition: z.enum(HEALTH_CONDITIONS), kind: z.enum(["opening", "recovery", "recurring", "settled"]),
  createdAt: timestamp, message: text, hardStop: z.literal(true).optional(),
  deliveries: z.object({ Vincent: deliverySchema, Coordinator: deliverySchema }),
});
export type HealthNotification = z.infer<typeof notificationSchema>;
const episodeSchema = z.object({
  id: text, openingId: text, recoveryId: text, openedAt: timestamp, lastActionableAt: timestamp, clearedAt: timestamp.nullable(),
  // The episode before it did not clear: it became a hard stop, and this one says so.
  continues: z.literal(true).optional(),
});
const recurrenceSchema = z.object({ id: text, startedAt: timestamp, endedAt: timestamp.nullable() });
const stateSchema = z.object({
  version: z.literal(1), lastAt: timestamp.nullable(), memory: HealthMemorySchema,
  episodes: z.record(z.enum(HEALTH_CONDITIONS), z.array(episodeSchema)),
  // Absent in state stored before the flap rule existed.
  recurrences: z.partialRecord(z.enum(HEALTH_CONDITIONS), z.array(recurrenceSchema)).default({}),
  outbox: z.array(notificationSchema),
});
function checkState(state: z.infer<typeof stateSchema>) {
  const fail = () => { throw Error("Contradictory health state"); };
  const within = (at: number) => state.lastAt !== null && at <= state.lastAt;
  if (Object.values(state.memory.observations).some(o => !within(o.observedAt))) fail();
  if (new Set(state.outbox.map(n => n.id)).size !== state.outbox.length) fail();
  type Expected = { id: string; incidentId: string; kind: HealthNotification["kind"]; at: number };
  // The stored messages of these kinds must be exactly the expected ones, in order.
  const matches = (condition: HealthCondition, kinds: HealthNotification["kind"][], expected: Expected[]) => {
    const actual = state.outbox.filter(n => n.condition === condition && kinds.includes(n.kind));
    if (actual.length !== expected.length) fail();
    actual.forEach((n, i) => {
      const e = expected[i];
      if (!e || n.id !== e.id || n.incidentId !== e.incidentId || n.kind !== e.kind || n.createdAt !== e.at ||
        /[\r\n]/.test(n.message) || n.message.length > 180 || (n.hardStop && n.kind !== "opening")) fail();
      for (const recipient of RECIPIENTS) {
        const { attempts, superseded } = n.deliveries[recipient];
        if (superseded && (superseded.at < n.createdAt || !within(superseded.at) || attempts.some(a => a.result !== "failed"))) fail();
        attempts.forEach((a, j) => {
          if (a.id !== `${n.id}:${recipient}:attempt:${j + 1}` || a.at < n.createdAt || !within(a.at) || (j > 0 && a.at < attempts[j - 1].at)) fail();
          if (a.renewedAt !== undefined && (a.renewedAt < a.at || !within(a.renewedAt))) fail();
          if (a.result === "in-flight") {
            if (a.finishedAt !== null || a.receipt !== null) fail();
          } else if (a.finishedAt === null || a.receipt === null || a.finishedAt < a.at || !within(a.finishedAt)) fail();
        });
      }
    });
    return expected.length;
  };
  let expectedCount = 0;
  const hardStops = new Set(state.outbox.filter(n => n.hardStop).map(n => n.id));
  for (const condition of HEALTH_CONDITIONS) {
    const expected: Expected[] = [];
    const episodes = state.episodes[condition];
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i], previous = episodes[i - 1];
      const id = `factory-health:${condition}:${i + 1}:${e.openedAt}`;
      if (e.id !== id || e.openingId !== `${id}:opening` || e.recoveryId !== `${id}:recovery` || !within(e.openedAt) ||
        !within(e.lastActionableAt) || e.lastActionableAt < e.openedAt ||
        (previous && (previous.clearedAt === null || e.openedAt < previous.clearedAt))) fail();
      if (e.continues && (previous?.clearedAt !== e.openedAt || !hardStops.has(e.openingId) || hardStops.has(previous.openingId))) fail();
      expected.push({ id: e.openingId, incidentId: id, kind: "opening", at: e.openedAt });
      if (e.clearedAt !== null) {
        if (!within(e.clearedAt) || e.clearedAt < e.lastActionableAt) fail();
        expected.push({ id: e.recoveryId, incidentId: id, kind: "recovery", at: e.clearedAt });
      }
    }
    expectedCount += matches(condition, ["opening", "recovery"], expected);
    const recurring: Expected[] = [], spans = state.recurrences[condition] ?? [];
    spans.forEach((r, i) => {
      const previous = spans[i - 1];
      if (r.id !== `factory-health:${condition}:recurring:${r.startedAt}` || !within(r.startedAt) ||
        (previous && (previous.endedAt === null || r.startedAt < previous.endedAt))) fail();
      recurring.push({ id: `${r.id}:opening`, incidentId: r.id, kind: "recurring", at: r.startedAt });
      if (r.endedAt !== null) {
        if (!within(r.endedAt) || r.endedAt < r.startedAt) fail();
        recurring.push({ id: `${r.id}:recovery`, incidentId: r.id, kind: "settled", at: r.endedAt });
      }
    });
    expectedCount += matches(condition, ["recurring", "settled"], recurring);
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
    version: 1, lastAt: null, memory: { releaseObligations: [], observations: {} }, outbox: [], recurrences: {},
    episodes: { controller: [], tick: [], pause: [], work: [], release: [], disk: [], qualification: [], aws: [] },
  };
}
function copyState(raw: FactoryHealthState, at: number): FactoryHealthState {
  // Invalid/unsupported persisted state is an error, never a silent dedup reset.
  const state = FactoryHealthStateSchema.parse(raw);
  if (state.lastAt !== null && at < state.lastAt) throw Error("Health clock moved backwards");
  state.lastAt = at;
  return state;
}

function delivered(n: HealthNotification, recipient: HealthRecipient) {
  return n.deliveries[recipient].attempts.find(a => a.result === "delivered");
}
type Recurrence = z.infer<typeof recurrenceSchema>;
const clip = (message: string) => message.length > 180 ? `${message.slice(0, 179)}…` : message;
const recurringMessage = (message: string) => clip(`Keeps recurring: ${message}`);
/** Everything raised while a "keeps recurring" span was open: its own message and each opening, in order. */
function raisedIn(state: FactoryHealthState, condition: HealthCondition, span: Recurrence) {
  const openings = new Set(state.episodes[condition].filter(e => e.openedAt >= span.startedAt && (span.endedAt === null || e.openedAt <= span.endedAt)).map(e => e.openingId));
  return state.outbox.filter(n => n.id === `${span.id}:opening` || openings.has(n.id));
}
/**
 * Whether this recipient has already been told what `opening` says since the
 * span opened. The "keeps recurring" message stands only for the fault it
 * names, and never for a hard stop. So a different fault, and the first hard
 * stop, raised while it is open are still sent, once each. A hard stop is
 * said again on a later day, however long the span has been open.
 */
function saidIn(state: FactoryHealthState, span: Recurrence, opening: HealthNotification, recipient: HealthRecipient) {
  for (const n of raisedIn(state, opening.condition, span)) {
    if (n.deliveries[recipient].superseded) continue;
    if (n.kind === "recurring") { if (!opening.hardStop && n.message === recurringMessage(opening.message)) return true; }
    else if (n.createdAt < opening.createdAt && n.message === opening.message && (!opening.hardStop || dayOf(n.createdAt) === dayOf(opening.createdAt))) return true;
  }
  return false;
}
/** Good news follows only bad news this recipient actually received. */
function told(state: FactoryHealthState, n: HealthNotification, recipient: HealthRecipient) {
  if (n.kind === "recovery") return state.outbox.some(o => o.incidentId === n.incidentId && o.kind === "opening" && delivered(o, recipient));
  if (n.kind !== "settled") return true;
  const span = (state.recurrences[n.condition] ?? []).find(r => r.id === n.incidentId);
  return span !== undefined && raisedIn(state, n.condition, span).some(o => delivered(o, recipient));
}
/**
 * Current state wins. A message that was never handed to the bridge is
 * archived, not sent, once it no longer describes the condition: an opening
 * whose episode has cleared goes with its recovery, a recovery goes when the
 * condition has reopened, and while a "keeps recurring" message is open an
 * opening that repeats what was already said goes, with every recovery (the
 * "stopped recurring" message closes them all). Nothing is deleted, and a
 * "keeps recurring" message is never archived here. A message already handed
 * over is left to its readback.
 */
function settle(state: FactoryHealthState, now: number): number {
  let archived = 0;
  const waiting = (n: HealthNotification, r: HealthRecipient) => !n.deliveries[r].superseded && n.deliveries[r].attempts.length === 0;
  const archive = (n: HealthNotification, r: HealthRecipient, reason: string) => { n.deliveries[r].superseded = { at: now, reason }; archived++; };
  const byId = new Map(state.outbox.map(n => [n.id, n]));
  for (const condition of HEALTH_CONDITIONS) {
    const episodes = state.episodes[condition], spans = state.recurrences[condition] ?? [];
    const spanAt = (at: number) => spans.find(r => at >= r.startedAt && (r.endedAt === null || at <= r.endedAt));
    episodes.forEach((e, i) => {
      const opening = byId.get(e.openingId)!, recovery = e.clearedAt === null ? null : byId.get(e.recoveryId)!;
      const span = spanAt(e.openedAt), worsened = episodes[i + 1]?.continues === true;
      for (const r of RECIPIENTS) {
        if (waiting(opening, r)) {
          if (span && saidIn(state, span, opening, r)) archive(opening, r, "covered by the keeps-recurring message");
          else if (e.clearedAt !== null) archive(opening, r, worsened ? "became a hard stop before it was sent" : "cleared before it was sent");
        }
        if (!recovery || !waiting(recovery, r)) continue;
        if (worsened) archive(recovery, r, "the condition became a hard stop");
        else if (opening.deliveries[r].superseded) archive(recovery, r, "its opening was never sent");
        else if (spanAt(e.clearedAt!)) archive(recovery, r, "covered by the keeps-recurring message");
        else if (i < episodes.length - 1) archive(recovery, r, "the condition reopened before this was sent");
      }
    });
    for (const span of spans) {
      const closing = span.endedAt === null ? null : byId.get(`${span.id}:recovery`)!;
      if (!closing) continue;
      // It closes for whoever was told anything while the span was open.
      const raised = raisedIn(state, condition, span);
      for (const r of RECIPIENTS) if (waiting(closing, r) && raised.every(n => n.deliveries[r].superseded)) archive(closing, r, "its opening was never sent");
    }
  }
  return archived;
}
/** The archive pass alone, for replaying a stored outbox without evaluating anything. */
export function settleHealthOutbox(raw: FactoryHealthState, clock: HealthClock): { state: FactoryHealthState; archived: number } {
  const now = time(clock), state = copyState(raw, now);
  return { state, archived: settle(state, now) };
}

/**
 * Serializable incident/outbox transition; no I/O. Every actionable condition opens
 * one episode; only fresh, positive healthy evidence clears it. Pending/unknown
 * never clears. Clearing evidence must be strictly newer than the last actionable
 * evaluation, including one with wholly missing inputs. Source watermarks and
 * contradiction latches survive restart. IDs are distinct after every reopen.
 * Delivery follows the current state (see `settle`): there is no ordering queue
 * and no waiting period, so one stuck message can never hold back a newer one.
 * So that this cannot hide a fault that comes and goes, the third opening of a
 * condition inside an hour also raises one "keeps recurring" message, which
 * that rule never archives and which closes with one "stopped recurring" message
 * after the condition has been quiet for thirty minutes. No periodic reminders.
 * A hard stop is always said by an opening of its own: an open episode that
 * becomes one is closed and opened again as a hard stop in the same evaluation.
 */
export function transitionFactoryHealth(raw: FactoryHealthState, snapshot: FactoryHealthSnapshot, clock: HealthClock): { state: FactoryHealthState; evaluation: HealthEvaluation; archived: number } {
  const now = time(clock), state = copyState(raw, now);
  const priorObligations = state.memory.releaseObligations;
  const evaluation = evaluateFactoryHealth(snapshot, () => now, state.memory);
  state.memory = evaluation.memory;
  const enqueue = (condition: HealthCondition, incidentId: string, id: string, kind: HealthNotification["kind"], message: string, hardStop?: true) => {
    state.outbox.push({ id, incidentId, condition, kind, createdAt: now, message, ...(hardStop && { hardStop }),
      deliveries: { Vincent: { attempts: [] }, Coordinator: { attempts: [] } } });
  };
  for (const f of evaluation.findings) {
    const episodes = state.episodes[f.condition], current = episodes.at(-1);
    const spans = state.recurrences[f.condition] ?? [], recurring = spans.at(-1)?.endedAt === null ? spans.at(-1)! : null;
    if (f.status === "incident" || f.status === "unknown") {
      const continues = current?.clearedAt === null;
      if (current && continues) {
        current.lastActionableAt = now;
        // Already said, unless it has just become a hard stop. That is never left
        // inside a routine episode: this one is closed (its closing message is
        // archived, never sent) and a hard-stop episode is opened in its place.
        if (!f.hardStop || state.outbox.some(n => n.id === current.openingId && n.hardStop)) continue;
        current.clearedAt = now;
        enqueue(f.condition, current.id, current.recoveryId, "recovery", "Replaced by a hard stop for the same condition.");
      }
      const id = `factory-health:${f.condition}:${episodes.length + 1}:${now}`;
      const episode = { id, openingId: `${id}:opening`, recoveryId: `${id}:recovery`, openedAt: now, lastActionableAt: now, clearedAt: null, ...(continues && { continues }) };
      episodes.push(episode);
      enqueue(f.condition, id, episode.openingId, "opening", f.message, f.hardStop);
      // Count only openings since the last "keeps recurring" message closed. A
      // fault that became a hard stop did not come back, so it is not counted twice.
      const since = Math.max(now - HEALTH_TIMING.recurringWindow, spans.at(-1)?.endedAt ?? -1);
      if (!recurring && episodes.filter(e => e.openedAt > since && !e.continues).length >= HEALTH_TIMING.recurringOpenings) {
        const recurringId = `factory-health:${f.condition}:recurring:${now}`;
        (state.recurrences[f.condition] ??= []).push({ id: recurringId, startedAt: now, endedAt: null });
        enqueue(f.condition, recurringId, `${recurringId}:opening`, "recurring", recurringMessage(f.message));
      }
      continue;
    }
    if (f.status === "healthy" && current?.clearedAt === null) {
      if (f.evidenceAt === null || f.evidenceAt <= current.lastActionableAt) {
        f.status = "unknown";
        f.message = "Factory recovery needs newer verified evidence.";
        f.reasons = ["Recovery evidence does not follow the last actionable observation"];
        continue;
      }
      current.clearedAt = now;
      enqueue(f.condition, current.id, current.recoveryId, "recovery", f.message);
    }
    if (recurring && current && current.clearedAt !== null && now - current.clearedAt >= HEALTH_TIMING.recurringQuiet) {
      recurring.endedAt = now;
      enqueue(f.condition, recurring.id, `${recurring.id}:recovery`, "settled", clip(`Stopped recurring: ${f.message}`));
    }
  }
  if (state.episodes.release.at(-1)?.clearedAt === null) {
    // Evaluator success is provisional until the incident transition accepts its
    // proof. Rejected, pending or partial recovery must not erase old obligations
    // and let a later day's healthy readback clear a different historical failure.
    state.memory.releaseObligations = [...new Map([...priorObligations, ...state.memory.releaseObligations].map(w => [w.id, w])).values()];
  }
  return { state, evaluation, archived: settle(state, now) };
}

export type HealthDeliveryCommand = {
  notificationId: string; recipient: HealthRecipient; idempotencyKey: string;
  attemptId: string; message: string; kind: HealthNotification["kind"]; createdAt: number;
  condition: HealthCondition; hardStop: boolean;
};
/**
 * `ungated`: Alido Mail's daily budget for Vincent is not running, so the job
 * spaces its own routine openings for him. `early`: hand over a recovery whose
 * opening Alido Mail is holding, so that the two can be cancelled together.
 */
export type HealthDeliveryRules = { ungated?: boolean; early?: boolean };
/**
 * A routine opening for Vincent that waits because another for the same
 * condition was handed over less than two hours ago. No queue forms behind it:
 * if its condition clears while it waits it is archived, like any other.
 */
function spaced(state: FactoryHealthState, n: HealthNotification, recipient: HealthRecipient, now: number) {
  if (recipient !== "Vincent" || n.kind !== "opening" || n.hardStop || n.deliveries.Vincent.attempts.length) return false;
  return state.outbox.some(o => o.condition === n.condition && o.kind === "opening" && o.id !== n.id &&
    o.deliveries.Vincent.attempts.length > 0 && now - o.deliveries.Vincent.attempts[0]!.at < HEALTH_TIMING.ungatedSpacing);
}
/** A recovery whose routine opening was handed to Alido Mail and is neither confirmed nor archived. Never a hard stop's. */
function behindOpening(state: FactoryHealthState, n: HealthNotification, recipient: HealthRecipient) {
  if (n.kind !== "recovery") return false;
  const opening = state.outbox.find(o => o.incidentId === n.incidentId && o.kind === "opening");
  return opening !== undefined && !opening.hardStop && opening.deliveries[recipient].attempts.length > 0 && !delivered(opening, recipient) && !opening.deliveries[recipient].superseded;
}
function due(state: FactoryHealthState, n: HealthNotification, recipient: HealthRecipient, now: number, rules: HealthDeliveryRules = {}) {
  const { attempts, superseded } = n.deliveries[recipient], last = attempts.at(-1);
  if (superseded || delivered(n, recipient) || n.createdAt > now || (last && now - (last.finishedAt ?? last.renewedAt ?? last.at) < HEALTH_TIMING.deliveryLease)) return false;
  if (rules.ungated && spaced(state, n, recipient, now)) return false;
  return told(state, n, recipient) || (rules.early === true && behindOpening(state, n, recipient));
}

/** Eligible intents only. Begin and persist the attempt before handing it to a bridge. */
export function pendingHealthDeliveries(raw: FactoryHealthState, clock: HealthClock, rules: Pick<HealthDeliveryRules, "ungated"> = {}): { notificationId: string; recipient: HealthRecipient }[] {
  const now = time(clock), state = copyState(raw, now);
  return state.outbox.flatMap(n => RECIPIENTS.filter(r => due(state, n, r, now, rules)).map(recipient => ({ notificationId: n.id, recipient })));
}

/**
 * Recoveries that wait for an opening Alido Mail has not confirmed, and those
 * already handed over early. The caller hands one over early only when Alido
 * Mail reports its opening held, and reads the answer back on later runs.
 * `attemptId` is null until it has been handed over.
 */
export function earlyHealthRecoveries(raw: FactoryHealthState, clock: HealthClock): { notificationId: string; openingId: string; recipient: HealthRecipient; attemptId: string | null }[] {
  const now = time(clock), state = copyState(raw, now);
  return state.outbox.flatMap(n => n.kind !== "recovery" ? [] : RECIPIENTS.flatMap(recipient => {
    const { attempts, superseded } = n.deliveries[recipient], opening = state.outbox.find(o => o.incidentId === n.incidentId && o.kind === "opening")!;
    if (superseded || delivered(n, recipient) || delivered(opening, recipient) || !(attempts.length || behindOpening(state, n, recipient))) return [];
    return [{ notificationId: n.id, openingId: opening.id, recipient, attemptId: attempts.at(-1)?.id ?? null }];
  }));
}

/**
 * Messages nobody has confirmed more than ten minutes after they were first
 * handed over (or created, if they never were). A recovery still waiting for
 * its opening is not listed; its opening is. Nor is an opening that is waiting
 * out the spacing above. The caller asks the bridge why each one is unconfirmed
 * before calling it a fault.
 */
export function unconfirmedHealthDeliveries(raw: FactoryHealthState, clock: HealthClock, rules: Pick<HealthDeliveryRules, "ungated"> = {}): { notificationId: string; recipient: HealthRecipient; condition: HealthCondition; kind: HealthNotification["kind"]; hardStop: boolean; createdAt: number }[] {
  const now = time(clock), state = copyState(raw, now);
  return state.outbox.flatMap(n => RECIPIENTS.filter(r => {
    const { attempts, superseded } = n.deliveries[r];
    if (superseded || delivered(n, r) || now - (attempts[0]?.at ?? n.createdAt) <= HEALTH_TIMING.unconfirmedAfter) return false;
    return told(state, n, r) && !(rules.ungated && spaced(state, n, r, now));
  }).map(recipient => ({ notificationId: n.id, recipient, condition: n.condition, kind: n.kind, hardStop: n.hardStop === true, createdAt: n.createdAt })));
}

/**
 * Lease is durable, not proof of delivery. After a crash retry the SAME bridge
 * idempotencyKey. Part 2 must provide idempotent insertion/readback per destination;
 * this helper cannot guarantee exactly-once transport with a non-idempotent sender.
 * A bridge-queued receipt alone must not be acknowledged as delivered. A retry
 * renews the attempt still in flight, so a long wait does not grow the state.
 */
export function beginHealthDelivery(raw: FactoryHealthState, notificationId: string, recipient: HealthRecipient, clock: HealthClock, rules: HealthDeliveryRules = {}): { state: FactoryHealthState; command: HealthDeliveryCommand } {
  const now = time(clock), state = copyState(raw, now);
  recipientSchema.parse(recipient);
  const n = state.outbox.find(n => n.id === notificationId);
  if (!n || !due(state, n, recipient, now, rules)) throw Error("Health delivery is not due");
  const attempts = n.deliveries[recipient].attempts;
  let attempt = attempts.at(-1);
  if (attempt?.result === "in-flight") attempt.renewedAt = now;
  else attempts.push(attempt = { id: `${n.id}:${recipient}:attempt:${attempts.length + 1}`, at: now, result: "in-flight", finishedAt: null, receipt: null });
  return { state, command: { notificationId, recipient, idempotencyKey: `${n.id}:${recipient}`, attemptId: attempt.id, message: n.message, kind: n.kind, createdAt: n.createdAt, condition: n.condition, hardStop: n.hardStop === true } };
}

/** Exact attempt acknowledgement. Separate receipts; failure is retained and retryable. */
export function acknowledgeHealthDelivery(raw: FactoryHealthState, command: Pick<HealthDeliveryCommand, "notificationId" | "recipient" | "idempotencyKey" | "attemptId">, result: { state: "delivered" | "failed"; receipt: string }, clock: HealthClock): FactoryHealthState {
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

/**
 * Archives one handed-over message that Alido Mail says it will never send on
 * its own: a row it cancelled, or folded into another message. Its recovery is
 * archived by the next transition. A delivered message is never archived.
 */
export function supersedeHealthDelivery(raw: FactoryHealthState, notificationId: string, recipient: HealthRecipient, reason: string, clock: HealthClock): FactoryHealthState {
  const now = time(clock), state = copyState(raw, now);
  recipientSchema.parse(recipient);
  text.parse(reason);
  const n = state.outbox.find(n => n.id === notificationId);
  if (!n || delivered(n, recipient)) throw Error("Health delivery cannot be superseded");
  const delivery = n.deliveries[recipient];
  if (delivery.superseded) return state;
  for (const a of delivery.attempts) if (a.result === "in-flight") Object.assign(a, { result: "failed", finishedAt: now, receipt: reason });
  delivery.superseded = { at: now, reason };
  return state;
}
