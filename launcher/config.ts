import { z } from "zod";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const finite = z.number().finite().nonnegative();
const ratio = finite.max(1);
const role = z.object({
  harness: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  area: z.string().optional(),
});
export const ConfigSchema = z.object({
  timezone: z.literal("America/Toronto"),
  schedule: z.object({
    qa_window: z.literal("20:00"),
    production_window: z.literal("21:30"),
    missed_window: z.literal("next_day"),
  }),
  owners: z.record(z.string(), role),
  usage_gates: z.object({
    admit_below: z.literal(0.7),
    high_benefit_only_below: z.literal(0.9),
    stop_at: z.literal(0.9),
    max_meter_age_minutes: finite.positive().max(15),
  }),
  overrun: z.object({ checkpoint_at: z.literal(1.8), pause_at: z.literal(2) }),
  capacity: z.object({
    start_parallel: z.number().int().positive(),
    heavy_test_slots: z.number().int().nonnegative(),
  }),
  wallet: z.object({
    aws: z.object({
      ceiling_usd_month: finite,
      reserve_usd: finite,
      hold_at_projected: finite,
      stop_at_actual: finite,
    }),
    other: z.object({ default_usd: finite }),
  }),
  projects: z.record(
    z.string(),
    z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      owners: z.array(z.string()),
      tests: z.string(),
    }),
  ),
});
export type Config = z.infer<typeof ConfigSchema>;
export const MeterSchema = z.object({
  observedAt: z.number().int().positive(),
  windows: z
    .array(z.object({ used: ratio, resetsAt: z.number().int().positive() }))
    .min(1),
  source: z.string().min(1),
});
export type Meter = z.infer<typeof MeterSchema>;
export const BillingSchema = z.object({
  observedAt: z.number().int().positive(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  postedCents: finite.int(),
  unpostedCents: finite.int(),
  fixedCents: finite.int(),
  projectedCents: finite.int(),
  receipt: z.string().min(1),
});
export type Billing = z.infer<typeof BillingSchema>;
export const TicketSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  area: z.string().default("unknown"),
  kind: z.string().default("unknown"),
  owner: z.string(),
  creator: z.string().min(1),
  source: z.string().min(1),
  outcome: z.string().min(1),
  test: z.string().min(1),
  approved: z.literal(true),
  benefit: z.enum(["normal", "high"]),
  estimateSeconds: finite.positive().max(14400),
  estimateTokens: finite.positive(),
  paths: z.array(z.string().min(1)).min(1),
  spansBackendAndScreen: z.literal(false),
  heavy: z.boolean(),
  wallet: z.enum(["aws", "other"]),
  costCents: finite.int(),
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1).optional(),
  effort: role.shape.effort.optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;
export const QualificationSchema = z.object({
  qualified: z.literal(true),
  subscription: z.literal(true),
  policyIsolation: z.literal(true),
  liveAccounting: z.literal(true),
  stopVerified: z.literal(true),
  phoneVerified: z.literal(true),
  version: z.string().min(1),
  model: z.string().min(1),
  effort: role.shape.effort,
  expiresAt: z.number().int().positive(),
  evidence: z.string().min(1),
});
export type Qualification = z.infer<typeof QualificationSchema>;
export const root = resolve(
  process.env.FACTORY_PRIVATE_DIR ?? join(homedir(), ".alido-private/factory"),
);
export async function configAt(
  path = join(root, "config.yaml"),
): Promise<Config> {
  return ConfigSchema.parse(Bun.YAML.parse(await Bun.file(path).text()));
}
export async function optionalJSON(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}
export async function inputs(dir = root) {
  const raw = (await optionalJSON(join(dir, "readings.json"))) as Record<
    string,
    unknown
  > | null;
  const out: { codex?: Meter; claude?: Meter; billing?: Billing } = {};
  for (const provider of ["codex", "claude"] as const) {
    const p = MeterSchema.safeParse(raw?.[provider]);
    if (p.success) out[provider] = p.data;
  }
  const billing = BillingSchema.safeParse(raw?.billing);
  if (billing.success) out.billing = billing.data;
  return out;
}
