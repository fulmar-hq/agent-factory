import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DecisionService, type DecisionDefinition } from "../tracking/decisions";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { config, ticket, admission } from "./fixtures";

const now = 1_800_000_000_000;
function decision(extra: Partial<DecisionDefinition> = {}): DecisionDefinition {
  return { id: "synthetic-choice", scope: "example/demo#1", question: "Proceed with this scope?",
    tier: "Vincent", options: ["proceed", "hold"], default: "hold", deadline: now + 1000,
    resolver: "synthetic-vincent", ...extra };
}
function scratch() {
  mkdirSync(".factory-tmp", { recursive: true });
  return mkdtempSync(resolve(".factory-tmp/decisions-"));
}
function audits(s: Store, phase: string) {
  return (s.rows("events") as { kind: string; data: string; at: number; undo: string }[])
    .filter(e => e.kind === `a3-decision-${phase}`);
}

test("typed definition and answer persist with idempotent creation and resolution", () => {
  const s = new Store(":memory:"), d = new DecisionService(s);
  try {
    expect(d.get("missing")).toBeNull();
    expect(d.create(decision(), now).outcome).toBeNull();
    expect(d.create(decision(), now + 1)).toEqual(d.get(decision().id)!);
    expect(() => d.create(decision({ question: "Different?" }), now)).toThrow("different definition");
    expect(() => d.resolve("missing", "hold", "synthetic-vincent", now)).toThrow("Unknown decision");
    expect(() => d.resolve(decision().id, "proceed", "someone-else", now)).toThrow("Wrong resolver");
    expect(() => d.resolve(decision().id, "unknown", "synthetic-vincent", now)).toThrow("Unknown option");
    const result = d.resolve(decision().id, "proceed", "synthetic-vincent", now + 999);
    expect(result.outcome).toEqual({ option: "proceed", resolvedBy: "synthetic-vincent", source: "answer", at: now + 999 });
    expect(d.resolve(decision().id, "hold", "synthetic-vincent", now + 2000)).toEqual(result);
    expect(d.create(decision(), now + 2000)).toEqual(result);
    expect(d.expire(now + 2000)).toEqual([]);
    expect(audits(s, "created")).toHaveLength(1);
    const evidence = audits(s, "resolved");
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(evidence[0].data)).toEqual(result);
    expect(evidence[0].at).toBe(now + 999);
    expect(evidence[0].undo).toContain("Retain");
  } finally { s.close(); }
});

