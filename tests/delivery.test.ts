import { test, expect } from "bun:test";
import { deliveryRequest } from "../adapters/delivery";
import { turnTokens } from "../launcher/budgets";
import { Store } from "../tracking/store";
import {TestEngine as Engine} from './fixtures';
import { config, ticket, admission } from "./fixtures";

test("publisher refuses retained macOS abort fixtures without changing the snapshot",async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {assertMacCrashSafe,testSnapshot}=await import("../adapters/delivery");
 const checkout=mkdtempSync(join(tmpdir(),"factory-crash-test-")),path=join(checkout,"infra/ci/test_calendar_build_diagnostic.py");
 mkdirSync(join(checkout,"infra/ci"),{recursive:true});writeFileSync(path,"os.abort()");
 const command="python3 -m unittest discover -s infra/ci -p 'test_*.py'";
 expect(()=>assertMacCrashSafe(checkout,command,"darwin")).toThrow("crash-producing");
 expect(()=>assertMacCrashSafe(checkout,"test -d infra/ci && cd infra/ci && python3 -m unittest -v","darwin")).toThrow("crash-producing");
 expect(()=>assertMacCrashSafe(checkout,command,"linux")).not.toThrow();
 expect(()=>assertMacCrashSafe(checkout,"node --version","darwin")).not.toThrow();
 expect(()=>assertMacCrashSafe(checkout,"python3 -m unittest test_other","darwin")).not.toThrow();
 expect(()=>assertMacCrashSafe(checkout,"python3 -m unittest discover -s infra/ci -p test_other.py","darwin")).not.toThrow();
 expect(()=>assertMacCrashSafe(checkout,"python3 -m unittest -v -k other","darwin")).toThrow("crash-producing");
 expect(()=>assertMacCrashSafe(checkout,"cd infra && python3 -m unittest discover -s ci","darwin")).toThrow("crash-producing");
 expect(()=>assertMacCrashSafe(checkout,"test -d . && (cd .factory-tmp && true); python3 -m unittest discover -s infra/ci","darwin")).toThrow("crash-producing");
 if(process.platform==="darwin")await expect(testSnapshot({...ticket(),test:command},checkout,"unused","unused")).rejects.toThrow("crash-producing");
 expect(readFileSync(path,"utf8")).toBe("os.abort()");
 writeFileSync(path,"os.kill(os.getpid(), int(child_signal))");
 expect(()=>assertMacCrashSafe(checkout,command,"darwin")).not.toThrow();
});

test("source command timeout retains an explicit failure diagnostic",async()=>{
 const {command}=await import("../adapters/github");
 await expect(command([process.execPath,"-e","setTimeout(()=>{},10000)"],undefined,50)).rejects.toThrow("timed out after 50ms");
});

