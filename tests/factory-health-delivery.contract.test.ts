// Health alarms must actually arrive. These tests hold the delivery rules:
// what counts as delivered, what is archived instead of sent, the flap rule,
// the alarm for a message nobody confirmed, and the ids hard stops carry.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeHealthDelivery, beginHealthDelivery, FactoryHealthStateSchema, HEALTH_CONDITIONS, HEALTH_TIMING,
  healthReleaseWindows, initialFactoryHealthState, pendingHealthDeliveries, settleHealthOutbox, supersedeHealthDelivery,
  transitionFactoryHealth, unconfirmedHealthDeliveries,
  type FactoryHealthSnapshot, type FactoryHealthState, type HealthNotification, type HealthRecipient,
} from "../launcher/factory-health";
import { HEALTH_HARD_STOPS, HEALTH_PROTECTED_PATHS, healthBridge, healthHardStopId, watchFactoryHealth, type HealthHardStop } from "../launcher/factory-health-runtime";
import { LoopHeartbeatSchema, parseOwnerMessageId } from "../launcher/loop-contract";
import { Store } from "../tracking/store";
import { config } from "./fixtures";
import { openRealMailStore, realMailSource } from "./helpers/real-mail-store";

const M = 60_000;
const AT = Date.parse("2026-11-10T12:00:00-05:00");
const RECIPIENTS = ["Vincent", "Coordinator"] as const;
const isDelivered = (n: HealthNotification, r: HealthRecipient) => n.deliveries[r].attempts.some(a => a.result === "delivered");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Only the disk is observed, so only the disk condition can open and clear. */
const disk = (at: number, usedFraction: number): FactoryHealthSnapshot =>
  ({ version: 1, capturedAt: at, disk: { state: "ok", observedAt: at, receipt: "fictional-disk-readback", value: { usedFraction } } });
const diskMessages = (state: FactoryHealthState) => state.outbox.filter(n => n.condition === "disk");
const dueFor = (state: FactoryHealthState, at: number) => {
  const disks = new Set(diskMessages(state).map(n => n.id));
  return pendingHealthDeliveries(state, () => at).filter(p => disks.has(p.notificationId));
};
function confirm(state: FactoryHealthState, id: string, recipient: HealthRecipient, at: number) {
  const begun = beginHealthDelivery(state, id, recipient, () => at);
  return acknowledgeHealthDelivery(begun.state, begun.command, { state: "delivered", receipt: "fictional-receipt" }, () => at);
}
/** Opens and clears the disk condition on alternate five-minute evaluations. */
function alternate(times: number, deliver: boolean) {
  let state = initialFactoryHealthState(), at = AT;
  const sent: string[] = [];
  for (let i = 0; i < 2 * times; i++, at += 5 * M) {
    state = transitionFactoryHealth(copy(state), disk(at, i % 2 === 0 ? 0.9 : 0.5), () => at).state;
    if (deliver) for (const p of dueFor(state, at)) {
      state = confirm(state, p.notificationId, p.recipient, at);
      if (p.recipient === "Vincent") sent.push(state.outbox.find(n => n.id === p.notificationId)!.kind);
    }
  }
  return { state, at: at - 5 * M, sent };
}

