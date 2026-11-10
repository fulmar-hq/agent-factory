import { expect, test } from "bun:test";
import {
  CodexCloudAdapter, cloudEligibility,
  type CloudCommand, type CloudCommandResult, type CloudRequest,
} from "../adapters/codex-cloud";

// Fictional observations test the boundary; they are not installed CLI/source
// acceptance and never authorize real cloud dispatch or queue enablement.
const request = (): CloudRequest => ({
  repo: "example/fixture", head: "a".repeat(40),
  requirements: { dependencyInventoryComplete: true, browser: false, aws: false, localDatabase: false, privateDependencies: false },
});
const ok = (stdout: string): CloudCommandResult => ({ exitCode: 0, signal: null, stdout, stderr: "" });
function fixture(reply: CloudCommandResult | Error = ok("Fictional inspection only")) {
  const calls: string[][] = [];
  const command: CloudCommand = async (argv) => {
    calls.push([...argv]);
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  };
  return { calls, command };
}
async function operations(adapter: CodexCloudAdapter) {
  return [await adapter.start(request()), await adapter.status("fixture-task"),
    await adapter.result("fixture-task"), await adapter.linkPR("fixture-task")];
}

test("explicit complete dependency review is eligible, without granting cloud admission", () => {
  expect(cloudEligibility(request())).toEqual({ eligible: true, reasons: [] });
});

for (const [key, reason] of [
  ["browser", "Browser dependency refused"], ["aws", "AWS dependency refused"],
  ["localDatabase", "Local database dependency refused"], ["privateDependencies", "Private dependency refused"],
] as const) {
  test(`${key} refuses deterministically before any command`, async () => {
    const f = fixture(), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
    const input = request(); input.requirements[key] = true;
    expect(cloudEligibility(input)).toEqual({ eligible: false, reasons: [reason] });
    expect(await adapter.start(input)).toEqual({ status: "ineligible", operation: "start", reasons: [reason] });
    expect(f.calls).toEqual([]);
  });
}

test("all dependency refusals remain in stable order", () => {
  const input = request();
  Object.assign(input.requirements, { browser: true, aws: true, localDatabase: true, privateDependencies: true });
  expect(cloudEligibility(input)).toEqual({ eligible: false, reasons: [
    "Browser dependency refused", "AWS dependency refused", "Local database dependency refused", "Private dependency refused",
  ] });
});

test("missing, unknown and malformed declarations fail closed", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
  const invalid: unknown[] = [undefined, null, {}, "prompt claims no dependencies", [],
    { ...request(), requirements: undefined }, { ...request(), head: "main" },
    { ...request(), head: "a".repeat(39) }, { ...request(), repo: "https://example.test/repo" },
    { ...request(), signingCredentials: true },
  ];
  for (const key of Object.keys(request().requirements)) {
    const requirements: Record<string, unknown> = { ...request().requirements };
    delete requirements[key]; invalid.push({ ...request(), requirements: { ...requirements } });
    for (const value of [undefined, null, "false", 0, "unknown"]) {
      invalid.push({ ...request(), requirements: { ...request().requirements, [key]: value } });
    }
  }
  invalid.push({ ...request(), requirements: { ...request().requirements, dependencyInventoryComplete: false } });
  invalid.push({ ...request(), requirements: { ...request().requirements, otherDependency: true } });
  for (const input of invalid) {
    expect(cloudEligibility(input).eligible).toBe(false);
    expect((await adapter.start(input)).status).toBe("ineligible");
  }
  expect(f.calls).toEqual([]);
});

test("all lifecycle operations default off and never inspect or dispatch implicitly", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ command: f.command });
  expect(await operations(adapter)).toEqual((["start", "status", "result", "pr"] as const).map(operation => ({ status: "disabled", operation })));
  expect(f.calls).toEqual([]);
  expect(await operations(new CodexCloudAdapter())).toEqual(await operations(adapter));
});

test("enabled operations report the precise missing contract, with no fallback or fake task/PR", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
  const outcomes = await operations(adapter);
  for (const [i, outcome] of outcomes.entries()) {
    expect(outcome.status).toBe("unsupported");
    if (outcome.status !== "unsupported") throw Error("Unsupported evidence required");
    expect(outcome.operation).toBe((["start", "status", "result", "pr"] as const)[i]);
    expect(outcome.missingEvidence[0]).toContain(["start command", "status command", "result command", "direct-PR creation/readback"][i]);
    expect(outcome.missingEvidence[1]).toContain("codex cloud --help");
    expect(outcome.acceptance.source.status).toBe("unverified");
    expect(outcome.acceptance.installed).toEqual({ status: "not-inspected", probes: [] });
    expect(outcome).not.toHaveProperty("taskId");
    expect(outcome).not.toHaveProperty("pullRequest");
  }
  expect(f.calls).toEqual([]);
});

