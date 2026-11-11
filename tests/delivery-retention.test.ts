import { test, expect } from "bun:test";
import { Store } from "../tracking/store";
import {TestEngine as Engine} from './fixtures';
import { config, ticket, admission } from "./fixtures";
import { branchFor } from "../adapters/delivery";
import { planDeliveryRetention, archiveDeliveryRetention, verifyPublished, verifyNativeTerminal, verifyProcessCustody,
  filesystemRetentionPort, type Publication, type Inventory, type RetentionPorts, type Context } from "../launcher/delivery-retention";
import type { spawnSync } from "node:child_process";

function fixture(external=false,published=true) {
  const policy=config();policy.projects.demo.repo="fulmar-hq/agent-factory";
  const s=new Store(":memory:"),e=new Engine(s,policy);e.pause(false,"owner");
  const t={...ticket(),repo:"fulmar-hq/agent-factory",model:"gpt-6.1-sol",effort:"medium" as const};
  const x=e.admit(t,admission()),id=x.id,root="/fictional/factory",destination="/fictional/archive",workspace=`${root}/workspaces/${id}`;
  const nativeId="01234567-89ab-cdef-0123-456789abcdef";
  s.db.query("UPDATE sessions SET status='finished',pid=NULL,native_id=? WHERE id=?").run(nativeId,id);
  const publication:Publication={repo:t.repo,branch:branchFor(id),head:"a".repeat(40),tree:"b".repeat(40),url:`https://github.com/${t.repo}/pull/153`};
  const contextPublication={id,...publication};
  if(published)s.event(`publish:${id}`,"launcher-publish",contextPublication,"retain");
  s.event(`workspace:${id}`,"workspace",{id,workspace},"retain");
  s.set(`supervisor:${id}`,"fictional-start-identity");
  s.event(`custody:${id}`,"custody",{id,pid:77,native:nativeId},"retain");
  s.set(`native-evidence:${id}`,{id:nativeId,path:"/fictional/native.jsonl",verified:true});
  s.set(`cleanup-evidence:${id}`,{verified:true,groups:[987]});
  const files=new Map<string,Inventory>([[workspace,{fingerprint:"worker-fingerprint",content:"worker-content",device:1,logicalBytes:1234,allocatedBytes:2048,entries:8}]]);
  const dirs=new Map<string,string[]>([[root,[]],[destination,[]]]),unsafe=new Set<string>(),calls:string[]=[];
  let beforeCustody=()=>{},beforeGithub=()=>{},beforeCopy=()=>{},beforeSync=()=>{};
  const ports:RetentionPorts={
    fs:{canonical:p=>{if(unsafe.has(p))throw Error("symlink/non-canonical path");return p;},
      exists:p=>files.has(p)||dirs.has(p),list:p=>dirs.get(p)??[],inventory:p=>{calls.push(`inventory:${p}`);const value=files.get(p);if(!value)throw Error("missing asset");return {...value};},
      device:()=>external?2:1,directoryIdentity:p=>`${p}:fictional-inode`,writable:()=>{},sync:p=>{beforeSync();calls.push(`sync:${p}`);},
      rename:(from,to)=>{calls.push(`rename:${from}`);files.set(to,{...files.get(from)!});files.delete(from);},
      copy:(from,to)=>{calls.push(`copy:${from}`);beforeCopy();files.set(to,{...files.get(from)!,device:2});}},
    github:async()=>{calls.push("github");beforeGithub();},custody:()=>{calls.push("custody");beforeCustody();},
  };
  const plan=()=>planDeliveryRetention(s,root,id,destination,ports);
  const archive=async()=>{const p=await plan();expect(p.result).toBe("planned");return archiveDeliveryRetention(s,id,p.manifest!.id,ports);};
  const c:Context={supervisor:{pid:77,identity:"fictional-start-identity"},session:{...x,status:"finished",pid:null,native_id:nativeId},workspace,paused:false,publication:contextPublication,
    native:{id:nativeId,path:"/fictional/native.jsonl",verified:true},cleanup:{verified:true,groups:[987]},browserClear:true};
  const transcript=()=>[
    {type:"session_meta",payload:{id:nativeId,cwd:workspace}},
    {type:"turn_context",payload:{model:t.model,effort:t.effort}},
    {type:"event_msg",payload:{type:"task_started"}},
    {type:"event_msg",payload:{type:"task_complete"}},
  ].map(row=>JSON.stringify(row)).join("\n")+"\n";
  return {s,id,root,destination,workspace,publication,files,dirs,unsafe,calls,ports,plan,archive,c,transcript,
    custody:(fn:()=>void)=>{beforeCustody=fn;},github:(fn:()=>void)=>{beforeGithub=fn;},copy:(fn:()=>void)=>{beforeCopy=fn;},sync:(fn:()=>void)=>{beforeSync=fn;}};
}

