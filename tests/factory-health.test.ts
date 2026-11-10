import { describe, expect, test } from "bun:test";
import {
  acknowledgeHealthDelivery, beginHealthDelivery, evaluateFactoryHealth,
  FactoryHealthSnapshotSchema, FactoryHealthStateSchema, HEALTH_CONDITIONS, HEALTH_TIMING,
  healthReleaseWindows, initialFactoryHealthState, pendingHealthDeliveries, transitionFactoryHealth,
  type FactoryHealthSnapshot, type FactoryHealthState, type HealthCondition,
  type HealthProcessSchema,
} from "../launcher/factory-health";
import type { z } from "zod";

const M = 60_000, H = 60 * M;
const AT = Date.parse("2026-11-10T18:00:00-05:00");
const ok = <T>(at: number, value: T) => ({ state: "ok" as const, observedAt: at, receipt: "fictional-source-readback", value });
type Value<K extends keyof FactoryHealthSnapshot> = Extract<NonNullable<FactoryHealthSnapshot[K]>, { state: "ok" }> extends { value: infer T } ? T : never;
function fixture(at = AT) {
  const windows = [...healthReleaseWindows(at, -1), ...healthReleaseWindows(at)];
  return {
    version: 1 as const, capturedAt: at,
    controller: ok<Value<"controller">>(at, { paused: false, actor: null, actorVerified: false, changedAt: at, changeReceipt: "fictional-control" }),
    tick: ok<Value<"tick">>(at, { lastSuccessAt: at, lastAttemptAt: at, result: "success" }),
    work: ok<Value<"work">>(at, { complete: true, ready: 0, building: 0, claims: [], running: [], inactiveSince: null, refusal: null }),
    releases: ok<Value<"releases">>(at, {
      completeFrom: 0, completeThrough: at,
      windows: windows.map(w => ({ windowId: w.id, state: at >= w.startAt ? "success" : "scheduled", startedAt: at >= w.startAt ? w.startAt : null, completedAt: at >= w.startAt ? w.startAt : null, receipt: "fictional-window-readback" })),
    }),
    disk: ok<Value<"disk">>(at, { usedFraction: 0.5 }),
    qualifications: ok<Value<"qualifications">>(at, {
      required: ["codex", "claude"], records: ["codex", "claude"].map(provider => ({ provider, qualificationId: `fictional-${provider}-qualification`, verified: true, expiresAt: at + 24 * H, receipt: "fictional-qualified", renewal: null })),
    }),
    aws: ok<Value<"aws">>(at, { verified: true, credentialId: "fictional-aws-session", expiresAt: at + 24 * H }),
    billing: ok<Value<"billing">>(at, { verified: true, month: windows.at(-1)!.day.slice(0, 7), allowed: true }),
    holds: ok<Value<"holds">>(at, { blocking: false }),
  } satisfies FactoryHealthSnapshot;
}
function process(at = AT): z.infer<typeof HealthProcessSchema> {
  return { sessionId: "fictional-session", nativeSessionId: "fictional-native", wakeId: "fictional-wake", pid: 123,
    provider: "codex", purpose: "work", qualificationId: null, qualificationExpiresAt: null,
    startedAt: at - M, observedAt: at, recordedIdentity: "123:start-one", observedIdentity: "123:start-one", receipt: "fictional-native-receipt", state: "running" };
}
function renewing(s: ReturnType<typeof fixture>) {
  const q = s.qualifications.value.records[0];
  q.renewal = { qualificationId: q.qualificationId, expiresAt: q.expiresAt, wakeId: "fictional-wake", sessionId: "fictional-session", nativeSessionId: "fictional-native", receipt: "fictional-renewal", process: process(s.capturedAt) };
  Object.assign(q.renewal.process, { purpose: "qualification-renewal", qualificationId: q.qualificationId, qualificationExpiresAt: q.expiresAt });
  return q.renewal;
}
const get = (snapshot: FactoryHealthSnapshot, condition: HealthCondition, at = snapshot.capturedAt) => evaluateFactoryHealth(snapshot, () => at).findings.find(f => f.condition === condition)!;
const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function advance(state: FactoryHealthState, s: FactoryHealthSnapshot, at = s.capturedAt) { return transitionFactoryHealth(roundtrip(state), s, () => at).state; }
function deliver(state: FactoryHealthState, id: string, recipient: "Vincent" | "Coordinator", at: number) {
  const begun = beginHealthDelivery(state, id, recipient, () => at);
  return acknowledgeHealthDelivery(begun.state, begun.command, { state: "delivered", receipt: `fictional-delivery:${begun.command.idempotencyKey}` }, () => at);
}

test("documented snapshot accepts synthetic complete evidence; healthy startup invents no recovery", () => {
  const s = fixture();
  expect(FactoryHealthSnapshotSchema.safeParse(s).success).toBe(true);
  const result = transitionFactoryHealth(initialFactoryHealthState(), s, () => AT);
  expect(result.evaluation.findings.every(f => f.status === "healthy")).toBe(true);
  expect(result.state.outbox).toEqual([]);
  expect(result.evaluation.findings.map(f => f.condition).sort()).toEqual([...HEALTH_CONDITIONS].sort());
  expect(s).toEqual(fixture());
});

