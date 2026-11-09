import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../tracking/store';
import { autonomyMetrics, AutonomyMetricsReader, type ControllerEvent } from '../tracking/autonomy-metrics';

const H = 3_600_000;
const event = (id: string, kind: string, at: number, data: unknown): ControllerEvent =>
  ({ id, kind, at, data: JSON.stringify(data) });
const publication = { id: 'session-one', repo: 'example/demo', head: 'a'.repeat(40), tree: 'b'.repeat(40), url: 'https://github.com/example/demo/pull/7' };

test('missing observations stay unknown, including empty windows', () => {
  const m = autonomyMetrics([], { from: 0, to: H });
  expect(m.decisions).toEqual({ rule: { observed: null, eventIds: [] }, owner: { observed: null, eventIds: [] }, default: { observed: null, eventIds: [] } });
  expect(m.launcherPublications.observed).toBeNull();
  expect(m.verifiedProductionDeliveries.observed).toBeNull();
  expect(m.eligibleHoursWithTicketProgress).toBeNull();
  expect(m.failureResponses).toEqual([]);
  expect(m.progressHours).toEqual([]);
  for (const intervals of [m.eligibility, m.readyStarvation, m.capacityStarvation]) {
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ from: 0, to: H, state: 'unknown' });
    expect(intervals[0].reason.length).toBeGreaterThan(10);
  }
});

test('half-open boundaries, UTC hour clipping and event IDs are deterministic', () => {
  const rows = [
    event('before', 'launcher-publish', H - 1, publication),
    event('at-start', 'launcher-publish', H, publication),
    event('at-end', 'launcher-publish', 2 * H + 1, publication),
    event('start', 'start-attempt', 2 * H, { id: 'session-two' }),
    event('complete', 'worker-exit', H + 1, { id: 'session-one', ok: true }),
  ];
  const window = { from: H, to: 2 * H + 1 };
  const m = autonomyMetrics(rows, window);
  expect(m).toEqual(autonomyMetrics([...rows, rows[1]].reverse(), window));
  expect(m.launcherPublications).toEqual({ observed: 1, eventIds: ['at-start'] });
  expect(m.progressHours.map(h => [h.from, h.to, h.eligible])).toEqual([[H, 2 * H, null], [2 * H, 2 * H + 1, null]]);
  expect(m.progressHours[0].ticketProgress.map(p => p.kind)).toEqual(['launcher-publish', 'worker-exit']);
  expect(m.eligibleHoursWithTicketProgress).toBeNull();
});

test('count actual decisions separately from requests and generic approval receipts', () => {
  const rows = [
    event('rule', 'intake-auto-approved', 1, { repo: 'example/demo', number: 1, digest: 'ready:synthetic' }),
    event('approval', 'intake-approval', 1, { repo: 'example/demo', number: 1 }),
    event('request', 'autonomy-owner-decision', 2, { id: 'question', tier: 'owner' }),
    event('answer', 'owner-answer', 3, { id: 'autonomy:question', answer: 'Not approved' }),
    event('default', 'autonomy-decision-default', 4, { id: 'other-question', default: 'not approved' }),
  ];
  const m = autonomyMetrics(rows, { from: 0, to: 5 });
  expect(m.decisions.rule).toEqual({ observed: 1, eventIds: ['rule'] });
  expect(m.decisions.owner).toEqual({ observed: 1, eventIds: ['answer'] });
  expect(m.decisions.default).toEqual({ observed: 1, eventIds: ['default'] });
});

test('failure latency starts at first failure, requires approved retry or escalation', () => {
  const rows = [
    event('failure', 'worker-exit', 1, { id: 's', ok: false }),
    event('failure-again', 'worker-failure', 2, { id: 's', error: 'test failed' }),
    event('classified', 'failure-classified', 10, { session: 's', at: 10 }),
    event('plan', 'automatic-retry-planned', 11, { session: 's' }),
    event('diagnosis', 'owner-wake-queued', 12, { kind: 'failure-diagnosis', payload: { session: 's' } }),
    event('wrong-session', 'automatic-retry-approved', 13, { session: 'other' }),
    event('retry', 'automatic-retry-approved', 20, { session: 's' }),
    event('later-escalation', 'autonomy-owner-decision', 21, { payload: { session: 's' } }),
    event('unresolved', 'worker-halt', 22, { id: 'pending' }),
  ];
  const m = autonomyMetrics(rows, { from: 15, to: 30 });
  expect(m.failureResponses).toEqual([
    { session: 's', failedAt: 1, failureEventId: 'failure', response: 'retry-approved', responseEventId: 'retry', respondedAt: 20, latencyMs: 19 },
    { session: 'pending', failedAt: 22, failureEventId: 'unresolved', response: null, responseEventId: null, respondedAt: null, latencyMs: null },
  ]);
  expect(autonomyMetrics(rows, { from: 15, to: 20 }).failureResponses[0].latencyMs).toBeNull();
  expect(autonomyMetrics(rows, { from: 21, to: 30 }).failureResponses.map(f => f.session)).toEqual(['pending']);
});