test("retained test scratch stays outside the source tree while source edits remain dirty",async()=>{
 const {mkdtempSync,writeFileSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {prepareTestScratch}=await import("../adapters/delivery"),{command}=await import("../adapters/github");
 const dir=mkdtempSync(join(tmpdir(),"factory-test-scratch-"));
 const git=(...args:string[])=>command(["git","-C",dir,...args]);
 await git("init");await git("config","user.name","Fictional");await git("config","user.email","fictional@example.invalid");
 writeFileSync(join(dir,"fixture"),"source");await git("add","fixture");await git("-c","commit.gpgsign=false","commit","-m","fixture");
 const tree=await git("rev-parse","HEAD^{tree}");prepareTestScratch(dir);
 writeFileSync(join(dir,".factory-tmp/test-receipt"),"retained");
 expect((await git("status","--porcelain")).trim()).toBe("");expect(await git("rev-parse","HEAD^{tree}")).toBe(tree);
 writeFileSync(join(dir,"fixture"),"changed");expect((await git("status","--porcelain")).trim()).toBe("M fixture");
 writeFileSync(join(dir,"unexpected"),"changed");expect(await git("status","--porcelain")).toContain("?? unexpected");
});

test("delivery pins fresh QA without changing the source checkout",async()=>{
 const {deliveryBase}=await import("../adapters/delivery");const calls:string[][]=[];
 const sha="a".repeat(40);
 expect(await deliveryBase("/fictional/source","fulmar-hq/alido",async a=>{calls.push(a);return calls.length===1?sha:"";})).toBe(sha);
 expect(calls[0]).toEqual(["gh","api","repos/fulmar-hq/alido/git/ref/heads/QA","--jq",".object.sha"]);
 expect(calls[1].slice(-4)).toEqual(["fetch","--no-tags","https://github.com/fulmar-hq/alido.git",sha]);
 await expect(deliveryBase("/unused","fulmar-hq/alido",async()=>"unknown")).rejects.toThrow("revision unknown");
 await expect(deliveryBase("/unused","elsewhere/repo",async()=>sha)).rejects.toThrow("source refused");
});

test("publisher rejects prose and cannot mask an earlier failed check",async()=>{
 const {executableTest,testShell}=await import("../adapters/delivery");
 for(const prose of ["Review case gates against existing routes/tests and git diff --check","Check configuration/route references and git diff --check","One available local reproduction; verify references and git diff --check"])
  expect(()=>executableTest(prose)).toThrow("executable test");
 for(const command of ["test 1 = 2; test 1 = 1","test 1 = 2 | cat; test 1 = 1"]){
  const p=Bun.spawn(testShell(command),{stdout:"ignore",stderr:"ignore"});
  expect(await p.exited).not.toBe(0);
 }
 const p=Bun.spawn(testShell('HOME="$PWD/.factory-tmp/home" node -e "process.exit(0)"'),{stdout:"ignore",stderr:"ignore"});
 expect(await p.exited).toBe(0);
});

test("prose delivery checks refuse before reservation or native start",async()=>{
 const {launchReady}=await import("../launcher/tick");
 const s=new Store(":memory:"),e=new Engine(s,config());e.pause(false,"owner");
 let calls=0;
 await expect(launchReady(e,{...ticket(),repo:"fulmar-hq/alido",test:"Review sources; git diff --check"},admission(),()=>{calls++;},async()=>{calls++;return "";})).rejects.toThrow("executable test");
 expect(calls).toBe(0);expect(e.sessions()).toHaveLength(0);expect(s.rows("debits")).toHaveLength(0);s.close();
});

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

test("publisher fails closed without native isolation and checks claim before importing",async()=>{
 const {publish}=await import("../adapters/delivery");
 let calls=0;
 const exec=async()=>{calls++;return "";};
 const t={...ticket(),repo:"fulmar-hq/alido"};
 await expect(publish(t,"a".repeat(64),"/unused","/unused","b".repeat(40),{isolationVerified:false,verifyClaim:()=>{},testTree:async()=>({passed:true,tree:""})},exec)).rejects.toThrow("isolation unproven");
 await expect(publish(t,"a".repeat(64),"/unused","/unused","b".repeat(40),{isolationVerified:true,verifyClaim:()=>{throw Error("claim refused");},testTree:async()=>({passed:true,tree:""})},exec)).rejects.toThrow("claim refused");
 expect(calls).toBe(0);
});

test("delivery setup preserves edits and isolates Git metadata and dependencies",async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,symlinkSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {prepareDelivery,branchFor}=await import("../adapters/delivery"),{command}=await import("../adapters/github");
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"factory-worktree-"))),source=join(dir,"source"),work=join(dir,"work"),id="d".repeat(64);
 mkdirSync(source);mkdirSync(join(source,"node_modules"));writeFileSync(join(source,"node_modules/fixture"),"original dependency");symlinkSync(join(source,"node_modules"),join(source,"node_modules/node_modules"));
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
 expect(realpathSync(join(work,"node_modules/node_modules"))).toBe(realpathSync(join(work,"node_modules")));
 expect(readFileSync(join(dir,"archive/original-gitfile"),"utf8")).toContain("gitdir:");
 const {existsSync,readdirSync}=await import('node:fs');
 expect(existsSync(join(dir,'archive/local-clone/fixture'))).toBe(false);
 mkdirSync(join(work,'.factory-tmp'),{recursive:true});
 writeFileSync(join(work,'.factory-tmp/dependencies-evicted.jsonl'),'retained eviction receipt');
 writeFileSync(join(work,'node_modules/result.log'),'retained evidence');
 await prepareDelivery(work,source,join(dir,'archive'),id);
 expect(readFileSync(join(work,'node_modules/fixture'),'utf8')).toBe('original dependency');
 const preserved=readdirSync(join(dir,'archive')).find(p=>p.startsWith('dependency-evidence-'))!;
 expect(readFileSync(join(dir,'archive',preserved,'result.log'),'utf8')).toBe('retained evidence');
 expect(readFileSync(join(work,'fixture'),'utf8')).toBe('preserved edit');
 expect(existsSync(join(work,'.factory-tmp/dependencies-evicted.jsonl'))).toBe(false);
 // Upgrade a dormant parent that already committed before a browser handoff:
 // the incremental bundle must retain those commits after its original base.
 await command(['git','-C',work,'add','fixture']);
 await command(['git','-C',work,'-c','commit.gpgsign=false','commit','-m','retained parent commit']);
 await command(['git','-C',work,'update-ref','-d','refs/factory/base']);
 await prepareDelivery(work,source,join(dir,'archive'),id,head);
 expect((await command(['git','-C',work,'rev-parse','refs/factory/base'])).trim()).toBe(head);
 await command(['git','-C',work,'bundle','create',join(dir,'incremental.bundle'),'HEAD','^refs/factory/base']);


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

