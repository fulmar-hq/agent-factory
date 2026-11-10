import type { Store } from './store';

export type MetricsWindow = { from: number; to: number };
export type ControllerEvent = { id: string; kind: string; at: number; data: string };
export type EvidenceCount = { observed: number | null; eventIds: string[] };
export type UnknownInterval = MetricsWindow & { state: 'unknown'; reason: string };
export type FailureLatency = {
  session: string;
  failedAt: number | null;
  failureEventId: string;
  response: 'retry-approved' | 'escalated' | null;
  responseEventId: string | null;
  respondedAt: number | null;
  latencyMs: number | null;
};
export type ProgressHour = MetricsWindow & {
  eligible: null;
  ticketProgress: { eventId: string; session: string | null; kind: string; at: number }[];
};
export type AutonomyMetrics = {
  window: MetricsWindow;
  /** Observed event counts are lower bounds, never proof of complete coverage. */
  decisions: { rule: EvidenceCount; owner: EvidenceCount; default: EvidenceCount };
  eligibleHoursWithTicketProgress: number | null;
  progressHours: ProgressHour[];
  eligibility: UnknownInterval[];
  failureResponses: FailureLatency[];
  readyStarvation: UnknownInterval[];
  capacityStarvation: UnknownInterval[];
  launcherPublications: EvidenceCount;
  verifiedProductionDeliveries: EvidenceCount;
  rejectedEventIds: string[];
};

type Decoded = Omit<ControllerEvent, 'data'> & { data: Record<string, unknown> };
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = (events: Decoded[]): EvidenceCount => ({
  observed: events.length || null,
  eventIds: events.map(e => e.id),
});
const hour = 3_600_000;
const sessionOf = (e: Decoded): string | null => {
  if (nonempty(e.data.session)) return e.data.session;
  if (nonempty(e.data.id)) return e.data.id;
  return e.kind === 'reservation' ? e.id : null;
};

/**
 * Pure replay over the controller's actual append-only event schema. Window is
 * half-open [from,to), in epoch milliseconds; no clock, model or network calls.
 * Supply all history through to, including earlier failures for cross-window
 * responses. Identical replays are idempotent. Conflicting IDs are rejected.
 * Missing event families produce null, not a fabricated zero. No current KV
 * snapshot is projected backwards into an interval. In particular the existing
 * controller persists neither eligibility nor queue/occupancy sample history.
 */
