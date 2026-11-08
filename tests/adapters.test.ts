import { test, expect } from "bun:test";
import {
  workerSpec,
  sessionEvent,
  subscriptionStatus,
} from "../adapters/workers";
import { issueTicket, intakeLabel, type Issue } from "../adapters/github";
import { ticket } from "./fixtures";
const issue = (): Issue => {
  const i: Issue = {
    number: 1,
    title: "Synthetic",
    state: "OPEN",
    body: "```factory\n" + JSON.stringify(ticket()) + "\n```",
    url: "https://github.com/example/demo/issues/1",
    updatedAt: "2026-11-07",
    labels: [
      { name: "state:ready" },
      { name: "kind:fix" },
      { name: "area:demo" },
    ],
  };
  i.labels.push({ name: intakeLabel("example/demo", i) });
  return i;
};
test("GitHub admits only a complete ready intake, one state/kind/area", () => {
  expect(issueTicket("example/demo", issue())?.approved).toBe(true);
  expect(issueTicket("example/demo", { ...issue(), state: "CLOSED" })).toBe(
    null,
  );
  expect(
    issueTicket("example/demo", {
      ...issue(),
      labels: [...issue().labels, { name: "state:building" }],
    }),
  ).toBe(null);
  expect(() =>
    issueTicket("example/demo", { ...issue(), body: "missing" }),
  ).toThrow("intake");
  expect(() =>
    issueTicket("example/demo", {
      ...issue(),
      labels: [{ name: "state:ready" }],
    }),
  ).toThrow("kind");
});
test("worker adapters pin requested native model and effort without key fallback", () => {
  const c = workerSpec(ticket(), "/synthetic");
  expect(c.argv).toContain("gpt-6.1-sol");
  expect(c.argv).toContain("model_reasoning_effort=medium");
  expect(c.argv).toContain('default_permissions="factory"');
  expect(c.argv.find(a=>a.startsWith("permissions.factory.filesystem="))).toContain('"/synthetic/node_modules"="read"');
  expect(c.argv).toContain("permissions.factory.network.enabled=false");
  expect(c.argv).toContain("permissions.factory.network.unix_sockets={  }");
  expect(c.env.SSH_AUTH_SOCK).toBeUndefined();
  expect(c.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(
    Object.keys(c.env).some((x) => /API_KEY|TOKEN|BEDROCK|FACTORY/.test(x)),
  ).toBe(false);
  const t = { ...ticket(), provider: "claude" as const, model: "opus-5.5" };
  const print = workerSpec(t, "/synthetic").argv;
  expect(print).toContain("-p");
  expect(print).toContain("--safe-mode");
  expect(print).toContain("--include-partial-messages");
  expect(print.slice(print.indexOf("--setting-sources"), print.indexOf("--setting-sources")+2)).toEqual(["--setting-sources", ""]);
  expect(print).toContain("--strict-mcp-config");
  expect(print).toContain("--no-chrome");
  expect(print.slice(print.indexOf("--permission-prompts"), print.indexOf("--permission-prompts")+2)).toEqual(["--permission-prompts", "none"]);
  const b = workerSpec(t, "/synthetic", "background");
  expect(b.argv).toContain("--bg");
  expect(b.argv).toContain("claude-opus-5-5");
  expect(b.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  const settings=JSON.parse(print[print.indexOf("--settings")+1]);
  expect(settings.sandbox).toMatchObject({enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,excludedCommands:[]});
  expect(print).toContain("--restricted");
  expect(b.argv).toContain("medium");
  expect(b.nativeId).toBeTruthy();
});
test("native receipts capture actual IDs and usage; missing receipt never invents one", () => {
  expect(
    sessionEvent("codex", '{"type":"thread.started","thread_id":"native"}')
      .native,
  ).toBe("native");
  expect(
    sessionEvent(
      "codex",
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}',
    ).tokens,
  ).toBe(13);
  expect(
    sessionEvent(
      "claude",
      '{"type":"result","session_id":"native","usage":{"input_tokens":20,"output_tokens":5}}',
    ).tokens,
  ).toBe(25);
  expect(sessionEvent("codex", "broken")).toEqual({});
  expect(sessionEvent("claude", JSON.stringify({type:"result",is_error:true,subtype:"success",stop_reason:"refusal"})).done).toBe(false);
  expect(sessionEvent("claude", JSON.stringify({type:"result",is_error:false,subtype:"success"})).done).toBe(true);
});
test("auth gate accepts subscription only and refuses key or third party routes", () => {
  expect(subscriptionStatus("codex", "Logged in using ChatGPT")).toBe(true);
  expect(subscriptionStatus("codex", "Logged in using API key")).toBe(false);
  expect(
    subscriptionStatus(
      "claude",
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
    ),
  ).toBe(true);
  expect(
    subscriptionStatus(
      "claude",
      '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"bedrock"}',
    ),
  ).toBe(false);
});
test("GitHub launch transition rechecks approval and logs its undo", async () => {
  const { markBuilding } = await import("../adapters/github"),
    { Store } = await import("../tracking/store");
  const s = new Store(":memory:"),
    t = issueTicket("example/demo", issue())!,
    calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return args.includes("view") ? JSON.stringify(issue()) : "";
  };
  await markBuilding(t, s, exec);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("state:building");
  expect(s.rows("events")).toHaveLength(1);
  await expect(
    markBuilding({ ...t, outcome: "Changed" }, s, exec),
  ).rejects.toThrow("changed");
  expect(calls.filter((x) => x.includes("edit"))).toHaveLength(1);
  s.close();
});
