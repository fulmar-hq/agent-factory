import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { renewQualification, renewalEligibility, type RenewalContext, type RenewalProbe, type RenewalProof, type RenewalRequest } from "../launcher/renewal";
import { renewalCLI } from "../scripts/renew-qualification";
import { config, qualification } from "./fixtures";

// SYNTHETIC orchestration only. These adapters are deliberately test-local;
// none supplies installed native qualification or any live success evidence.
const now = Date.parse("2026-11-08T17:00:00-05:00"), hour = 3600000;
const request: RenewalRequest = { provider: "codex", model: "gpt-6.1-sol", effort: "medium", publisher: { repo: "fulmar-hq/agent-factory", tree: "a".repeat(40) } };
function setup(expiry = now + hour) {
  const scratch = resolve(".factory-tmp/renewal-tests");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "synthetic-"));
  const path = join(dir, "qualifications.json");
  const original = JSON.stringify({ codex: { ...qualification(), expiresAt: expiry }, claude: { retained: "unmodified fictional record" }, retained: ["unknown fields stay"] }, null, 4) + "\n";
  writeFileSync(path, original);
  return { dir, path, original };
}
function proof(c: RenewalContext): RenewalProof {
  return {
    source: "native", runId: c.runId, provider: c.provider, nativeId: `synthetic-${c.runId}`, startedAt: now, observedAt: now,
    expiresAt: now + 24 * hour, version: "synthetic-only", model: c.model, effort: c.effort,
    subscription: { route: "subscription", receipt: "synthetic subscription" },
    denials: (["file", "command"] as const).flatMap(boundary => (["controller-read", "outside-write"] as const).map(operation => ({ boundary, operation, result: "denied" as const, knownTarget: "synthetic protected target", toolCallId: `${boundary}-${operation}`, receipt: "synthetic denied tool event" }))),
    accounting: { inputTokens: 10, outputTokens: 2, elapsedMs: 100, receipt: "synthetic native usage" },
    stop: { processIdentity: "synthetic pid/start", signal: "SIGTERM", descendantsRemaining: 0, receipt: "synthetic stop", containmentReceipt: "synthetic containment" },
    phone: { nativeId: `synthetic-${c.runId}`, steeringReceipt: "synthetic phone steering" },
    publisher: { repo: c.publisher.repo, testedTree: c.publisher.tree, publishedTree: c.publisher.tree, commit: "b".repeat(40), githubVerifiedSignatureReceipt: "synthetic github signature", exactTreeTestReceipt: "synthetic test" },
  };
}
function adapter(change: (p: RenewalProof, c: RenewalContext) => unknown = p => p): RenewalProbe {
  return { unsupported: () => null, collect: async () => ({ untrusted: "collected flags never authorize" }), verify: async c => change(proof(c), c) };
}
const run = (s: ReturnType<typeof setup>, probe = adapter()) => renewQualification({ dir: s.dir, request, probe, clock: () => now });

test("eligibility is the exact Toronto minute (DST aware), or at most six hours including expired", () => {
  for (const date of ["2026-11-08T18:00:59-05:00", "2026-07-08T18:00:00-04:00"] ) {
    const t = Date.parse(date);
    expect(renewalEligibility(t + 24 * hour, t)).toBe(true);
    expect(renewalEligibility(t + 24 * hour, t + 60000)).toBe(false);
  }
  expect(renewalEligibility(now + 6 * hour, now)).toBe(true);
  expect(renewalEligibility(now + 6 * hour + 1, now)).toBe(false);
  expect(renewalEligibility(now - hour, now)).toBe(true);
  expect(renewalEligibility(NaN, now)).toBe(false);
});

test("not eligible does not probe or take a claim", async () => {
  const s = setup(now + 7 * hour);
  const result = await run(s, adapter(() => { throw Error("must not run"); }));
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("not eligible");
  expect(existsSync(join(s.dir, "renewal-claims"))).toBe(false);
});

test("successful synthetic orchestration archives exact original bytes and preserves other providers", async () => {
  const s = setup();
  const result = await run(s);
  expect(result.status).toBe("renewed");
  expect(readFileSync(join(result.claim!, "qualifications.original.json"), "utf8")).toBe(s.original);
  const next = JSON.parse(readFileSync(s.path, "utf8"));
  expect(next.claude).toEqual(JSON.parse(s.original).claude);
  expect(next.retained).toEqual(JSON.parse(s.original).retained);
  expect(next.codex.phoneVerified).toBe(true);
  expect(next.codex.expiresAt).toBe(now + 24 * hour);
  expect(existsSync(next.codex.evidence)).toBe(true);
  expect(JSON.parse(readFileSync(result.receipt!, "utf8")).status).toBe("renewed");
});

test("expired originals require new proof; expiry alone never renews", async () => {
  const s = setup(now - hour);
  expect((await run(s)).status).toBe("renewed");
  const unsupported = setup(now - hour);
  const result = await renewQualification({ dir: unsupported.dir, request, clock: () => now });
  expect(result.status).toBe("refused");
  expect(readFileSync(unsupported.path, "utf8")).toBe(unsupported.original);
});