test("planning requires durable publication first and makes no filesystem mutations",async()=>{
 const f=fixture(false,false);
 expect((await f.plan()).reason).toContain("durable launcher-publish");expect(f.calls).toEqual([]);f.s.close();
});

test("finish plan retains exact evidence, conservative estimates and all controller rows",async()=>{
 const f=fixture(),claims=f.s.rows("debits"),session=f.s.rows("sessions");
 const result=await f.plan();expect(result.result).toBe("planned");
 expect(result.manifest).toMatchObject({estimatedLogicalBytes:1234,estimatedAllocatedBytes:2048,recoveredBytes:0,
   retained:{native:{id:f.c.session.native_id},cleanup:{verified:true},session:{native_id:f.c.session.native_id},publication:f.c.publication}});
 expect(result.manifest!.limitations.join(" ")).toContain("Same-volume");
 expect(f.calls.filter(c=>c.startsWith("copy:")||c.startsWith("rename:"))).toEqual([]);
 expect(f.s.rows("debits")).toEqual(claims);expect(f.s.rows("sessions")).toEqual(session);
 expect(f.s.db.query("SELECT * FROM events WHERE kind='delivery-retention-plan'").all()).toHaveLength(1);f.s.close();
});

for(const mode of ["no destination","overlap","unusable","symlink","outside target exists","source special"])test(`archive planning refuses ${mode}`,async()=>{
 const f=fixture();let dest:string|undefined=f.destination;
 if(mode==="no destination")dest=undefined;
 if(mode==="overlap")dest=f.root+"/archive";
 if(mode==="unusable")f.ports.fs.writable=()=>{throw Error("unmounted/read-only destination");};
 if(mode==="symlink")f.unsafe.add(f.workspace);
 if(mode==="outside target exists")f.files.set(`${f.destination}/${f.id}-0`,f.files.get(f.workspace)!);
 if(mode==="source special")f.ports.fs.inventory=()=>{throw Error("special archive object refused");};
 const r=await planDeliveryRetention(f.s,f.root,f.id,dest,f.ports);expect(r.result).toBe("blocked");expect(r.reason).toBeTruthy();expect(r.recoveredBytes).toBe(0);
 expect(f.files.has(f.workspace)).toBe(true);f.s.close();
});

for(const status of ["running","paused","waiting-browser","unknown","archived"])test(`nonterminal ${status} custody retains everything`,async()=>{
 const f=fixture();f.s.db.query("UPDATE sessions SET status=? WHERE id=?").run(status,f.id);
 expect((await f.plan()).result).toBe("blocked");expect(f.calls).toEqual([]);f.s.close();
});

for(const problem of ["paused factory","supervisor","no native","native mismatch","cleanup unknown","browser live","browser unknown","browser open tab"])test(`${problem} fails closed`,async()=>{
 const f=fixture();
 if(problem==="paused factory")f.s.set("paused",true);
 if(problem==="supervisor")f.s.db.query("UPDATE sessions SET pid=123 WHERE id=?").run(f.id);
 if(problem==="no native")f.s.set(`native-evidence:${f.id}`,null);
 if(problem==="native mismatch")f.s.set(`native-evidence:${f.id}`,{...f.c.native,id:"wrong"});
 if(problem==="cleanup unknown")f.s.set(`cleanup-evidence:${f.id}`,{verified:false});
 if(problem.startsWith("browser"))f.s.set("browser-job:fixture",{parent:f.id,state:problem==="browser live"?"running":"returned",nativePending:problem==="browser unknown",result:{tabClosed:problem!=="browser open tab"}});
 expect((await f.plan()).result).toBe("blocked");expect(f.files.has(f.workspace)).toBe(true);f.s.close();
});

test("publisher check unavailable or changed never creates a plan or runs archive",async()=>{
 const f=fixture();f.github(()=>{throw Error("GitHub unavailable");});
 expect((await f.plan()).reason).toContain("GitHub unavailable");expect(f.s.get(`delivery-retention:${f.id}`)).toBeNull();
 f.github(()=>{});const p=await f.plan();f.github(()=>{throw Error("exact head mismatch");});
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).reason).toContain("exact head mismatch");
 expect(f.files.has(f.workspace)).toBe(true);f.s.close();
});