describe("current state wins", () => {
  test("an opening that cleared before it was sent is archived with its recovery, and nothing is deleted", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    expect(dueFor(state, AT).map(p => p.recipient)).toEqual([...RECIPIENTS]);
    state = transitionFactoryHealth(state, disk(AT + 5 * M, 0.5), () => AT + 5 * M).state;
    expect(dueFor(state, AT + 5 * M)).toEqual([]);
    expect(diskMessages(state).map(n => [n.kind, n.deliveries.Vincent.superseded?.reason])).toEqual([
      ["opening", "cleared before it was sent"], ["recovery", "its opening was never sent"],
    ]);
    expect(unconfirmedHealthDeliveries(state, () => AT + 60 * M).filter(u => u.condition === "disk")).toEqual([]);
  });
  test("a newer opening is never held back by an older one, and there is no waiting period", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const first = diskMessages(state)[0]!;
    // Handed to the bridge and never confirmed: under strict order this blocked the condition for good.
    state = beginHealthDelivery(state, first.id, "Coordinator", () => AT).state;
    state = confirm(state, first.id, "Vincent", AT);
    state = transitionFactoryHealth(state, disk(AT + 5 * M, 0.5), () => AT + 5 * M).state;
    state = confirm(state, diskMessages(state)[1]!.id, "Vincent", AT + 5 * M);
    state = transitionFactoryHealth(state, disk(AT + 10 * M, 0.9), () => AT + 10 * M).state;
    const second = diskMessages(state)[2]!;
    expect(dueFor(state, AT + 10 * M)).toEqual([
      { notificationId: first.id, recipient: "Coordinator" },
      { notificationId: second.id, recipient: "Vincent" }, { notificationId: second.id, recipient: "Coordinator" },
    ]);
    // The first recovery was never handed to the Coordinator and the condition has reopened.
    expect(diskMessages(state)[1]!.deliveries.Coordinator.superseded?.reason).toBe("the condition reopened before this was sent");
  });
  test("a recovery follows only an opening that recipient received", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const opening = diskMessages(state)[0]!;
    state = beginHealthDelivery(state, opening.id, "Vincent", () => AT).state;
    state = transitionFactoryHealth(state, disk(AT + 5 * M, 0.5), () => AT + 5 * M).state;
    const recovery = diskMessages(state)[1]!;
    expect(dueFor(state, AT + 5 * M)).toEqual([{ notificationId: opening.id, recipient: "Vincent" }]);
    expect(() => beginHealthDelivery(state, recovery.id, "Vincent", () => AT + 5 * M)).toThrow("not due");
    state = confirm(state, opening.id, "Vincent", AT + 5 * M);
    expect(dueFor(state, AT + 5 * M)).toEqual([{ notificationId: recovery.id, recipient: "Vincent" }]);
  });
  test("a row the mail gate cancelled is archived, and its recovery goes with it on the next evaluation", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const opening = diskMessages(state)[0]!;
    state = beginHealthDelivery(state, opening.id, "Vincent", () => AT).state;
    const done = confirm(state, opening.id, "Coordinator", AT);
    expect(() => supersedeHealthDelivery(done, opening.id, "Coordinator", "late", () => AT + M)).toThrow("cannot be superseded");
    state = supersedeHealthDelivery(state, opening.id, "Vincent", "cancelled by Alido Mail", () => AT + M);
    expect(supersedeHealthDelivery(state, opening.id, "Vincent", "again", () => AT + M)).toEqual(state);
    expect(diskMessages(state)[0]!.deliveries.Vincent).toMatchObject({ superseded: { reason: "cancelled by Alido Mail" }, attempts: [{ result: "failed" }] });
    state = transitionFactoryHealth(state, disk(AT + 5 * M, 0.5), () => AT + 5 * M).state;
    expect(diskMessages(state)[1]!.deliveries.Vincent.superseded?.reason).toBe("its opening was never sent");
    expect(FactoryHealthStateSchema.parse(copy(state))).toEqual(state);
  });
  test("a retry renews the attempt still in flight, so a long wait does not grow the state", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const id = diskMessages(state)[0]!.id;
    for (let i = 0; i < 50; i++) state = beginHealthDelivery(state, id, "Vincent", () => AT + i * 5 * M).state;
    expect(diskMessages(state)[0]!.deliveries.Vincent.attempts).toEqual([
      { id: `${id}:Vincent:attempt:1`, at: AT, renewedAt: AT + 49 * 5 * M, result: "in-flight", finishedAt: null, receipt: null },
    ]);
  });
  test("lateness is measured from the first hand-over, so a recovery that waited for its opening is not late on arrival", () => {
    let state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const opening = diskMessages(state)[0]!, handed = beginHealthDelivery(state, opening.id, "Vincent", () => AT);
    state = transitionFactoryHealth(handed.state, disk(AT + 5 * M, 0.5), () => AT + 5 * M).state;
    const recovery = diskMessages(state)[1]!;
    const late = (s: FactoryHealthState, at: number) => unconfirmedHealthDeliveries(s, () => at).filter(u => u.condition === "disk" && u.recipient === "Vincent").map(u => u.kind);
    expect(late(state, AT + 10 * M)).toEqual([]);
    expect(late(state, AT + 10 * M + 1)).toEqual(["opening"]);
    // Three hours later the opening is confirmed and its recovery is handed over.
    state = acknowledgeHealthDelivery(state, handed.command, { state: "delivered", receipt: "fictional-late-receipt" }, () => AT + 180 * M);
    state = beginHealthDelivery(state, recovery.id, "Vincent", () => AT + 180 * M).state;
    expect(late(state, AT + 190 * M)).toEqual([]);
    expect(late(state, AT + 190 * M + 1)).toEqual(["recovery"]);
  });
  test("state stored before these rules still loads, and an archived message cannot also be delivered", () => {
    const state = transitionFactoryHealth(initialFactoryHealthState(), disk(AT, 0.9), () => AT).state;
    const { recurrences: _, ...older } = copy(state);
    expect(FactoryHealthStateSchema.parse(older)).toEqual(state);
    const both = copy(confirm(state, diskMessages(state)[0]!.id, "Vincent", AT));
    both.outbox.find(n => n.condition === "disk")!.deliveries.Vincent.superseded = { at: AT, reason: "fictional" };
    expect(() => FactoryHealthStateSchema.parse(both)).toThrow("Contradictory");
  });
});

