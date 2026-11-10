import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { command } from "../adapters/github";
import { branchFor, isDeliveryRepo } from "../adapters/delivery";
import type { Store } from "../tracking/store";
import type { Session } from "./engine";

export type Publication = {repo:string; branch:string; head:string; tree:string; url:string};
const sha = (s:unknown):s is string => typeof s==="string" && /^[a-f0-9]{40}$/.test(s);
const digest = (v:unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const inside = (root:string,path:string) => path===root || (!relative(root,path).startsWith("..") && !isAbsolute(relative(root,path)));
const undo = "Retain manifests, bundles, logs, tests, native receipts, claims and debit history; restore archived paths only after custody reconciliation";

// Fresh authenticated readback, including merged/closed PRs. A signed commit at
// another head, a fork, another base or a matching branch name is insufficient.
export async function verifyPublished(p:Publication, execute=command) {
  if(!isDeliveryRepo(p.repo) || !sha(p.head) || !sha(p.tree) || !/^feat\/factory-[a-f0-9]{16}$/.test(p.branch))throw Error("publication identity refused");
  const prefix=`https://github.com/${p.repo}/pull/`;
  if(!p.url.startsWith(prefix) || !/^[1-9][0-9]*$/.test(p.url.slice(prefix.length)))throw Error("publication PR URL refused");
  const api=async(path:string)=>JSON.parse(await execute(["gh","api",`repos/${p.repo}/${path}`]));
  const ref=await api(`git/ref/heads/${p.branch}`);
  const commit=await api(`commits/${p.head}`);
  const pr=await api(`pulls/${p.url.slice(prefix.length)}`);
  if(ref.ref!==`refs/heads/${p.branch}` || ref.object?.type!=="commit" || ref.object?.sha!==p.head ||
    commit.sha!==p.head || commit.commit?.tree?.sha!==p.tree || commit.commit?.verification?.verified!==true ||
    commit.commit?.verification?.reason!=="valid" || pr.html_url!==p.url ||
    pr.head?.sha!==p.head || pr.head?.ref!==p.branch || pr.head?.repo?.full_name!==p.repo ||
    pr.base?.ref!==(p.repo==="fulmar-hq/alido" ? "QA" : "main") || pr.base?.repo?.full_name!==p.repo ||
    !["open","closed"].includes(pr.state))throw Error("GitHub branch/PR/signed tree proof mismatch");
  const finalRef=await api(`git/ref/heads/${p.branch}`);
  if(finalRef.ref!==ref.ref || finalRef.object?.type!=="commit" || finalRef.object?.sha!==p.head)throw Error("GitHub branch changed during final recheck");
}

export type Inventory = {fingerprint:string; content:string; device:number; logicalBytes:number; allocatedBytes:number; entries:number};
export type RetentionFS = {
  canonical:(path:string)=>string;
  exists:(path:string)=>boolean;
  list:(path:string)=>string[];
  inventory:(path:string)=>Inventory;
  device:(path:string)=>number;
  directoryIdentity:(path:string)=>string;
  writable:(path:string)=>void;
  rename:(from:string,to:string)=>void;
  copy:(from:string,to:string)=>void;
  sync:(path:string)=>void;
};
// Fixed bounds apply to both preview and execution. No special files, external
// symlink targets or hardlinked writable objects can enter an archive operation.
export function filesystemRetentionPort(io=fs):RetentionFS {
 const port:RetentionFS = {
  canonical(path) {
    if(!isAbsolute(path) || resolve(path)!==path || io.realpathSync(path)!==path || io.lstatSync(path).isSymbolicLink())throw Error(`non-canonical archive path: ${path}`);
    return path;
  },
  exists:path=>{try{io.lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}},
  list:path=>io.readdirSync(path),
  device:path=>io.lstatSync(path).dev,
  directoryIdentity:path=>{const s=io.lstatSync(path);if(!s.isDirectory())throw Error("archive directory required");return `${s.dev}:${s.ino}`;},
  writable:path=>{if(!io.lstatSync(path).isDirectory())throw Error("archive destination is not a directory");io.accessSync(path,io.constants.W_OK|io.constants.X_OK);},
  inventory(root) {
    port.canonical(root);
    const identity=createHash("sha256"),content=createHash("sha256");
    let entries=0,logicalBytes=0,allocatedBytes=0;
    const visit=(path:string)=>{
      if(++entries>150000)throw Error("archive inventory entry bound exceeded");
      const s=io.lstatSync(path),name=relative(root,path);
      identity.update(JSON.stringify([name,s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs]));
      content.update(JSON.stringify([name,s.mode]));
      if(s.isSymbolicLink()) {
        const target=io.readlinkSync(path);
        if(isAbsolute(target) || !inside(root,io.realpathSync(path)))throw Error("archive symlink escapes asset");
        content.update(target);
      } else if(s.isDirectory()) {
        for(const name of io.readdirSync(path).sort())visit(join(path,name));
      } else if(s.isFile()) {
        if(s.nlink!==1)throw Error("shared writable archive object refused");
        logicalBytes+=s.size;allocatedBytes+=s.blocks*512;
        if(logicalBytes>20*1024**3)throw Error("archive byte bound exceeded");
        const fd=io.openSync(path,io.constants.O_RDONLY|io.constants.O_NOFOLLOW|io.constants.O_NONBLOCK);
        try {
          const pinned=io.fstatSync(fd);
          if(pinned.dev!==s.dev || pinned.ino!==s.ino || !pinned.isFile())throw Error("archive file raced inventory");
          const hash=createHash("sha256"),buf=Buffer.alloc(1024*1024);let n:number,read=0;
          while((n=io.readSync(fd,buf))>0){read+=n;if(read>s.size)throw Error("archive file grew");hash.update(buf.subarray(0,n));}
          const after=io.fstatSync(fd);
          if(read!==s.size || after.mtimeMs!==s.mtimeMs || after.ctimeMs!==s.ctimeMs)throw Error("archive file changed");
          content.update(hash.digest());
        } finally {io.closeSync(fd);}
      } else throw Error("special archive object refused");
      const after=io.lstatSync(path);
      if(after.ino!==s.ino || after.dev!==s.dev || after.mtimeMs!==s.mtimeMs || after.ctimeMs!==s.ctimeMs)throw Error("archive path raced inventory");
    };
    visit(root);
    return {fingerprint:identity.digest("hex"),content:content.digest("hex"),device:io.lstatSync(root).dev,logicalBytes,allocatedBytes,entries};
  },
  rename:(from,to)=>io.renameSync(from,to),
  copy:(from,to)=>io.cpSync(from,to,{recursive:true,verbatimSymlinks:true,dereference:false,preserveTimestamps:true,
    mode:io.constants.COPYFILE_FICLONE,force:false,errorOnExist:true}),
  sync(path) {
    // Flush regular archive files, then directories, before recording completion.
    const visit=(p:string)=>{const s=io.lstatSync(p);if(s.isSymbolicLink())return;
      if(s.isDirectory())for(const name of io.readdirSync(p))visit(join(p,name));
      const fd=io.openSync(p,io.constants.O_RDONLY|io.constants.O_NOFOLLOW);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}
    };visit(path);const fd=io.openSync(dirname(path),io.constants.O_RDONLY);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}
  },
};
 return port;
}
export const retentionFS=filesystemRetentionPort();