describe("all six parent conditions and exact boundaries", () => {
  for (const kind of ["ready", "building"] as const) {
    test(`${kind} work needs twenty minutes with neither claims nor running work`, () => {
      const s = fixture(); s.work.value[kind] = 1; s.work.value.inactiveSince = AT - 20 * M + 1; s.work.value.refusal = "qualification";
      expect(get(s, "work").status).toBe("pending");
      s.work.value.inactiveSince--;
      expect(get(s, "work")).toMatchObject({ status: "incident", message: "Factory work has waited twenty minutes because worker qualification is missing." });
      s.work.value.refusal = null;
      expect(get(s, "work").status).toBe("unknown");
      s.work.value.inactiveSince = null;
      s.work.value.claims = [{ id: "fictional-claim", heldSince: AT, receipt: "fictional-claim-custody" }];
      expect(get(s, "work").status).toBe("healthy");
      s.work.value.claims = []; s.work.value.running = [process()];
      expect(get(s, "work").status).toBe("healthy");
    });
  }
  test("disk is unhealthy strictly above 85%, with an independent failed-read state", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.85;
    expect(get(s, "disk").status).toBe("healthy");
    s.disk.value.usedFraction += Number.EPSILON;
    expect(get(s, "disk").status).toBe("incident");
    const broken: FactoryHealthSnapshot = { ...s, disk: { state: "error", observedAt: AT, reason: "fictional stat failure" } };
    expect(get(broken, "disk").status).toBe("unknown");
    expect(get(broken, "controller").status).toBe("healthy");
  });
  test("every required qualification warns at three hours; active bound renewal is the only exemption", () => {
    const s = fixture(); const q = s.qualifications.value.records[0];
    q.expiresAt = AT + 3 * H + 1;
    expect(get(s, "qualification").status).toBe("healthy");
    q.expiresAt--;
    expect(get(s, "qualification").status).toBe("incident");
    renewing(s);
    expect(get(s, "qualification").status).toBe("healthy");
    s.qualifications.value.records[1].expiresAt = AT + 3 * H;
    expect(get(s, "qualification").status).toBe("incident");
    s.qualifications.value.records[1].expiresAt += 1;
    q.expiresAt = AT;
    renewing(s);
    expect(get(s, "qualification")).toMatchObject({ status: "incident", message: "A required factory qualification has expired; renew it." });
  });
  test("AWS must cover tonight's whole final window, including the start minute", () => {
    const s = fixture(), last = healthReleaseWindows(AT)[1];
    s.aws.value.expiresAt = last.endAt;
    expect(get(s, "aws").status).toBe("healthy");
    s.aws.value.expiresAt--;
    expect(get(s, "aws").status).toBe("incident");
    s.aws.value.expiresAt = last.startAt;
    expect(get(s, "aws").status).toBe("incident");
    s.aws.value.expiresAt = AT;
    expect(get(s, "aws").message).toContain("has expired");
  });
  test("only a verified Vincent pause is exempt, and tick age is strictly over ten minutes", () => {
    const s = fixture(); s.controller.value.paused = true; s.controller.value.actor = "Vincent"; s.controller.value.actorVerified = true;
    expect(get(s, "pause").status).toBe("healthy");
    s.controller.value.actor = "Coordinator";
    expect(get(s, "pause").status).toBe("incident");
    s.controller.value.actor = "other";
    expect(get(s, "pause").status).toBe("incident");
    s.controller.value.actor = "Vincent"; s.controller.value.actorVerified = false;
    expect(get(s, "pause").status).toBe("unknown");
    s.tick.value.lastSuccessAt = s.tick.value.lastAttemptAt = AT - 10 * M;
    expect(get(s, "tick").status).toBe("healthy");
    s.tick.value.lastSuccessAt--; s.tick.value.lastAttemptAt--;
    expect(get(s, "tick").status).toBe("incident");
    s.tick.value.lastSuccessAt = AT - M; s.tick.value.lastAttemptAt = AT; s.tick.value.result = "failure";
    expect(get(s, "tick").message).toContain("tick failed");
    s.tick.value.result = "success";
    expect(get(s, "tick").status).toBe("unknown");
  });
  for (const stage of ["qa", "production"] as const) {
    test(`${stage} release is missing at five minutes, failed immediately and clears only on timely proven success`, () => {
      const w = healthReleaseWindows(AT).find(w => w.stage === stage)!;
      const s = fixture(w.startAt + 5 * M - 1), r = s.releases.value.windows.find(r => r.windowId === w.id)!;
      r.state = "scheduled"; r.startedAt = r.completedAt = null;
      expect(get(s, "release").status).toBe("pending");
      expect(get(s, "release", w.startAt + 5 * M).status).toBe("incident");
      r.state = "failed";
      expect(get(s, "release", w.startAt + 1).status).toBe("unknown"); // future snapshot cannot be backdated
      const failed = fixture(w.startAt + 1), f = failed.releases.value.windows.find(r => r.windowId === w.id)!;
      f.state = "failed"; f.startedAt = w.startAt; f.completedAt = w.startAt;
      let state = advance(initialFactoryHealthState(), failed);
      expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening"]);
      const running = fixture(w.startAt + 2); const run = running.releases.value.windows.find(r => r.windowId === w.id)!;
      run.state = "running"; run.completedAt = null;
      state = advance(state, running);
      expect(state.outbox.filter(n => n.condition === "release")).toHaveLength(1);
      const success = fixture(w.startAt + 3);
      state = advance(state, success);
      expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening", "recovery"]);
      const late = fixture(w.startAt + 6 * M); const l = late.releases.value.windows.find(r => r.windowId === w.id)!;
      l.startedAt = l.completedAt = w.endAt;
      expect(get(late, "release").status).toBe("unknown");
    });
  }
});