describe("a fault that comes and goes is not hidden", () => {
  test("six open-and-clear rounds with delivery down yield exactly one 'keeps recurring' message, not zero", () => {
    const { state, at } = alternate(6, false);
    const kinds = diskMessages(state).map(n => n.kind);
    expect(kinds.filter(k => k === "opening")).toHaveLength(6);
    expect(kinds.filter(k => k === "recurring")).toHaveLength(1);
    const notice = diskMessages(state).find(n => n.kind === "recurring")!;
    expect(notice.message).toBe("Keeps recurring: Factory disk use is above 85%; free space safely.");
    // It is raised by the third opening, twenty minutes in, and is the only thing left to send.
    expect(notice.createdAt).toBe(AT + 20 * M);
    expect(dueFor(state, at)).toEqual(RECIPIENTS.map(recipient => ({ notificationId: notice.id, recipient })));
    for (const n of diskMessages(state)) for (const r of RECIPIENTS) expect(n.deliveries[r].superseded === undefined).toBe(n.kind === "recurring");
    // Later evaluations never archive it, however long it waits.
    let later = state;
    for (let i = 1; i <= 24; i++) later = transitionFactoryHealth(later, disk(at + i * 60 * M, 0.5), () => at + i * 60 * M).state;
    expect(dueFor(later, at + 24 * 60 * M).map(p => p.notificationId)).toEqual([notice.id, notice.id]);
  });
  test("with delivery working he hears the first two rounds, then one 'keeps recurring' message and no more openings", () => {
    const { sent } = alternate(6, true);
    expect(sent).toEqual(["opening", "recovery", "opening", "recovery", "recurring"]);
  });
  test("it stays open until thirty quiet minutes, then closes with one message and the count starts again", () => {
    let { state, at } = alternate(6, true);
    const cleared = at;
    for (at += 5 * M; at < cleared + HEALTH_TIMING.recurringQuiet; at += 5 * M) {
      state = transitionFactoryHealth(state, disk(at, 0.5), () => at).state;
      expect(diskMessages(state).some(n => n.kind === "settled")).toBe(false);
    }
    state = transitionFactoryHealth(state, disk(at, 0.5), () => at).state;
    const settled = diskMessages(state).filter(n => n.kind === "settled");
    expect(settled.map(n => [n.message, n.createdAt])).toEqual([["Stopped recurring: Factory disk use is back within its limit.", cleared + 30 * M]]);
    expect(dueFor(state, at).map(p => p.notificationId)).toEqual([settled[0]!.id, settled[0]!.id]);
    state = transitionFactoryHealth(state, disk(at + 5 * M, 0.9), () => at + 5 * M).state;
    expect(diskMessages(state).at(-1)).toMatchObject({ kind: "opening", hardStop: true });
    expect(diskMessages(state).filter(n => n.kind === "recurring")).toHaveLength(1);
    expect(dueFor(state, at + 5 * M).map(p => p.notificationId)).toContain(diskMessages(state).at(-1)!.id);
  });
  test("an undelivered 'keeps recurring' message outlives its own end, and its closing message waits for it", () => {
    let { state, at } = alternate(3, false);
    for (let i = 0; i < 8; i++) state = transitionFactoryHealth(state, disk(at += 5 * M, 0.5), () => at).state;
    const [notice, settled] = ["recurring", "settled"].map(kind => diskMessages(state).find(n => n.kind === kind)!);
    expect(dueFor(state, at).map(p => p.notificationId)).toEqual([notice!.id, notice!.id]);
    state = confirm(state, notice!.id, "Vincent", at);
    expect(dueFor(state, at)).toEqual([{ notificationId: notice!.id, recipient: "Coordinator" }, { notificationId: settled!.id, recipient: "Vincent" }]);
    expect(FactoryHealthStateSchema.parse(copy(state))).toEqual(state);
  });
  test("two openings in an hour, or three spread over more than an hour, are ordinary", () => {
    expect(diskMessages(alternate(2, false).state).some(n => n.kind === "recurring")).toBe(false);
    let state = initialFactoryHealthState(), at = AT;
    for (let i = 0; i < 6; i++, at += 31 * M) state = transitionFactoryHealth(state, disk(at, i % 2 === 0 ? 0.9 : 0.5), () => at).state;
    expect(diskMessages(state).map(n => n.kind)).toEqual(["opening", "recovery", "opening", "recovery", "opening", "recovery"]);
  });
});

// The outbox as it stood on the Mac, reduced to what the rules read.
function storedOutbox(): FactoryHealthState {
  const stored = JSON.parse(readFileSync(new URL("./data/health-outbox-stored-20261111.json", import.meta.url), "utf8")) as {
    lastAt: number; messages: string[]; episodes: Record<string, [number, number, number | null, number, number | null, string][]>;
  };
  const state = initialFactoryHealthState();
  state.lastAt = stored.lastAt;
  const attempts = (id: string, recipient: string, at: number, outcome: string) => outcome === "-" ? [] : [outcome === "d"
    ? { id: `${id}:${recipient}:attempt:1`, at, result: "delivered" as const, finishedAt: at, receipt: "stored-receipt" }
    : { id: `${id}:${recipient}:attempt:1`, at, result: "in-flight" as const, finishedAt: null, receipt: null }];
  for (const condition of HEALTH_CONDITIONS) stored.episodes[condition]!.forEach(([openedAt, lastActionableAt, clearedAt, opening, recovery, outcomes], i) => {
    const id = `factory-health:${condition}:${i + 1}:${openedAt}`;
    state.episodes[condition].push({ id, openingId: `${id}:opening`, recoveryId: `${id}:recovery`, openedAt, lastActionableAt, clearedAt });
    const add = (kind: "opening" | "recovery", at: number, message: number, vincent: string, coordinator: string) => state.outbox.push({
      id: `${id}:${kind}`, incidentId: id, condition, kind, createdAt: at, message: stored.messages[message]!,
      deliveries: { Vincent: { attempts: attempts(`${id}:${kind}`, "Vincent", at, vincent) }, Coordinator: { attempts: attempts(`${id}:${kind}`, "Coordinator", at, coordinator) } },
    });
    add("opening", openedAt, opening, outcomes[0]!, outcomes[2]!);
    if (clearedAt !== null) add("recovery", clearedAt, recovery!, outcomes[1]!, outcomes[3]!);
  });
  return FactoryHealthStateSchema.parse(state);
}