export type Context = {session:Session; workspace:string; supervisor:{pid:number;identity:string}; planning?:boolean; paused:boolean; publication:Publication; native: {id?:string;verified?:boolean;path?:string};
  cleanup:{verified?:boolean;groups?:number[]}; browserClear:boolean};
export type RetentionPorts = {
  fs:RetentionFS;
  github:(publication:Publication)=>Promise<void>;
  // Must synchronously read native/process identity, cwd and open-file custody;
  // unavailable or partial tables throw. Called again with no await before I/O.
  custody:(context:Context,paths:string[])=>void;
};
export type Manifest = {version:1; id:string; session:string; publication:Publication; destination:string; destinationIdentity:string;
  assets:{source:string; target:string; inventory:Inventory; mode:"rename"|"copy-retain-source"}[];
  estimatedLogicalBytes:number; estimatedAllocatedBytes:number; recoveredBytes:0; limitations:string[]; retained:unknown};
export type RetentionResult = {result:"planned"|"archived"|"blocked"; reason?:string; manifest?:Manifest; recoveredBytes:0; completed:string[]};
const key=(id:string)=>`delivery-retention:${id}`;

function context(s:Store,id:string):Context {
  const session=s.db.query("SELECT * FROM sessions WHERE id=?").get(id) as Session|null;
  const event=s.db.query("SELECT data FROM events WHERE id=? AND kind='launcher-publish'").get(`publish:${id}`) as {data:string}|null;
  if(!session || !event)throw Error("durable launcher-publish evidence required");
  const publication=JSON.parse(event.data) as Publication & {id:string};
  const workspaceEvent=s.db.query("SELECT data FROM events WHERE id=? AND kind='workspace'").get(`workspace:${id}`) as {data:string}|null;
  const workspace=workspaceEvent ? JSON.parse(workspaceEvent.data).workspace : null;
  const custody=s.db.query("SELECT data FROM events WHERE kind='custody' AND json_extract(data,'$.id')=? ORDER BY at DESC,rowid DESC LIMIT 1").get(id) as {data:string}|null;
  const supervisorPid=custody ? JSON.parse(custody.data).pid : null;
  const supervisorIdentity=s.get<string>(`supervisor:${id}`);
  const native=s.get<Context["native"]>(`native-evidence:${id}`),cleanup=s.get<Context["cleanup"]>(`cleanup-evidence:${id}`);
  const parent=s.get<{state?:string;custodyBlocked?:boolean}>(`browser-parent:${id}`);
  const jobs=(s.db.query("SELECT value FROM kv WHERE key LIKE 'browser-job:%'").all() as {value:string}[]).map(x=>JSON.parse(x.value));
  if(publication.id!==id || publication.branch!==branchFor(id) || publication.repo!==JSON.parse(session.brief).repo ||
    !Number.isSafeInteger(supervisorPid) || supervisorPid<1 || (typeof supervisorIdentity!=="string" || !supervisorIdentity) || typeof workspace!=="string" || !isAbsolute(workspace) || session.provider!=="codex" || session.status!=="finished" || session.pid!==null || !session.native_id || s.get("paused")!==false ||
    native?.verified!==true || native.id!==session.native_id || !native.path || cleanup?.verified!==true || !Array.isArray(cleanup.groups) || !cleanup.groups.length || cleanup.groups.some(group=>!Number.isSafeInteger(group) || group<1) ||
    (parent && (parent.state!=="returned" || parent.custodyBlocked)) ||
    jobs.some(j=>j.parent===id && (j.state!=="returned" || j.nativePending || j.fallbackPending || j.result?.tabClosed!==true || !["done","blocked","not done"].includes(j.result?.status))))
    throw Error("terminal native/process/browser custody unresolved or paused");
  return {session,workspace,supervisor:{pid:supervisorPid,identity:supervisorIdentity},paused:false,publication,native,cleanup,browserClear:true};
}

