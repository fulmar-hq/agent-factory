import { expect,test } from "bun:test";
import { mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeReceipt } from "../adapters/native";
import { WorkerAccounting } from "../adapters/workers";
const id="00000000-0000-0000-0000-000000000001";
test("rollout binds exact session/workspace, counts live cumulative usage and rejects conflicts",()=>{
 const home=mkdtempSync(join(tmpdir(),"factory-native-")),day=join(home,".codex/sessions/2026/11/07");mkdirSync(day,{recursive:true});
 const path=join(day,`rollout-${id}.jsonl`),a=new WorkerAccounting(),r=new NativeReceipt("codex",id,"/fixture",home,Date.parse("2026-11-07T12:00Z"));
 const row=(x:unknown)=>JSON.stringify(x)+"\n";
 try {
  // A newer unrelated receipt cannot supply usage or identity.
  writeFileSync(join(day,"rollout-other.jsonl"),row({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{total_tokens:999}}}}));
  r.poll(a);expect(a.tokens).toBe(0);
  writeFileSync(path,row({type:"session_meta",payload:{id,cwd:"/fixture"}})+row({type:"turn_context",payload:{model:"gpt-6.1-sol",effort:"medium"}}));
  const usage=row({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{total_tokens:42}}}});
  appendFileSync(path,usage.slice(0,-2));r.poll(a);expect(a.tokens).toBe(0);
  appendFileSync(path,usage.slice(-2));r.poll(a);expect(a.tokens).toBe(42);
  r.poll(a);expect(a.tokens).toBe(42);expect(r.evidence("gpt-6.1-sol","medium").verified).toBe(true);
  appendFileSync(path,row({type:"turn_context",payload:{model:"other",effort:"medium"}}));r.poll(a);
  expect(r.evidence("gpt-6.1-sol","medium")).toMatchObject({verified:false,conflict:true});
  writeFileSync(path,"{}");expect(()=>r.poll(a)).toThrow("truncated");
 }finally{rmSync(home,{recursive:true});}
});
test("native reader refuses a matching filename whose session custody differs",()=>{
 const home=mkdtempSync(join(tmpdir(),"factory-native-")),day=join(home,".codex/sessions/2026/11/07");mkdirSync(day,{recursive:true});
 try {
  writeFileSync(join(day,`rollout-${id}.jsonl`),JSON.stringify({type:"session_meta",payload:{id,cwd:"/other"}})+"\n");
  expect(()=>new NativeReceipt("codex",id,"/fixture",home,Date.parse("2026-11-07T12:00Z")).poll(new WorkerAccounting())).toThrow("custody mismatch");
 }finally{rmSync(home,{recursive:true});}
});
test("Claude transcript receipts deduplicate streamed messages and expose actual fallback",()=>{
 const home=mkdtempSync(join(tmpdir(),"factory-native-")),dir=join(home,".claude/projects/-fixture");mkdirSync(dir,{recursive:true});
 const a=new WorkerAccounting(),r=new NativeReceipt("claude",id,"/fixture",home,Date.now());
 const row=(x:unknown)=>JSON.stringify({sessionId:id,cwd:"/fixture",...x as object})+"\n";
 try {
  a.ingest("claude",JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"m",usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:5}}}}));
  const path=join(dir,`${id}.jsonl`);
  writeFileSync(path,row({type:"assistant",effort:"medium",message:{id:"m",model:"claude-opus-5-5",usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:5}}}));
  r.poll(a);expect(a.tokens).toBe(35);expect(r.evidence("opus-5.5","medium").verified).toBe(true);
  appendFileSync(path,row({type:"api-request",params:{model:"claude-opus-4-8",output_config:{effort:"medium"}}}));r.poll(a);
  expect(r.evidence("opus-5.5","medium").conflict).toBe(true);
  appendFileSync(path,JSON.stringify({type:"assistant",sessionId:"other"})+"\n");expect(()=>r.poll(a)).toThrow("custody mismatch");
 }finally{rmSync(home,{recursive:true});}
});

for(const reason of ["tokens","identity"]) test(`supervisor polls silent Codex rollout and stops on ${reason}`,async()=>{
 const {Store}=await import("../tracking/store"),{Engine}=await import("../launcher/engine");
 const {claimSupervisor,superviseSession}=await import("../launcher/worker"),{ticket,config}=await import("./fixtures");
 const home=mkdtempSync(join(tmpdir(),"factory-poll-")),workspace=join(home,"workspace"),bin=join(home,"bin");
 mkdirSync(workspace);mkdirSync(bin);
 const day=join(home,".codex/sessions",new Date().toISOString().slice(0,10).replaceAll("-","/"));mkdirSync(day,{recursive:true});
 const row=(x:unknown)=>JSON.stringify(x)+"\n";
 writeFileSync(join(day,`rollout-${id}.jsonl`),row({type:"session_meta",payload:{id,cwd:workspace}})+row({type:"turn_context",payload:{model:reason==="identity"?"unexpected":"gpt-6.1-sol",effort:"medium"}})+row({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{total_tokens:100}}}}));
 writeFileSync(join(bin,"codex"),`#!/bin/sh\necho '{"type":"thread.started","thread_id":"${id}"}'\nexec sleep 60\n`,{mode:0o700});
 const oldPath=process.env.PATH,oldHome=process.env.HOME;
 process.env.PATH=bin+":"+oldPath;process.env.HOME=home;
 const s=new Store(join(home,"state.sqlite")),e=new Engine(s,config()),t={...ticket(),model:"gpt-6.1-sol",effort:"medium" as const,estimateTokens:reason==="tokens"?30:1000};
 e.pause(false,"owner");s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)").run("native-poll","example/demo#1","builder","codex","reserved",JSON.stringify(t));
 e.claimStart("native-poll");claimSupervisor(e,"native-poll");
 try {
  await superviseSession(e,"native-poll",t,workspace,join(home,"out.jsonl"));
  expect(e.sessions()[0].status).toBe("paused");expect(e.sessions()[0].actual_tokens).toBe(100);
  expect(s.get<{conflict:boolean}>("native-evidence:native-poll")?.conflict).toBe(reason==="identity");
  expect(e.claimStart("native-poll")).toBe(false);
 }finally{process.env.PATH=oldPath;process.env.HOME=oldHome;s.close();rmSync(home,{recursive:true});}
},10000);