describe("replay of the stored outbox", () => {
  const before = storedOutbox(), now = before.lastAt! + 5 * M;
  const { state, archived } = settleHealthOutbox(before, () => now);
  const waiting = (recipient: HealthRecipient, s = state) => pendingHealthDeliveries(s, () => now).filter(p => p.recipient === recipient).map(p => p.notificationId);

  test("under the old rules' backlog, 138 messages would be released at once; the archive pass leaves none for Vincent", () => {
    expect(pendingHealthDeliveries(before, () => now)).toHaveLength(138);
    expect(archived).toBe(265);
    expect(waiting("Vincent")).toEqual([]);
    // What is left for the Coordinator is a readback of rows already in Alido Mail, not new mail.
    expect(waiting("Coordinator")).toHaveLength(7);
    for (const id of waiting("Coordinator")) expect(before.outbox.find(n => n.id === id)!.deliveries.Coordinator.attempts).toHaveLength(1);
    expect(settleHealthOutbox(state, () => now).archived).toBe(0);
  });
  test("it archives and never deletes", () => {
    expect(state.outbox.map(n => n.id)).toEqual(before.outbox.map(n => n.id));
    expect(state.episodes).toEqual(before.episodes);
    for (const [i, n] of state.outbox.entries()) for (const r of RECIPIENTS) expect(n.deliveries[r].attempts).toEqual(before.outbox[i]!.deliveries[r].attempts);
  });
  test("every opening has a recovery or is superseded, and nothing is sent about a cleared condition", () => {
    const byId = new Map(state.outbox.map(n => [n.id, n]));
    let checked = 0;
    for (const condition of HEALTH_CONDITIONS) state.episodes[condition].forEach((e, i, all) => {
      const opening = byId.get(e.openingId)!, recovery = e.clearedAt === null ? null : byId.get(e.recoveryId)!;
      for (const r of RECIPIENTS) {
        const handed = opening.deliveries[r].attempts.length > 0, due = waiting(r);
        checked++;
        if (!recovery) { expect(handed).toBe(true); continue; }
        // A cleared condition: an opening never handed over is archived with its recovery.
        if (!handed) {
          expect(opening.deliveries[r].superseded?.reason).toBe("cleared before it was sent");
          expect(recovery.deliveries[r].superseded?.reason).toBe("its opening was never sent");
          expect(due).not.toContain(opening.id);
          continue;
        }
        // An opening he received has its recovery: delivered, or replaced by the condition reopening.
        if (isDelivered(opening, r)) expect(isDelivered(recovery, r) || (i < all.length - 1 && recovery.deliveries[r].superseded?.reason === "the condition reopened before this was sent")).toBe(true);
        expect(due).not.toContain(recovery.id);
      }
    });
    expect(checked).toBe(2 * 81);
  });
  test("once the seven rows already in Alido Mail are confirmed, at most one recovery per condition follows", () => {
    let confirmed = state;
    for (const id of waiting("Coordinator")) confirmed = confirm(confirmed, id, "Coordinator", now);
    confirmed = settleHealthOutbox(confirmed, () => now).state;
    expect(waiting("Vincent", confirmed)).toEqual([]);
    // Disk and AWS each opened once and cleared; the Coordinator hears that they did.
    expect(waiting("Coordinator", confirmed)).toEqual(["factory-health:disk:1:1794315005713:recovery", "factory-health:aws:1:1794371105343:recovery"]);
  });
});

describe("replay of the stored 'work' history with delivery working", () => {
  test("72 openings and 72 recoveries become 14 messages for Vincent, none of them late", () => {
    const stored = JSON.parse(readFileSync(new URL("./data/health-outbox-stored-20261111.json", import.meta.url), "utf8")) as { lastAt: number; episodes: { work: [number, number, number | null][] } };
    const episodes = stored.episodes.work, bad = (at: number) => episodes.some(([opened, , cleared]) => at >= opened && (cleared === null || at < cleared));
    // The disk condition stands in for "work": the delivery rules are the same for every condition.
    const times = new Set(episodes.flatMap(([opened, , cleared]) => cleared === null ? [opened] : [opened, cleared]));
    for (let at = episodes[0]![0]; at <= stored.lastAt; at += 5 * M) times.add(at);
    let state = initialFactoryHealthState();
    const sent: Record<string, number> = {};
    for (const at of [...times].sort((a, b) => a - b)) {
      state = transitionFactoryHealth(state, disk(at, bad(at) ? 0.9 : 0.5), () => at).state;
      for (let pass = 0; pass < 2; pass++) for (const p of dueFor(state, at)) {
        const n = state.outbox.find(n => n.id === p.notificationId)!;
        expect(at - n.createdAt).toBe(0);
        state = confirm(state, p.notificationId, p.recipient, at);
        if (p.recipient === "Vincent") sent[n.kind] = (sent[n.kind] ?? 0) + 1;
      }
    }
    expect(diskMessages(state).filter(n => n.kind === "opening")).toHaveLength(72);
    expect(sent).toEqual({ opening: 5, recovery: 5, recurring: 2, settled: 2 });
  });
});

