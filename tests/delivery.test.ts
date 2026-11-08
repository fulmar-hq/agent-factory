import { test, expect } from "bun:test";
import { deliveryRequest } from "../adapters/delivery";
import { turnTokens } from "../launcher/budgets";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { config, ticket, admission } from "./fixtures";

test("calibration uses native cumulative completed-turn deltas including cache",()=>{
 const row=(p:unknown)=>JSON.stringify({type:"event_msg",payload:p});
 const token=(n:number)=>row({type:"token_count",info:{total_token_usage:{total_tokens:n}}});
 expect(turnTokens([token(12),token(12),row({type:"task_complete"}),token(42),row({type:"task_complete"}),token(100)].join("\n"))).toEqual([12,30]);
 expect(turnTokens(token(1000))).toEqual([]);
});
test("delivery accepts only title and body, never repository, commands, refs or URL",()=>{
 expect(deliveryRequest({title:"Test",body:"refs #1"})).toEqual({title:"Test",body:"refs #1"});
 for(const field of ["repo","url","args","head","base","command"]) expect(()=>deliveryRequest({title:"Test",body:"",[field]:"anything"})).toThrow();
});
test("calibration freezes effective estimate; continuation preserves all original custody",()=>{
 const s=new Store(":memory:"),e=new Engine(s,config());e.pause(false,"owner");
 s.set("token-calibration:codex",9000000);
 const x=e.admit(ticket(),admission());
 expect(JSON.parse(x.brief).estimateTokens).toBe(9000000);
 e.claimStart(x.id);s.db.query("UPDATE sessions SET status='paused',native_id=?,actual_seconds=12,actual_tokens=440894 WHERE id=?").run("01a1b923-818c-7663-990e-9bee3fd9238d",x.id);
 s.set("token-calibration:codex",10000000);
 expect(()=>e.continueSession(x.id,"fixture",()=>{})).toThrow("cleanup");
 s.event(`cleanup:${x.id}`,"worker-cleanup",{verified:true},"retain");
 expect(()=>e.continueSession(x.id,"fixture",()=>{throw Error("spawn failed")})).toThrow("spawn failed");
 expect(e.sessions()[0].status).toBe("paused");
 const claims=s.db.query("SELECT * FROM claims").all(),debits=s.rows("debits");
 e.continueSession(x.id,"fixture",()=>{});
 expect(e.sessions()[0]).toMatchObject({status:"starting",actual_tokens:440894,actual_seconds:12,native_id:"01a1b923-818c-7663-990e-9bee3fd9238d",brief:x.brief});
 expect(s.db.query("SELECT * FROM claims").all()).toEqual(claims);expect(s.rows("debits")).toEqual(debits);
 expect(()=>e.continueSession(x.id,"fixture",()=>{})).toThrow("custody");
 expect(()=>e.admit(ticket(),admission())).toThrow("duplicate");
 s.close();
});

test("broker fixes GitHub destination and QA base and refuses foreign changed paths",async()=>{
 const {mkdtempSync,writeFileSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {deliveryBroker}=await import("../adapters/delivery");
 const dir=mkdtempSync(join(tmpdir(),"factory-broker-"));writeFileSync(join(dir,".factory-delivery.bundle"),"fixture");
 const calls:string[][]=[];let foreign=true;
 const execute=async(args:string[])=>{
  calls.push(args);
  if(args.includes("rev-parse"))return "a".repeat(40);
  if(args.includes("diff"))return foreign ? "outside.ts\n" : ticket().paths[0]+"\n";
  if(args.includes("--min-parents=2"))return "";
  if(args.includes("rev-list"))return "a".repeat(40);
  if(args.includes("list"))return "[]";
  if(args.includes("create"))return "https://github.com/fulmar-hq/alido/pull/1";
  return "";
 };
 const broker=await deliveryBroker({...ticket(),repo:"fulmar-hq/alido"},"a".repeat(64),dir,dir,"b".repeat(40),()=>{},execute);
 try {
  const send=(body:unknown)=>fetch("http://localhost/deliver",{unix:broker.socket,method:"POST",body:JSON.stringify(body)});
  expect((await send({title:"fixture",body:"",repo:"elsewhere/repo"})).status).toBe(400);
  expect((await send({title:"fixture",body:""})).status).toBe(400);
  expect(calls.some(c=>c.includes("push"))).toBe(false);
  foreign=false;
  expect((await send({title:"fixture",body:"refs #1"})).status).toBe(200);
  expect(calls.find(c=>c.includes("push"))).toContain("https://github.com/fulmar-hq/alido.git");
  const pr=calls.find(c=>c.includes("create"))!;
  expect(pr[pr.indexOf("--base")+1]).toBe("QA");expect(pr[pr.indexOf("--repo")+1]).toBe("fulmar-hq/alido");
  expect(calls.some(c=>c.includes("verify-commit"))).toBe(true);
 } finally {broker.close();}
});

test("delivery setup preserves edits and isolates Git metadata and dependencies",async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {prepareDelivery,branchFor}=await import("../adapters/delivery"),{command}=await import("../adapters/github");
 const dir=mkdtempSync(join(tmpdir(),"factory-worktree-")),source=join(dir,"source"),work=join(dir,"work"),id="d".repeat(64);
 mkdirSync(source);mkdirSync(join(source,"node_modules"));writeFileSync(join(source,"node_modules/fixture"),"original dependency");
 const git=(...args:string[])=>command(["git","-C",source,...args]);
 await git("init");await git("config","user.name","Fictional Owner");await git("config","user.email","fictional@example.invalid");
 writeFileSync(join(source,"fixture"),"base");await git("add","fixture");await git("-c","commit.gpgsign=false","commit","-m","fixture");
 await git("worktree","add","-b",branchFor(id),work,"HEAD");
 writeFileSync(join(work,"fixture"),"preserved edit");writeFileSync(join(work,"untracked"),"preserved new file");
 const before=await command(["git","-C",work,"diff","--binary"]),head=(await git("rev-parse","HEAD")).trim();
 await prepareDelivery(work,source,join(dir,"archive"),id);
 expect(await command(["git","-C",work,"diff","--binary"])).toBe(before);
 expect(readFileSync(join(work,"untracked"),"utf8")).toBe("preserved new file");
 expect((await command(["git","-C",work,"rev-parse","HEAD"])).trim()).toBe(head);
 expect(realpathSync(join(work,".git"))).toBe(join(realpathSync(work),".git"));
 writeFileSync(join(work,"node_modules/fixture"),"changed locally");
 expect(readFileSync(join(source,"node_modules/fixture"),"utf8")).toBe("original dependency");
 expect(readFileSync(join(dir,"archive/original-gitfile"),"utf8")).toContain("gitdir:");
});

test("trusted Git receives an immutable private bundle snapshot and refuses symlinks",async()=>{
 const {mkdtempSync,writeFileSync,readFileSync,symlinkSync,mkdirSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {snapshotBundle}=await import("../adapters/delivery");
 const dir=mkdtempSync(join(tmpdir(),"factory-bundle-")),source=join(dir,"worker.bundle"),target=join(dir,"private.bundle");
 writeFileSync(source,"original");snapshotBundle(source,target);writeFileSync(source,"changed");
 expect(readFileSync(target,"utf8")).toBe("original");
 symlinkSync(source,join(dir,"link"));expect(()=>snapshotBundle(join(dir,"link"),join(dir,"refused"))).toThrow();
 mkdirSync(join(dir,"directory"));expect(()=>snapshotBundle(join(dir,"directory"),join(dir,"refused"))).toThrow("regular bundle");
});
