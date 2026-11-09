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
    admit_below: ratio.positive(),
    high_benefit_only_below: ratio.positive(),
    stop_at: ratio.positive(),
    max_meter_age_minutes: finite.positive().max(15),
  }),
  usage_windows: z.object({
    rule: z.literal("gate on every window the provider actually exposes; require at least one fresh native window (<= max age); 70/90% thresholds apply to each exposed window; missing data = refuse"),
  }).optional(),
  usage_push: z.object({
    until: z.union([z.iso.datetime({offset:true}),z.iso.datetime({offset:true,precision:-1})]), target:z.string(), pace:z.string(), admit_below:ratio.optional(),
    ready_buffer:z.literal("slots + 6"), effort:z.object({build:z.literal("high"),intake:z.literal("medium"),review:z.literal("medium")}),
    challenger:z.string(), guard:z.string(),
  }).optional(),
  overrun: z.object({ checkpoint_at: z.literal(1.8), pause_at: z.literal(2) }),
  ticket_budget_default: z.object({
    estimate_tokens:z.literal(8000000), checkpoint_tokens:z.literal(14400000), pause_tokens:z.literal(16000000),
    estimate_minutes:z.literal(30), checkpoint_minutes:z.literal(54), pause_minutes:z.literal(60),
    rule:z.string().optional(),
  }).optional(),
  autonomy: z.object({
    intake_mode: z.enum(["drain", "build"]).default("drain"),
    intake_owner: z.string().min(1),
    ready_buffer: z.literal(3),
    auto_approval: z.object({
      max_minutes: z.literal(30),
      max_docs_per_round: z.literal(1),
      protected_paths: z.array(z.string().min(1)).min(1),
    }),
    restart: z.object({max_retries: z.literal(1), causes_per_hour: z.number().int().min(1).max(10)}),
  }).optional(),
  capacity: z.object({
    start_parallel: z.number().int().positive(),
    heavy_test_slots: z.number().int().nonnegative(),
    controller: z.object({start: z.number().int().min(1).max(16), max: z.number().int().min(1).max(16), interval_minutes: z.number().int().min(1), busy_above: ratio, failure_below: ratio, mini_memory_free_floor: ratio.optional()}).refine(p=>p.start<=p.max).optional(),
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
}).refine(c=>!!c.usage_push || (c.usage_gates.admit_below<=.7 && c.usage_gates.high_benefit_only_below<=.9 && c.usage_gates.stop_at<=.9),{message:"raised usage gates require a dated Codex push"}).refine(c=>c.usage_gates.admit_below<=c.usage_gates.high_benefit_only_below && c.usage_gates.high_benefit_only_below<=c.usage_gates.stop_at,{message:"usage thresholds must be ordered"});
export type Config = z.infer<typeof ConfigSchema>;
export const MeterSchema = z.object({
  observedAt: z.number().int().positive(),
  nativeProvider: z.enum(["codex", "claude"]).optional(),
  windows: z
    .array(z.object({ used: ratio, resetsAt: z.number().int().positive(), name: z.string().optional(), durationMinutes: z.number().positive().optional() }))
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
  approvalDigest: z.string().regex(/^ready:[A-Za-z0-9_-]{43}$/).optional(),
  benefit: z.enum(["normal", "high"]),
  estimateSeconds: finite.positive().max(14400).default(1800),
  estimateTokens: finite.positive().default(8000000),
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
  phoneVerified: z.boolean(),
  waiver: z.object({ phone: z.literal("deferred") }).strict().optional(),
  version: z.string().min(1),
  model: z.string().min(1),
  effort: role.shape.effort,
  expiresAt: z.number().int().positive(),
  evidence: z.string().min(1),
}).refine((q) => q.phoneVerified || q.waiver?.phone === "deferred", {
  message: "phone verification or explicit phone: deferred waiver required",
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