// A complete ps table pins observed groups and exact native IDs. lsof's machine
// output includes cwd, executable mappings and all open files system-wide. Exit
// errors/permission diagnostics/empty or malformed output are never absence proof.
export function verifyNativeTerminal(c:Context, read=(path:string)=>{
  retentionFS.canonical(path);
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile() || before.size>64*1024*1024)throw Error("bounded native transcript required");
    const bytes=Buffer.alloc(before.size+1);let length=0,n:number;
    while(length<bytes.length && (n=fs.readSync(fd,bytes,length,bytes.length-length,null))>0)length+=n;
    const text=bytes.subarray(0,length).toString("utf8"),after=fs.fstatSync(fd);
    if(length!==before.size)throw Error("native transcript changed during bounded readback");
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)throw Error("native transcript raced readback");
    return text;
  } finally {fs.closeSync(fd);}
}) {
  const text=read(c.native.path!);
  if(!text.endsWith("\n"))throw Error("native transcript has partial tail");
  let bound=false,terminal=false,qualified=false;
  const ticket=JSON.parse(c.session.brief);
  for(const line of text.trimEnd().split("\n")) {
    const row=JSON.parse(line);
    if(row.type==="session_meta") {
      if(row.payload?.id!==c.session.native_id || row.payload?.cwd!==c.workspace)throw Error("fresh native identity/cwd mismatch");
      bound=true;
    }
    if(row.type==="turn_context") {
      if(row.payload?.model!==ticket.model || row.payload?.effort!==ticket.effort)throw Error("fresh native model/effort mismatch");
      qualified=true;terminal=false;
    }
    if(row.type==="event_msg") {
      if(row.payload?.type==="task_complete")terminal=true;
      else if(row.payload?.type!=="token_count")terminal=false;
    } else if(row.type!=="session_meta" && row.type!=="turn_context")terminal=false;
  }
  if(!bound || !terminal || !qualified)throw Error("fresh terminal native evidence unavailable");
}
export function verifyProcessCustody(c:Context,paths:string[], run=spawnSync, readNative?: (path:string)=>string) {
  verifyNativeTerminal(c,readNative);
  const checkProcesses=()=>{
    const ps=run("/bin/ps",["-ww","-axo","pid=,ppid=,pgid=,stat=,lstart=,args="],{encoding:"utf8",timeout:5000,maxBuffer:32*1024*1024});
    if(ps.error || ps.status!==0 || ps.stderr.trim() || !ps.stdout.trim())throw Error("fresh process inventory unavailable");
    for(const line of ps.stdout.trim().split("\n")) {
      const row=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if(!row)throw Error("partial process inventory");
      if((Number(row[1])===c.supervisor.pid && !(c.planning && c.supervisor.pid===process.pid)) || c.cleanup.groups!.includes(Number(row[3])) || row[5].includes(c.session.native_id!) || [c.workspace,...paths].some(path=>row[5].includes(path)))throw Error(`live native/process custody: ${row[1]}`);
    }
  };checkProcesses();
  const files=run(process.platform==="darwin" ? "/usr/sbin/lsof" : "lsof",["-nP","-Fpcfn"],{encoding:"utf8",timeout:5000,maxBuffer:32*1024*1024});
  if(files.error || files.status!==0 || files.stderr.trim() || !files.stdout.startsWith("p"))throw Error("fresh cwd/open-file inventory unavailable");
  let pid="";
  for(const line of files.stdout.trim().split("\n")) {
    if(line.startsWith("p")){if(!/^p[1-9][0-9]*$/.test(line))throw Error("partial open-file inventory");pid=line.slice(1);}
    else if(line.startsWith("n")) {
      const name=line.slice(1).replace(/ \(deleted\)$/,"");
      if(paths.some(path=>inside(path,name)))throw Error(`cwd/open-file custody: ${pid} ${name}`);
    } else if(!/^[cf]/.test(line))throw Error("unknown open-file inventory record");
  }
  checkProcesses();verifyNativeTerminal(c,readNative);
}
export const retentionPorts:RetentionPorts={fs:retentionFS,github:verifyPublished,custody:verifyProcessCustody};

