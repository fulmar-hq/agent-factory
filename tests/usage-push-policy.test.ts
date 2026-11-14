import { expect, test } from "bun:test";
import { ConfigSchema, TicketSchema, QualificationSchema } from "../launcher/config";
import { readyBuffer, qualificationFor } from "../launcher/usage-push-policy";
import { usageGate } from "../launcher/engine";
import {TestEngine as Engine} from "./fixtures";
import { Store } from "../tracking/store";
import { launchReady } from "../launcher/tick";
import { requireWorkerQualification } from "../launcher/worker";
import { intakeLabel, issueTicket, type Issue } from "../adapters/github";
import { config, ticket, qualification, admission, meter, now } from "./fixtures";

const until = now + 3600000;
function pushConfig() {
  return ConfigSchema.parse({
    ...config(),
    usage_push: { until: new Date(until).toISOString(), ready_buffer: "slots + 6" },
    capacity: { ...config().capacity, controller: { start: 6, max: 12, interval_minutes: 60, busy_above: .8, failure_below: .3 } },
    autonomy: {
      intake_owner: "builder", ready_buffer: 3,
      auto_approval: { max_minutes: 30, max_docs_per_round: 1, protected_paths: [".github"] },
      restart: { max_retries: 1, causes_per_hour: 3 },
    },
  });
}

test("approved Nov 11 07:40 Toronto cutoff restores plus three without extending qualification", () => {
  const until = "2026-11-11T07:40:00-05:00", deadline = Date.parse(until);
  expect(deadline).toBe(Date.parse("2026-11-11T12:40:00Z"));
  const c = ConfigSchema.parse({ ...pushConfig(), usage_push: { until, ready_buffer: "slots + 6" } });
  // Fictional evidence proves selection only; it cannot qualify an installation.
  const q = { ...qualification(), expiresAt: deadline };
  const entries = { codex: { ...q, effort: "high" as const }, "codex:medium": q };
  const retained = JSON.stringify(entries);
  for (const at of [deadline - 1, deadline, deadline + 1]) {
    expect(readyBuffer(c, at)).toBe(at < deadline ? 6 : 3);
    expect(qualificationFor(entries, c, ticket(), at)).toEqual(at < deadline ? q : undefined);
    const live = { ...q, expiresAt: deadline + 1000 };
    expect(qualificationFor({ codex: live }, c, ticket(), at)).toEqual(live);
    expect(qualificationFor({ codex: live }, c, { ...ticket(), effort: "high" }, at)).toBeUndefined();
  }
  expect(JSON.stringify(entries)).toBe(retained);
});

test("optional push accepts exact offset instants and only the bounded buffer", () => {
  const c = pushConfig();
  expect(ConfigSchema.parse(config()).usage_push).toBeUndefined();
  for (const instant of [new Date(until).toISOString(), "2026-11-07T19:00-05:00", "2026-11-07T19:00:00.000-05:00"]) {
    const parsed = ConfigSchema.parse({ ...c, usage_push: { until: instant, ready_buffer: "slots + 6" } });
    expect(readyBuffer(parsed, until - 1)).toBe(6);
    expect(readyBuffer(parsed, until)).toBe(3);
    expect(readyBuffer(parsed, until + 1)).toBe(3);
  }
  for (const bad of [null, {}, { until: "tomorrow", ready_buffer: "slots + 6" },
    { until: "2026-11-07T19:00", ready_buffer: "slots + 6" },
    { until: "2026-02-30T19:00Z", ready_buffer: "slots + 6" },
    { until: new Date(until).toISOString(), ready_buffer: 6 },
    { until: new Date(until).toISOString(), ready_buffer: "slots + 7" }]) {
    expect(ConfigSchema.safeParse({ ...c, usage_push: bad }).success).toBe(false);
  }
  const parsed = ConfigSchema.parse({ ...c, usage_push: { ...c.usage_push, admit_below: .97, effort: { build: "high" }, capacity: 16 } });
  expect(parsed.usage_push).toEqual(c.usage_push);
  expect(parsed.autonomy!.ready_buffer).toBe(3);
  expect(readyBuffer({ ...c, usage_push: undefined }, now)).toBe(3);
});