test("same volume archive preserves complete assets, never claims freed space, and repeats idempotently",async()=>{
 const f=fixture(),original=f.files.get(f.workspace)!,p=await f.plan();
 const run=()=>archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports);
 const first=await run();expect(first.result).toBe("archived");expect(first.recoveredBytes).toBe(0);
 expect(f.files.get(p.manifest!.assets[0].target)).toEqual(original);expect(f.files.has(f.workspace)).toBe(false);
 expect((await run()).result).toBe("archived");expect((await f.plan()).manifest?.id).toBe(p.manifest!.id);
 expect(f.calls.filter(c=>c.startsWith("rename:"))).toHaveLength(1);
 expect(f.s.db.query("SELECT * FROM claims WHERE session=?").all(f.id)).not.toHaveLength(0);f.s.close();
});

test("external volume archive copies retain originals and distinguish estimates from recovered bytes",async()=>{
 const f=fixture(true),p=await f.plan();expect(p.manifest!.assets[0].mode).toBe("copy-retain-source");
 expect(p.manifest!.limitations.join(" ")).toContain("retain originals");
 const run=()=>archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports);
 expect((await run()).result).toBe("archived");expect((await run()).result).toBe("archived");
 expect(f.files.has(f.workspace)).toBe(true);expect(f.calls.filter(c=>c.startsWith("copy:"))).toHaveLength(1);
 expect(p.manifest!.estimatedAllocatedBytes).toBe(2048);expect((await run()).recoveredBytes).toBe(0);f.s.close();
});

test("last GitHub and process rechecks precede archive, including process races after intent",async()=>{
 const f=fixture(),p=await f.plan();f.calls.length=0;let n=0;
 f.custody(()=>{if(++n===2)throw Error("process raced final check");});
 const r=await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports);
 expect(r.result).toBe("blocked");expect(r.reason).toContain("process raced");expect(f.calls.filter(c=>c.startsWith("rename:"))).toEqual([]);
 expect(f.calls.indexOf("github")).toBeLessThan(f.calls.indexOf("custody"));
 f.custody(()=>{});expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).result).toBe("archived");f.s.close();
});

for(const race of ["source changed","target appeared","destination symlink","destination changed","custody paused"])test(`final recheck blocks ${race}`,async()=>{
 const f=fixture(),p=await f.plan();let n=0;
 f.github(()=>{if(++n===2){
  if(race==="source changed")f.files.get(f.workspace)!.fingerprint="changed";
  if(race==="target appeared")f.files.set(p.manifest!.assets[0].target,f.files.get(f.workspace)!);
  if(race==="destination symlink")f.unsafe.add(f.destination);
  if(race==="destination changed")f.ports.fs.directoryIdentity=()=>"different-volume";
  if(race==="custody paused")f.s.set("paused",true);
 }});
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).result).toBe("blocked");
 expect(f.calls.filter(c=>c.startsWith("rename:"))).toEqual([]);f.s.close();
});

test("bounded candidates exclude retained publisher bundle/tests/logs and preserve prior successful archives on partial failure",async()=>{
 const f=fixture(),runs=`${f.root}/runs/delivery/${f.id}`,attempt=`${runs}/initial`,publisher=`${attempt}/publisher`,checkout=`${publisher}/publish-abcdef`;
 f.dirs.set(runs,["initial"]);f.dirs.set(attempt,[]);f.dirs.set(publisher,["incoming-fixture.bundle","tested-tree.json","publish-abcdef"]);
 f.files.set(checkout,{...f.files.get(f.workspace)!,fingerprint:"test-checkout",content:"test-content"});
 const p=await f.plan();expect(p.manifest!.assets.map(a=>a.source)).toEqual([f.workspace,checkout]);
 const original=f.ports.fs.rename;f.ports.fs.rename=(from,to)=>{if(from===checkout)throw Error("archive volume failure");original(from,to);};
 const first=await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports);
 expect(first.result).toBe("blocked");expect(first.completed).toHaveLength(1);expect(f.files.has(checkout)).toBe(true);
 f.ports.fs.rename=original;expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).result).toBe("archived");
 expect(f.calls.filter(c=>c===`rename:${f.workspace}`)).toHaveLength(1);f.s.close();
});

test("interrupted complete move is reconciled from durable intent; sync failure does not lose assets",async()=>{
 const f=fixture(),p=await f.plan();f.sync(()=>{throw Error("disk sync failed");});
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).reason).toContain("disk sync failed");
 expect(f.files.has(p.manifest!.assets[0].target)).toBe(true);f.sync(()=>{});
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).result).toBe("archived");
 expect(f.calls.filter(c=>c.startsWith("rename:"))).toHaveLength(1);f.s.close();
});