test("launcher signs only the tested snapshot and refuses dirty or mismatched receipts",async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,realpathSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {publish}=await import("../adapters/delivery"),{command}=await import("../adapters/github");
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"factory-publish-"))),source=join(dir,"source");mkdirSync(source);
 const git=(...a:string[])=>command(["git","-C",source,...a]);
 await git("init");await git("config","user.name","Fictional");await git("config","user.email","fixture@example.invalid");
 writeFileSync(join(source,"fixture"),"base");await git("add","fixture");await git("-c","commit.gpgsign=false","commit","-m","base");
 const base=(await git("rev-parse","HEAD")).trim();
 writeFileSync(join(source,"fixture"),"tested");await git("add","fixture");await git("-c","commit.gpgsign=false","commit","-m","worker");
 await git("bundle","create",".factory-delivery.bundle","HEAD",`^${base}`);
 const t={...ticket(),repo:"fulmar-hq/alido",paths:["fixture"]},calls:string[][]=[];
 let signed="",testedTree="";
 const execute=async(a:string[])=>{
  calls.push(a);
  if(a.includes("commit-tree")) {testedTree=a[a.indexOf("commit-tree")+2];signed=await command(a.filter(x=>x!=="-S"));return signed;}
  if(a[0]==="gh" && a[1]==="api") {
   if(a[2].includes("git/ref/"))return JSON.stringify({ref:`refs/heads/feat/factory-${"a".repeat(16)}`,object:{type:"commit",sha:signed.trim()}});
   if(a[2].includes("commits/"))return JSON.stringify({sha:signed.trim(),commit:{tree:{sha:testedTree},verification:{verified:true,reason:"valid"}}});
   if(a[2].includes("pulls/"))return JSON.stringify({html_url:"https://github.com/fulmar-hq/alido/pull/1",state:"open",head:{sha:signed.trim(),ref:`feat/factory-${"a".repeat(16)}`,repo:{full_name:t.repo}},base:{ref:"QA",repo:{full_name:t.repo}}});
  }
  if(a.includes("verify-commit") || a.includes("push"))return "";
  if(a.includes("list"))return "[]";
  if(a.includes("create") && a[0]==="gh")return "https://github.com/fulmar-hq/alido/pull/1";
  return command(a);
 };
 let claims=0;
 const result=await publish(t,"a".repeat(64),source,join(dir,"pass"),base,{isolationVerified:true,verifyClaim:()=>{claims++;},testTree:async(checkout,tree)=>{
  expect(await Bun.file(join(checkout,"fixture")).text()).toBe("tested");return {tree,passed:true};
 }},execute,source,join(dir,"source-seeds"));
 expect(claims).toBe(3);expect(calls.find(a=>a.includes("commit-tree"))).toContain("-S");
 expect(calls.find(a=>a.includes("push"))?.at(-1)).toBe(`refs/heads/${result.branch}:refs/heads/${result.branch}`);
 expect((await command(["git","-C",source,"rev-parse","HEAD^{tree}"])).trim()).toBe(result.tree);
 calls.length=0;
 for(const mode of ["failed","mismatch","dirty"]){
  await expect(publish(t,"a".repeat(64),source,join(dir,mode),base,{isolationVerified:true,verifyClaim:()=>{},testTree:async(checkout,tree)=>{
   if(mode==="dirty")writeFileSync(join(checkout,"fixture"),"unreviewed");
   return {tree:mode==="mismatch" ? "0".repeat(40) : tree,passed:mode!=="failed"};
  }},execute,source)).rejects.toThrow("exact tested tree");
 }
 expect(calls.some(a=>a.includes("push"))).toBe(false);expect(calls.some(a=>a.includes("commit-tree"))).toBe(false);
 await expect(publish({...t,paths:["elsewhere"]},"a".repeat(64),source,join(dir,"paths"),base,{isolationVerified:true,verifyClaim:()=>{},testTree:async(_,tree)=>({tree,passed:true})},execute,source)).rejects.toThrow("outside approved scope");
});