test("retained high primary and medium entry match each ticket without effort overrides or renewal", () => {
  const c = pushConfig(), medium = qualification(), high = { ...medium, effort: "high" as const };
  const entries = { codex: high, "codex:medium": medium, "codex:high": high };
  const before = JSON.stringify(entries);
  for (const at of [until - 1, until, until + 1]) {
    expect(qualificationFor(entries, c, ticket(), at)).toEqual(medium);
    expect(qualificationFor(entries, c, { ...ticket(), effort: "high" }, at)).toEqual(high);
    expect(qualificationFor(entries, { ...c, owners: { builder: { ...c.owners.builder, effort: "high" } } }, ticket(), at)).toEqual(high);
  }
  expect(JSON.stringify(entries)).toBe(before);
  // Recheck both stages against the same retained expiry, never renew it.
  expect(qualificationFor(entries, c, ticket(), medium.expiresAt - 1)).toEqual(medium);
  expect(qualificationFor(entries, c, ticket(), medium.expiresAt)).toBeUndefined();
  expect(qualificationFor(entries, c, ticket(), medium.expiresAt + 1)).toBeUndefined();
});

test("invalid preferred evidence cannot hide an exact live primary", () => {
  const c = pushConfig(), q = qualification();
  for (const bad of [null, { ...q, expiresAt: now }, { ...q, effort: "high" }, { ...q, model: "another-model" }, { ...q, evidence: "" }]) {
    expect(qualificationFor({ codex: q, "codex:medium": bad }, c, ticket(), now)).toEqual(q);
    expect(qualificationFor({ codex: bad, "codex:medium": q }, c, ticket(), now)).toEqual(q);
  }
});

test("missing, expired, wrong-provider/model/effort and incomplete evidence fail closed at admission", () => {
  const c = pushConfig(), q = qualification();
  const bad = [null, [], {}, { claude: q, "claude:medium": q },
    { codex: { ...q, model: "another-model" } }, { "codex:medium": { ...q, effort: "high" } },
    { codex: { ...q, expiresAt: now } }, { "codex:medium": { ...q, expiresAt: now - 1 } },
    { codex: { ...q, evidence: "" } }, { codex: { ...q, phoneVerified: false } },
    ...["qualified", "subscription", "policyIsolation", "liveAccounting", "stopVerified"].map(key => ({ codex: { ...q, [key]: false } }))];
  for (const raw of bad) {
    const selected = qualificationFor(raw, c, ticket(), now);
    expect(selected).toBeUndefined();
    const s = new Store(":memory:"), e = new Engine(s, c);
    try {
      e.pause(false, "owner");
      expect(() => e.admit(ticket(), { ...admission(), qualification: selected })).toThrow("worker unqualified");
      expect(e.sessions()).toHaveLength(0);
    } finally { s.close(); }
  }
  expect(qualificationFor({ codex: q }, c, { ...ticket(), model: "another-model" }, now)).toBeUndefined();
  expect(qualificationFor({ codex: q }, c, { ...ticket(), effort: "high" }, now)).toBeUndefined();
  expect(qualificationFor({ codex: q }, c, ticket(), NaN)).toBeUndefined();
  expect(qualificationFor({ claude: q }, c, { ...ticket(), provider: "claude" }, now)).toEqual(q);
});

test("selected evidence admits the requested effort and is refused if it expires before reservation", () => {
  const c = pushConfig(), q = qualification();
  for (const effort of ["medium", "high"] as const) {
    const t = { ...ticket(), effort }, matching = { ...q, effort, expiresAt: now + 1 };
    const entries = { codex: { ...q, effort: effort === "medium" ? "high" : "medium" }, [`codex:${effort}`]: matching };
    const selected = qualificationFor(entries, c, t, now);
    const s = new Store(":memory:"), e = new Engine(s, c);
    try {
      e.pause(false, "owner");
      expect(() => e.admit(t, { ...admission(), now: now + 1, qualification: selected })).toThrow("worker unqualified");
      const x = e.admit(t, { ...admission(), qualification: selected });
      expect(JSON.parse(x.brief)).toMatchObject({ model: t.model ?? c.owners.builder.model, effort });
      expect(qualificationFor(entries, c, JSON.parse(x.brief), now + 1)).toBeUndefined();
    } finally { s.close(); }
  }
});