test("rejects malformed definitions without state or audit writes", () => {
  const s = new Store(":memory:"), d = new DecisionService(s);
  try {
    const invalid = [
      { id: " " }, { scope: "" }, { question: "" }, { tier: "" }, { resolver: "" },
      { options: [] }, { options: ["hold"] }, { options: ["hold", "hold"] },
      { default: "missing" }, { deadline: NaN }, { deadline: Infinity },
      { deadline: -1 }, { deadline: 0.5 }, { deadline: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const extra of invalid) expect(() => d.create(decision(extra), now)).toThrow();
    expect(() => d.create(decision(), NaN)).toThrow();
    expect(() => d.expire(Infinity)).toThrow();
    expect(() => d.resolve("missing", "hold", "synthetic-vincent", -1)).toThrow();
    expect(d.get(decision().id)).toBeNull();
    expect(audits(s, "created")).toEqual([]);
  } finally { s.close(); }
});

test("absolute deadline wins at the boundary and defaults exactly once after restart", () => {
  const path = join(scratch(), "state.sqlite");
  let s = new Store(path), d = new DecisionService(s);
  try {
    d.create(decision(), now);
    expect(d.expire(now + 999)).toEqual([]);
    s.close(); s = new Store(path); d = new DecisionService(s);
    const result = d.resolve(decision().id, "proceed", "synthetic-vincent", now + 1000);
    expect(result.outcome).toEqual({ option: "hold", resolvedBy: "deadline-default", source: "deadline", at: now + 1000 });
    s.close(); s = new Store(path); d = new DecisionService(s);
    expect(d.expire(now + 5000)).toEqual([]);
    expect(d.resolve(decision().id, "proceed", "synthetic-vincent", now + 5000)).toEqual(result);
    expect(audits(s, "resolved")).toHaveLength(1);
    d.create(decision({ id: "missed-tick", deadline: now - 1 }), now);
    expect(d.expire(now).map(x => x.id)).toEqual(["missed-tick"]);
    expect(d.expire(now)).toEqual([]);
  } finally { s.close(); }
});

test("unanswered Vincent decision holds only its scope while unrelated work progresses", () => {
  const s = new Store(":memory:"), d = new DecisionService(s), e = new Engine(s, config());
  try {
    e.pause(false, "owner");
    d.create(decision(), now);
    expect(d.pending("example/demo#1")).toHaveLength(1);
    expect(d.pending("example/demo#2")).toEqual([]);
    const x = e.admit(ticket(2), admission());
    e.finish(x.id, true);
    expect(e.sessions().find(row => row.id === x.id)?.status).toBe("finished");
    expect(s.get("paused")).toBe(false);
    expect(d.get(decision().id)?.outcome).toBeNull();
    expect(d.expire(now + 1000)).toHaveLength(1);
    expect(d.pending("example/demo#1")).toEqual([]);
    expect(s.get("paused")).toBe(false);
  } finally { s.close(); }
});

test("preserves questions, A4 decision data and audit records across service initialization", () => {
  const path = join(scratch(), "state.sqlite");
  let s = new Store(path);
  const a4 = { id: "legacy", state: "open", default: "not approved", deadline: now + 1000 };
  try {
    s.db.query("INSERT INTO questions VALUES(?,?,?,?)").run("legacy", "Existing question", null, now);
    s.set("autonomy-decision:legacy", a4);
    s.event("decision:legacy", "autonomy-owner-decision", a4, "retain", now);
    const questions = s.rows("questions"), events = s.rows("events");
    const d = new DecisionService(s);
    d.create(decision({ id: "legacy" }), now);
    d.expire(now + 1000);
    s.close(); s = new Store(path); new DecisionService(s);
    expect(s.rows("questions")).toEqual(questions);
    expect(s.get("autonomy-decision:legacy")).toEqual(a4);
    expect(s.rows("events")).toContainEqual(events[0]);
  } finally { s.close(); }
});

test("audit and state commit together; all decision evidence rejects mutation", () => {
  const s = new Store(":memory:"), d = new DecisionService(s);
  try {
    // A reserved audit ID collision must fail closed, including creation rollback.
    s.event(JSON.stringify(["a3-decision", "collision", "created"]), "fixture", {}, "retain", now);
    expect(() => d.create(decision({ id: "collision" }), now)).toThrow("audit ID conflict");
    expect(d.get("collision")).toBeNull();
    d.create(decision(), now);
    s.db.exec(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON events
      WHEN NEW.kind='a3-decision-resolved' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    expect(() => d.expire(now + 1000)).toThrow("synthetic audit failure");
    expect(d.get(decision().id)?.outcome).toBeNull();
    expect(audits(s, "resolved")).toEqual([]);
    s.db.exec("DROP TRIGGER synthetic_audit_failure");
    expect(d.expire(now + 1000)).toHaveLength(1);
    for (const table of ["a3_decisions", "a3_outcomes", "events"]) {
      expect(() => s.db.exec(`DELETE FROM ${table}`)).toThrow();
      const column = table === "a3_decisions" ? "definition" : table === "a3_outcomes" ? "outcome" : "data";
      expect(() => s.db.exec(`UPDATE ${table} SET ${column}='{}'`)).toThrow();
    }
  } finally { s.close(); }
});

// Independent Bun processes use only synthetic SQLite and a scratch rendezvous.
// No deliberate aborts, signals, external messages, adapters or real owner identity.
for (const mode of ["defaults", "answers", "late-answer"] as const) {
  test(`competing processes retain one outcome and audit: ${mode}`, async () => {
    const dir = scratch(), path = join(dir, "state.sqlite"), gate = join(dir, "go");
    let s = new Store(path);
    const d = new DecisionService(s);
    d.create(decision(), now);
    // Keep an open connection while competitors start; Store initializes WAL
    // before setting busy_timeout, so simultaneous cold opens are outside this service.
    const imports = `import {Store} from ${JSON.stringify(resolve("tracking/store.ts"))};
      import {DecisionService} from ${JSON.stringify(resolve("tracking/decisions.ts"))};`;
    const children = [0, 1].map(n => Bun.spawn([process.execPath, "--no-env-file", "-e", `${imports}
      const s=new Store(${JSON.stringify(path)}), d=new DecisionService(s);
      const end=Date.now()+5000;
      while(!await Bun.file(${JSON.stringify(gate)}).exists()) {
        if(Date.now()>end) throw Error('rendezvous timeout'); await Bun.sleep(5);
      }
      const mode=${JSON.stringify(mode)}, n=${n};
      if(mode==='defaults' || (mode==='late-answer' && n===0)) d.expire(${now + 1000});
      else d.resolve('synthetic-choice',n===0?'proceed':'hold','synthetic-vincent',mode==='answers'?${now + 999}:${now + 1000});
      console.log(JSON.stringify(d.get('synthetic-choice')));s.close();
    `], { stdout: "pipe", stderr: "pipe" }));
    writeFileSync(gate, "go");
    const outputs = await Promise.all(children.map(async child => {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe(""); expect(exit).toBe(0);
      return JSON.parse(stdout);
    }));
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0].outcome.source).toBe(mode === "answers" ? "answer" : "deadline");
    if (mode !== "answers") expect(outputs[0].outcome.option).toBe("hold");
    s.close(); s = new Store(path);
    try {
      const restarted = new DecisionService(s);
      expect(restarted.expire(now + 5000)).toEqual([]);
      expect(restarted.get(decision().id)).toEqual(outputs[0]);
      expect(audits(s, "created")).toHaveLength(1);
      expect(audits(s, "resolved")).toHaveLength(1);
    } finally { s.close(); }
  });
}