// BEGIN IMMEDIATE excludes new launcher admissions/continuations while external
// proof is read. This is a bounded one-session API, never a recurring sweeper.
async function locked<T>(s:Store,fn:()=>Promise<T>) {
  s.db.exec("BEGIN IMMEDIATE");try{const value=await fn();s.db.exec("COMMIT");return value;}catch(error){if(s.db.inTransaction)s.db.exec("ROLLBACK");throw error;}
}
function blocked(s:Store,id:string,error:unknown,manifest?:Manifest,completed:string[]=[]):RetentionResult {
  const result:RetentionResult={result:"blocked",reason:String(error),manifest,completed,recoveredBytes:0};
  s.event(`retention-blocked:${id}:${crypto.randomUUID()}`,"delivery-retention-blocked",result,undo);return result;
}

export async function planDeliveryRetention(s:Store,root:string,id:string,destination:string|undefined,ports=retentionPorts):Promise<RetentionResult> {
  try{return await locked(s,async()=>{
    const c=context(s,id),io=ports.fs;
    if(!/^[a-f0-9]{64}$/.test(id))throw Error("retention session identity refused");
    if(!destination)throw Error("archive destination is not configured; artifacts retained, no space recovered");
    root=io.canonical(root);
    if(c.workspace!==join(root,"workspaces",id))throw Error("workspace custody path mismatch");
    const archiveDestination=io.canonical(destination);io.writable(archiveDestination);
    destination=archiveDestination;
    if(inside(root,destination) || inside(destination,root))throw Error("archive destination overlaps operational root");
    const previous=s.get<Manifest>(key(id));
    if(previous) {
      if(previous.destinationIdentity!==io.directoryIdentity(destination) || previous.destination!==destination || digest(previous.publication)!==digest(c.publication))throw Error("existing archive plan identity changed");
      await ports.github(c.publication);
      if(digest(context(s,id))!==digest(c))throw Error("custody changed during planning");
      ports.custody({...c,planning:true},previous.assets.flatMap(a=>[a.source,a.target]));
      return {result:"planned",manifest:previous,completed:[],recoveredBytes:0};
    }
    const sources=[join(root,"workspaces",id)];
    const runs=join(root,"runs","delivery",id);
    const attempts=io.exists(runs)?io.list(runs):[];
    if(attempts.length>32)throw Error("archive attempt bound exceeded");
    for(const attempt of attempts) {
      if(!/^[a-zA-Z0-9-]+$/.test(attempt))throw Error("unsafe delivery attempt path");
      const dir=join(runs,attempt);io.canonical(dir);
      if(io.exists(join(dir,"local-clone")))sources.push(join(dir,"local-clone"));
      const publisher=join(dir,"publisher");
      if(io.exists(publisher)) {io.canonical(publisher);const names=io.list(publisher);if(names.length>128)throw Error("publisher candidate bound exceeded");for(const name of names)if(/^publish-[a-f0-9-]+$/.test(name))sources.push(join(publisher,name));}
      if(sources.length>32)throw Error("archive candidate bound exceeded");
    }
    const assets=sources.map((source,i)=>{
      io.canonical(source);io.directoryIdentity(source);const inventory=io.inventory(source),target=join(archiveDestination,`${id}-${i}`);
      if(io.exists(target))throw Error("archive target already exists without receipt");
      return {source,target,inventory,mode:inventory.device===io.device(archiveDestination)?"rename" as const:"copy-retain-source" as const};
    });
    await ports.github(c.publication);
    if(digest(context(s,id))!==digest(c))throw Error("custody changed during planning");
    ports.custody({...c,planning:true},assets.map(a=>a.source));
    const data={version:1 as const,session:id,publication:c.publication,destination,destinationIdentity:io.directoryIdentity(destination),assets,
      estimatedLogicalBytes:assets.reduce((n,a)=>n+a.inventory.logicalBytes,0),estimatedAllocatedBytes:assets.reduce((n,a)=>n+a.inventory.allocatedBytes,0),recoveredBytes:0 as const,
      limitations:["Archive only; no deletion and no measured recovered bytes.","Allocated bytes are stat-block estimates, not measured exclusive or reclaimable APFS space.",
        ...(assets.some(a=>a.mode==="rename")?["Same-volume archive moves do not free space."]:[]),
        ...(assets.some(a=>a.mode==="copy-retain-source")?["Cross-volume archive copies retain originals; physical space reclamation is not performed."]:[])],
      retained:{native:c.native,cleanup:c.cleanup,supervisor:c.supervisor,workspace:c.workspace,session:c.session,publication:c.publication,
        evidence:"Bundle and Git metadata travel intact; publisher incoming bundles, tested-tree receipts, logs, native transcripts, claims and debits remain at recorded paths."}};
    const manifest:Manifest={...data,id:digest(data)};
    if(JSON.stringify(manifest).length>128*1024)throw Error("archive manifest bound exceeded");
    s.set(key(id),manifest);s.event(`retention-plan:${manifest.id}`,"delivery-retention-plan",manifest,undo);
    return {result:"planned",manifest,completed:[],recoveredBytes:0};
  });}catch(error){return blocked(s,id,error);}
}