// A hand-made mail table: enough for the launcher's own rows. The real mail
// code is exercised in the last block.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "health-delivery-")), path = join(dir, "mail.sqlite"), db = new Database(path);
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,wake_id TEXT);
    CREATE TABLE telegram_messages(message_id INTEGER PRIMARY KEY,mail_id TEXT,sent_at INTEGER);`);
  const factory = join(dir, "factory");
  mkdirSync(factory);
  return { dir, factory, path, db };
}
const offline = { execute: async () => { throw Error("fictional no network"); } };
// These runs read this machine's real disk, which may itself be over its limit, so tests look at the tick only.
const aboutTick = <T extends { notification: string }>(list: T[]) => list.filter(u => u.notification.includes(":tick:"));
const tickLog = (factory: string, entries: [number, "ok" | "error"][]) =>
  writeFileSync(join(factory, "tick.log"), entries.map(([at, status]) => JSON.stringify({ at, status })).join("\n") + "\n");
const ids = (db: Database, where: string) => (db.query(`SELECT id FROM messages WHERE ${where} ORDER BY id`).all() as { id: string }[]).map(r => r.id);
const storedState = (factory: string) => {
  const db = new Database(join(factory, "health/state.sqlite"), { readonly: true });
  try { return FactoryHealthStateSchema.parse(JSON.parse((db.query("SELECT json FROM state WHERE id=1").get() as { json: string }).json)); } finally { db.close(); }
};

describe("hard stops carry the contract's id", () => {
  test("every id the health job can build is a hard stop the contract knows", () => {
    expect(Object.keys(HEALTH_HARD_STOPS).sort()).toEqual(["aws", "disk", "tick"]);
    expect(parseOwnerMessageId(healthHardStopId("disk", AT))).toMatchObject({ tier: "hard-stop", kind: "disk", subject: "data-volume", day: "2026-11-10" });
    expect(parseOwnerMessageId(healthHardStopId("aws", AT))).toMatchObject({ tier: "hard-stop", kind: "human-step", subject: "aws-sign-in" });
    expect(parseOwnerMessageId(healthHardStopId("tick", AT))).toMatchObject({ tier: "hard-stop", kind: "factory-down", subject: "tick-dead" });
    // The day is Toronto's, not UTC's.
    expect(healthHardStopId("tick", Date.parse("2026-11-11T03:30:00Z"))).toBe("loop:hard-stop:factory-down:tick-dead:2026-11-10");
  });
  test("only a real loss is marked: unknown evidence and 'expires before tonight' stay routine", () => {
    const evaluate = (snapshot: FactoryHealthSnapshot) => transitionFactoryHealth(initialFactoryHealthState(), snapshot, () => AT).state.outbox;
    const source = <T>(value: T) => ({ state: "ok" as const, observedAt: AT, receipt: "fictional-readback", value });
    const marked = (outbox: HealthNotification[]) => outbox.filter(n => n.hardStop).map(n => n.condition);
    expect(marked(evaluate({ version: 1, capturedAt: AT }))).toEqual([]);
    expect(marked(evaluate({ version: 1, capturedAt: AT, aws: source({ verified: true, credentialId: "fictional", expiresAt: AT + 60 * M }) }))).toEqual([]);
    expect(marked(evaluate({ version: 1, capturedAt: AT,
      aws: source({ verified: true, credentialId: "fictional", expiresAt: AT - M }), disk: source({ usedFraction: 0.9 }),
      tick: source({ lastSuccessAt: AT - 11 * M, lastAttemptAt: AT - 11 * M, result: "success" as const }),
    })).sort()).toEqual(["aws", "disk", "tick"]);
    expect(marked(evaluate({ version: 1, capturedAt: AT, tick: source({ lastSuccessAt: AT - M, lastAttemptAt: AT, result: "failure" as const }) }))).toEqual(["tick"]);
  });
  test("a tick fault is written for Vincent under the hard-stop id; a second one that day keeps its own id rather than pass unsaid", async () => {
    const f = workspace();
    try {
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"]]);
      await watchFactoryHealth(f.factory, f.path, AT, offline);
      const stop = healthHardStopId("tick", AT);
      expect(ids(f.db, "recipient='Vincent' AND summary LIKE 'Factory tick failed%'")).toEqual([stop]);
      expect(ids(f.db, "recipient='Coordinator' AND summary LIKE 'Factory tick failed%'")).toEqual([`factory-health:tick:1:${AT}:opening:Coordinator`]);
      // Sent, recovered, then the tick fails again the same afternoon.
      f.db.query("INSERT INTO telegram_messages VALUES(1,?,?)").run(stop, AT + M);
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"], [AT + 5 * M, "ok"]]);
      await watchFactoryHealth(f.factory, f.path, AT + 5 * M, offline);
      const recovery = `factory-health:tick:1:${AT}:recovery:Vincent`;
      expect(ids(f.db, "recipient='Vincent' AND summary='Factory ticks are working again.'")).toEqual([recovery]);
      f.db.query("INSERT INTO telegram_messages VALUES(2,?,?)").run(recovery, AT + 6 * M);
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"], [AT + 5 * M, "ok"], [AT + 3 * 60 * M, "error"]]);
      await watchFactoryHealth(f.factory, f.path, AT + 3 * 60 * M, offline);
      expect(ids(f.db, "recipient='Vincent' AND summary LIKE 'Factory tick failed%'")).toEqual([`factory-health:tick:2:${AT + 3 * 60 * M}:opening:Vincent`, stop].sort());
    } finally { f.db.close(); }
  });
  test("another writer's row for the same hard stop on the same day is shared, whatever its wording", () => {
    const f = workspace();
    try {
      const bridge = healthBridge(f.path), stop = healthHardStopId("disk", AT);
      try {
        bridge.send(stop, "Vincent", "Disk is full; new work is stopped.");
        expect(() => bridge.send(stop, "Vincent", "Factory disk use is above 85%; free space safely.")).toThrow("different notification");
        bridge.send(stop, "Vincent", "Factory disk use is above 85%; free space safely.", true);
        expect(() => bridge.send(stop, "Coordinator", "Factory disk use is above 85%; free space safely.", true)).toThrow("different notification");
      } finally { bridge.close(); }
      expect(f.db.query("SELECT summary FROM messages").all()).toEqual([{ summary: "Disk is full; new work is stopped." }]);
    } finally { f.db.close(); }
  });
});

describe("a message nobody confirmed is a fault of its own", () => {
  const heartbeat = (factory: string) => JSON.parse(readFileSync(join(factory, "health/heartbeat.json"), "utf8"));
  test("after ten minutes it is the alarm in the heartbeat and in the job's result; a row the gate holds is not", async () => {
    const f = workspace();
    try {
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"]]);
      const first = await watchFactoryHealth(f.factory, f.path, AT, offline);
      expect(first).toMatchObject({ deliveryAlarm: null, unconfirmed: [] });
      expect(heartbeat(f.factory)).toEqual({ at: AT });
      // Exactly ten minutes is not yet late.
      expect((await watchFactoryHealth(f.factory, f.path, AT + 10 * M, offline)).deliveryAlarm).toBeNull();
      const stop = healthHardStopId("tick", AT), work = `factory-health:work:1:${AT}:opening`;
      // Stand-ins for what Alido Mail does: the Coordinator's rows are digested, one routine row is held by the gate, the rest never leave.
      f.db.query("UPDATE messages SET wake_state='digested',wake_id='fictional-wake' WHERE recipient='Coordinator'").run();
      f.db.query("UPDATE messages SET wake_state='held' WHERE id=?").run(`${work}:Vincent`);
      const late = await watchFactoryHealth(f.factory, f.path, AT + 11 * M, offline);
      expect(late.unconfirmed.every(u => u.recipient === "Vincent" && u.reason === "written to Alido Mail but not sent")).toBe(true);
      expect(late.unconfirmed.map(u => u.notification)).not.toContain(work);
      // The hard stop is named first.
      expect(late.unconfirmed[0]).toEqual({ notification: `factory-health:tick:1:${AT}:opening`, recipient: "Vincent", hardStop: true, reason: "written to Alido Mail but not sent", createdAt: AT });
      const stops = late.unconfirmed.filter(u => u.hardStop).length;
      expect(late.deliveryAlarm).toBe(`${late.unconfirmed.length} health messages unconfirmed after 10 minutes, ${stops} of them a hard stop. First: factory-health:tick:1:${AT}:opening for Vincent, created 2026-11-10, 12:00 Toronto time, written to Alido Mail but not sent.`);
      expect(LoopHeartbeatSchema.parse(heartbeat(f.factory))).toEqual({ at: AT + 11 * M, alarm: late.deliveryAlarm! });
      // The Coordinator's leg was confirmed by "digested"; that says nothing about Vincent's.
      const state = storedState(f.factory), tick = state.outbox.find(n => n.condition === "tick")!;
      expect(isDelivered(tick, "Coordinator")).toBe(true);
      expect(isDelivered(tick, "Vincent")).toBe(false);
      // Sent at last: only the Telegram sent time counts.
      const pending = ids(f.db, "recipient='Vincent' AND wake_state='pending'");
      pending.forEach((id, i) => f.db.query("INSERT INTO telegram_messages VALUES(?,?,?)").run(i + 1, id, AT + 12 * M));
      const sent = await watchFactoryHealth(f.factory, f.path, AT + 16 * M, offline);
      expect(sent).toMatchObject({ deliveryAlarm: null, unconfirmed: [] });
      expect(heartbeat(f.factory)).toEqual({ at: AT + 16 * M });
      expect(storedState(f.factory).outbox.find(n => n.id === work)!.deliveries.Vincent).toMatchObject({ attempts: [{ result: "in-flight" }] });
      expect(pending).toContain(stop);
    } finally { f.db.close(); }
  });
  test("a hard stop has no 'held' exception, and a routine row the gate folds or cancels is archived", async () => {
    const f = workspace();
    try {
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"]]);
      await watchFactoryHealth(f.factory, f.path, AT, offline);
      const stop = healthHardStopId("tick", AT), work = `factory-health:work:1:${AT}:opening`, aws = `factory-health:aws:1:${AT}:opening`;
      f.db.query("UPDATE messages SET wake_state='held' WHERE recipient='Vincent'").run();
      f.db.query("UPDATE messages SET wake_state='folded' WHERE id=?").run(`${work}:Vincent`);
      f.db.query("UPDATE messages SET wake_state='cancelled' WHERE id=?").run(`${aws}:Vincent`);
      f.db.query("UPDATE messages SET wake_state='digested',wake_id='fictional-wake' WHERE recipient='Coordinator'").run();
      const late = await watchFactoryHealth(f.factory, f.path, AT + 11 * M, offline);
      expect(aboutTick(late.unconfirmed)).toEqual([{ notification: `factory-health:tick:1:${AT}:opening`, recipient: "Vincent", hardStop: true, reason: "held by the mail gate", createdAt: AT }]);
      // Every other row for Vincent is routine and held, so only hard stops are left to report.
      expect(late.unconfirmed.every(u => u.hardStop)).toBe(true);
      expect(late.deliveryAlarm).toMatch(/^\d health messages? unconfirmed after 10 minutes, \d of them a hard stop\. First: /);
      const state = storedState(f.factory), reason = (id: string) => state.outbox.find(n => n.id === id)!.deliveries.Vincent.superseded?.reason;
      expect([reason(work), reason(aws)]).toEqual(["folded by Alido Mail", "cancelled by Alido Mail"]);
      // Even cancelled, a hard stop is not quietly archived while its condition is open.
      f.db.query("UPDATE messages SET wake_state='cancelled' WHERE id=?").run(stop);
      const still = await watchFactoryHealth(f.factory, f.path, AT + 16 * M, offline);
      expect(aboutTick(still.unconfirmed)).toEqual([{ notification: `factory-health:tick:1:${AT}:opening`, recipient: "Vincent", hardStop: true, reason: "cancelled by the mail gate", createdAt: AT }]);
      // Once the condition has cleared there is nothing left to say, so it is archived with its reason.
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"], [AT + 20 * M, "ok"]]);
      await watchFactoryHealth(f.factory, f.path, AT + 21 * M, offline);
      const ended = await watchFactoryHealth(f.factory, f.path, AT + 26 * M, offline);
      expect(aboutTick(ended.unconfirmed)).toEqual([]);
      expect(storedState(f.factory).outbox.filter(n => n.condition === "tick").map(n => n.deliveries.Vincent.superseded?.reason)).toEqual(["cancelled by Alido Mail", "its opening was never sent"]);
    } finally { f.db.close(); }
  });
});

describe("nothing is written about a cleared condition", () => {
  test("an opening that never reached Alido Mail is archived, not written, once its condition has cleared", async () => {
    const f = workspace();
    try {
      // Alido Mail cannot be written to during the first run.
      f.db.exec("ALTER TABLE messages RENAME TO messages_away");
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"]]);
      await watchFactoryHealth(f.factory, f.path, AT, offline);
      f.db.exec("ALTER TABLE messages_away RENAME TO messages");
      expect(ids(f.db, "1")).toEqual([]);
      tickLog(f.factory, [[AT - M, "ok"], [AT, "error"], [AT + 5 * M, "ok"]]);
      await watchFactoryHealth(f.factory, f.path, AT + 5 * M, offline);
      await watchFactoryHealth(f.factory, f.path, AT + 10 * M, offline);
      // The conditions still open are written now; the tick fault that came and went is not.
      expect(ids(f.db, "1").length).toBeGreaterThan(3);
      expect(ids(f.db, "summary LIKE '%tick%'")).toEqual([]);
      const tick = storedState(f.factory).outbox.filter(n => n.condition === "tick");
      expect(tick.map(n => RECIPIENTS.map(r => n.deliveries[r].superseded?.reason))).toEqual([
        ["cleared before it was sent", "cleared before it was sent"], ["its opening was never sent", "its opening was never sent"],
      ]);
    } finally { f.db.close(); }
  });
});

describe("a reopened condition is said again", () => {
  test("it does not borrow its own earlier row; another writer's alarm, unless folded or cancelled, still stands in", async () => {
    // Real time, because Alido Mail rows are stamped with it and the lookup compares against it.
    const f = workspace(), s = new Store(join(f.factory, "controller.sqlite")), T = Date.now() + 1000;
    const work = () => ids(f.db, "recipient='Vincent' AND id LIKE 'factory-health:work:%'");
    try {
      s.set("paused", false);
      s.event("init", "resume", {}, "retain", T - 24 * 60 * M);
      writeFileSync(join(f.factory, "config.yaml"), JSON.stringify(config()));
      writeFileSync(join(f.factory, "qualifications.json"), "{}");
      // Work evidence is the controller's heartbeat: fresh is healthy, more than five minutes old is unknown.
      const run = (at: number, heartbeatAt: number) => {
        s.set("heartbeat", { at: heartbeatAt, status: "ok", ready: 0 });
        tickLog(f.factory, [[at, "ok"]]);
        return watchFactoryHealth(f.factory, f.path, at, offline);
      };
      const opening = (n: number, at: number) => `factory-health:work:${n}:${at}:opening:Vincent`;
      await run(T, T - 10 * M);
      expect(work()).toEqual([opening(1, T)]);
      f.db.query("INSERT INTO telegram_messages VALUES(1,?,?)").run(opening(1, T), T + M);
      await run(T + 5 * M, T + 5 * M);
      // Fifteen minutes after the first opening it is unknown again. The old two-hour rule left this unsaid.
      await run(T + 20 * M, T + 5 * M);
      expect(work()).toEqual([opening(1, T), `factory-health:work:1:${T}:recovery:Vincent`, opening(2, T + 20 * M)].sort());
      f.db.query("INSERT INTO telegram_messages VALUES(2,?,?)").run(opening(2, T + 20 * M), T + 21 * M);
      await run(T + 25 * M, T + 25 * M);
      // The tick's own stall alarm, from another writer, is on its way: the next opening borrows it.
      // (Openings are spaced more than an hour apart here so the flap rule stays out of it.)
      const stall = f.db.query("INSERT INTO messages(id,created_at,recipient,recipient_app,summary,wake_state) VALUES(?,?,'Vincent','telegram','Fictional stall alarm',?)");
      stall.run("claim-stall:fictional-1", T + 80 * M, "pending");
      await run(T + 90 * M, T + 25 * M);
      expect(storedState(f.factory).episodes.work).toHaveLength(3);
      expect(work()).toHaveLength(4);
      // Folded by the gate, it will never be sent, so it stands in for nothing.
      await run(T + 95 * M, T + 95 * M);
      stall.run("claim-stall:fictional-2", T + 140 * M, "folded");
      await run(T + 160 * M, T + 95 * M);
      expect(work()).toContain(opening(4, T + 160 * M));
      expect(work().some(id => id.includes("recurring"))).toBe(false);
    } finally { s.close(); f.db.close(); }
  });
});

describe("the one-time archive pass over the stored backlog", () => {
  test("the old state is kept once, nothing about a cleared condition is written, and Vincent gets no burst", async () => {
    const f = workspace();
    try {
      const { recurrences: _, ...old } = storedOutbox(), now = old.lastAt! + 5 * M;
      mkdirSync(join(f.factory, "health"));
      const health = new Database(join(f.factory, "health/state.sqlite"));
      health.exec("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,inactive INTEGER)");
      health.query("INSERT INTO state VALUES(1,?,NULL)").run(JSON.stringify(old));
      health.close();
      // Alido Mail already holds the seven Coordinator rows the old rules kept retrying; each was digested long ago.
      const inMail = old.outbox.filter(n => n.deliveries.Coordinator.attempts.length > 0).map(n => `${n.id}:Coordinator`);
      const bridge = healthBridge(f.path);
      try { for (const id of inMail) bridge.send(id, "Coordinator", old.outbox.find(n => `${n.id}:Coordinator` === id)!.message); } finally { bridge.close(); }
      f.db.query("UPDATE messages SET wake_state='digested',wake_id='fictional-wake'").run();
      expect(inMail).toHaveLength(7);
      const first = await watchFactoryHealth(f.factory, f.path, now, offline);
      // 265 from the backlog, plus whatever this run's own evaluation replaced.
      expect(first.archived).toBeGreaterThanOrEqual(265);
      await watchFactoryHealth(f.factory, f.path, now + 5 * M, offline);
      const archive = new Database(join(f.factory, "health/state.sqlite"), { readonly: true });
      try {
        expect(archive.query("SELECT at,reason,json FROM state_archive").all()).toEqual([{ at: now, reason: "state before the first current-state-wins pass", json: JSON.stringify(old) }]);
      } finally { archive.close(); }
      // Vincent hears only what this run itself found, never the backlog.
      const cleared = new Set(HEALTH_CONDITIONS.flatMap(c => old.episodes[c].filter(e => e.clearedAt !== null).flatMap(e => [e.openingId, e.recoveryId])));
      const written = ids(f.db, "recipient='Vincent'");
      expect(written.length).toBeLessThanOrEqual(HEALTH_CONDITIONS.length);
      for (const id of written) expect(cleared.has(id.replace(/:Vincent$/, ""))).toBe(false);
      // The Coordinator's seven old rows are confirmed, not rewritten. The only new mail about the
      // backlog is the recovery of a condition that opened once, was received, and has stayed clear.
      const state = storedState(f.factory);
      for (const id of inMail) expect(isDelivered(state.outbox.find(n => `${n.id}:Coordinator` === id)!, "Coordinator")).toBe(true);
      const fresh = ids(f.db, "recipient='Coordinator'").filter(id => !inMail.includes(id) && cleared.has(id.replace(/:Coordinator$/, "")));
      for (const id of fresh) expect(["factory-health:disk:1:1794315005713:recovery:Coordinator", "factory-health:aws:1:1794371105343:recovery:Coordinator"]).toContain(id);
    } finally { f.db.close(); }
  });
  test("the two health files are named for the protected list", () => {
    expect([...HEALTH_PROTECTED_PATHS]).toEqual(["launcher/factory-health.ts", "launcher/factory-health-runtime.ts"]);
  });
});

// These run Alido Mail's own code on a temporary store. That checkout is a
// separate repository and is absent in this repository's CI, where they are
// skipped. Run them on the Mac with FACTORY_REQUIRE_MAIL_SOURCE=1 before install.
describe.skipIf(!realMailSource())("delivery proof on the real mail store", () => {
  test("an fyi ends 'digested' and counts; Vincent's row counts only with its Telegram sent time; a held row is not a failure", async () => {
    const mail = await openRealMailStore(), factory = mkdtempSync(join(tmpdir(), "health-real-mail-"));
    try {
      const at = Date.now() - 20 * M, state = () => storedState(factory);
      tickLog(factory, [[at - M, "ok"], [at, "error"]]);
      await watchFactoryHealth(factory, mail.path, at, offline);
      const openings = state().outbox, stop = healthHardStopId("tick", at);
      const vincentRow = (n: HealthNotification) => n.hardStop ? healthHardStopId(n.condition as HealthHardStop, n.createdAt) : `${n.id}:Vincent`;
      expect(openings.length).toBeGreaterThan(3);
      expect(mail.row(stop)).toMatchObject({ recipient: "Vincent", recipient_app: "telegram", wake_state: "pending" });
      for (const n of openings) expect(mail.row(`${n.id}:Coordinator`)).toMatchObject({ kind: "fyi", state: "unread", wake_state: "pending" });

      // The Coordinator's leg, through the wake a Claude chat's mail server runs.
      expect(await mail.wakeClaude("Coordinator")).toBe(true);
      for (const n of openings) expect(mail.row(`${n.id}:Coordinator`)).toMatchObject({ wake_state: "digested" });
      // One routine row stands in for a row the gate holds. The value is hand-set
      // because the gate is not in this repository; nothing else here is.
      const held = openings.find(n => n.condition === "work")!;
      mail.db.query("update messages set wake_state='held' where id=?").run(`${held.id}:Vincent`);

      const late = await watchFactoryHealth(factory, mail.path, at + 11 * M, offline);
      for (const n of state().outbox) {
        expect(isDelivered(n, "Coordinator")).toBe(true);
        expect(n.deliveries.Coordinator.attempts.at(-1)!.receipt).toBe(`alido-mail:${n.id}:Coordinator:${mail.row(`${n.id}:Coordinator`)!.wake_id}`);
        // Digested mail for the Coordinator is no proof Vincent was told.
        expect(isDelivered(n, "Vincent")).toBe(false);
      }
      // Nothing was sent to Telegram, so every Vincent row is a failure, except the held one.
      expect(late.unconfirmed.map(u => u.notification).sort()).toEqual(openings.filter(n => n.id !== held.id).map(n => n.id).sort());
      expect(late.unconfirmed.every(u => u.recipient === "Vincent")).toBe(true);
      expect(late.deliveryAlarm).toMatch(/ unconfirmed after 10 minutes, \d of them a hard stop\. First: /);

      // Alido Mail's one send function, through a stand-in Telegram connection.
      expect((await mail.sendToVincent()).length).toBeGreaterThan(0);
      expect(mail.telegramSentAt(stop)).not.toBeNull();
      const after = await watchFactoryHealth(factory, mail.path, at + 16 * M, offline);
      for (const n of state().outbox.filter(n => n.kind === "opening")) expect(isDelivered(n, "Vincent")).toBe(mail.telegramSentAt(vincentRow(n)) !== null);
      expect(isDelivered(state().outbox.find(n => n.hardStop)!, "Vincent")).toBe(true);
      expect(after.unconfirmed.filter(u => u.hardStop)).toEqual([]);
      // Whatever the sender did with the held row, it is never called a failure while it is held.
      if (mail.row(`${held.id}:Vincent`)!.wake_state === "held") {
        expect(mail.telegramSentAt(`${held.id}:Vincent`)).toBeNull();
        expect(after.unconfirmed.map(u => u.notification)).not.toContain(held.id);
      }
      expect(mail.revision).toMatch(/^[a-f0-9]{40}$/);
    } finally { mail.close(); }
  });
});

test("the day of a hard-stop id is the Toronto day the release windows use", () => {
  expect(healthHardStopId("disk", AT).endsWith(healthReleaseWindows(AT)[0]!.day)).toBe(true);
});