test("default live adapter visibly refuses unsupported and partial qualify-delivery probes", async () => {
  const s = setup();
  const result = await renewQualification({ dir: s.dir, request, clock: () => now });
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("unsupported full native renewal probe");
  expect(result.reason).toContain("qualify-delivery");
  expect(existsSync(result.receipt!)).toBe(true);
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("prompt-impossible denial is a refusal, never inferred from model agreement", async () => {
  const s = setup(); let collected = false;
  const result = await run(s, { ...adapter(), unsupported: () => "prompt-impossible: installed native tools cannot address the controller target", collect: async () => { collected = true; return { passed: true }; } });
  expect(result.reason).toContain("prompt-impossible");
  expect(collected).toBe(false);
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

const invalid: [string, (p: RenewalProof) => unknown][] = [
  ["flags", () => ({ qualified: true, subscription: true, policyIsolation: true, liveAccounting: true, stopVerified: true, phoneVerified: true })],
  ["partial qualify-delivery receipt", () => ({ version: 2, code: 0, out: '{"credential":true}' })],
  ["fixture source", p => ({ ...p, source: "fixture" })],
  ["wrong model", p => ({ ...p, model: "other" })],
  ["wrong effort", p => ({ ...p, effort: "low" })],
  ["wrong provider", p => ({ ...p, provider: "claude" })],
  ["replayed run", p => ({ ...p, runId: "old" })],
  ["old observation", p => ({ ...p, startedAt: now - 1 })],
  ["future observation", p => ({ ...p, observedAt: now + 1 })],
  ["expired qualification", p => ({ ...p, expiresAt: now })],
  ["unbounded qualification", p => ({ ...p, expiresAt: now + 25 * hour })],
  ["API route", p => ({ ...p, subscription: { ...p.subscription, route: "api" } })],
  ["missing file denials", p => ({ ...p, denials: p.denials.filter(d => d.boundary === "command") })],
  ["reused tool invocation", p => ({ ...p, denials: p.denials.map(d => ({ ...d, toolCallId: "same" })) })],
  ["allowed outside write", p => ({ ...p, denials: p.denials.map(d => ({ ...d, result: "allowed" })) })],
  ["missing phone proof", p => ({ ...p, phone: undefined, waiver: { phone: "deferred" } })],
  ["wrong phone session", p => ({ ...p, phone: { ...p.phone, nativeId: "old session" } })],
  ["missing accounting", p => ({ ...p, accounting: undefined })],
  ["zero native accounting", p => ({ ...p, accounting: { ...p.accounting, inputTokens: 0 } })],
  ["live descendant", p => ({ ...p, stop: { ...p.stop, descendantsRemaining: 1 } })],
  ["missing containment", p => ({ ...p, stop: { ...p.stop, containmentReceipt: "" } })],
  ["wrong tested tree", p => ({ ...p, publisher: { ...p.publisher, testedTree: "c".repeat(40) } })],
  ["wrong published tree", p => ({ ...p, publisher: { ...p.publisher, publishedTree: "c".repeat(40) } })],
  ["missing GitHub signature", p => ({ ...p, publisher: { ...p.publisher, githubVerifiedSignatureReceipt: "" } })],
];
for (const [name, change] of invalid) test(`${name} cannot authorize renewal`, async () => {
  const s = setup();
  const result = await run(s, adapter(change));
  expect(result.status).toBe("refused");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("independent receipt verification can refuse a collected success", async () => {
  const s = setup();
  const result = await run(s, { ...adapter(), collect: async c => proof(c), verify: async () => { throw Error("native transcript does not substantiate receipts"); } });
  expect(result.reason).toContain("does not substantiate");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("claims persist across handled failures and restarts; duplicate never probes", async () => {
  const s = setup();
  const first = await run(s, adapter(() => { throw Error("interrupted native probe"); }));
  const second = await run(s, adapter(() => { throw Error("must not probe twice"); }));
  expect(first.status).toBe("refused");
  expect(second.status).toBe("refused");
  expect(second.reason).toContain("EEXIST");
  expect(readFileSync(join(first.claim!, "qualifications.original.json"), "utf8")).toBe(s.original);
  expect(existsSync(join(s.dir, "renewal-claims/active"))).toBe(true);
});

test("unsupported claims survive restarts even after the global lock is archived", async () => {
  const s = setup();
  const first = await renewQualification({ dir: s.dir, request, clock: () => now });
  expect(first.status).toBe("refused");
  expect(existsSync(join(s.dir, "renewal-claims/active"))).toBe(false);
  const second = await run(s);
  expect(second.status).toBe("refused");
  expect(second.reason).toContain("EEXIST");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("concurrent providers cannot overwrite the qualification map", async () => {
  const s = setup();
  writeFileSync(s.path, JSON.stringify({ codex: { ...qualification(), expiresAt: now + hour }, claude: { ...qualification(), expiresAt: now + hour } }));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = run(s, { ...adapter(), collect: async () => { await waiting; return {}; } });
  const second = await renewQualification({ dir: s.dir, request: { ...request, provider: "claude" }, probe: adapter(), clock: () => now });
  expect(second.status).toBe("refused");
  expect(second.reason).toContain("EEXIST");
  release();
  expect((await first).status).toBe("renewed");
});

test("hard-interrupted global lock is never stolen even if old", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "renewal-claims/active"), { recursive: true });
  const result = await run(s);
  expect(result.status).toBe("refused");
  expect(existsSync(join(s.dir, "renewal-claims/active"))).toBe(true);
});

for (const at of ["archived", "staged", "before-replace"] as const) test(`interruption at ${at} preserves original and durable claim`, async () => {
  const s = setup();
  const result = await renewQualification({ dir: s.dir, request, probe: adapter(), clock: () => now, checkpoint: point => {
    if (point === at) {
      if (point === "staged") writeFileSync(join(s.dir, "renewal-claims", `codex-${now + hour}`, "qualifications.next.json"), '{"partial":');
      throw Error("synthetic interrupted write");
    }
  } });
  expect(result.status).toBe("refused");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
  expect(readFileSync(join(result.claim!, "qualifications.original.json"), "utf8")).toBe(s.original);
  expect((await run(s)).status).toBe("refused");
});

test("interruption after atomic rename reports uncertain and keeps reconciliation journal", async () => {
  const s = setup();
  const result = await renewQualification({ dir: s.dir, request, probe: adapter(), clock: () => now, checkpoint: p => { if (p === "replaced") throw Error("synthetic receipt interruption"); } });
  expect(result.status).toBe("uncertain");
  expect(JSON.parse(readFileSync(s.path, "utf8")).codex.expiresAt).toBe(now + 24 * hour);
  expect(existsSync(join(result.claim!, "prepared.json"))).toBe(true);
  expect(readFileSync(join(result.claim!, "qualifications.original.json"), "utf8")).toBe(s.original);
});

test("intervening qualification changes are retained rather than overwritten", async () => {
  const s = setup();
  const changed = s.original + " \n";
  const result = await run(s, adapter(p => { writeFileSync(s.path, changed); return p; }));
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("changed during probes");
  expect(readFileSync(s.path, "utf8")).toBe(changed);
});

test("expiry during staging cannot authorize replacement", async () => {
  const s = setup(); let current = now;
  const result = await renewQualification({ dir: s.dir, request, probe: adapter(), clock: () => current, checkpoint: p => { if (p === "before-replace") current = now + 24 * hour; } });
  expect(result.status).toBe("refused");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("a silently truncated staged write cannot replace the original", async () => {
  const s = setup();
  const result = await renewQualification({ dir: s.dir, request, probe: adapter(), clock: () => now, checkpoint: p => {
    if (p === "staged") writeFileSync(join(s.dir, "renewal-claims", `codex-${now + hour}`, "qualifications.next.json"), '{"partial":');
  } });
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("staged qualification interrupted or changed");
  expect(readFileSync(s.path, "utf8")).toBe(s.original);
});

test("missing, malformed and symlink qualifications refuse without probing", async () => {
  for (const content of ["not json", "[]", "{}", '{"codex":{"qualified":true}}']) {
    const s = setup(); writeFileSync(s.path, content);
    expect((await run(s)).status).toBe("refused");
    expect(readFileSync(s.path, "utf8")).toBe(content);
  }
  const s = setup();
  symlinkSync(s.path, join(s.dir, "alias.json"));
  const child = join(s.dir, "child"); mkdirSync(child);
  symlinkSync(join(s.dir, "alias.json"), join(child, "qualifications.json"));
  expect((await renewQualification({ dir: child, request, probe: adapter(), clock: () => now })).status).toBe("refused");
});

test("CLI rejects flags and derives exact model/effort from configured owner; never imports receipts", async () => {
  const s = setup();
  writeFileSync(s.path, JSON.stringify({ codex: { ...qualification(), expiresAt: 1 } }));
  expect((await renewalCLI(["--success"], s.dir)).status).toBe("refused");
  writeFileSync(join(s.dir, "config.yaml"), JSON.stringify(config()));
  const result = await renewalCLI(["codex", "builder", request.publisher.repo, request.publisher.tree], s.dir);
  expect(result.status).toBe("refused");
  expect(result.reason).toContain("unsupported full native renewal probe");
  expect((await renewalCLI(["claude", "builder", request.publisher.repo, request.publisher.tree], s.dir)).reason).toContain("configured owner/provider");
  const claims = readdirSync(join(s.dir, "renewal-claims")).filter(n => n.startsWith("codex-"));
  expect(claims).toHaveLength(1);
  const retained = JSON.parse(readFileSync(join(s.dir, "renewal-claims", claims[0]!, "claim.json"), "utf8"));
  expect(retained.request.model).toBe(config().owners.builder!.model);
  expect(retained.request.effort).toBe(config().owners.builder!.effort);
});
