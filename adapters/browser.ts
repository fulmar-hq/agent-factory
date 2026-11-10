import { Database } from "bun:sqlite";
import { existsSync, openSync, fstatSync, closeSync, readFileSync, writeFileSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Engine, usageGate } from "../launcher/engine";
import { type BrowserJob, type BrowserPorts, type BrowserReceipt, BrowserResult, readBrowserJSON, browserDir, saveBrowser } from "../launcher/browser";
import { mailPath } from "../launcher/alerts";
import { optionalJSON, type Meter } from "../launcher/config";
import type { Ticket } from "../launcher/config";
import { verifySubscription, WorkerAccounting } from "./workers";
import { command } from "./github";

export function browserArgs(j:BrowserJob, brief:string, path:string) {
  return ["claude","--bg","--chrome","-n",`Alido · #${j.issue} · browser`,"--model","opus","--effort","medium",
    "--permission-mode","dontAsk","--setting-sources","","--strict-mcp-config",
    "--tools","Write","--add-dir",browserDirFromPath(path),
    "--allowedTools","mcp__claude-in-chrome__*",`Edit(/${path})`,"--",brief];
}
function browserDirFromPath(path:string) {return path.slice(0,path.lastIndexOf("/"));}
// Never inherit API keys or billing/provider routing. Native subscription only.
export async function browserCommand(args:string[],cwd?:string) {
  const env:Record<string,string>={};
  for(const k of ["PATH","HOME","USER","LOGNAME","TMPDIR","LANG"])if(process.env[k])env[k]=process.env[k]!;
  const p=Bun.spawn(args,{cwd,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>p.kill(),20000);
  try {
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    if(code!==0)throw Error(`${args[0]} browser command failed: ${err.slice(0,500)}${out.slice(0,500)}`);
    return out;
  } finally {clearTimeout(timer);}
}
// Background transcripts include native file-history bookkeeping without a
// sessionId. Only those explicit non-message records may lack custody identity;
// every model/tool/other record must match the exact allocated session.
export function browserNativeEvidence(id:string,cwd:string,home=homedir()) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error("browser native ID invalid");
  const path=join(home,".claude/projects",cwd.replace(/[^a-zA-Z0-9]/g,"-"),`${id}.jsonl`);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const models=new Set<string>(),efforts=new Set<string>(),tools:string[]=[];
  const calls=new Map<string,{name:string;input:Record<string,unknown>}>(),createdTabs=new Set<number>(),closedTabs=new Set<number>();
  let navigated=false,observed=false;
  const accounting=new WorkerAccounting();let bound=false;
  try {
    const before=fstatSync(fd);
    if(!before.isFile() || before.size>64*1024*1024)throw Error("browser native transcript bounds refused");
    const content=readFileSync(fd,"utf8");
    for(const line of content.trimEnd().split("\n")) {
      const x=JSON.parse(line);
      if(["file-history-snapshot","file-history-delta"].includes(x.type) && x.sessionId===undefined)continue;
      if(x.sessionId!==id || (x.cwd && x.cwd!==cwd))throw Error("browser native custody mismatch");
      if(x.cwd===cwd)bound=true;
      if(x.type==="assistant") {
        if(x.message?.model)models.add(x.message.model);
        if(x.effort)efforts.add(x.effort);
        for(const c of x.message?.content ?? [])if(c.type==="tool_use"){tools.push(c.name);calls.set(c.id,{name:c.name,input:c.input ?? {}});}
      }
      if(x.type==="user" && Array.isArray(x.message?.content))for(const c of x.message.content) {
        if(c.type!=="tool_result" || c.is_error)continue;
        const call=calls.get(c.tool_use_id);if(!call)continue;
        const body=typeof c.content==="string" ? c.content : (c.content ?? []).filter((b:{type:string})=>b.type==="text").map((b:{text:string})=>b.text).join("\n");
        const name=call.name.split("__").at(-1);
        if(name==="tabs_create_mcp")for(const m of body.matchAll(/Created new tab\. Tab ID:\s*(\d+)/g))createdTabs.add(Number(m[1]));
        if(name==="tabs_context_mcp" && call.input.createIfEmpty===true)for(const b of Array.isArray(c.content)?c.content:[]) {
          if(b.type!=="text")continue;
          try {for(const tab of JSON.parse(b.text).availableTabs ?? [])if(Number.isSafeInteger(tab.tabId))createdTabs.add(tab.tabId);}catch {/* Non-JSON context text. */}
        }
        if(name==="tabs_close_mcp" || name==="browser_batch")for(const m of body.matchAll(/Closed tab\s+(\d+)/g))closedTabs.add(Number(m[1]));
        if(["navigate","browser_batch"].includes(name ?? "") && /Navigated to https?:\/\//.test(body))navigated=true;
        const readsPage=["get_page_text","read_page","javascript_tool","browser_batch"].includes(name ?? "") || (name==="computer" && call.input.action==="screenshot");
        if(readsPage && body.trim() && !/permission denied|failed:|is_error|error capturing/i.test(body))observed=true;
      }
      if(x.type==="api-request") {
        if(x.params?.model)models.add(x.params.model);
        if(x.params?.output_config?.effort)efforts.add(x.params.output_config.effort);
      }
      accounting.ingest("claude",line);
    }
    const after=fstatSync(fd),caughtUp=content.endsWith("\n") && before.size===after.size && before.mtimeMs===after.mtimeMs;
    const conflict=[...models].some(m=>m!=="claude-opus-5-5") || [...efforts].some(v=>v!=="medium");
    return {id,path,bound,caughtUp,models:[...models],efforts:[...efforts],tools,createdTabs:[...createdTabs],closedTabs:[...closedTabs],navigated,observed,tokens:accounting.tokens,conflict,
      verified:bound && caughtUp && !conflict && models.size===1 && efforts.size===1};
  } finally {closeSync(fd);}
}
export function verifyBrowserPageReceipt(r:BrowserReceipt,e:ReturnType<typeof browserNativeEvidence>) {
  if(r.tabClosed && r.tabId!==null && !e.closedTabs.includes(r.tabId))throw Error("browser native tab closure evidence missing");
  if(r.status==="done" && (!e.createdTabs.includes(r.tabId!) || !e.navigated || !e.observed))throw Error("browser native page evidence missing");
}
const Agent=z.object({id:z.string().optional(),sessionId:z.string(),pid:z.number().optional(),state:z.string().optional(),status:z.string().optional(),cwd:z.string().optional(),name:z.string().optional(),startedAt:z.number().optional()}).passthrough();
export function queueBrowserMail(id:string, recipient:string, app:"codex"|"telegram", summary:string, body:string, now:number, path=mailPath()) {
  if(!existsSync(path))throw Error("existing Alido Mail bridge unavailable");
  const db=new Database(path,{readwrite:true,strict:true});
  try {
    db.exec("PRAGMA busy_timeout=10000");
    db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
      VALUES(?,?,?,'Factory Desk','codex','factory-launcher',?,?,'decision','required',?,?,?,0,?,'unread','pending')`)
      .run(id,id,now,recipient,app,summary,body,id,createHash("sha256").update(summary+body).digest("hex"));
  } finally {db.close();}
}
export function browserMailAnswer(j:BrowserJob,path=mailPath()):string|null {
  if(!existsSync(path))return null;
  const db=new Database(path,{readonly:true,strict:true});
  try {
    const row=db.query("SELECT summary,body FROM messages WHERE sender_app='telegram' AND (reply_to=? OR thread_id=?) AND created_at>=? AND created_at<? ORDER BY created_at LIMIT 1")
      .get(`browser-question:${j.id}`,`browser-question:${j.id}`,j.at,j.deadline) as {summary:string;body:string}|null;
    return row ? `${row.summary} ${row.body}`.trim().slice(0,4000) : null;
  } finally {db.close();}
}
export function nativeBrowserPorts(e:Engine,dir:string,resume:(id:string)=>void):BrowserPorts {
  const list=async()=>z.array(Agent).parse(JSON.parse(await browserCommand(["claude","agents","--json","--all"])));
  const find=async(j:BrowserJob)=>{
    const agents=await list(),exact=agents.find(a=>a.sessionId===j.native);
    if(exact)return exact;
    const cwd=e.s.get<string>(`browser-cwd:${j.id}:${j.nonce}`);
    if(!cwd || !j.launchAt)return;
    // --bg allocates its own native UUID; --session-id is ignored by v2.1.319.
    // Recover a lost start response from the unique retained name/cwd/time claim.
    const candidates=agents.filter(a=>a.name===`Alido · #${j.issue} · browser` && a.cwd===cwd && a.startedAt!==undefined && a.startedAt>=j.launchAt!-2000 && a.startedAt<=(j.runDeadline ?? j.deadline));
    if(candidates.length>1)throw Error("ambiguous background browser custody");
    if(candidates[0]) {j.native=candidates[0].sessionId;j.handle=candidates[0].id;saveBrowser(e.s,j);return candidates[0];}
  };
  return {
    async start(j,brief,path) {
      const parent=e.sessions().find(x=>x.id===j.parent);
      if(!parent || parent.status!=="waiting-browser")throw Error("waiting browser parent required");
      const high=(JSON.parse(parent.brief) as Ticket).benefit==="high";
      usageGate(e.s.get<Record<string,Meter>>("readings")?.claude,high,Date.now(),e.c,"claude");
      await verifySubscription("claude");
      const help=await browserCommand(["claude","--help"]);
      for(const flag of ["--bg","--chrome","--permission-mode","--allowedTools"])if(!help.includes(flag))throw Error(`Claude missing ${flag}`);
      const repos=await optionalJSON(join(dir,"repositories.json")) as Record<string,string>|null;
      const cwd=repos?.[j.repo];if(!cwd)throw Error("browser trusted source checkout unavailable");
      if(e.s.get("paused")!==false || e.sessions().find(x=>x.id===j.parent)?.status!=="waiting-browser" || e.s.get<{child:string}>(`browser-parent:${j.parent}`)?.child!==j.id)throw Error("browser start custody/paused refused");
      usageGate(e.s.get<Record<string,Meter>>("readings")?.claude,high,Date.now(),e.c,"claude");
      e.s.set(`browser-cwd:${j.id}:${j.nonce}`,cwd);
      const output=await browserCommand(browserArgs(j,brief,path),cwd);
      const match=output.match(/backgrounded\s*·\s*([a-f0-9]{8,36})/);
      if(!match)throw Error("background handle unverified");
      j.handle=match[1];saveBrowser(e.s,j);
      const a=await find(j);
      if(!a || a.id!==match[1])throw Error("background native ID unverified");
      e.s.event(`browser-native:${j.id}:${j.nonce}`,"browser-native-start",{child:j.id,native:j.native,handle:match[1],cwd},"Retain exact native ID; stop before fallback");
      return match[1];
    },
    async observe(j) {
      const a=await find(j);
      if(!a)return "failed";
      const cwd=e.s.get<string>(`browser-cwd:${j.id}:${j.nonce}`);
      if(!cwd)throw Error("browser native workspace unknown");
      let evidence:ReturnType<typeof browserNativeEvidence>;
      try {evidence=browserNativeEvidence(j.native,cwd);}
      catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT" && a.status!=="idle")return "running";throw error;}
      e.s.set(`browser-native-evidence:${j.id}:${j.nonce}`,evidence);
      if(evidence.conflict || evidence.tokens>=8000000)throw Error("browser native model/effort or token bound refused");
      if(a.status==="idle" || ["done","blocked"].includes(a.state ?? "")) {
        if(!evidence.verified)throw Error("browser native receipt unverified");
        const result=BrowserResult.parse(readBrowserJSON(join(browserDir(dir,j),"result.json")));
        verifyBrowserPageReceipt(result,evidence);
        return "done";
      }
      if(a.state==="stopped" || !a.pid)return "failed";
      return "running";
    },
    async stop(j) {
      const a=await find(j);
      // Exact all-state native inventory proves a refused start created nothing.
      if(!a)return !e.s.get(`browser-cwd:${j.id}:${j.nonce}`) || Date.now()-(j.launchAt ?? j.at)>30000;
      if(a.pid)await browserCommand(["claude","stop",a.id ?? j.native]);
      const after=await find(j);
      const stopped=!after?.pid && (!after || ["stopped","done","blocked"].includes(after.state ?? ""));
      if(stopped)e.s.event(`browser-stopped:${j.id}:${j.nonce}`,"browser-native-stopped",{child:j.id,native:j.native,state:after?.state},"Retain native browser custody and tab closure evidence");
      return stopped;
    },
    async fallback(j,brief,path) {
      // Existing mail directory supplies actual app presence; no stale hardcoded chat.
      const cli=process.env.FACTORY_MAIL_CLI ?? join(homedir(),"Developer/alido-agent-mail/src/cli.ts");
      const agents=z.array(z.object({address:z.string(),app:z.string(),presence:z.string(),ref:z.string()})).parse(JSON.parse(await command([process.execPath,cli,"agents","--json"])));
      const target=j.fallback ?? agents.find(a=>a.app==="codex" && a.presence==="idle");
      if(!target)throw Error("no open idle Codex app chat in Alido Mail directory");
      j.fallback={address:target.address,ref:target.ref};saveBrowser(e.s,j);
      const briefPath=join(browserDirFromPath(path),"fallback-brief.txt");
      if(!existsSync(briefPath))writeFileSync(briefPath,brief,{flag:"wx",mode:0o600});
      const body=`Browser fallback. Read ${briefPath}. Follow its hard rules. Reconcile tabs from native ${j.native}; close only proven session-owned tabs. Use your own new tab and close it. tabClosed must cover all owned tabs. Write result.json beside the brief (exact schema/nonce there). Deadline ${new Date(j.deadline).toISOString()}; default not done. Never enter credentials, accept terms, change billing/payment/limits or send real-person texts. The receipt returns to the parent.`;
      if(body.length>800)throw Error("fallback mail exceeds bridge body bound");
      queueBrowserMail(`browser-fallback:${j.id}:${j.nonce}`,target.address,"codex","A background browser task needs an app browser.",body,Date.now());
      // Use the bridge's normal app-open path as well as its retained queued
      // wake. Opening/queuing alone never counts as a browser result.
      await command([process.execPath,cli,"open",target.address]);
      return {address:target.address,ref:target.ref};
    },
    async notify(j,question) {
      queueBrowserMail(`browser-question:${j.id}`,"Vincent","telegram",question,"",Date.now());
    },
    async answer(j) {return browserMailAnswer(j);},
    resume,
  };
}