describe("sixty-minute preflight checks every gate for both release windows", () => {
  const cases: [string, (s: ReturnType<typeof fixture>, endAt: number) => void, string][] = [
    ["billing", s => { s.billing.value.allowed = false; }, "billing"],
    ["AWS through window", (s, end) => { s.aws.value.expiresAt = end - 1; }, "AWS"],
    ["qualification through window", (s, end) => { s.qualifications.value.records[1].expiresAt = end - 1; }, "qualification"],
    ["disk", s => { s.disk.value.usedFraction = 0.850001; }, "disk"],
    ["holds", s => { s.holds.value.blocking = true; }, "hold"],
  ];
  for (const stage of ["qa", "production"] as const) for (const [name, mutate, reason] of cases) {
    test(`${stage}: ${name} activates exactly sixty minutes before the window`, () => {
      const w = healthReleaseWindows(AT).find(w => w.stage === stage)!;
      const before = fixture(w.startAt - H - 1); mutate(before, w.endAt);
      expect(get(before, "release").status).toBe("healthy");
      const due = fixture(w.startAt - H); mutate(due, w.endAt);
      expect(get(due, "release").status).toBe("incident");
      expect(get(due, "release").reasons.join(" ").toLowerCase()).toContain(reason.toLowerCase());
      const opened = advance(initialFactoryHealthState(), due);
      const recovered = advance(opened, fixture(due.capturedAt + 1));
      expect(recovered.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening", "recovery"]);
    });
  }
  for (const source of ["billing", "aws", "qualifications", "disk", "holds"] as const) {
    test(`missing ${source} cannot pass preflight or manufacture a release recovery`, () => {
      const at = healthReleaseWindows(AT)[0].startAt - H;
      const s: FactoryHealthSnapshot = { ...fixture(at), [source]: null };
      expect(get(s, "release").status).toBe("unknown");
      let state = advance(initialFactoryHealthState(), s);
      state = advance(state, { ...s, capturedAt: at + 1 });
      expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening"]);
    });
  }
  test("fresh renewal custody does not extend qualification or AWS expiry through a release", () => {
    const w = healthReleaseWindows(AT)[0], s = fixture(w.startAt - H);
    s.qualifications.value.records[0].expiresAt = w.endAt - 1; renewing(s);
    expect(get(s, "qualification").status).toBe("healthy");
    expect(get(s, "release").status).toBe("incident");
    s.qualifications.value.records[0].expiresAt = w.endAt;
    s.aws.value.expiresAt = w.endAt;
    expect(get(s, "release").status).toBe("healthy");
  });
  test("wrong billing month, stale billing and incomplete release readback are unknown", () => {
    const at = healthReleaseWindows(AT)[0].startAt - H, s = fixture(at);
    s.billing.value.month = "2026-10";
    expect(get(s, "release").status).toBe("unknown");
    s.billing.value.month = "2026-11"; s.billing.observedAt = at - HEALTH_TIMING.billingMaxAge;
    expect(get(s, "release").status).toBe("unknown");
    s.billing.observedAt = at; s.releases.value.completeThrough--;
    expect(get(s, "release").status).toBe("unknown");
  });
});

describe("Toronto civil dates, midnight and DST", () => {
  for (const [at, qa, production] of [
    ["2026-03-07T12:00:00Z", "2026-03-08T01:00:00Z", "2026-03-08T02:30:00Z"],
    ["2026-03-08T12:00:00Z", "2026-03-09T00:00:00Z", "2026-03-09T01:30:00Z"],
    ["2026-10-31T12:00:00Z", "2026-11-01T00:00:00Z", "2026-11-01T01:30:00Z"],
    ["2026-11-01T12:00:00Z", "2026-11-02T01:00:00Z", "2026-11-02T02:30:00Z"],
  ]) test(`window offsets on ${at}`, () => {
    const windows = healthReleaseWindows(Date.parse(at));
    expect(windows.map(w => new Date(w.startAt).toISOString())).toEqual([new Date(qa).toISOString(), new Date(production).toISOString()]);
    expect(windows.every(w => w.endAt - w.startAt === M)).toBe(true);
  });
  test("previous civil day is 23 or 25 hours away across DST, never an assumed 24h", () => {
    const spring = Date.parse("2026-03-08T12:00:00Z"), fall = Date.parse("2026-11-01T12:00:00Z");
    expect(healthReleaseWindows(spring)[0].startAt - healthReleaseWindows(spring, -1)[0].startAt).toBe(23 * H);
    expect(healthReleaseWindows(fall)[0].startAt - healthReleaseWindows(fall, -1)[0].startAt).toBe(25 * H);
    const repeatedHourA = Date.parse("2026-11-01T01:30:00-04:00"), repeatedHourB = Date.parse("2026-11-01T01:30:00-05:00");
    expect(healthReleaseWindows(repeatedHourA)).toEqual(healthReleaseWindows(repeatedHourB));
  });
  test("UTC midnight still uses the same Toronto day; local midnight changes the final AWS window", () => {
    const a = Date.parse("2026-11-10T23:59:59.999Z"), b = a + 1;
    expect(healthReleaseWindows(a)).toEqual(healthReleaseWindows(b));
    const before = Date.parse("2026-11-10T23:59:59.999-05:00"), after = before + 1;
    expect(healthReleaseWindows(after)[0].day).toBe("2026-11-11");
    const s = fixture(after); s.aws.value.expiresAt = after + H;
    expect(get(s, "aws").status).toBe("incident");
  });
  test("unresolved release survives midnight, missing next-day evidence and two later days", () => {
    const at = Date.parse("2026-11-10T21:35:00-05:00"), w = healthReleaseWindows(at)[1];
    const s = fixture(at), r = s.releases.value.windows.find(r => r.windowId === w.id)!;
    r.state = "failed";
    let state = advance(initialFactoryHealthState(), s);
    const later = fixture(at + 49 * H);
    state = advance(state, later);
    expect(state.memory.releaseObligations.some(o => o.id === w.id)).toBe(true);
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening"]);
    const resolved = fixture(at + 49 * H + 1);
    resolved.releases.value.windows.push({ windowId: w.id, state: "success", startedAt: w.startAt, completedAt: w.endAt, receipt: "fictional-late-readback-of-timely-success" });
    state = advance(state, resolved);
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening", "recovery"]);
    expect(state.memory.releaseObligations.some(o => o.id === w.id)).toBe(false);
  });
  test("bootstrap after midnight requires yesterday's releases, and observes the year/month boundary", () => {
    const at = Date.parse("2027-01-01T00:00:00-05:00"), s = fixture(at);
    expect(healthReleaseWindows(at, -1)[0].day).toBe("2026-12-31");
    s.releases.value.windows = [];
    expect(get(s, "release").status).toBe("incident");
  });
});

describe("unavailable, stale, contradictory and forged provenance", () => {
  test("five-minute evidence boundary is inclusive; one more millisecond makes every source unknown", () => {
    expect(evaluateFactoryHealth(fixture(), () => AT + 5 * M).findings.every(f => f.status === "healthy")).toBe(true);
    expect(evaluateFactoryHealth(fixture(), () => AT + 5 * M + 1).findings.every(f => f.status === "unknown")).toBe(true);
  });
  test("unavailable controller evidence leaves independent tick and disk readings visible", () => {
    const s = fixture(); s.tick.value.result = "failure"; s.disk.value.usedFraction = 0.9;
    const broken: FactoryHealthSnapshot = { ...s, controller: null };
    expect(get(broken, "controller").status).toBe("unknown");
    expect(get(broken, "pause").status).toBe("unknown");
    expect(get(broken, "tick").status).toBe("incident");
    expect(get(broken, "disk").status).toBe("incident");
  });
  test("every stale, absent, future, malformed or failed input is actionable", () => {
    for (const source of ["controller", "tick", "work", "disk", "qualifications", "aws", "releases"] as const) {
      const condition: HealthCondition = ({ qualifications: "qualification", releases: "release" } as const)[source as "qualifications" | "releases"] ?? source as HealthCondition;
      const s = fixture();
      expect(get({ ...s, [source]: null }, condition).status).toBe("unknown");
      expect(get({ ...s, [source]: { ...s[source], observedAt: AT - 5 * M - 1 } }, condition).status).toBe("unknown");
      expect(get({ ...s, [source]: { ...s[source], observedAt: AT + 1 } }, condition).status).toBe("unknown");
      expect(get({ ...s, [source]: { ...s[source], receipt: "" } }, condition).status).toBe("unknown");
      expect(get({ ...s, [source]: { state: "error", observedAt: AT, reason: "fictional-read-error" } }, condition).status).toBe("unknown");
    }
    expect(evaluateFactoryHealth({ ...fixture(), capturedAt: AT - 5 * M - 1 }, () => AT).findings.every(f => f.status === "unknown")).toBe(true);
    expect(evaluateFactoryHealth({ ...fixture(), capturedAt: AT + 1 }, () => AT).findings.every(f => f.status === "unknown")).toBe(true);
  });
  test("incomplete inventory and PID reuse cannot prove running work", () => {
    const s = fixture(); s.work.value.ready = 1; s.work.value.running = [process()];
    s.work.value.running[0].observedIdentity = "123:different-start";
    expect(get(s, "work").status).toBe("unknown");
    s.work.value.running[0] = process(); s.work.value.running[0].state = "queued";
    expect(get(s, "work").status).toBe("unknown");
    s.work.value.running[0] = process(); s.work.value.inactiveSince = AT - 20 * M;
    expect(get(s, "work").status).toBe("unknown");
    s.work.value.inactiveSince = null; s.work.value.running[0].observedAt = AT - 5 * M - 1;
    expect(get(s, "work").status).toBe("unknown");
    const incomplete = roundtrip(s); (incomplete.work.value as { complete: boolean }).complete = false;
    expect(get(incomplete, "work").status).toBe("unknown");
  });
  test("future evidence relative to capture and duplicate native process custody are unknown", () => {
    const s = fixture(); s.disk.observedAt++;
    expect(get(s, "disk", AT + 1).status).toBe("unknown");
    s.work.value.running = [process(), { ...process(), sessionId: "another-session" }];
    expect(get(s, "work").status).toBe("unknown");
    s.work.value.running[1].pid++;
    expect(get(s, "work").status).toBe("unknown");
  });
  for (const mutation of ["qualification", "expiry", "wake", "session", "native", "identity", "queued", "stopped", "stale", "provider", "purpose", "process-qualification", "process-expiry"] as const) {
    test(`renewal ${mutation} mismatch cannot suppress the three-hour warning`, () => {
      const s = fixture(); s.qualifications.value.records[0].expiresAt = AT + H; const r = renewing(s);
      if (mutation === "qualification") r.qualificationId = "unrelated-qualification";
      if (mutation === "expiry") r.expiresAt++;
      if (mutation === "wake") r.wakeId = "unrelated-wake";
      if (mutation === "session") r.sessionId = "unrelated-session";
      if (mutation === "native") r.nativeSessionId = "unrelated-native";
      if (mutation === "identity") r.process.observedIdentity = "reused-pid";
      if (mutation === "queued") r.process.state = "queued";
      if (mutation === "stopped") r.process.state = "stopped";
      if (mutation === "stale") r.process.observedAt = AT - 5 * M - 1;
      if (mutation === "provider") r.process.provider = "claude";
      if (mutation === "purpose") r.process.purpose = "work";
      if (mutation === "process-qualification") r.process.qualificationId = "unrelated-qualification";
      if (mutation === "process-expiry") r.process.qualificationExpiresAt!++;
      expect(get(s, "qualification").status).toBe("unknown");
    });
  }
  test("missing or duplicate required qualifications and contradictory release success are unknown", () => {
    const s = fixture(); s.qualifications.value.records.pop();
    expect(get(s, "qualification").status).toBe("unknown");
    s.qualifications.value.records.push(s.qualifications.value.records[0]);
    expect(get(s, "qualification").status).toBe("unknown");
    s.releases.value.windows[0].completedAt = AT + 1;
    expect(get(s, "release").status).toBe("unknown");
    s.releases.value.windows[0].completedAt = s.releases.value.windows[0].startedAt;
    s.releases.value.windows.push(s.releases.value.windows[0]);
    expect(get(s, "release").status).toBe("unknown");
  });
  test("one live process cannot supply two required providers' renewal custody", () => {
    const s = fixture(); s.qualifications.value.records[0].expiresAt = AT + H;
    const first = renewing(s), second = s.qualifications.value.records[1];
    second.expiresAt = AT + H;
    second.renewal = { ...first, qualificationId: second.qualificationId, process: { ...first.process, provider: second.provider, qualificationId: second.qualificationId } };
    expect(get(s, "qualification").status).toBe("unknown");
  });
});

describe("durable incident and notification transitions", () => {
  for (const evidenceTime of [AT - 1, AT]) test(`disk evidence from ${evidenceTime === AT ? "the same" : "an earlier"} observation cannot invent recovery after restart`, () => {
    const bad = fixture(); bad.disk.value.usedFraction = 0.9;
    const opened = advance(initialFactoryHealthState(), bad);
    const previous = roundtrip(opened);
    const good = fixture(AT + 1); good.disk.observedAt = evidenceTime;
    const result = transitionFactoryHealth(roundtrip(opened), good, () => AT + 1);
    expect(result.evaluation.findings.find(f => f.condition === "disk")?.status).toBe("unknown");
    expect(result.state.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening"]);
    expect(opened).toEqual(previous);
    const recovered = advance(result.state, fixture(AT + 2));
    expect(recovered.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  test("same-time contradiction stays latched until newer evidence, even if the original reading is replayed", () => {
    const bad = fixture(); bad.disk.value.usedFraction = 0.9;
    let state = advance(initialFactoryHealthState(), bad);
    const conflict = fixture(AT + 1); conflict.disk.observedAt = AT;
    state = advance(state, conflict);
    expect(state.memory.observations.disk?.conflicted).toBe(true);
    const replay = fixture(AT + 2); replay.disk = bad.disk;
    const result = transitionFactoryHealth(roundtrip(state), replay, () => AT + 2);
    expect(result.evaluation.findings.find(f => f.condition === "disk")?.status).toBe("unknown");
    expect(result.state.memory.observations.disk?.conflicted).toBe(true);
    state = advance(result.state, fixture(AT + 3));
    expect(state.memory.observations.disk?.conflicted).toBe(false);
    expect(state.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  test("missing source evidence opens a durable barrier that only a newer positive reading clears", () => {
    let state = advance(initialFactoryHealthState(), { ...fixture(), disk: null });
    const older = fixture(AT + 1); older.disk.observedAt = AT - 1;
    const result = transitionFactoryHealth(roundtrip(state), older, () => AT + 1);
    expect(result.evaluation.findings.find(f => f.condition === "disk")?.status).toBe("unknown");
    state = result.state;
    expect(state.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening"]);
    state = advance(state, fixture(AT + 2));
    expect(state.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  test("per-source ordering also protects a preflight incident and ignores object property order", () => {
    const at = healthReleaseWindows(AT)[0].startAt - H, s = fixture(at); s.holds.value.blocking = true;
    let state = advance(initialFactoryHealthState(), s);
    const old = fixture(at + 1); old.holds.observedAt = at - 1;
    state = advance(state, old);
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening"]);
    state = advance(state, fixture(at + 2));
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening", "recovery"]);
    const reordered = fixture(at + 2);
    reordered.holds = { value: reordered.holds.value, receipt: reordered.holds.receipt, observedAt: at + 2, state: "ok" };
    const result = transitionFactoryHealth(roundtrip(state), reordered, () => at + 3);
    expect(result.evaluation.findings.find(f => f.condition === "release")?.status).toBe("healthy");
    expect(result.state.outbox.filter(n => n.condition === "release")).toHaveLength(2);
  });
  test("rejected old release recovery retains its exact obligation through a restart and newer unrelated success", () => {
    const at = Date.parse("2026-11-10T21:35:00-05:00"), w = healthReleaseWindows(at)[1];
    const failed = fixture(at); failed.releases.value.windows.find(r => r.windowId === w.id)!.state = "failed";
    let state = advance(initialFactoryHealthState(), failed);
    const later = at + 49 * H;
    state = advance(state, { ...fixture(later), releases: null });
    const oldSuccess = fixture(later + 1);
    oldSuccess.releases.observedAt = oldSuccess.releases.value.completeThrough = later - 1;
    oldSuccess.releases.value.windows.push({ windowId: w.id, state: "success", startedAt: w.startAt, completedAt: w.endAt, receipt: "fictional-old-success-readback" });
    const rejected = transitionFactoryHealth(roundtrip(state), oldSuccess, () => later + 1);
    expect(rejected.evaluation.findings.find(f => f.condition === "release")?.status).toBe("unknown");
    expect(rejected.state.memory.releaseObligations.some(o => o.id === w.id)).toBe(true);
    state = advance(roundtrip(rejected.state), fixture(later + 2));
    expect(state.memory.releaseObligations.some(o => o.id === w.id)).toBe(true);
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening"]);
    const proven = fixture(later + 3);
    proven.releases.value.windows.push({ windowId: w.id, state: "success", startedAt: w.startAt, completedAt: w.endAt, receipt: "fictional-new-verified-readback" });
    state = advance(state, proven);
    expect(state.memory.releaseObligations.some(o => o.id === w.id)).toBe(false);
    expect(state.outbox.filter(n => n.condition === "release").map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  const recoveries: [HealthCondition, (s: ReturnType<typeof fixture>) => void][] = [
    ["work", s => { Object.assign(s.work.value, { ready: 1, inactiveSince: AT - 20 * M, refusal: "billing" }); }],
    ["disk", s => { s.disk.value.usedFraction = 0.9; }],
    ["qualification", s => { s.qualifications.value.records[0].expiresAt = AT + H; }],
    ["aws", s => { s.aws.value.expiresAt = AT + H; }],
    ["pause", s => { Object.assign(s.controller.value, { paused: true, actor: "Coordinator", actorVerified: true }); }],
    ["tick", s => { s.tick.value.lastSuccessAt = s.tick.value.lastAttemptAt = AT - 10 * M - 1; }],
  ];
  for (const [condition, mutate] of recoveries) test(`${condition} recovers exactly once from a known failure with fresh positive evidence`, () => {
    const s = fixture(); mutate(s);
    let state = advance(initialFactoryHealthState(), s);
    expect(get(s, condition).status).toBe("incident");
    state = advance(state, { ...fixture(AT + 1), [condition === "qualification" ? "qualifications" : condition === "pause" ? "controller" : condition]: null });
    expect(state.outbox.filter(n => n.condition === condition).map(n => n.kind)).toEqual(["opening"]);
    state = advance(state, fixture(AT + 2));
    state = advance(state, fixture(AT + 3));
    expect(state.outbox.filter(n => n.condition === condition).map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  test("all actionable conditions have one stable opening and one positive-evidence recovery across restart", () => {
    const unknown: FactoryHealthSnapshot = { version: 1, capturedAt: AT };
    let state = advance(initialFactoryHealthState(), unknown);
    expect(state.outbox).toHaveLength(HEALTH_CONDITIONS.length);
    const ids = state.outbox.map(n => n.id);
    state = advance(state, unknown);
    expect(state.outbox.map(n => n.id)).toEqual(ids);
    expect(FactoryHealthStateSchema.parse(roundtrip(state))).toEqual(state);
    state = advance(state, fixture(AT + 1));
    state = advance(state, fixture(AT + 2));
    expect(state.outbox).toHaveLength(2 * HEALTH_CONDITIONS.length);
    for (const condition of HEALTH_CONDITIONS) {
      const messages = state.outbox.filter(n => n.condition === condition);
      expect(messages.map(n => n.kind)).toEqual(["opening", "recovery"]);
      expect(messages[0].incidentId).toBe(messages[1].incidentId);
      expect(messages[0].id).not.toBe(messages[1].id);
      expect(messages.every(n => !/[\r\n]|#\d+|ticket/i.test(n.message) && n.message.length < 180)).toBe(true);
    }
  });
  test("unknown, stale and a reset inactivity clock cannot invent a recovery", () => {
    const s = fixture(); s.work.value.ready = 1; s.work.value.inactiveSince = AT - 20 * M; s.work.value.refusal = "approval";
    let state = advance(initialFactoryHealthState(), s);
    const fresh = fixture(AT + 1); fresh.work.value = { ...s.work.value, inactiveSince: AT + 1 };
    state = advance(state, fresh);
    state = advance(state, { ...fresh, work: null });
    state = advance(state, fresh, AT + 6 * M);
    expect(state.outbox.filter(n => n.condition === "work").map(n => n.kind)).toEqual(["opening"]);
    state = advance(state, fixture(AT + 6 * M + 1));
    expect(state.outbox.filter(n => n.condition === "work").map(n => n.kind)).toEqual(["opening", "recovery"]);
  });
  test("rapid flapping retains unique incidents but no repeat opening or recovery delivery within two hours", () => {
    const bad = fixture(); bad.disk.value.usedFraction = 0.9;
    let state = advance(initialFactoryHealthState(), bad);
    const first = state.outbox[0];
    state = deliver(state, first.id, "Vincent", AT);
    state = deliver(state, first.id, "Coordinator", AT);
    state = advance(state, fixture(AT + M));
    const clear = state.outbox.find(n => n.condition === "disk" && n.kind === "recovery")!;
    state = deliver(state, clear.id, "Vincent", AT + M);
    state = deliver(state, clear.id, "Coordinator", AT + M);
    const reopened = fixture(AT + 2 * M); reopened.disk.value.usedFraction = 0.9;
    state = advance(state, reopened);
    const second = state.outbox.at(-1)!;
    expect(second.id).not.toBe(first.id);
    expect(second.incidentId).not.toBe(first.incidentId);
    state = advance(state, fixture(AT + 3 * M));
    expect(pendingHealthDeliveries(roundtrip(state), () => AT + 2 * H - 1).filter(n => n.notificationId === second.id)).toEqual([]);
    expect(() => beginHealthDelivery(state, second.id, "Vincent", () => AT + 2 * H - 1)).toThrow("not due");
    expect(pendingHealthDeliveries(state, () => AT + 2 * H).map(n => n.notificationId)).toEqual([second.id, second.id]);
    state = deliver(state, second.id, "Vincent", AT + 2 * H);
    state = deliver(state, second.id, "Coordinator", AT + 2 * H);
    expect(pendingHealthDeliveries(state, () => AT + 2 * H + M - 1)).toEqual([]);
    const secondClear = state.outbox.at(-1)!;
    state = deliver(state, secondClear.id, "Vincent", AT + 2 * H + M);
    state = deliver(state, secondClear.id, "Coordinator", AT + 2 * H + M);
    expect(pendingHealthDeliveries(state, () => AT + 4 * H)).toEqual([]);
    expect(state.outbox.filter(n => n.condition === "disk").map(n => n.kind)).toEqual(["opening", "recovery", "opening", "recovery"]);
  });
  test("failed delivery retries the same bridge ID and does not acknowledge the other recipient", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.9;
    let state = advance(initialFactoryHealthState(), s), id = state.outbox[0].id;
    const first = beginHealthDelivery(state, id, "Vincent", () => AT); state = first.state;
    state = acknowledgeHealthDelivery(roundtrip(state), first.command, { state: "failed", receipt: "fictional-bridge-unavailable" }, () => AT + 1);
    expect(pendingHealthDeliveries(state, () => AT + M).some(n => n.recipient === "Vincent")).toBe(false);
    const retry = beginHealthDelivery(roundtrip(state), id, "Vincent", () => AT + M + 1);
    expect(retry.command.idempotencyKey).toBe(first.command.idempotencyKey);
    expect(retry.command.attemptId).not.toBe(first.command.attemptId);
    state = acknowledgeHealthDelivery(retry.state, retry.command, { state: "delivered", receipt: "fictional-vincent-receipt" }, () => AT + M + 2);
    expect(state.outbox[0].deliveries.Vincent.attempts.map(a => a.result)).toEqual(["failed", "delivered"]);
    expect(state.outbox[0].deliveries.Coordinator.attempts).toEqual([]);
    expect(pendingHealthDeliveries(state, () => AT + M + 2)).toEqual([{ notificationId: id, recipient: "Coordinator" }]);
  });
  test("crash before or after bridge write retries one stable key with a retained in-flight lease", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.9;
    let state = advance(initialFactoryHealthState(), s);
    const first = beginHealthDelivery(state, state.outbox[0].id, "Vincent", () => AT);
    state = roundtrip(first.state);
    expect(pendingHealthDeliveries(state, () => AT + M - 1).some(n => n.recipient === "Vincent")).toBe(false);
    const retry = beginHealthDelivery(state, state.outbox[0].id, "Vincent", () => AT + M);
    // Synthetic idempotent bridge: write succeeded, process died before ack.
    const bridge = new Map([[first.command.idempotencyKey, "fictional-existing-delivery"]]);
    expect(bridge.get(retry.command.idempotencyKey)).toBe("fictional-existing-delivery");
    state = acknowledgeHealthDelivery(retry.state, retry.command, { state: "delivered", receipt: bridge.get(retry.command.idempotencyKey)! }, () => AT + M);
    const repeated = acknowledgeHealthDelivery(state, retry.command, { state: "delivered", receipt: "fictional-existing-delivery" }, () => AT + M);
    expect(repeated).toEqual(state);
    expect(bridge.size).toBe(1);
    expect(pendingHealthDeliveries(state, () => AT + 4 * H).some(n => n.recipient === "Vincent")).toBe(false);
  });
  test("one destination progresses through recovery while the other retains an undelivered opening", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.9;
    let state = advance(initialFactoryHealthState(), s);
    const id = state.outbox[0].id;
    state = deliver(state, id, "Vincent", AT);
    state = advance(state, fixture(AT + 1));
    const recovery = state.outbox.at(-1)!;
    expect(pendingHealthDeliveries(state, () => AT + 1)).toEqual([
      { notificationId: id, recipient: "Coordinator" }, { notificationId: recovery.id, recipient: "Vincent" },
    ]);
    expect(() => beginHealthDelivery(state, recovery.id, "Coordinator", () => AT + 1)).toThrow();
    state = deliver(state, recovery.id, "Vincent", AT + 1);
    state = deliver(state, id, "Coordinator", AT + 2);
    state = deliver(state, recovery.id, "Coordinator", AT + 2);
    expect(pendingHealthDeliveries(state, () => AT + 3)).toEqual([]);
  });
  test("bad state, clock rollback, duplicate ack conflict and wrong custody are rejected without mutation", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.9;
    const state = advance(initialFactoryHealthState(), s), original = roundtrip(state);
    expect(() => transitionFactoryHealth(state, s, () => AT - 1)).toThrow("backwards");
    expect(() => evaluateFactoryHealth(s, () => NaN)).toThrow();
    expect(() => transitionFactoryHealth({ ...state, version: 2 } as unknown as FactoryHealthState, s, () => AT)).toThrow();
    const begun = beginHealthDelivery(state, state.outbox[0].id, "Vincent", () => AT);
    const acknowledged = acknowledgeHealthDelivery(begun.state, begun.command, { state: "delivered", receipt: "fictional-receipt" }, () => AT);
    expect(() => acknowledgeHealthDelivery(acknowledged, begun.command, { state: "failed", receipt: "different" }, () => AT)).toThrow("Conflicting");
    expect(() => acknowledgeHealthDelivery(begun.state, { ...begun.command, recipient: "Coordinator" }, { state: "delivered", receipt: "fictional" }, () => AT)).toThrow();
    expect(() => acknowledgeHealthDelivery(begun.state, { ...begun.command, attemptId: "fictional-unknown-attempt" }, { state: "delivered", receipt: "fictional" }, () => AT)).toThrow();
    expect(state).toEqual(original);
  });
  test("contradictory serialized receipts or lost outbox history never reset deduplication", () => {
    const s = fixture(); s.disk.value.usedFraction = 0.9;
    const state = advance(initialFactoryHealthState(), s);
    const missing = roundtrip(state); missing.outbox = [];
    expect(() => advance(missing, fixture(AT + 1))).toThrow("Contradictory");
    const begun = beginHealthDelivery(state, state.outbox[0].id, "Vincent", () => AT);
    const corrupt = roundtrip(begun.state); corrupt.outbox[0].deliveries.Vincent.attempts[0].result = "delivered";
    expect(() => pendingHealthDeliveries(corrupt, () => AT + M)).toThrow("Contradictory");
    const wrongId = roundtrip(state); wrongId.episodes.disk[0].id = "fictional-reset";
    expect(() => advance(wrongId, fixture(AT + 1))).toThrow("Contradictory");
  });
});
