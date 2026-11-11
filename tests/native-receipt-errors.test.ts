import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { NativeReceipt } from "../adapters/native";
import { WorkerAccounting } from "../adapters/workers";

const id = "00000000-0000-0000-0000-000000000051";
const workspace = "/fictional-workspace";
const row = (value: unknown) => JSON.stringify(value) + "\n";
const context = row({type:"turn_context",payload:{model:"fictional-model",effort:"medium"}});
const usage = (tokens: number) => row({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{total_tokens:tokens,cached_input_tokens:7}}}});

function fixture(provider = "codex") {
  const scratch = join(process.cwd(), ".factory-tmp");
  fs.mkdirSync(scratch, {recursive:true});
  const home = fs.mkdtempSync(join(scratch, "receipt-errors-"));
  const dir = provider === "codex" ? join(home, ".codex/sessions/2026/11/07") : join(home, ".claude/projects/-fictional-workspace");
  fs.mkdirSync(dir, {recursive:true});
  const path = join(dir, provider === "codex" ? `rollout-${id}.jsonl` : `${id}.jsonl`);
  const initial = provider === "codex"
    ? row({type:"session_meta",payload:{id,cwd:workspace}}) + context + usage(42)
    : row({type:"assistant",sessionId:id,cwd:workspace,effort:"medium",message:{id:"fictional-message",model:"fictional-model",usage:{input_tokens:35,cache_read_input_tokens:7}}});
  fs.writeFileSync(path, initial);
  const receipt = new NativeReceipt(provider, id, workspace, home, Date.parse("2026-11-07T12:00Z"));
  const accounting = new WorkerAccounting();
  const evidence = () => receipt.evidence("fictional-model", "medium");
  const poll = () => receipt.poll(accounting);
  poll();
  expect(evidence().verified).toBe(true);
  return {path,initial,receipt,accounting,evidence,poll,dispose:() => fs.rmSync(home,{recursive:true})};
}

for (const provider of ["codex", "claude"]) {
  const badRows = [
    {name:"malformed JSON",line:"{broken}\n",error:"malformed native receipt"},
    {name:"wrong native ID",line:row(provider === "codex" ? {type:"session_meta",payload:{id:"00000000-0000-0000-0000-000000000052",cwd:workspace}} : {type:"assistant",sessionId:"00000000-0000-0000-0000-000000000052",cwd:workspace}),error:"custody mismatch"},
    {name:"wrong workspace",line:row(provider === "codex" ? {type:"session_meta",payload:{id,cwd:"/other-fictional-workspace"}} : {type:"assistant",sessionId:id,cwd:"/other-fictional-workspace"}),error:provider === "codex" ? "custody mismatch" : "workspace mismatch"},
  ];
  for (const bad of badRows) test(`${provider}: verified receipt stays invalid after ${bad.name}`, () => {
    const f = fixture(provider);
    try {
      fs.appendFileSync(f.path, bad.line);
      expect(f.poll).toThrow(bad.error);
      expect(f.receipt.caughtUp).toBe(false);
      expect(f.evidence().verified).toBe(false);
      expect(f.accounting.tokens).toBe(42);
      expect(f.accounting.cachedTokens).toBe(7);
      // The bad row was consumed; retry and beginTurn must not erase its failure.
      expect(f.poll).toThrow(bad.error);
      f.receipt.beginTurn();
      fs.appendFileSync(f.path, context);
      expect(f.poll).toThrow(bad.error);
      expect(f.evidence().verified).toBe(false);
      expect(f.accounting.tokens).toBe(42);
    } finally { f.dispose(); }
  });

  test(`${provider}: truncation remains terminal after the file is restored`, () => {
    const f = fixture(provider);
    try {
      fs.writeFileSync(f.path, "");
      expect(f.poll).toThrow("truncated");
      expect(f.receipt.caughtUp).toBe(false);
      expect(f.evidence().verified).toBe(false);
      fs.writeFileSync(f.path, f.initial);
      expect(f.poll).toThrow("truncated");
      expect(f.evidence().verified).toBe(false);
      expect(f.accounting.tokens).toBe(42);
      expect(f.accounting.cachedTokens).toBe(7);
    } finally { f.dispose(); }
  });
}

test("a transient open failure invalidates verification until a successful poll", () => {
  const f = fixture();
  const retained = f.path + ".retained";
  try {
    fs.renameSync(f.path, retained);
    expect(f.poll).toThrow();
    expect(f.receipt.caughtUp).toBe(false);
    expect(f.evidence().verified).toBe(false);
    fs.renameSync(retained, f.path);
    f.poll();
    expect(f.evidence().verified).toBe(true);
    expect(f.accounting.tokens).toBe(42);
  } finally { f.dispose(); }
});

test("a transient read failure preserves counters and can catch up on retry", () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.path, usage(55));
    const read = spyOn(fs, "readSync").mockImplementationOnce(() => { throw Error("fictional read failure"); });
    try {
      expect(f.poll).toThrow("fictional read failure");
      expect(f.receipt.caughtUp).toBe(false);
      expect(f.evidence().verified).toBe(false);
      expect(f.accounting.tokens).toBe(42);
    } finally { read.mockRestore(); }
    f.poll();
    expect(f.evidence().verified).toBe(true);
    expect(f.accounting.tokens).toBe(55);
    expect(f.accounting.cachedTokens).toBe(7);
  } finally { f.dispose(); }
});

test("normal appends, partial lines and beginTurn preserve incremental accounting", () => {
  const f = fixture();
  try {
    const next = usage(55);
    fs.appendFileSync(f.path, next.slice(0, -2));
    f.poll();
    expect(f.evidence().verified).toBe(false);
    expect(f.accounting.tokens).toBe(42);
    fs.appendFileSync(f.path, next.slice(-2));
    f.poll();
    expect(f.evidence().verified).toBe(true);
    expect(f.accounting.tokens).toBe(55);
    f.receipt.beginTurn();
    f.poll();
    expect(f.evidence()).toMatchObject({bound:true,verified:false,models:[],efforts:[]});
    fs.appendFileSync(f.path, context + usage(50));
    f.poll();
    expect(f.evidence().verified).toBe(true);
    expect(f.accounting.tokens).toBe(55);
    expect(f.accounting.cachedTokens).toBe(7);
    f.poll();
    expect(f.accounting.tokens).toBe(55);
  } finally { f.dispose(); }
});