test("dependency copies request clone-aware independent files through the filesystem port",async()=>{
 const {copyDependencies}=await import("../adapters/delivery"),{constants}=await import("node:fs");
 let options:unknown;const io={realpathSync:(p:string)=>p,lstatSync:()=>({isSymbolicLink:()=>false,isDirectory:()=>true}),existsSync:()=>false,
   cpSync:(_from:string,_to:string,opts:unknown)=>{options=opts;},readdirSync:()=>[]};
 await copyDependencies("/fictional/source","/fictional/target",io as unknown as Parameters<typeof copyDependencies>[2],async()=>{throw Error("portable copy must not shell out");},"linux");
 const calls:string[][]=[];
 await copyDependencies("/fictional/source","/fictional/target",io as unknown as Parameters<typeof copyDependencies>[2],async args=>{calls.push(args);return "";},"darwin");
 expect(calls).toEqual([["cp","-cR","/fictional/source","/fictional/target"]]);
 expect(options).toMatchObject({mode:constants.COPYFILE_FICLONE,recursive:true,dereference:false,force:false,errorOnExist:true});
});

test("worker refuses hardlinked dependency objects and shared standalone Git alternates",async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,linkSync,readFileSync,realpathSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {verifyDependencyObjects,prepareDelivery,branchFor}=await import("../adapters/delivery"),{command}=await import("../adapters/github");
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"factory-shared-refusal-"))),deps=join(dir,"deps");mkdirSync(deps);
 writeFileSync(join(dir,"shared"),"source");linkSync(join(dir,"shared"),join(deps,"fixture"));
 expect(()=>verifyDependencyObjects(deps)).toThrow("shared writable");
 const source=join(dir,"source"),work=join(dir,"work"),id="e".repeat(64);mkdirSync(source);mkdirSync(join(source,"node_modules"));
 const git=(...args:string[])=>command(["git","-C",source,...args]);
 await git("init");await git("config","user.name","Fictional");await git("config","user.email","fixture@example.invalid");
 writeFileSync(join(source,"fixture"),"base");await git("add","fixture");await git("-c","commit.gpgsign=false","commit","-m","fixture");
 await git("worktree","add","-b",branchFor(id),work,"HEAD");await prepareDelivery(work,source,join(dir,"archive"),id);
 const alternate=join(work,".git/objects/info/alternates");writeFileSync(alternate,join(source,".git/objects"));
 await expect(prepareDelivery(work,source,join(dir,"archive"),id)).rejects.toThrow("standalone worker Git");
 expect(readFileSync(alternate,"utf8")).toBe(join(source,".git/objects"));
});

