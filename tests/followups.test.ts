import { test, expect } from "bun:test";
import {TestEngine as Engine} from './fixtures';
import { Store } from "../tracking/store";
import { launchReady } from "../launcher/tick";
import { TicketSchema } from "../launcher/config";
import { intakeLabel, issueTicket, type Issue } from "../adapters/github";
import { config, ticket, admission, now } from "./fixtures";
const setup = () => {
  const e = new Engine(new Store(":memory:"), config());
  e.pause(false, "owner");
  return e;
};
for (const pid of [process.pid, 1])
  test(`#8 archive stale process instance at PID ${pid}`, () => {
    const e = setup();
    try {
      const x = e.admit(ticket(), admission());
      e.claimStart(x.id, now);
      e.register(x.id, pid, "retained-native");
      e.s.set(`supervisor:${x.id}`, "previous-boot-start");
      e.finish(x.id, false);
      e.archive(x.id, "native custody reconciled", "owner");
      expect(e.active()).toHaveLength(0);
      expect(e.sessions()[0].native_id).toBe("retained-native");
    } finally { e.s.close(); }
  });
for (const path of ["src/straße", "src/İ", "src/ı", "src/ǅ"])
  test(`#10 non-ASCII path refuses: ${path}`, () => {
    const e = setup();
    try {
      expect(() => e.admit({ ...ticket(), paths: [path] }, admission())).toThrow("invalid paths");
      expect(e.sessions()).toHaveLength(0);
      expect(e.s.rows("debits")).toHaveLength(0);
    } finally { e.s.close(); }
  });
for (const failure of ["edit", "read", "spawn"])
  test(`#9 ${failure} before spawn preserves retry, slots and wallet`, async () => {
    const e = setup();
    let t = TicketSchema.parse({ ...ticket(), costCents: 50 });
    const issue: Issue = { number: 1, title: t.title, body: `\`\`\`factory\n${JSON.stringify(t)}\n\`\`\``, state: "OPEN", url: "fixture", updatedAt: "fixture", labels: [{name:"state:ready"}, {name:"kind:fix"}, {name:"area:demo"}] };
    issue.labels.push({ name: intakeLabel(t.repo, issue) });
    t = issueTicket(t.repo, issue)!;
    let fail = true, spawned = 0;
    const exec = async (args: string[]) => {
      if (args.includes("view")) {
        if (fail && failure === "read") throw Error("temporary gh failure");
        return JSON.stringify(fail && failure === "edit" ? { ...issue, body: issue.body.replace('"costCents":50', '"costCents":99') } : issue);
      }
      return "";
    };
    const spawn = () => {
      if (fail && failure === "spawn") throw Error("spawn refused");
      spawned++;
    };
    try {
      await expect(launchReady(e, t, admission(), spawn, exec, () => now)).rejects.toThrow();
      expect(e.sessions()).toHaveLength(0);
      expect(e.s.rows("debits")).toHaveLength(0);
      expect(e.s.rows("events").filter((x: any) => x.kind === "reservation")).toHaveLength(0);
      expect(spawned).toBe(0);
      fail = false;
      await launchReady(e, t, admission(), spawn, exec, () => now);
      expect(spawned).toBe(1);
      expect(e.active()).toHaveLength(1);
      expect(e.s.rows("debits")).toHaveLength(1);
    } finally { e.s.close(); }
  });

test("#9 post-spawn label failure retains custody and prevents another spawn", async () => {
  const e = setup();
  let t = TicketSchema.parse(ticket());
  const i: Issue = { number: 1, title: t.title, body: `\`\`\`factory\n${JSON.stringify(t)}\n\`\`\``, state: "OPEN", url: "fixture", updatedAt: "fixture", labels: [{ name: "state:ready" }, { name: "kind:fix" }, { name: "area:demo" }] };
  i.labels.push({ name: intakeLabel(t.repo, i) });
  t = issueTicket(t.repo, i)!;
  let starts = 0;
  const exec = async (args: string[]) => {
    if (args.includes("view")) return JSON.stringify(i);
    throw Error("label API failed");
  };
  try {
    await launchReady(e, t, admission(), () => { starts++; }, exec, () => now);
    await expect(launchReady(e, t, admission(), () => { starts++; }, exec, () => now)).rejects.toThrow("duplicate");
    expect(starts).toBe(1);
    expect(e.active()).toHaveLength(1);
    expect(e.s.rows("events").filter((x: any) => x.kind === "github-state-failure")).toHaveLength(1);
  } finally { e.s.close(); }
});
