import { expect, test } from "bun:test";
import { QualificationSchema } from "../launcher/config";
import { WorkerAccounting } from "../adapters/workers";
import { qualification, admission, ticket, config } from "./fixtures";
import { Engine } from "../launcher/engine";
import { Store } from "../tracking/store";
import { tickSummary } from "../launcher/tick";

test("phone deferral is explicit and cannot waive any other qualification gate", () => {
  const q = {...qualification(), phoneVerified:false};
  expect(QualificationSchema.safeParse(q).success).toBe(false);
  const deferred = {...q, waiver:{phone:"deferred" as const}};
  expect(QualificationSchema.safeParse(deferred).success).toBe(true);
  for (const key of ["qualified", "subscription", "policyIsolation", "liveAccounting", "stopVerified"])
    expect(QualificationSchema.safeParse({...deferred,[key]:false}).success).toBe(false);
  expect(QualificationSchema.safeParse({...q,waiver:{phone:"yes"}}).success).toBe(false);
  const s = new Store(":memory:"), e = new Engine(s,config());
  e.pause(false,"owner");
  expect(e.admit(ticket(),{...admission(),qualification:deferred}).status).toBe("reserved");
  s.close();
});
test("stream usage is live, monotonic and final receipts do not double count", () => {
  const a = new WorkerAccounting();
  const ingest = (event:unknown) => a.ingest("claude",JSON.stringify({type:"stream_event",event})).tokens;
  expect(ingest({type:"message_start",message:{id:"a",usage:{input_tokens:10,cache_read_input_tokens:20}}})).toBe(30);
  expect(ingest({type:"message_delta",usage:{output_tokens:5}})).toBe(35);
  expect(ingest({type:"message_delta",usage:{output_tokens:5}})).toBe(35);
  expect(ingest({type:"message_start",message:{id:"b",usage:{input_tokens:15}}})).toBe(50);
  expect(ingest({type:"message_delta",usage:{output_tokens:7}})).toBe(57);
  expect(a.ingest("claude",JSON.stringify({type:"result",usage:{input_tokens:25,cache_read_input_tokens:20,output_tokens:12}})).tokens).toBe(57);
  expect(a.ingest("claude","broken").tokens).toBe(57);
  const codex = new WorkerAccounting();
  expect(codex.ingest("codex",'{"type":"turn.started"}').tokens).toBe(0);
  expect(codex.ingest("codex",'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}').tokens).toBe(15);
});
test("each CLI tick emits one summary including errors", async () => {
  const lines:string[] = [];
  await tickSummary(async()=>({at:1,status:"ok",ready:0}),line=>lines.push(line));
  await expect(tickSummary(async()=>{throw Error("unavailable")},line=>lines.push(line))).rejects.toThrow("unavailable");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).status).toBe("ok");
  expect(JSON.parse(lines[1]).status).toBe("error");
});

test("stream token overrun pauses the shared supervisor before any final receipt", async () => {
  const { mkdtempSync,writeFileSync,rmSync }=await import("node:fs");
  const { join }=await import("node:path");
  const { tmpdir }=await import("node:os");
  const { superviseSession,claimSupervisor }=await import("../launcher/worker");
  const dir=mkdtempSync(join(tmpdir(),"factory-stream-")), s=new Store(join(dir,"state.sqlite")), e=new Engine(s,config());
  const oldPath=process.env.PATH;
  writeFileSync(join(dir,"claude"),`#!/bin/sh\necho '{"type":"system","session_id":"synthetic"}'\necho '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","usage":{"input_tokens":100}}}}'\nexec sleep 60\n`,{mode:0o700});
  process.env.PATH=dir+":"+oldPath;
  const t={...ticket(),provider:"claude" as const,model:"opus",effort:"medium" as const,estimateTokens:30};
  // Deliberate synthetic session, independent of production admission or credentials.
  s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)").run("stream","example/demo#1","builder","claude","reserved",JSON.stringify(t));
  e.pause(false,"owner"); e.claimStart("stream");
  await expect(superviseSession(e,"stream",t,dir,join(dir,"unowned.jsonl"))).rejects.toThrow("owned starting");
  expect(claimSupervisor(e,"stream")).toBeTruthy();
  expect(claimSupervisor(e,"stream")).toBeNull();
  try {
    await superviseSession(e,"stream",t,dir,join(dir,"native.jsonl"));
    const session=e.sessions()[0];
    expect(session.status).toBe("paused");
    expect(session.actual_tokens).toBe(100);
    expect(session.pid).toBeNull();
    expect(e.claimStart("stream")).toBe(false);
    e.archive("stream","synthetic process ended","owner");
    expect(e.sessions()[0].status).toBe("archived");
    await expect(superviseSession(e,"stream",t,dir,join(dir,"replay.jsonl"))).rejects.toThrow("owned starting");
  } finally {process.env.PATH=oldPath;s.close();rmSync(dir,{recursive:true});}
},10000);