test("tick admission and worker start select retained exact-effort evidence independently", async () => {
  for (const effort of ["medium", "high"] as const) {
    const s = new Store(":memory:"), e = new Engine(s, pushConfig());
    const q = { ...qualification(), effort, expiresAt: now + 2 };
    const entries = { codex: { ...q, effort: effort === "medium" ? "high" : "medium" }, [`codex:${effort}`]: q };
    const brief = { ...ticket(), effort };
    const i: Issue = { number: 1, title: brief.title, state: "OPEN", url: "fixture", updatedAt: "fixture",
      body: "```factory\n" + JSON.stringify(brief) + "\n```",
      labels: [{ name: "state:ready" }, { name: "kind:fix" }, { name: "area:demo" }] };
    i.labels.push({ name: intakeLabel(brief.repo, i) });
    const t = issueTicket(brief.repo, i)!;
    let starts = 0;
    const execute = async (args: string[]) => args.includes("view") ? JSON.stringify(i) : "";
    try {
      e.pause(false, "owner");
      const x = await launchReady(e, t, { ...admission(), qualifications: entries }, () => { starts++; }, execute, () => now);
      expect(starts).toBe(1);
      const frozen = JSON.parse(x.brief);
      expect(requireWorkerQualification(e, frozen, entries, now + 1)).toEqual(q);
      expect(() => requireWorkerQualification(e, { ...frozen, model: undefined }, entries, now)).toThrow("qualification expired or paused");
      expect(() => requireWorkerQualification(e, { ...frozen, effort: undefined }, entries, now)).toThrow("qualification expired or paused");
      expect(() => requireWorkerQualification(e, frozen, entries, now + 2)).toThrow("qualification expired or paused");
      expect(() => requireWorkerQualification(e, frozen, { codex: entries.codex }, now)).toThrow("qualification expired or paused");
      expect(() => requireWorkerQualification(e, frozen, { [`codex:${effort}`]: { ...q, model: "another-model" } }, now)).toThrow("qualification expired or paused");
      expect(() => requireWorkerQualification(e, frozen, { claude: q }, now)).toThrow("qualification expired or paused");
      e.pause(true, "owner");
      expect(() => requireWorkerQualification(e, frozen, entries, now)).toThrow("qualification expired or paused");
    } finally { s.close(); }
  }
});

test("tick selects after async intake validation and refuses missing retained proof even with a fallback admission field", async () => {
  for (const mode of ["expired", "live-primary", "missing"] as const) {
    const s = new Store(":memory:"), e = new Engine(s, pushConfig());
    const q = { ...qualification(), expiresAt: now + 1 };
    const entries = mode === "missing" ? undefined : { "codex:medium": q,
      codex: mode === "live-primary" ? { ...q, expiresAt: now + 1000 } : q };
    const brief = ticket(), i: Issue = { number: 1, title: brief.title, state: "OPEN", url: "fixture", updatedAt: "fixture",
      body: "```factory\n" + JSON.stringify(brief) + "\n```",
      labels: [{ name: "state:ready" }, { name: "kind:fix" }, { name: "area:demo" }] };
    i.labels.push({ name: intakeLabel(brief.repo, i) });
    const t = issueTicket(brief.repo, i)!;
    let at = now, starts = 0;
    const execute = async (args: string[]) => { at = now + 1; return args.includes("view") ? JSON.stringify(i) : ""; };
    try {
      e.pause(false, "owner");
      const pending = launchReady(e, t, { ...admission(), qualifications: entries }, () => { starts++; }, execute, () => at);
      if (mode === "live-primary") { await pending; expect(starts).toBe(1); }
      else {
        await expect(pending).rejects.toThrow("worker unqualified");
        expect(starts).toBe(0); expect(e.sessions()).toHaveLength(0); expect(s.rows("debits")).toHaveLength(0);
      }
    } finally { s.close(); }
  }
});