test("partial copy retains source and partial archive and refuses an overwrite on retry",async()=>{
 const f=fixture(true),p=await f.plan();
 f.ports.fs.copy=(from,to)=>{f.files.set(to,{...f.files.get(from)!,content:"partial"});throw Error("copy interrupted");};
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).result).toBe("blocked");
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).reason).toContain("partial archive");
 expect(f.files.has(f.workspace)).toBe(true);expect(f.files.get(p.manifest!.assets[0].target)!.content).toBe("partial");f.s.close();
});

test("unknown plan IDs, plan reuse changes and oversized candidate manifests fail closed",async()=>{
 const f=fixture(),p=await f.plan();expect((await archiveDeliveryRetention(f.s,f.id,"wrong",f.ports)).result).toBe("blocked");
 expect((await planDeliveryRetention(f.s,f.root,f.id,"/fictional/other",f.ports)).result).toBe("blocked");f.s.close();
 const g=fixture(),runs=`${g.root}/runs/delivery/${g.id}`;g.dirs.set(runs,Array.from({length:34},(_,i)=>String(i)));
 for(const attempt of g.dirs.get(runs)!){const dir=`${runs}/${attempt}`;g.dirs.set(dir,[]);g.files.set(`${dir}/local-clone`,g.files.get(g.workspace)!);}
 expect((await g.plan()).reason).toContain("bound");g.s.close();
});

function githubProof(p:Publication) {
 return [{ref:`refs/heads/${p.branch}`,object:{type:"commit",sha:p.head}},
   {sha:p.head,commit:{tree:{sha:p.tree},verification:{verified:true,reason:"valid"}}},
   {html_url:p.url,state:"open",head:{sha:p.head,ref:p.branch,repo:{full_name:p.repo}},base:{ref:"main",repo:{full_name:p.repo}}},
   {ref:`refs/heads/${p.branch}`,object:{type:"commit",sha:p.head}}];
}

test("fresh GitHub proof requires exact branch, verified signature/tree and same-repo all-state PR",async()=>{
 const f=fixture(),calls:string[][]=[];
 for(const state of ["open","closed"]) {
  const proof=githubProof(f.publication);proof[2].state=state;
  await verifyPublished(f.publication,async args=>{calls.push(args);return JSON.stringify(proof.shift());});
 }
 expect(calls[0]).toEqual(["gh","api",`repos/${f.publication.repo}/git/ref/heads/${f.publication.branch}`]);f.s.close();
});

for(const problem of ["branch head","tree","signature","PR head","fork","base","URL","unknown state","final branch race","unavailable"])test(`GitHub ${problem} refuses retention`,async()=>{
 const f=fixture(),proof=githubProof(f.publication);
 if(problem==="branch head")proof[0].object!.sha="c".repeat(40);
 if(problem==="tree")proof[1].commit!.tree.sha="c".repeat(40);
 if(problem==="signature")proof[1].commit!.verification.verified=false;
 if(problem==="PR head")proof[2].head!.sha="c".repeat(40);
 if(problem==="fork")proof[2].head!.repo.full_name="fork/repo";
 if(problem==="base")proof[2].base!.ref="other";
 if(problem==="URL")proof[2].html_url+="0";
 if(problem==="unknown state")proof[2].state="unknown";
 if(problem==="final branch race")proof[3].object!.sha="c".repeat(40);
 await expect(verifyPublished(f.publication,async()=>{if(problem==="unavailable")throw Error("network unavailable");return JSON.stringify(proof.shift());})).rejects.toThrow();f.s.close();
});

test("fresh native readback binds ID, cwd, model and terminal tail, rejecting resumed/partial evidence",()=>{
 const f=fixture();expect(()=>verifyNativeTerminal(f.c,f.transcript)).not.toThrow();
 for(const text of [f.transcript().slice(0,-1),f.transcript().replace(f.c.session.native_id!,"wrong"),f.transcript().replace(f.workspace,"/wrong"),
  f.transcript().replace("gpt-6.1-sol","other"),f.transcript()+JSON.stringify({type:"unknown"})+"\n",f.transcript()+JSON.stringify({type:"event_msg",payload:{type:"task_started"}})+"\n"])
  expect(()=>verifyNativeTerminal(f.c,()=>text)).toThrow();f.s.close();
});

function processRun(ps:string[],lsof="p1\ncfixture\nfcwd\nn/elsewhere\n",error=false):typeof spawnSync {
 return ((name:string)=>({status:error?1:0,error:undefined,stdout:name.includes("lsof")?lsof:ps.length>1?ps.shift()!:ps[0],stderr:"",signal:null,pid:1,output:[]})) as unknown as typeof spawnSync;
}

