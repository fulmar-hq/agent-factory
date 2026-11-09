import {qualificationFor} from "./push";
import { prepareDelivery, publish, testSnapshot, executableTest, deliveryBase, isDeliveryRepo } from "../adapters/delivery";
import { NativeReceipt } from "../adapters/native";
import { spawnWorker } from "./child";
import { processIdentity } from "./process";
import { join } from "node:path";
import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { Engine } from "./engine";
import { configAt, root, optionalJSON, QualificationSchema, type Ticket, type Meter } from "./config";
import { Store } from "../tracking/store";
import {
  workerSpec,
  WorkerAccounting,
  verifySubscription,
  materializeSettings,
} from "../adapters/workers";
import { command } from "../adapters/github";
export function claimSupervisor(e: Engine, id: string) {
  // BEGIN IMMEDIATE waits for the launch reservation to commit before reading it.
  return e.s.atomic(() => {
    const current = e.sessions().find((x) => x.id === id);
    if (!current || current.status !== "starting") return null;
    if (e.s.db.query("UPDATE sessions SET pid=? WHERE id=? AND status='starting' AND pid IS NULL")
      .run(process.pid, id).changes !== 1) return null;
    e.s.set(`supervisor:${id}`, processIdentity(process.pid));
    return current;
  });
}
export async function runWorker(id: string) {
  const c = await configAt(), s = new Store(join(root, "controller.sqlite")), e = new Engine(s, c);
  const x = claimSupervisor(e, id);
  if (!x) { s.close(); return; }
  const t = JSON.parse(x.brief) as Ticket;
  try {
    const qs = (await optionalJSON(
      join(root, "qualifications.json"),
    )) as Record<string, unknown> | null;
    const q = QualificationSchema.parse(qualificationFor(qs ?? {},t.provider,t.effort!));
    if (
      q.expiresAt <= Date.now() ||
      q.model !== t.model ||
      q.effort !== t.effort ||
      s.get("paused") !== false
    )
      throw Error("qualification expired or paused");
    const readings = s.get<Record<string, Meter>>("readings");
    e.workerUsage(id, readings?.[t.provider], Date.now());
    await verifySubscription(t.provider);
    const repos = (await optionalJSON(
      join(root, "repositories.json"),
    )) as Record<string, string> | null;
    const source = repos?.[t.repo];
    if (!source) throw Error("workspace missing");
    const workspace = join(root, "workspaces", id);
    mkdirSync(join(root, "workspaces"), { recursive: true, mode: 0o700 });
    const continuation = s.get<{attempt:string;native:string}>(`continuation:${id}`);
    const delivery = t.provider === "codex" && isDeliveryRepo(t.repo);
    if (delivery) executableTest(t.test);
    const base = !continuation && delivery ? await deliveryBase(source,t.repo) : "HEAD";
    if (!continuation) await command([
      "git",
      "-C",
      source,
      "worktree",
      "add",
      "-b",
      `feat/factory-${id.slice(0, 16)}`,
      workspace,
      base,
    ]);
    s.event(
      `workspace:${id}`,
      "workspace",
      { id, workspace },
      `Preserve work, then archive workspace ${workspace} and branch after custody transfer`,
    );
    const attempt = continuation?.attempt ?? "initial";
    const archive = join(root,"runs","delivery",id,attempt);
    if (delivery) {
      const qualified=s.get<{expiresAt:number;version:number}>("delivery-qualified");
      if(!qualified || qualified.version!==2 || qualified.expiresAt<=Date.now())throw Error("publisher blocked: isolation unproven");
      await prepareDelivery(workspace,source,archive,id);
    }
    mkdirSync(join(workspace,".factory-tmp"),{recursive:true});
    const baselineKey=`publish-base:${id}`;
    if(!s.get(baselineKey))s.set(baselineKey,(await command(["git","-C",workspace,"rev-parse","HEAD"])).trim());
    await superviseSession(e,id,t,workspace,join(root,`worker-${id}${continuation ? `-${attempt}` : ""}.jsonl`),delivery ? {native:continuation?.native} : undefined);
    if(delivery && e.sessions().find(x=>x.id===id)?.status==="finished") {
      const verifyClaim=()=>{
        const current=e.sessions().find(x=>x.id===id);
        const q=s.get<{expiresAt:number;version:number}>("delivery-qualified");
        const claims=s.db.query("SELECT path FROM claims WHERE session=?").all(id) as {path:string}[];
        if(!current || current.status!=="finished" || s.get("paused")!==false || s.get<{verified:boolean}>(`cleanup-evidence:${id}`)?.verified!==true || !q || q.version!==2 || q.expiresAt<=Date.now() || claims.length!==t.paths.length || t.paths.some(p=>!claims.some(c=>c.path===p.toLowerCase())))throw Error("publisher claim/cleanup/qualification refused");
      };
      const result=await publish(t,id,workspace,join(archive,"publisher"),s.get<string>(baselineKey)!,{verifyClaim,isolationVerified:true,testTree:(checkout,tree)=>testSnapshot(t,checkout,tree,source)},command,source);
      s.event(`publish:${id}`,"launcher-publish",{id,...result},"Retain PR and signed tree; undo accepted changes with signed revert");
    }
  } catch (error) {
    e.finish(id, false);
    s.event(`failure:${id}`, "worker-failure", {id, error: String(error)}, "Reconcile preserved work and native session; never blindly retry");
  } finally {
    s.db.query("UPDATE sessions SET pid=NULL WHERE id=?").run(id);
    s.close();
  }
}
// Shared execution path for admitted workers and owner-run disposable rehearsals.
// This function does not admit work or create qualification evidence.
export async function superviseSession(e: Engine, id: string, t: Ticket, workspace: string, logPath: string, delivery?: {native?:string}) {
  const continuation = e.s.get<{attempt:string;native:string}>(`continuation:${id}`);
  const attempt = continuation?.attempt ?? id;
  const original = e.sessions().find(x => x.id === id)!;
  if(original.status!=="starting" || original.pid!==process.pid)throw Error("owned starting supervisor required");
  // Reconcile persisted usage before any next native turn can start.
  e.account(id,original.actual_seconds,original.actual_tokens);
  if(e.budget(original).nextTurnBlocked)throw Error("budget pause; next turn blocked");
  e.s.atomic(() => {
    const session = e.sessions().find(x => x.id === id);
    if (!session || session.pid !== process.pid || session.status !== "starting" || e.s.get("paused") !== false)
      throw Error("owned starting supervisor required");
    if (!e.s.event(`native-start:${attempt}`, "native-start-attempt", {id}, "Never replay this native start; reconcile retained custody"))
      throw Error("native start already attempted");
  });
  const start = Date.now();
  e.s.set(`active-clock:${id}`,{at:start,seconds:original.actual_seconds});
  let child: ReturnType<typeof spawnWorker> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fd: number | undefined;
  let halt: ((signal?: string) => void) | undefined;
  const onTerm = () => halt?.("SIGTERM"), onInt = () => halt?.("SIGINT");
  try {
    const settingsPath = logPath + ".settings.json";
    const spec = materializeSettings(workerSpec(t, workspace,"print",root,delivery), settingsPath);
    if (spec.settings) e.s.event(`native-settings:${attempt}`, "native-settings", {id, path:settingsPath, settings:spec.settings}, "Retain the per-run settings with native receipts; requalify policy changes");
    fd = openSync(logPath, "ax", 0o600);
    child = spawnWorker(spec, workspace, fd);
    e.s.event(`native-process:${attempt}`, "native-process", {id, pid:child.pid, processGroup:child.pid, identity:child.pid ? processIdentity(child.pid) : null}, "Reconcile process identity and group before archiving; retain native receipts");
    e.register(id, process.pid, spec.nativeId ?? null);
    let stop = false,
      totalTokens = 0,
      completed = false;
    const accounting = new WorkerAccounting();
    let native: NativeReceipt | undefined = spec.nativeId ? new NativeReceipt(t.provider,spec.nativeId,workspace,spec.env.HOME,original.started ?? start) : undefined;
    const checkStreamModel = () => {
      if (t.provider !== "claude") return;
      const selected = spec.argv[spec.argv.indexOf("--model") + 1];
      if ([...accounting.models].some(model => model !== selected)) {
        e.s.set(`stop:${id}`, {reason:"native stream model conflict", models:[...accounting.models]});
        halt!();
      }
    };
    const sample = () => {
      try {
        native?.poll(accounting);
        totalTokens=accounting.tokens;
        e.s.set(`cached-tokens:${id}`,accounting.cachedTokens);
        checkStreamModel();
        if(native) {
          const evidence=native.evidence(t.model ?? (t.provider==="codex" ? "gpt-6.1-sol" : "opus"),t.effort ?? "medium");
          e.s.set(`native-evidence:${id}`,evidence);
          if(evidence.conflict) {e.s.set(`stop:${id}`,{reason:"native model/effort conflict"});halt!();}
        }
      } catch(error) {e.s.set(`stop:${id}`,{reason:String(error)});halt!();}
      e.account(id,original.actual_seconds+(Date.now()-start)/1000,totalTokens);
    };
    let stopping: Promise<void> | undefined;
    halt = (signal?: string) => {
      if (stop) return;
      e.s.event(`halt:${attempt}`, "worker-halt", {id, signal:signal ?? null,
        reason:e.s.get(`stop:${id}`) ?? (e.s.get("paused") !== false ? "factory paused" : "worker stop"),
      }, "Reconcile stop evidence and preserved work before archiving custody");
      stop = true;
      stopping = child!.stop();
      // Cleanup is awaited below; attach a handler now while stdout is draining.
      void stopping.catch(() => {});
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    timer = setInterval(() => {
      sample();
      const state = e.sessions().find((a) => a.id === id);
      if (
        e.s.get("paused") !== false ||
        e.s.get(`stop:${id}`) ||
        state?.status === "paused"
      )
        halt!();
    }, 500);
    let pending = "";
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      writeSync(fd, text);
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const event = accounting.ingest(t.provider, line);
        checkStreamModel();
        if (event.native) {
          if(delivery?.native && event.native!==delivery.native)throw Error("continuation native ID changed");
          if(native && native.id!==event.native)throw Error("native ID changed");
          native ??= new NativeReceipt(t.provider,event.native,workspace,spec.env.HOME,original.started ?? start);
          e.register(id, process.pid, event.native);
        }
        if (event.tokens !== undefined) totalTokens = event.tokens;
        if (event.done) completed = true;
        e.account(id, original.actual_seconds+(Date.now() - start) / 1000, totalTokens);
        if (e.sessions().find((x) => x.id === id)?.status === "paused") halt();
      }
    }
    const code = await child.exited;
    // Drain bounded chunks after exit; never accept identity from an unread tail.
    for(let i=0;i<64;i++) {sample();if(!native || native.caughtUp || stop)break;}
    clearInterval(timer);
    if (stopping) await stopping;
    closeSync(fd);
    fd = undefined;
    if (stop)
      e.s.db.query("UPDATE sessions SET status='paused' WHERE id=?").run(id);
    else e.finish(id, code === 0 && completed && native?.evidence(t.model ?? (t.provider==="codex" ? "gpt-6.1-sol" : "opus"),t.effort ?? "medium").verified === true);
  } finally {
    if (timer) clearInterval(timer);
    if (halt) {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    }
    if (fd !== undefined) closeSync(fd);
    try {
      if (child) {
        try { await child.stop(); }
        finally {
          e.s.set(`cleanup-evidence:${id}`,child.cleanup);
          e.s.event(`cleanup:${attempt}`, "worker-cleanup", child.cleanup, "Retain process-group readback and native custody; never infer unobserved containment");
          await child.exited;
        }
      }
    } finally { e.s.db.query("UPDATE sessions SET pid=NULL WHERE id=?").run(id); }
  }
}
if (import.meta.main) await runWorker(process.argv[2]);
