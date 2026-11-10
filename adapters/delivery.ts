import { existsSync, renameSync, mkdirSync, realpathSync, openSync, closeSync, readSync, writeSync, constants, fstatSync, readdirSync, readlinkSync, symlinkSync, appendFileSync, readFileSync, cpSync, lstatSync } from "node:fs";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import { command } from "./github";
import type { Ticket } from "../launcher/config";

// Preserve and replace dependency links that still point to the source install.
// Never widen filesystem reads to make a copied dependency layout work.
export function localizeDependencies(workspace:string, source:string, archive:string) {
  const deps=join(workspace,"node_modules"), installed=join(source,"node_modules");
  const visit=(dir:string)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name);
      if(entry.isSymbolicLink()) {
        const target=readlinkSync(path);
        if(!isAbsolute(target)) {
          const tail=relative(deps,resolve(dirname(path),target));
          if(tail.startsWith("..") || isAbsolute(tail))throw Error("dependency link escapes copied install");
          continue;
        }
        const tail=relative(installed,target);
        if(tail.startsWith("..") || isAbsolute(tail))throw Error("dependency link escapes installed dependencies");
        const saved=join(archive,"dependency-links",relative(deps,path));
        mkdirSync(dirname(saved),{recursive:true,mode:0o700});
        renameSync(path,saved);
        symlinkSync(relative(dirname(path),join(deps,tail)) || ".",path);
      } else if(entry.isDirectory())visit(path);
    }
  };
  visit(deps);
  const verify=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isSymbolicLink()) {
      const tail=relative(deps,realpathSync(path));
      if(tail.startsWith("..") || isAbsolute(tail))throw Error("dependency link resolves outside copied install");
    } else if(entry.isDirectory())verify(path);
  }};verify(deps);
}

// Native macOS cp requests APFS copy-on-write; portable COPYFILE_FICLONE
// falls back to an ordinary independent copy on other filesystems. Never use hardlinks/shared Git objects.
export async function copyDependencies(source:string, target:string, io = {cpSync,lstatSync,readdirSync,realpathSync,existsSync}, execute=command, platform:NodeJS.Platform=process.platform) {
  if(io.realpathSync(source)!==resolve(source) || io.lstatSync(source).isSymbolicLink())throw Error("dependency root must be local");
  if(io.existsSync(target))throw Error("dependency copy target already exists");
  if(platform==="darwin")await execute(["cp","-cR",source,target]);
  else io.cpSync(source,target,{recursive:true,mode:constants.COPYFILE_FICLONE,
    dereference:false,verbatimSymlinks:true,force:false,errorOnExist:true});
  verifyDependencyObjects(target,io);
}
export function verifyDependencyObjects(target:string, io = {lstatSync,readdirSync,realpathSync}) {
  if(!io.lstatSync(target).isDirectory() || io.realpathSync(target)!==resolve(target))throw Error("shared dependency root refused");
  const visit=(dir:string)=>{
    for(const entry of io.readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name),stat=io.lstatSync(path);
      if(stat.isDirectory())visit(path);
      else if(stat.isFile() && stat.nlink!==1)throw Error("shared writable dependency object refused");
      else if(!stat.isFile() && !stat.isSymbolicLink())throw Error("special dependency object refused");
    }
  };
  visit(target);
}