test("process and cwd/open-file ports fail closed on unknown tables and final process race",()=>{
 const f=fixture(),idle="1 0 1 S Tue Nov 10 00:00:00 2026 fixture\n";
 const read=f.transcript;
 expect(()=>verifyProcessCustody(f.c,[f.workspace],processRun([idle]),read)).not.toThrow();
 for(const run of [processRun(["malformed"]),processRun(["77 1 77 S Tue Nov 10 00:00:00 2026 supervisor\n"]),processRun([idle],"",true),processRun([idle],`p9\ncfixture\nfcwd\nn${f.workspace}\n`),
   processRun([idle],`p9\ncfixture\nf3\nn${f.workspace}/node_modules/fixture\n`),
   processRun([idle,`99 1 987 S Tue Nov 10 00:00:00 2026 native\n`]),
   processRun([`99 1 99 S Tue Nov 10 00:00:00 2026 codex resume ${f.c.session.native_id}\n`])])
  expect(()=>verifyProcessCustody(f.c,[f.workspace],run,read)).toThrow();f.s.close();
});


test("filesystem inventory verifies content, metadata and symlink safety without archive mutations",async()=>{
 const fs=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"factory-retention-inventory-"))),source=join(dir,"source");fs.mkdirSync(source);
 fs.writeFileSync(join(source,"fixture"),"retained evidence");fs.symlinkSync("fixture",join(source,"local-link"));
 const io={...fs,renameSync:()=>{throw Error("no live archive");},cpSync:()=>{throw Error("no live copy");}};
 const port=filesystemRetentionPort(io),first=port.inventory(source);
 expect(first.logicalBytes).toBe(17);expect(first.entries).toBe(3);expect(port.inventory(source)).toEqual(first);
 fs.writeFileSync(join(source,"fixture"),"changed evidence");expect(port.inventory(source).content).not.toBe(first.content);
 fs.mkdirSync(join(dir,"outside"));fs.writeFileSync(join(dir,"outside/shared"),"outside");
 fs.symlinkSync("../outside",join(source,"escape"));expect(()=>port.inventory(source)).toThrow("symlink escapes");
 const linked=join(dir,"linked");fs.symlinkSync(source,linked);expect(()=>port.canonical(linked)).toThrow("non-canonical");
 const hardlinks=join(dir,"hardlinks");fs.mkdirSync(hardlinks);fs.linkSync(join(dir,"outside/shared"),join(hardlinks,"shared"));
 expect(()=>port.inventory(hardlinks)).toThrow("shared writable");
});


test("retained manifest corruption cannot redirect an archive operation",async()=>{
 const f=fixture(),p=await f.plan();p.manifest!.assets[0].source="/fictional/somebody-elses-work";
 f.s.set(`delivery-retention:${f.id}`,p.manifest);
 expect((await archiveDeliveryRetention(f.s,f.id,p.manifest!.id,f.ports)).reason).toContain("integrity");
 expect(f.calls.filter(c=>c.startsWith("rename:")||c.startsWith("copy:"))).toEqual([]);f.s.close();
});

test("unknown browser-parent and missing supervisor evidence remain blocked",async()=>{
 const f=fixture();f.s.set(`browser-parent:${f.id}`,{state:"RW"});expect((await f.plan()).result).toBe("blocked");f.s.close();
 const g=fixture();g.s.set(`supervisor:${g.id}`,null);expect((await g.plan()).result).toBe("blocked");g.s.close();
});

for(const lsof of ["p9\ncfixture\nfcwd\n", "p9\ncfixture\nfNOFD\nn/proc/9/fd (opendir: Permission denied)\n", "p9\ncfixture\nf3\nn/elsewhere\n"])test("incomplete lsof custody never authorizes an archive: "+JSON.stringify(lsof), async()=>{
 const f=fixture(),idle="1 0 1 S Tue Nov 10 00:00:00 2026 fixture\n";
 f.ports.custody=c=>verifyProcessCustody(c,[f.workspace],processRun([idle],lsof),f.transcript);
 const result=await f.plan();expect(result.result).toBe("blocked");expect(f.files.has(f.workspace)).toBe(true);expect(f.calls.some(c=>c.startsWith("rename:"))).toBe(false);f.s.close();
});

test("detached local browser check cannot retain a published project copy",async()=>{
 const f=fixture();f.s.set('browser-job:detached',{parent:f.id,detached:true,state:'running',nativePending:true});
 expect((await f.plan()).result).toBe('planned');f.s.close();
});