// Caller supplies the retained plan ID, never arbitrary paths. Missed cleanup
// calls this same API. Write-ahead intents allow verification after interruption;
// partial/unverifiable copies stay retained and blocked, never overwritten.
export async function archiveDeliveryRetention(s:Store,id:string,planId:string,ports=retentionPorts):Promise<RetentionResult> {
  let manifest:Manifest|undefined;const completed:string[]=[];
  try{return await locked(s,async()=>{
    const c=context(s,id),io=ports.fs;
    manifest=s.get<Manifest>(key(id)) ?? undefined;
    if(!manifest || manifest.id!==planId || manifest.session!==id || digest(manifest.publication)!==digest(c.publication))throw Error("retained archive plan mismatch");
    const {id:retainedId,...data}=manifest;
    if(digest(data)!==retainedId || manifest.assets.length<1 || manifest.assets.length>32)throw Error("archive manifest integrity mismatch");
    const assertDestination=()=>{io.canonical(manifest!.destination);io.writable(manifest!.destination);
      if(io.directoryIdentity(manifest!.destination)!==manifest!.destinationIdentity)throw Error("configured archive destination changed or unmounted");};
    assertDestination();
    await ports.github(c.publication);
    for(const asset of manifest.assets) {
      const receiptKey=`retention-asset:${manifest.id}:${digest(asset.source)}`;
      const receipt=s.get<{state:string}>(receiptKey);
      io.canonical(dirname(asset.target));
      const present=io.exists(asset.source),target=io.exists(asset.target);
      if(target) {
        if(!receipt || (asset.mode==="rename" && present) || (asset.mode==="copy-retain-source" && !present))throw Error("unowned or ambiguous archive target; retained for reconciliation");
        if(io.inventory(asset.target).content!==asset.inventory.content)throw Error("partial archive retained; content verification failed");
        if(present && io.inventory(asset.source).fingerprint!==asset.inventory.fingerprint)throw Error("source changed after archive copy");
      } else {
        if(receipt?.state==="done" || !present)throw Error("archive receipt/path mismatch");
        if(io.inventory(asset.source).fingerprint!==asset.inventory.fingerprint)throw Error("archive source changed after dry run");
      }
      // Last remote readback, fresh database/native/browser checks, then the
      // synchronous process/cwd/open-file and path rechecks directly before I/O.
      await ports.github(c.publication);
      const fresh=context(s,id);
      if(digest(fresh)!==digest(c))throw Error("custody changed during archive verification");
      assertDestination();
      if(present && io.inventory(asset.source).fingerprint!==asset.inventory.fingerprint)throw Error("source raced archive verification");
      ports.custody(fresh,[asset.source,asset.target]);
      if(!target) {
        if(io.exists(asset.target))throw Error("archive target raced final recheck");
        s.set(receiptKey,{state:"intent",asset});
        // Commit intent before touching disk. All mutations are synchronous; the
        // same connection immediately reacquires custody for the next item.
        s.db.exec("COMMIT");s.db.exec("BEGIN IMMEDIATE");
        if(digest(context(s,id))!==digest(c))throw Error("custody raced archive intent");
        assertDestination();io.canonical(asset.source);
        if(io.exists(asset.target) || io.inventory(asset.source).fingerprint!==asset.inventory.fingerprint)throw Error("path raced archive intent");
        ports.custody(context(s,id),[asset.source,asset.target]);
        assertDestination();io.canonical(asset.source);
        if(io.exists(asset.target))throw Error("archive target appeared during custody check");
        if(asset.mode==="rename")io.rename(asset.source,asset.target);else io.copy(asset.source,asset.target);
      }
      if(io.inventory(asset.target).content!==asset.inventory.content)throw Error("archive content mismatch; all partial artifacts retained");
      io.sync(asset.target);
      if(io.inventory(asset.target).content!==asset.inventory.content ||
        (asset.mode==="rename" ? io.exists(asset.source) : !io.exists(asset.source) || io.inventory(asset.source).fingerprint!==asset.inventory.fingerprint))
        throw Error("archive/source changed during durable verification; retained for reconciliation");
      s.set(receiptKey,{state:"done",asset,sourceRetained:asset.mode==="copy-retain-source",recoveredBytes:0});
      s.event(`retention-asset:${manifest.id}:${digest(asset.source)}`,"delivery-retention-archive",{asset,recoveredBytes:0},undo);
      // Preserve successful receipts even if a later asset fails.
      s.db.exec("COMMIT");s.db.exec("BEGIN IMMEDIATE");completed.push(asset.target);
    }
    return {result:"archived",manifest,completed,recoveredBytes:0};
  });}catch(error){return blocked(s,id,error,manifest,completed);}
}
