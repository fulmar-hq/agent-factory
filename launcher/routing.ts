import { z } from "zod";

// Intake reviews dependencies, rather than searching prose ("no AWS" must not
// become an AWS dependency). Every new ticket declares the entire inventory.
export const ExecutionRequirements = z.strictObject({
  computerControl: z.boolean(),
  browser: z.boolean(),
  signIn: z.boolean(),
  aws: z.boolean(),
  localDatabase: z.boolean(),
  closeCollaboration: z.boolean(),
});
export type Execution = z.infer<typeof ExecutionRequirements>;
export type RoutingInput = { runs?: "cloud" | "local"; execution?: Execution; needs_browser?: boolean };
export function executionRoute(t: RoutingInput): "cloud" | "local" {
  if (t.needs_browser || (t.execution && Object.values(t.execution).some(Boolean))) return "local";
  if (t.execution) return "cloud";
  return t.runs ?? "cloud";
}
export function needsApp(t: RoutingInput): boolean {
  return !!(t.needs_browser || t.execution?.browser || t.execution?.computerControl || t.execution?.signIn);
}
export function newTicketRoute(raw: Record<string, unknown>) {
  const execution = ExecutionRequirements.parse(raw.execution);
  const runs = executionRoute({ execution, needs_browser: raw.needs_browser === true });
  if (raw.runs !== undefined && raw.runs !== runs) throw Error("execution requirements conflict with runs");
  return { execution, runs };
}
export function routedLabels(t: RoutingInput, labels: { name: string }[]) {
  const routes = labels.filter(l => l.name.startsWith("runs:"));
  if (routes.length > 1 || (routes.length === 1 && !["runs:cloud", "runs:local"].includes(routes[0].name)))
    throw Error("one runs:cloud or runs:local label required");
  const runs = routes[0]?.name.slice(5) as RoutingInput["runs"];
  if (runs && t.runs && runs !== t.runs) throw Error("runs label differs from approved brief");
  const declared = runs ?? t.runs;
  if (declared && (t.execution || t.needs_browser) && executionRoute(t) !== declared)
    throw Error("local dependency or execution inventory conflicts with runs");
  return { ...t, ...(runs ? { runs } : {}) };
}
// The existing supervisor is a LOCAL headless worker. Cloud and app tasks may
// never reach its workspace/publisher setup, even via direct Engine callers.
// Unlabelled historical briefs retain their existing local execution path.
export function requireHeadlessLocal(t: RoutingInput) {
  if (t.runs === "cloud" || (t.execution && executionRoute(t) === "cloud"))
    throw Error("cloud dispatch blocked: environment, billing, cancel and real-task qualification not verified; no local fallback");
  if (needsApp(t))
    throw Error("local app task: Alido Mail handoff and accepting app owner required; no headless start");
}

export const routingInstructions = `At ticket creation, review the whole outcome including its proof and declare execution with six booleans: computerControl, browser, signIn, aws, localDatabase, closeCollaboration. Any true value means runs:local; all false means runs:cloud. No browser/computer control, sign-in, AWS, local database or close collaboration is eligible for cloud. A local browser/computer-control/sign-in task goes through Alido Mail to an accepting desktop app chat, never a headless worker. Everything else defaults to cloud. The launcher attaches the runs label when creating the issue. Cloud unavailability means wait with a named dependency, never silently create a local project copy. No purchased credits, paid overflow, auto top-up, API-key fallback or billing changes. Missing environment/billing/cancellation/qualification proof blocks cloud dispatch.`;
