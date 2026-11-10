import {
  ConfigSchema,
  type Ticket,
  type Qualification,
  type Meter,
  type Billing,
} from "../launcher/config";
export const now = Date.parse("2026-11-07T18:00:00-05:00");
export const config = () =>
  ConfigSchema.parse({
    timezone: "America/Toronto",
    schedule: {
      qa_window: "20:00",
      production_window: "21:30",
      missed_window: "next_day",
    },
    owners: {
      builder: { harness: "codex", model: "gpt-6.1-sol", effort: "medium" },
    },
    usage_gates: {
      admit_below: 0.7,
      high_benefit_only_below: 0.9,
      stop_at: 0.9,
      max_meter_age_minutes: 15,
    },
    overrun: { checkpoint_at: 1.8, pause_at: 2 },
    capacity: { start_parallel: 2, heavy_test_slots: 1 },
    wallet: {
      aws: {
        ceiling_usd_month: 75,
        reserve_usd: 15,
        hold_at_projected: 60,
        stop_at_actual: 65,
      },
      other: { default_usd: 1 },
    },
    projects: {
      demo: { repo: "example/demo", owners: ["builder"], tests: "bun test" },
    },
  });
export const ticket = (n = 1): Ticket => ({
  repo: "example/demo",
  number: n,
  area: "unknown",
  kind: "unknown",
  title: "Synthetic work",
  owner: "builder",
  creator: "fixture",
  source: `fixture:${n}`,
  outcome: "Make synthetic change",
  test: "bun test",
  approved: true,
  benefit: "normal",
  estimateSeconds: 100,
  estimateTokens: 1000,
  paths: [`src/task-${n}.ts`],
  spansBackendAndScreen: false,
  heavy: false,
  wallet: "other",
  costCents: 0,
  provider: "codex",
});
export const qualification = (): Qualification => ({
  qualified: true,
  subscription: true,
  policyIsolation: true,
  liveAccounting: true,
  stopVerified: true,
  phoneVerified: true,
  version: "fixture",
  model: "gpt-6.1-sol",
  effort: "medium",
  expiresAt: now + 86400000,
  evidence: "synthetic qualification only",
});
export const meter = (used = 0.69): Meter => ({
  observedAt: now,
  windows: [
    { used, resetsAt: now + 3600000 },
    { used, resetsAt: now + 86400000 },
  ],
  source: "fixture",
});
export const billing = (): Billing => ({
  observedAt: now,
  month: "2026-11",
  postedCents: 1000,
  unpostedCents: 100,
  fixedCents: 100,
  projectedCents: 5000,
  receipt: "synthetic",
});
export const admission = () => ({
  now,
  meter: meter(),
  qualification: qualification(),
  billing: billing(),
});
// Fictional GraphQL connection, including completeness for nested evidence.
export function githubPage(kind:'issues'|'pullRequests',rows:any[],options:{total?:number;next?:boolean;cursor?:string|null}={}) {
 const info={hasNextPage:false,endCursor:null};
 const nodes=rows.map(r=>kind==='issues'?{...r,closedAt:r.closedAt??null,labels:{nodes:r.labels,pageInfo:info}}:{title:'Fictional pull',headRefName:'fixture',reviewDecision:null,...r,reviews:{nodes:r.reviews??[],pageInfo:info},closingIssuesReferences:{nodes:r.closingIssuesReferences??[],pageInfo:info},commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:r.statusCheckRollup??[],pageInfo:info}}}}]}});
 return JSON.stringify({data:{repository:{[kind]:{totalCount:options.total??rows.length,nodes,pageInfo:{hasNextPage:options.next??false,endCursor:options.cursor??null}}}}});
}
