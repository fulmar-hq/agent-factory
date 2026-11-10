import { expect, test, spyOn } from "bun:test";
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
  await tickSummary(async()=>({at:1,status:"ok",ready:1,paused:true,claimed:0,refusals:[{ticket:"example/demo#1",reason:"Error: usage window missing"}]}),line=>lines.push(line));
  await expect(tickSummary(async()=>{throw Error("unavailable")},line=>lines.push(line))).rejects.toThrow("unavailable");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0])).toMatchObject({status:"ok",paused:true,claimed:0,refusals:[{ticket:"example/demo#1",reason:"Error: usage window missing"}]});
  expect(JSON.parse(lines[1]).status).toBe("error");
});

for (const cleanupFails of [false, true]) test(`stream token overrun pauses before a final receipt; cleanup ${cleanupFails ? "failure refuses proof" : "evidence is retained"}`, async () => {
  const { mkdtempSync,mkdirSync,rmSync }=await import("node:fs");
  const { Readable }=await import("node:stream");
  const { join }=await import("node:path");
  const { superviseSession,claimSupervisor }=await import("../launcher/worker");
  const scratch=join(process.cwd(),".factory-tmp");
  mkdirSync(scratch,{recursive:true});
  const dir=mkdtempSync(join(scratch,"factory-stream-")), s=new Store(join(dir,"state.sqlite")), e=new Engine(s,config());
  // Synthetic process evidence only. Real descendant/signal/EPERM assertions
  // remain in tests/child.test.ts; this unit test proves supervisor behavior.
  const cleanup={groups:[4242],deniedSignals:[] as string[],verified:false};
  let spawned=0,stopped=0;
  const identity=(pid:number)=>`fixture-boot:fixture-start:${pid}`;
  const processEvidence=await import("../launcher/process");
  const childEvidence=await import("../launcher/child");
  const identitySpy=spyOn(processEvidence,"processIdentity").mockImplementation(identity);
  const spawnSpy=spyOn(childEvidence,"spawnWorker").mockImplementation(()=>{
    spawned++;
    return {pid:4242,stdout:Readable.from([new TextEncoder().encode(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"m",usage:{input_tokens:100}}}})+"\n")]),
      exited:Promise.resolve(null),cleanup,stop:async()=>{
        stopped++;
        if(cleanupFails)throw Error("synthetic process table unavailable");
        cleanup.verified=true;
      }};
  });
  try {
    const t={...ticket(),provider:"claude" as const,model:"opus",effort:"medium" as const,estimateTokens:30};
    // Deliberate synthetic session, independent of production admission or credentials.
    s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)").run("stream","example/demo#1","builder","claude","reserved",JSON.stringify(t));
    e.pause(false,"owner"); e.claimStart("stream");
    await expect(superviseSession(e,"stream",t,dir,join(dir,"unowned.jsonl"))).rejects.toThrow("owned starting");
    expect(spawned).toBe(0);
    expect(claimSupervisor(e,"stream")).toBeTruthy();
    expect(s.get("supervisor:stream")).toBe(identity(process.pid));
    expect(claimSupervisor(e,"stream")).toBeNull();
    const running=superviseSession(e,"stream",t,dir,join(dir,"native.jsonl"));
    if(cleanupFails)await expect(running).rejects.toThrow("synthetic process table unavailable");
    else await running;
    expect(spawned).toBe(1);
    expect(stopped).toBeGreaterThan(0);
    expect(s.get("cleanup-evidence:stream")).toEqual({...cleanup,verified:!cleanupFails});
    const processEvent=(s.rows("events") as {kind:string;data:string}[]).find(row=>row.kind==="native-process")!;
    expect(JSON.parse(processEvent.data)).toMatchObject({pid:4242,processGroup:4242,identity:identity(4242)});
    const session=e.sessions()[0];
    expect(session.status).toBe("paused");
    expect(session.actual_tokens).toBe(100);
    expect(session.pid).toBeNull();
    expect(e.claimStart("stream")).toBe(false);
    if (!cleanupFails) {
      e.archive("stream","synthetic process ended","owner");
      expect(e.sessions()[0].status).toBe("archived");
      await expect(superviseSession(e,"stream",t,dir,join(dir,"replay.jsonl"))).rejects.toThrow("owned starting");
    }
  } finally {spawnSpy.mockRestore();identitySpy.mockRestore();s.close();rmSync(dir,{recursive:true});}
},10000);

test("unavailable process identity refuses supervisor custody without recording proof", async () => {
  const { claimSupervisor }=await import("../launcher/worker");
  const processEvidence=await import("../launcher/process");
  const s=new Store(":memory:"),e=new Engine(s,config());
  s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)")
    .run("identity","example/demo#1","builder","codex","reserved",JSON.stringify(ticket()));
  e.pause(false,"owner");e.claimStart("identity");
  const identitySpy=spyOn(processEvidence,"processIdentity").mockImplementation(()=>{throw Object.assign(Error("synthetic identity EPERM"),{code:"EPERM"});});
  try {
    expect(()=>claimSupervisor(e,"identity")).toThrow("synthetic identity EPERM");
    expect(e.sessions()[0]).toMatchObject({status:"starting",pid:null});
    expect(s.get("supervisor:identity")).toBeNull();
  } finally {identitySpy.mockRestore();s.close();}
});