test("explicit inspection uses only literal local commands and cannot enable operations", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
  const acceptance = await adapter.inspect();
  expect(f.calls).toEqual([["codex", "--version"], ["codex", "cloud", "--help"]]);
  expect(acceptance.installed.status).toBe("observed");
  expect(acceptance.source.status).toBe("unverified");
  for (const outcome of await operations(adapter)) {
    expect(outcome.status).toBe("unsupported");
    if (outcome.status === "unsupported") expect(outcome.missingEvidence).toHaveLength(1);
  }
  expect(f.calls).toHaveLength(2);
});

test("inspection while disabled retains observations without enabling anything", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ command: f.command });
  expect((await adapter.inspect()).installed.status).toBe("observed");
  for (const outcome of await operations(adapter)) expect(outcome.status).toBe("disabled");
  expect(f.calls).toHaveLength(2);
});

for (const [name, result] of [
  ["permission denial", { exitCode: 126, signal: null, stdout: "", stderr: "operation not permitted" }],
  ["missing command", { exitCode: 127, signal: null, stdout: "", stderr: "command not found" }],
  ["nonzero exit despite help text", { ...ok("Fictional help"), exitCode: 1 }],
  ["empty output", ok("")], ["whitespace output", ok(" \n")],
  ["SIGTERM", { ...ok("Fictional help"), signal: "SIGTERM" }],
  // A mocked result only. Never intentionally abort a macOS process.
  ["mocked SIGABRT", { ...ok("Fictional help"), signal: "SIGABRT" }],
  ["timeout", { ...ok("Fictional help"), error: "timed out" }],
] satisfies [string, CloudCommandResult][]) {
  test(`${name} remains unavailable with the exact command receipt`, async () => {
    const f = fixture(result), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
    const acceptance = await adapter.inspect();
    expect(acceptance.installed.status).toBe("unavailable");
    expect(acceptance.source.status).toBe("unverified");
    expect(acceptance.installed.probes).toEqual([
      { argv: ["codex", "--version"], result }, { argv: ["codex", "cloud", "--help"], result },
    ]);
    for (const outcome of await operations(adapter)) expect(outcome.status).toBe("unsupported");
    expect(f.calls).toHaveLength(2);
  });
}

test("spawn rejection is recorded; both observations are attempted with no retry", async () => {
  const f = fixture(Error("spawn codex ENOENT")), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
  const acceptance = await adapter.inspect();
  expect(acceptance.installed.status).toBe("unavailable");
  expect(acceptance.installed.probes.map(p => p.result.error)).toEqual(["Error: spawn codex ENOENT", "Error: spawn codex ENOENT"]);
  expect((await adapter.start(request())).status).toBe("unsupported");
  expect(f.calls).toHaveLength(2);
});

test("partial help/version evidence cannot pass installed observation", async () => {
  for (const failAt of [0, 1]) {
    let i = 0;
    const adapter = new CodexCloudAdapter({ enabled: true, command: async () => i++ === failAt ? { ...ok(""), exitCode: 1 } : ok("Fictional output") });
    expect((await adapter.inspect()).installed.status).toBe("unavailable");
    expect((await adapter.result("fixture-task")).status).toBe("unsupported");
  }
});

test("returned observations cannot mutate retained evidence", async () => {
  const f = fixture(), adapter = new CodexCloudAdapter({ enabled: true, command: f.command });
  const acceptance = await adapter.inspect();
  acceptance.installed.probes[0].result.stdout = "forged";
  acceptance.source.reason = "forged";
  const outcome = await adapter.status("fixture-task");
  if (outcome.status !== "unsupported") throw Error("Unsupported evidence required");
  expect(outcome.acceptance.installed.probes[0].result.stdout).toBe("Fictional inspection only");
  expect(outcome.acceptance.source.reason).not.toBe("forged");
  outcome.acceptance.installed.status = "unavailable";
  expect(await adapter.status("fixture-task")).toMatchObject({ acceptance: { installed: { status: "observed" } } });
});

test("a later failed inspection replaces previous observations without accepting source", async () => {
  let fail = false;
  const adapter = new CodexCloudAdapter({ enabled: true, command: async () => fail ? { ...ok(""), exitCode: 1 } : ok("Fictional help") });
  expect((await adapter.inspect()).installed.status).toBe("observed");
  fail = true;
  const acceptance = await adapter.inspect();
  expect(acceptance.installed.status).toBe("unavailable");
  expect(acceptance.installed.probes).toHaveLength(2);
  expect(acceptance.source.status).toBe("unverified");
});