export const deliveryRepo = "fulmar-hq/alido";
export const isDeliveryRepo = (repo:string) => [deliveryRepo,"fulmar-hq/agent-factory"].includes(repo);
export const branchFor = (id:string) => `feat/factory-${id.slice(0,16)}`;
export async function deliveryBase(source:string, repo:string, execute=command) {
  if(!isDeliveryRepo(repo))throw Error("delivery source refused");
  const sha=(await execute(["gh","api",`repos/${repo}/git/ref/heads/${repo===deliveryRepo ? "QA" : "main"}`,"--jq",".object.sha"])).trim();
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error("current QA revision unknown");
  // Fetch the immutable object, never reset a user's checkout or depend on the
  // shared FETCH_HEAD, which another concurrent fetch could replace.
  await execute(["git","-C",source,"-c","credential.helper=","-c","credential.https://github.com.helper=!gh auth git-credential","fetch","--no-tags",`https://github.com/${repo}.git`,sha]);
  return sha;
}
// The intake test is an executable command, not acceptance prose. Keep the
// approved command exact; owners must approve a new digest to change it.
export function executableTest(test:string) {
  if (!/^(?:[A-Z_][A-Z_0-9]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)\s+)*(?:bun|node|git|python3|test|\/[^\s]+)(?:\s|$)/.test(test.trim()))
    throw Error("executable test command required; reapprove intake with acceptance prose in outcome");
  return test;
}
export const testShell = (test:string) => ["/bin/bash","-e","-o","pipefail","-c",executableTest(test)];
// Retained snapshots may predate the macOS-safe diagnostic test. Refuse the
// known crashing suite rather than changing a frozen tree or skipping a test.
export function assertMacCrashSafe(checkout:string, test:string, platform:NodeJS.Platform=process.platform) {
  if(platform!=="darwin")return;
  const path=join(checkout,"infra/ci/test_calendar_build_diagnostic.py");
  if(!existsSync(path) || !readFileSync(path,"utf8").includes("os.abort()"))return;
  const refuse=()=>{throw Error("macOS crash-producing diagnostic test refused; approve the SIGTERM-on-macOS test repair before retrying this frozen snapshot");};
  if(/test_calendar_build_diagnostic/.test(test))refuse();
  for(const match of test.matchAll(/\bunittest\b([^;&|]*)/g)) {
    let cwd=checkout;
    for(const cd of test.slice(0,match.index).matchAll(/\bcd\s+([^\s;&|]+)/g)) {
      const value=cd[1]!.replace(/^['"]|['"]$/g,"");if(!/^[A-Za-z0-9_./-]+$/.test(value))refuse();cwd=resolve(cwd,value);
    }
    const args=match[1]!.trim().split(/\s+/).filter(Boolean).map(s=>s.replace(/^['"]|['"]$/g,""));
    let discovery=false,start=cwd,pattern="test*.py";const names:string[]=[];
    for(let i=0;i<args.length;i++) {
      const arg=args[i]!;if(arg==="discover"){discovery=true;continue;}
      if(["-v","-q","-f","-b","-c","--verbose","--quiet","--failfast","--buffer","--catch","--locals"].includes(arg))continue;
      if(arg==="-k"){if(!args[++i])refuse();continue;}
      if(["-s","--start-directory","-p","--pattern","-t","--top-level-directory"].includes(arg)) {
        const value=args[++i];if(!value || !/^[A-Za-z0-9_./*?\[\]-]+$/.test(value))refuse();
        if(arg==="-s"||arg==="--start-directory")start=resolve(cwd,value!);else if(arg==="-p"||arg==="--pattern")pattern=value!;continue;
      }
      if(!/^[A-Za-z0-9_./]+$/.test(arg))refuse();names.push(arg);
    }
    if(!discovery&&names.length)continue;
    const tail=relative(start,path);if(!tail.startsWith("..")&&!isAbsolute(tail)&&new Bun.Glob(pattern).match("test_calendar_build_diagnostic.py"))refuse();
  }
  // Other test runners are unresolved collection unless explicitly scoped to files.
  for(const match of test.matchAll(/\bpytest\b([^;&|]*)/g)) {
    const paths=match[1]!.trim().split(/\s+/).filter(s=>s&&!s.startsWith("-"));
    if(!paths.length||paths.some(p=>!p.endsWith(".py")||!/^[A-Za-z0-9_./]+$/.test(p)))refuse();
  }
}
export function prepareTestScratch(checkout:string) {
  mkdirSync(join(checkout,".factory-tmp"),{recursive:true});
  appendFileSync(join(checkout,".git/info/exclude"),"\n.factory-tmp/\n");
}
// Trusted setup runs before model tools. No shared writable Git metadata or
// dependency symlinks into another checkout. Original gitfile stays archived.
export async function prepareDelivery(workspace:string, source:string, archive:string, id:string) {
  mkdirSync(archive,{recursive:true,mode:0o700});
  workspace=realpathSync(workspace);
  const git = (...args:string[]) => command(["git","-C",workspace,...args]);
  if (!existsSync(join(workspace,".git/HEAD"))) {
    const head=(await git("rev-parse","HEAD")).trim();
    const branch=(await git("branch","--show-current")).trim();
    if (branch !== branchFor(id)) throw Error("worker branch mismatch");
    const clone=join(archive,"local-clone");
    await command(["git","clone","--no-hardlinks","--no-checkout",source,clone]);
    await command(["git","-C",clone,"checkout","-b",branch,head]);
    renameSync(join(workspace,".git"),join(archive,"original-gitfile"));
    renameSync(join(clone,".git"),join(workspace,".git"));
  }
  if (!existsSync(join(workspace,"node_modules"))) {
    if (!existsSync(join(source,"node_modules"))) throw Error("installed dependencies missing");
    await copyDependencies(join(source,"node_modules"),join(workspace,"node_modules"));
  }
  verifyDependencyObjects(join(workspace,"node_modules"));
  localizeDependencies(workspace,source,archive);
  const metadata=join(workspace,".git");
  if(realpathSync(metadata)!==metadata || existsSync(join(metadata,"commondir")) || existsSync(join(metadata,"objects/info/alternates")))throw Error("standalone worker Git required");
  const checkGit=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name),stat=lstatSync(path);
    if(stat.isSymbolicLink() || (stat.isFile() && stat.nlink!==1))throw Error("shared writable worker Git object refused");
    if(stat.isDirectory())checkGit(path);
  }};checkGit(metadata);
  if((await git("branch","--show-current")).trim()!==branchFor(id))throw Error("worker branch mismatch");
  const exclude=join(workspace,".git/info/exclude");
  const {appendFileSync}=await import("node:fs");
  appendFileSync(exclude,"\n.factory-tmp/\n.factory-delivery.bundle\n");
  for (const [key,value] of [
    ["user.name","Vincent Messina"], ["user.email","72951696+vincentmessina@users.noreply.github.com"],
    ["commit.gpgsign","false"], ["core.hooksPath","/dev/null"], ["core.excludesFile","/dev/null"],
  ]) await git("config","--local",key,value);
}

// Snapshot through a non-following descriptor before trusted Git reads the
// bundle. Workers can modify their workspace while this broker is awaiting I/O.
export function snapshotBundle(source:string, target:string) {
  const input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let output:number|undefined;
  try {
    if(!fstatSync(input).isFile())throw Error("regular bundle required");
    output=openSync(target,"wx",0o600);
    const chunk=Buffer.alloc(1024*1024);let total=0,n:number;
    while((n=readSync(input,chunk,0,chunk.length,null))>0) {
      total+=n;if(total>1024*1024*1024)throw Error("bundle exceeds 1 GiB");
      let offset=0;while(offset<n)offset+=writeSync(output,chunk,offset,n-offset);
    }
  } finally {closeSync(input);if(output!==undefined)closeSync(output);}
}

export function deliveryRequest(raw:unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid delivery request");
  const r=raw as Record<string,unknown>;
  if (Object.keys(r).sort().join(",") !== "body,title" || typeof r.title !== "string" || typeof r.body !== "string" || !r.title.trim() || r.title.length>200 || r.body.length>20000) throw Error("title and body only");
  return {title:r.title,body:r.body};
}
// No worker-facing publisher socket. The launcher calls PUBLISH after verified
// cleanup and re-tests a private snapshot. Hooks and worker Git config never run
// in the trusted publisher. Failure at any gate retains the snapshot, no push.
export type PublishAuthority = {
  verifyClaim: () => void;
  testTree: (checkout:string, tree:string) => Promise<{tree:string; passed:boolean}>;
  isolationVerified: boolean;
};
export async function publish(t:Ticket, id:string, workspace:string, dir:string, baseline:string,
  authority:PublishAuthority, execute=command, trustedSource=workspace) {
  if (!authority.isolationVerified) throw Error("publisher blocked: isolation unproven");
  if (![deliveryRepo,"fulmar-hq/agent-factory"].includes(t.repo) || !/^[a-f0-9]{40}$/.test(baseline)) throw Error("publisher destination/base refused");
  authority.verifyClaim();
  const branch=branchFor(id);
  if (!/^(feat|fix)\/[a-zA-Z0-9/-]+$/.test(branch)) throw Error("publisher branch refused");
  mkdirSync(dir,{recursive:true,mode:0o700});
  const snapshot=join(dir,`incoming-${crypto.randomUUID()}.bundle`);
  snapshotBundle(join(workspace,".factory-delivery.bundle"),snapshot);
  const checkout=join(dir,`publish-${crypto.randomUUID()}`);
  await execute(["git","-c","core.hooksPath=/dev/null","clone","--no-hardlinks","--no-checkout",trustedSource,checkout]);
  const git=(...args:string[])=>execute(["git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","user.name=Vincent Messina","-c","user.email=72951696+vincentmessina@users.noreply.github.com","-c","core.attributesFile=/dev/null","-C",checkout,...args]);
  await git("config","core.hooksPath","/dev/null");
  await git("fetch","--no-tags",snapshot,"HEAD");
  const head=(await git("rev-parse","FETCH_HEAD")).trim();
  await git("merge-base","--is-ancestor",baseline,head);
  // Exact expected base, no alternate parent, merge, or concealed intermediate edit.
  const roots=(await git("rev-list","--reverse",`${baseline}..${head}`)).trim().split("\n").filter(Boolean);
  if (!roots.length) throw Error("empty delivery");
  let parent=baseline;
  for(const sha of roots) {
    if ((await git("show","-s","--format=%P",sha)).trim()!==parent) throw Error("unexpected delivery base/parents");
    const paths=(await git("diff-tree","--no-commit-id","--name-only","-r",sha)).trim().split("\n").filter(Boolean);
    if(paths.some(p=>!t.paths.includes(p)))throw Error("commit paths outside approved scope");
    parent=sha;
  }
  const changed=(await git("diff","--name-only",baseline,head)).trim().split("\n").filter(Boolean);
  if(!changed.length || changed.some(p=>!t.paths.includes(p)))throw Error("delivery paths outside approved scope");
  await git("checkout","--detach",head);
  if((await git("status","--porcelain")).trim())throw Error("publisher checkout not clean");
  const tree=(await git("rev-parse","HEAD^{tree}")).trim();
  const tests=await authority.testTree(checkout,tree);
  if(!tests.passed || tests.tree!==tree || (await git("rev-parse","HEAD^{tree}")).trim()!==tree || (await git("status","--porcelain")).trim())throw Error(`exact tested tree required; inspect ${join(dir,"tested-tree.json")}`);
  authority.verifyClaim();
  // Squash only the tested tree onto the authorized base. Only this launcher
  // command can contact the signing agent; no worker-supplied hooks or argv.
  const signed=(await git("-c","gpg.format=ssh","-c",`user.signingkey=${join(process.env.HOME!,".ssh/fisher_commit_signing_ed25519.pub")}`,
    "commit-tree","-S",tree,"-p",baseline,"-m",`factory: ${t.title} (refs #${t.number})`)).trim();
  await git("-c",`gpg.ssh.allowedSignersFile=${join(process.env.HOME!,".ssh/fisher_allowed_signers")}`,"verify-commit",signed);
  if((await git("rev-parse",`${signed}^{tree}`)).trim()!==tree)throw Error("signed tree changed");
  await git("update-ref",`refs/heads/${branch}`,signed);
  authority.verifyClaim();
  await git("-c","credential.helper=","-c","credential.https://github.com.helper=!gh auth git-credential","push",`https://github.com/${t.repo}.git`,`refs/heads/${branch}:refs/heads/${branch}`);
  const base=t.repo===deliveryRepo ? "QA" : "main";
  const existing=JSON.parse(await execute(["gh","pr","list","--repo",t.repo,"--head",branch,"--base",base,"--json","url"]));
  const url=existing[0]?.url ?? (await execute(["gh","pr","create","--repo",t.repo,"--base",base,"--head",branch,"--title",t.title,"--body",`refs #${t.number}\nLauncher tested tree: ${tree}\nLauncher signed commit: ${signed}`])).trim();
  const result={head:signed,tree,url,branch,repo:t.repo};
  const {verifyPublished}=await import("../launcher/delivery-retention");
  await verifyPublished(result,execute);
  return result;
}

// Tests run in the worker boundary, never with launcher credentials. The caller
// checks clean status and the tree again after this process exits.
export async function testSnapshot(t:Ticket, checkout:string, tree:string, source:string) {
  executableTest(t.test);
  assertMacCrashSafe(checkout,t.test);
  const {workerSpec}=await import("./workers");
  if(existsSync(join(source,"node_modules"))) {
    await copyDependencies(join(source,"node_modules"),join(checkout,"node_modules"));
    localizeDependencies(checkout,source,join(dirname(checkout),"test-dependency-archive"));
  }
  // Tests retain scratch receipts (including Vitest's local token). They are
  // declared non-source assets, just as in the prepared worker checkout.
  prepareTestScratch(checkout);
  const spec=workerSpec(t,checkout);
  const overrides=spec.argv.flatMap((a,i)=>a==="-c"?[a,spec.argv[i+1]]:[]);
  const p=Bun.spawn(["codex","sandbox",...overrides,"-P","factory","-C",checkout,...testShell(t.test)],{cwd:checkout,env:spec.env,stdout:"pipe",stderr:"pipe",stdin:"ignore"});
  const timer=setTimeout(()=>p.kill(),600000);
  try {
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    const {writeFileSync}=await import("node:fs");
    writeFileSync(join(dirname(checkout),"tested-tree.json"),JSON.stringify({tree,command:t.test,code,out,err,at:Date.now()}),{flag:"wx",mode:0o600});
    return {tree,passed:code===0};
  } finally {clearTimeout(timer);}
}