test('standalone copy-on-write clone has no live alternates and mutations never change source objects',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,chmodSync,realpathSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {cloneStandalone}=await import('../adapters/delivery'),{command}=await import('../adapters/github');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'factory-object-copy-'))),source=join(dir,'source'),target=join(dir,'copy');mkdirSync(source);
 const git=(...args:string[])=>command(['git','-C',source,...args]);
 await git('init');writeFileSync(join(source,'fixture'),'retained');await git('add','fixture');
 await git('-c','user.name=Fictional','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');
 const sha=(await git('rev-parse','HEAD')).trim();
 await cloneStandalone(source,target);
 expect(existsSync(join(target,'.git/objects/info/alternates'))).toBe(false);
 expect((await command(['git','-C',target,'rev-parse','HEAD'])).trim()).toBe(sha);
 const object=join(sha.slice(0,2),sha.slice(2)),original=join(source,'.git/objects',object),copied=join(target,'.git/objects',object);
 const before=readFileSync(original);expect(lstatSync(copied).nlink).toBe(1);expect(lstatSync(copied).ino).not.toBe(lstatSync(original).ino);
 chmodSync(copied,0o600);writeFileSync(copied,'changed only in disposable test clone');expect(readFileSync(original)).toEqual(before);
 expect((await git('cat-file','-t',sha)).trim()).toBe('commit');
 // A source that itself depends on external objects is never copied as standalone.
 writeFileSync(join(source,'.git/objects/info/alternates'),'/fictional/other/objects');
 if(process.platform==='darwin')await expect(cloneStandalone(source,join(dir,'refused'))).rejects.toThrow('standalone source');
});

test('source seeds preserve immutable baselines and give each consumer independent files',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {materializeTree}=await import('../adapters/delivery'),{command}=await import('../adapters/github');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'factory-source-seed-'))),source=join(dir,'original'),seeds=join(dir,'seeds');mkdirSync(source);
 const git=(where:string,...args:string[])=>command(['git','-C',where,...args]);
 await git(source,'init');writeFileSync(join(source,'fixture'),'committed baseline');await git(source,'add','fixture');
 await git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','fixture');
 const base=(await git(source,'rev-parse','HEAD')).trim();writeFileSync(join(source,'fixture'),'private dirty original');
 for(const name of ['one','two']) {
  const target=join(dir,name);await git(source,'worktree','add','--detach','--no-checkout',target,base);
  await materializeTree(source,target,base,seeds);
  expect(readFileSync(join(target,'fixture'),'utf8')).toBe('committed baseline');
  expect((await git(target,'status','--porcelain')).trim()).toBe('');
  expect(lstatSync(join(target,'fixture')).nlink).toBe(1);
  writeFileSync(join(target,'fixture'),'independent consumer edit');
 }
 expect(readFileSync(join(source,'fixture'),'utf8')).toBe('private dirty original');
 expect(readFileSync(join(seeds,base,'source/fixture'),'utf8')).toBe('committed baseline');
 writeFileSync(join(seeds,base,'source/fixture'),'changed seed');
 const refused=join(dir,'refused');await git(source,'worktree','add','--detach','--no-checkout',refused,base);
 await expect(materializeTree(source,refused,base,seeds)).rejects.toThrow('source seed custody incomplete');
});
