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
  notificationCooldown: 2 * 60 * MINUTE,
  deliveryLease: MINUTE,
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
const billingSchema = z.object({ verified: z.boolean(), month: z.string().regex(/^\d{4}-\d{2}$/), allowed: z.boolean() });
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
export type HealthFinding = { condition: HealthCondition; status: HealthStatus; message: string; reasons: string[]; evidenceAt: number | null };
const windowSchema = z.object({
  id: text, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stage: z.enum(["qa", "production"]), startAt: timestamp, endAt: timestamp,
});
export type HealthReleaseWindow = z.infer<typeof windowSchema>;
const HEALTH_SOURCES = ["controller", "tick", "work", "releases", "disk", "qualifications", "aws", "billing", "holds"] as const;
type HealthSource = typeof HEALTH_SOURCES[number];
const observationSchema = z.object({ observedAt: timestamp, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), conflicted: z.boolean() });
export const HealthMemorySchema = z.object({
  releaseObligations: z.array(windowSchema),
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
type Issue = { status: "incident" | "unknown"; reason: string };
const issue = (reason: string, status: Issue["status"] = "incident"): Issue => ({ status, reason });
function finding(condition: HealthCondition, issues: Issue[], healthy: string, pending = false): HealthFinding {
  const status = issues.some(i => i.status === "unknown") ? "unknown" : issues.length ? "incident" : pending ? "pending" : "healthy";
  return { condition, status, message: issues.length ? `${issues[0].reason}.` : healthy, reasons: issues.map(i => i.reason), evidenceAt: null };
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
  else if (tick.value.result === "failure") tickIssues.push(issue("Factory tick failed; the controller needs attention"));
  else if (now - tick.value.lastSuccessAt > HEALTH_TIMING.tickMaxAge) tickIssues.push(issue("Factory has not completed a tick for over ten minutes"));
  findings.push(finding("tick", tickIssues, "Factory ticks are working again."));

  const workIssues: Issue[] = [];
  let workPending = false;
  if (!work.ok || work.value.claims.some(c => c.heldSince > work.observedAt) ||
    new Set(work.value.claims.map(c => c.id)).size !== work.value.claims.length ||
    new Set(work.value.running.map(p => p.sessionId)).size !== work.value.running.length ||
    new Set(work.value.running.map(p => p.pid)).size !== work.value.running.length ||
    new Set(work.value.running.map(p => p.nativeSessionId)).size !== work.value.running.length ||
    work.value.running.some(p => !live(p, now, work.observedAt)) ||
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
  findings.push(finding("disk", !disk.ok ? [unavailable("disk")] : disk.value.usedFraction > 0.85 ? [issue("Factory disk use is above 85%; free space safely")] : [], "Factory disk use is back within its limit."));

  function qualificationIssues(through?: number): Issue[] {
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
    aws.value.expiresAt <= now ? [issue("Factory AWS access has expired; renew access")] :
    aws.value.expiresAt < finalEnd ? [issue("Factory AWS access expires before tonight's final release window ends")] : [];
  findings.push(finding("aws", awsIssues, "Factory AWS access covers tonight's final release window."));

  function preflight(window: HealthReleaseWindow): Issue[] {
    releaseSources.push(billing, aws, qualifications, disk, holds);
    const issues: Issue[] = [];
    if (!billing.ok || !billing.value.verified || billing.value.month !== window.day.slice(0, 7)) issues.push(unavailable("release billing"));
    else if (!billing.value.allowed) issues.push(issue("Factory release is blocked by billing"));
    if (!aws.ok || !aws.value.verified) issues.push(unavailable("release AWS access"));
    else if (aws.value.expiresAt < window.endAt) issues.push(issue("Factory AWS access will not cover the release window"));
    issues.push(...qualificationIssues(window.endAt));
    if (!disk.ok) issues.push(unavailable("release disk"));
    else if (disk.value.usedFraction > 0.85) issues.push(issue("Factory release is blocked by low disk space"));
    if (!holds.ok) issues.push(unavailable("release holds"));
    else if (holds.value.blocking) issues.push(issue("Factory release is blocked by a hold"));
    return issues;
  }
  const candidates = new Map<string, HealthReleaseWindow>();
  for (const w of [...healthReleaseWindows(now, -1), ...tonight, ...memory.releaseObligations]) {
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
  return { at: now, findings, memory: { releaseObligations: unresolved, observations: memory.observations } };
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
    version: 1, lastAt: null, memory: { releaseObligations: [], observations: {} }, outbox: [],
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

/**
 * Serializable incident/outbox transition; no I/O. Every actionable condition opens
 * one episode; only fresh, positive healthy evidence clears it. Pending/unknown
 * never clears. Clearing evidence must be strictly newer than the last actionable
 * evaluation, including one with wholly missing inputs. Source watermarks and
 * contradiction latches survive restart. IDs are distinct after every reopen.
 * Opening and recovery intents are retained, ordered per condition and recipient.
 * Repeated openings AND repeated recoveries wait two hours after the preceding
 * same-kind delivery, including reopen. A recovery may follow its opening promptly.
 * Rapid flapping retains history; deferred messages are historical transition
 * receipts, not assertions about current state. There are no periodic reminders.
 */
export function transitionFactoryHealth(raw: FactoryHealthState, snapshot: FactoryHealthSnapshot, clock: HealthClock): { state: FactoryHealthState; evaluation: HealthEvaluation } {
  const now = time(clock), state = copyState(raw, now);
  const priorObligations = state.memory.releaseObligations;
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
  if (state.episodes.release.at(-1)?.clearedAt === null) {
    // Evaluator success is provisional until the incident transition accepts its
    // proof. Rejected, pending or partial recovery must not erase old obligations
    // and let a later day's healthy readback clear a different historical failure.
    state.memory.releaseObligations = [...new Map([...priorObligations, ...state.memory.releaseObligations].map(w => [w.id, w])).values()];
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
  // Preserve open/clear/reopen ordering even when one destination is unavailable.
  for (const previous of state.outbox) {
    if (previous.id === n.id) break;
    if (previous.condition !== n.condition) continue;
    const receipt = delivered(previous, recipient);
    if (!receipt) return false;
    if (previous.kind === n.kind && now - receipt.finishedAt! < HEALTH_TIMING.notificationCooldown) return false;
  }
  return true;
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