export function autonomyMetrics(rows: readonly ControllerEvent[], window: MetricsWindow): AutonomyMetrics {
  const { from, to } = window;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    throw Error('metrics window must be a nonempty epoch-millisecond interval');
  const grouped = new Map<string, ControllerEvent[]>();
  for (const row of rows) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }
  const rejected = new Set<string>();
  const events: Decoded[] = [];
  for (const [id, group] of grouped) {
    const row = group[0];
    if (group.some(r => r.kind !== row.kind || r.at !== row.at || r.data !== row.data) ||
        !nonempty(id) || !Number.isSafeInteger(row.at) || row.at < 0) {
      rejected.add(id); continue;
    }
    if (row.at >= to) continue;
    try {
      const data: unknown = JSON.parse(row.data);
      if (!object(data)) throw Error('object required');
      events.push({ ...row, data });
    } catch { rejected.add(id); }
  }
  events.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inside = events.filter(e => e.at >= from);
  const valid = (kind: string, predicate: (d: Record<string, unknown>) => boolean) =>
    inside.filter(e => {
      if (e.kind !== kind) return false;
      if (predicate(e.data)) return true;
      rejected.add(e.id); return false;
    });
  const publications = valid('launcher-publish', d =>
    nonempty(d.id) && nonempty(d.repo) && nonempty(d.head) && /^[a-f0-9]{40}$/.test(d.head) &&
    nonempty(d.tree) && /^[a-f0-9]{40}$/.test(d.tree) && nonempty(d.url) &&
    d.url.startsWith(`https://github.com/${d.repo}/pull/`) &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(d.url));
  const rule = valid('intake-auto-approved', d => nonempty(d.repo) && Number.isInteger(d.number) && nonempty(d.digest));
  const owner = valid('owner-answer', d => nonempty(d.id) && nonempty(d.answer))
    .filter(e => (e.data.id as string).startsWith('autonomy:'));
  const defaults = valid('autonomy-decision-default', d => nonempty(d.id) && nonempty(d.default));

  // Prefer the first actual failure receipt, not the later classification time.
  // Retain unresolved failures and never turn elapsed waiting into a response.
  const failures = new Map<string, Decoded>();
  for (const e of events) {
    const isFailure = e.kind === 'worker-failure' || e.kind === 'worker-halt' ||
      e.kind === 'failure-classified' || (e.kind === 'worker-exit' && e.data.ok === false);
    if (!isFailure) continue;
    const session = sessionOf(e);
    if (!session) { rejected.add(e.id); continue; }
    if (!failures.has(session)) failures.set(session, e);
  }
  const failureResponses: FailureLatency[] = [];
  for (const [session, failure] of failures) {
    const response = events.find(e => e.at >= failure.at && (
      (e.kind === 'automatic-retry-approved' && e.data.session === session) ||
      (e.kind === 'autonomy-owner-decision' && object(e.data.payload) &&
        (e.data.payload.session === session ||
          (Array.isArray(e.data.payload.recent) && e.data.payload.recent.some(f => object(f) && f.session === session))))
    ));
    // A cohort includes failures in the window and earlier failures whose first
    // response falls in it. Earlier unresolved failures remain visible as well.
    if (failure.at < from && response && response.at < from) continue;
    // A classification timestamp observes diagnosis, not when failure occurred.
    const failedAt = failure.kind === 'failure-classified' ? null : failure.at;
    failureResponses.push({
      session, failedAt, failureEventId: failure.id,
      response: response ? response.kind === 'automatic-retry-approved' ? 'retry-approved' : 'escalated' : null,
      responseEventId: response?.id ?? null, respondedAt: response?.at ?? null,
      latencyMs: response && failedAt !== null ? response.at - failedAt : null,
    });
  }
  const reservations = valid('reservation', d => nonempty(d.repo) && Number.isInteger(d.number));
  const progress = inside.filter(e => reservations.includes(e) ||
    (e.kind === 'start-attempt' && nonempty(e.data.id)) ||
    (e.kind === 'worker-exit' && e.data.ok === true && nonempty(e.data.id)) || publications.includes(e));
  // Sparse UTC hour buckets bound output by evidence, even for long windows.
  const buckets = new Map<number, ProgressHour>();
  for (const e of progress) {
    const start = Math.floor(e.at / hour) * hour;
    const bucket = buckets.get(start) ?? { from: Math.max(from, start), to: Math.min(to, start + hour), eligible: null, ticketProgress: [] };
    bucket.ticketProgress.push({ eventId: e.id, session: sessionOf(e), kind: e.kind, at: e.at });
    buckets.set(start, bucket);
  }
  const unknown = (reason: string): UnknownInterval[] => [{ from, to, state: 'unknown', reason }];
  return {
    window: { from, to },
    decisions: { rule: count(rule), owner: count(owner), default: count(defaults) },
    eligibleHoursWithTicketProgress: null,
    progressHours: [...buckets.values()],
    eligibility: unknown('Controller events do not retain continuous admission eligibility observations.'),
    failureResponses,
    readyStarvation: unknown('Ready snapshots and intake wakes do not establish queue state between observations.'),
    capacityStarvation: unknown('Current capacity and capacity-increased events do not establish historical available slots.'),
    launcherPublications: count(publications),
    // release-authorization is permission, worker-exit is native completion,
    // launcher-publish is a PR. No existing event verifies Production delivery.
    verifiedProductionDeliveries: { observed: null, eventIds: [] },
    rejectedEventIds: [...rejected].sort(),
  };
}

/** Read-only reusable service for the board; replay survives controller restarts. */
export class AutonomyMetricsReader {
  constructor(private readonly store: Store) {}
  read(window: MetricsWindow): AutonomyMetrics {
    return this.store.atomic(() => autonomyMetrics(
      this.store.db.query('SELECT id,kind,at,data FROM events WHERE at<? ORDER BY at,id').all(window.to) as ControllerEvent[],
      window,
    ));
  }
}