test('immediate escalation, circuit escalation and same-time events have stable attribution', () => {
  const rows = [
    event('exit-a', 'worker-exit', 1, { id: 'a', ok: false }),
    event('exit-b', 'worker-exit', 2, { id: 'b', ok: false }),
    event('decision-a', 'autonomy-owner-decision', 1, { payload: { session: 'a' } }),
    event('decision-circuit', 'autonomy-owner-decision', 3, { payload: { recent: [{ session: 'a' }, { session: 'b' }] } }),
  ];
  const m = autonomyMetrics(rows, { from: 0, to: 4 });
  expect(m.failureResponses.map(f => [f.session, f.response, f.latencyMs])).toEqual([['a', 'escalated', 0], ['b', 'escalated', 1]]);
});

test('classification alone does not invent failure time or latency', () => {
  const m = autonomyMetrics([
    event('classification', 'failure-classified', 10, { session: 'legacy' }),
    event('decision', 'autonomy-owner-decision', 20, { payload: { session: 'legacy' } }),
  ], { from: 0, to: 30 });
  expect(m.failureResponses[0]).toMatchObject({ failedAt: null, respondedAt: 20, latencyMs: null, response: 'escalated' });
});

test('PR publication, native success and release permission never prove Production delivery', () => {
  const rows = [
    event('native', 'worker-exit', 1, { id: 'session-one', ok: true }),
    event('legacy', 'worker-delivery', 2, { id: 'session-one', url: publication.url }),
    event('publish', 'launcher-publish', 3, publication),
    event('production', 'release-authorization', 4, { revision: publication.head, receipt: 'synthetic authorization only' }),
    event('increase', 'capacity-increased', 5, { from: 6, to: 7, busy: 1 }),
    event('intake', 'owner-wake-queued', 6, { kind: 'product-intake', payload: { ready: 0, target: 9 } }),
  ];
  const m = autonomyMetrics(rows, { from: 0, to: 7 });
  expect(m.launcherPublications.observed).toBe(1);
  expect(m.verifiedProductionDeliveries.observed).toBeNull();
  expect(m.readyStarvation[0].state).toBe('unknown');
  expect(m.capacityStarvation[0].state).toBe('unknown');
});

test('malformed, conflicting and future evidence cannot become success or a zero', () => {
  const rows = [
    { id: 'json', kind: 'launcher-publish', at: 1, data: '{' },
    event('shape', 'launcher-publish', 1, []),
    event('partial', 'launcher-publish', 1, { id: 's' }),
    event('conflict', 'launcher-publish', 1, publication),
    event('conflict', 'launcher-publish', 2, publication),
    event('future', 'launcher-publish', 100, publication),
    event('negative', 'launcher-publish', -1, publication),
    event('bad-answer', 'owner-answer', 1, { id: 'q' }),
  ];
  const m = autonomyMetrics(rows, { from: 0, to: 10 });
  expect(m.launcherPublications.observed).toBeNull();
  expect(m.decisions.owner.observed).toBeNull();
  expect(m.rejectedEventIds).toEqual(['bad-answer', 'conflict', 'json', 'negative', 'partial', 'shape']);
  for (const window of [{ from: 1, to: 1 }, { from: -1, to: 1 }, { from: 0, to: Infinity }, { from: 0.5, to: 1 }])
    expect(() => autonomyMetrics([], window)).toThrow();
});

test('persistent reader replays after restart without writes or mutable snapshot history', () => {
  mkdirSync('.factory-tmp', { recursive: true });
  const path = join('.factory-tmp', `metrics-${crypto.randomUUID()}.sqlite`);
  let s = new Store(path);
  try {
    s.event('failure', 'worker-failure', { id: 's', error: 'synthetic failure' }, 'retain fixture', 10);
    s.event('publish', 'launcher-publish', publication, 'retain fixture', 20);
    s.set('heartbeat', { at: 20, ready: 0, paused: false });
    s.set('capacity-controller', { at: 20, slots: 6, busy: 0 });
    const window = { from: 0, to: 30 };
    const first = new AutonomyMetricsReader(s).read(window);
    s.close();
    s = new Store(path);
    expect(s.event('publish', 'launcher-publish', publication, 'retain fixture', 20)).toBe(false);
    expect(new AutonomyMetricsReader(s).read(window)).toEqual(first);
    expect(s.rows('events')).toHaveLength(2);
    expect(s.get('heartbeat')).toEqual({ at: 20, ready: 0, paused: false });
    s.event('response', 'autonomy-owner-decision', { payload: { session: 's' } }, 'retain fixture', 30);
    expect(new AutonomyMetricsReader(s).read(window)).toEqual(first);
    expect(new AutonomyMetricsReader(s).read({ from: 0, to: 31 }).failureResponses[0].latencyMs).toBe(20);
  } finally { s.close(); }
});