test("all existing config LIMIT literals, defaults, wallet and schedule remain unchanged during and after push", () => {
  const c = pushConfig();
  expect(c.usage_gates).toEqual({ admit_below: .7, high_benefit_only_below: .9, stop_at: .9, max_meter_age_minutes: 15 });
  expect(c.capacity.controller).toEqual({ start: 6, max: 12, interval_minutes: 60, busy_above: .8, failure_below: .3 });
  expect(c.schedule).toEqual({ qa_window: "20:00", production_window: "21:30", missed_window: "next_day" });
  expect(c.timezone).toBe("America/Toronto");
  expect(ConfigSchema.safeParse({ ...c, timezone: "UTC" }).success).toBe(false);
  expect(c.overrun).toEqual({ checkpoint_at: 1.8, pause_at: 2 });
  expect(c.wallet).toEqual(config().wallet);
  expect(c.autonomy).toMatchObject({ ready_buffer: 3, intake_mode: "drain", idle_wake_minutes: 10, auto_approval: { max_minutes: 30, max_docs_per_round: 1 }, restart: { max_retries: 1 } });
  const defaults = { estimate_tokens: 8000000, checkpoint_tokens: 14400000, pause_tokens: 16000000, estimate_minutes: 30, checkpoint_minutes: 54, pause_minutes: 60 } as const;
  expect(ConfigSchema.parse({ ...c, ticket_budget_default: defaults }).ticket_budget_default).toEqual(defaults);
  for (const [section, values] of Object.entries({ usage_gates: c.usage_gates, controller: c.capacity.controller!, schedule: c.schedule, overrun: c.overrun, ticket_budget_default: defaults,
    autonomy: { ready_buffer: 3 }, auto_approval: c.autonomy!.auto_approval, restart: { max_retries: 1 } })) {
    for (const [key, value] of Object.entries(values)) {
      if (key === "max_meter_age_minutes" || key === "protected_paths") continue;
      const changed = typeof value === "number" ? value + 1 : "changed";
      const raw = section === "controller" ? { ...c, capacity: { ...c.capacity, controller: { ...c.capacity.controller, [key]: changed } } }
        : section === "auto_approval" || section === "restart" ? { ...c, autonomy: { ...c.autonomy, [section]: { ...c.autonomy![section], [key]: changed } } }
        : { ...c, [section]: { ...((section === "ticket_budget_default" ? defaults : c[section as keyof typeof c]) as object), [key]: changed } };
      expect(ConfigSchema.safeParse(raw).success).toBe(false);
    }
  }
  const { estimateTokens, estimateSeconds, ...withoutEstimates } = ticket();
  expect(TicketSchema.parse(withoutEstimates)).toMatchObject({ estimateTokens: 8000000, estimateSeconds: 1800, approved: true, spansBackendAndScreen: false });
  expect(TicketSchema.safeParse({ ...ticket(), approved: false }).success).toBe(false);
  expect(TicketSchema.safeParse({ ...ticket(), spansBackendAndScreen: true }).success).toBe(false);
  expect(QualificationSchema.safeParse({ ...qualification(), waiver: { phone: "other" } }).success).toBe(false);
  for (const at of [until - 1, until, until + 1]) for (const provider of ["codex", "claude"] as const) {
    const reading = { ...meter(.7), observedAt: at, windows: meter(.7).windows.map(w => ({ ...w, resetsAt: at + 3600000 })) };
    expect(() => usageGate(reading, false, at, c, provider)).toThrow("high benefit only");
    expect(() => usageGate({ ...reading, windows: reading.windows.map(w => ({ ...w, used: .9 })) }, true, at, c, provider)).toThrow("usage stop");
  }
});
