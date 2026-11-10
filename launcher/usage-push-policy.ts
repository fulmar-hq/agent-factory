import { QualificationSchema, type Config, type Qualification, type Ticket } from "./config";

// The configured instant is exclusive. No quota, capacity or effort overrides.
export function readyBuffer(c: Config, now: number): number {
  return c.usage_push && now < Date.parse(c.usage_push.until) ? 6 : c.autonomy?.ready_buffer ?? 3;
}

// Provider identity comes from the retained key, model/effort from validated
// evidence. An invalid preferred entry must not hide valid primary evidence.
export function qualificationFor(raw: unknown, c: Config, t: Ticket, now: number): Qualification | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Number.isFinite(now)) return;
  const entries = raw as Record<string, unknown>;
  const model = t.model ?? c.owners[t.owner]?.model;
  const effort = t.effort ?? c.owners[t.owner]?.effort;
  for (const key of [`${t.provider}:${effort}`, t.provider]) {
    if (!Object.hasOwn(entries, key)) continue;
    const q = QualificationSchema.safeParse(entries[key]);
    if (q.success && q.data.expiresAt > now && q.data.model === model && q.data.effort === effort) return q.data;
  }
}
