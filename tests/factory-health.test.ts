import { describe, expect, test } from "bun:test";
import {
  acknowledgeHealthDelivery, beginHealthDelivery, evaluateFactoryHealth,
  FactoryHealthSnapshotSchema, FactoryHealthStateSchema, HEALTH_CONDITIONS, HEALTH_TIMING,
  initialFactoryHealthState, pendingHealthDeliveries, transitionFactoryHealth,
  type FactoryHealthSnapshot, type FactoryHealthState, type HealthCondition,
  type HealthProcessSchema,
} from "../launcher/factory-health";
import type { z } from "zod";

const M = 60_000, H = 60 * M;
const AT = Date.parse("2026-11-10T18:00:00-05:00");
const ok = <T>(at: number, value: T) => ({ state: "ok" as const, observedAt: at, receipt: "fictional-source-readback", value });
type Value<K extends keyof FactoryHealthSnapshot> = Extract<NonNullable<FactoryHealthSnapshot[K]>, { state: "ok" }> extends { value: infer T } ? T : never;
function fixture(at = AT) {
  return {
    version: 1 as const, capturedAt: at,
    controller: ok<Value<"controller">>(at, { paused: false, actor: null, actorVerified: false, changedAt: at, changeReceipt: "fictional-control" }),
    tick: ok<Value<"tick">>(at, { lastSuccessAt: at, lastAttemptAt: at, result: "success" }),
    disk: ok<Value<"disk">>(at, { usedFraction: 0.5 }),
    qualifications: ok<Value<"qualifications">>(at, {
      required: ["codex", "claude"], records: ["codex", "claude"].map(provider => ({ provider, qualificationId: `fictional-${provider}-qualification`, verified: true, expiresAt: at + 24 * H, receipt: "fictional-qualified", renewal: null })),
    }),
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

describe("every condition and exact boundaries", () => {
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
    // One failed tick that a recent success surrounds is not an incident.
    s.tick.value.lastSuccessAt = AT - M; s.tick.value.lastAttemptAt = AT; s.tick.value.result = "failure";
    expect(get(s, "tick").status).toBe("healthy");
    s.tick.value.lastSuccessAt = AT - 10 * M - 1;
    expect(get(s, "tick").message).toContain("over ten minutes");
    s.tick.value.result = "success";
    expect(get(s, "tick").status).toBe("unknown");
  });
});

describe("unavailable, stale, contradictory and forged provenance", () => {
  test("five-minute evidence boundary is inclusive; one more millisecond makes every source unknown", () => {
    expect(evaluateFactoryHealth(fixture(), () => AT + 5 * M).findings.every(f => f.status === "healthy")).toBe(true);
    expect(evaluateFactoryHealth(fixture(), () => AT + 5 * M + 1).findings.every(f => f.status === "unknown")).toBe(true);
  });
  test("unavailable controller evidence leaves independent tick and disk readings visible", () => {
    const s = fixture(); s.tick.value.lastSuccessAt = s.tick.value.lastAttemptAt = AT - 11 * M; s.disk.value.usedFraction = 0.9;
    const broken: FactoryHealthSnapshot = { ...s, controller: null };
    expect(get(broken, "controller").status).toBe("unknown");
    expect(get(broken, "pause").status).toBe("unknown");
    expect(get(broken, "tick").status).toBe("incident");
    expect(get(broken, "disk").status).toBe("incident");
  });
  test("every stale, absent, future, malformed or failed input is actionable", () => {
    for (const source of ["controller", "tick", "disk", "qualifications"] as const) {
      const condition: HealthCondition = source === "qualifications" ? "qualification" : source;
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
  test("missing or duplicate required qualifications are unknown", () => {
    const s = fixture(); s.qualifications.value.records.pop();
    expect(get(s, "qualification").status).toBe("unknown");
    s.qualifications.value.records.push(s.qualifications.value.records[0]);
    expect(get(s, "qualification").status).toBe("unknown");
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
  test("only the latest transition is delivered; superseded flaps are never drip-fed later", () => {
    const disk = (at: number, used: number) => { const s = fixture(at); s.disk.value.usedFraction = used; return s; };
    let state = advance(initialFactoryHealthState(), disk(AT, 0.9));
    const opening = state.outbox[0].id;
    state = deliver(state, opening, "Vincent", AT);
    state = advance(state, disk(AT + 1, 0.5));
    const recovery = state.outbox.at(-1)!.id;
    // The Coordinator was never told about the opening, so it gets no recovery either.
    expect(pendingHealthDeliveries(state, () => AT + 1)).toEqual([{ notificationId: recovery, recipient: "Vincent" }]);
    state = deliver(state, recovery, "Vincent", AT + 1);
    for (const [at, used] of [[AT + 2, 0.9], [AT + 3, 0.5], [AT + 4, 0.9]] as const) state = advance(state, disk(at, used));
    const latest = state.outbox.at(-1)!.id;
    expect(pendingHealthDeliveries(state, () => AT + 5)).toEqual([{ notificationId: latest, recipient: "Coordinator" }]);
    expect(pendingHealthDeliveries(state, () => AT + 2 * H)).toEqual([
      { notificationId: latest, recipient: "Vincent" }, { notificationId: latest, recipient: "Coordinator" },
    ]);
    expect(state.outbox.filter(n => n.condition === "disk")).toHaveLength(5);
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


