import { test, expect } from "bun:test";
import { newTicketRoute, executionRoute, needsApp, routedLabels, type Execution } from "../launcher/routing";
import { TestEngine, config, ticket, admission } from "./fixtures";
import { Store } from "../tracking/store";
import { issueTicket, intakeLabel, type Issue } from "../adapters/github";

const eligible = (): Execution => ({ computerControl: false, browser: false, signIn: false, aws: false, localDatabase: false, closeCollaboration: false });
test("complete eligible inventory defaults cloud; every local dependency wins", () => {
  expect(newTicketRoute({ execution: eligible() }).runs).toBe("cloud");
  for (const key of Object.keys(eligible()) as (keyof Execution)[]) {
    const execution = { ...eligible(), [key]: true };
    expect(newTicketRoute({ execution }).runs).toBe("local");
    expect(executionRoute({ runs: "cloud", execution })).toBe("local");
    expect(() => newTicketRoute({ execution, runs: "cloud" })).toThrow("conflict");
    expect(needsApp({ execution })).toBe(["computerControl", "browser", "signIn"].includes(key));
  }
  expect(newTicketRoute({ execution: eligible(), needs_browser: true }).runs).toBe("local");
  expect(() => newTicketRoute({ execution: { browser: false } })).toThrow();
  expect(() => newTicketRoute({})).toThrow();
});
test("GitHub runs labels survive parsing without changing the approved digest", () => {
  const i: Issue = { number: 1, title: "Synthetic task", body: "```factory\n" + JSON.stringify(ticket()) + "\n```", state: "OPEN", url: "", updatedAt: "", labels: ["kind:fix", "area:demo", "state:ready", "runs:cloud"].map(name => ({ name })) };
  i.labels.push({ name: intakeLabel("example/demo", i) });
  expect(issueTicket("example/demo", i)?.runs).toBe("cloud");
  expect(() => routedLabels({ needs_browser: true }, i.labels)).toThrow("local dependency");
  expect(() => routedLabels({}, [{ name: "runs:cloud" }, { name: "runs:local" }])).toThrow();
  expect(() => routedLabels({ runs: "local" }, [{ name: "runs:cloud" }])).toThrow("approved brief");
  expect(() => routedLabels({ runs: "local", execution: eligible() }, [{ name: "runs:local" }])).toThrow("conflicts");
});
test("cloud/app work cannot reserve a local slot, debit, path or workspace", () => {
  const e = new TestEngine(new Store(":memory:"), config()); e.pause(false, "owner");
  try {
    for (const brief of [
      { ...ticket(), runs: "cloud" },
      { ...ticket(), execution: eligible() },
      { ...ticket(), runs: "local", execution: eligible() },
      { ...ticket(), runs: "local", needs_browser: true },
      { ...ticket(), execution: { ...eligible(), signIn: true } },
    ]) expect(() => e.admit(brief, admission())).toThrow();
    expect(e.sessions()).toHaveLength(0);
    expect(e.s.rows("debits")).toHaveLength(0);
    expect(e.s.db.query("SELECT * FROM claims").all()).toHaveLength(0);
    expect(e.slots().used).toBe(0);
    // AWS-only/DB-only/collaboration-only work can still use the ordinary
    // qualified local lane, with all existing usage/capacity gates intact.
    expect(e.admit({ ...ticket(), runs: "local", execution: { ...eligible(), aws: true } }, admission()).status).toBe("reserved");
  } finally { e.s.close(); }
});
