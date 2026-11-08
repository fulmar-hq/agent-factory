import { NativeReceipt } from "../adapters/native";
import { spawnWorker } from "./child";
import { processIdentity } from "./process";
import { join } from "node:path";
import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { Engine, usageGate } from "./engine";
import { configAt, root, optionalJSON, QualificationSchema, type Ticket } from "./config";
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
    const q = QualificationSchema.parse(qs?.[t.provider]);
    if (
      q.expiresAt <= Date.now() ||
      q.model !== t.model ||
      q.effort !== t.effort ||
      s.get("paused") !== false
    )
      throw Error("qualification expired or paused");
    const readings = s.get<Record<string, unknown>>("readings");
    usageGate(readings?.[t.provider], t.benefit === "high", Date.now(), c);
    await verifySubscription(t.provider);
    const repos = (await optionalJSON(
      join(root, "repositories.json"),
    )) as Record<string, string> | null;
    const source = repos?.[t.repo];
    if (!source) throw Error("workspace missing");
    const workspace = join(root, "workspaces", id);
    mkdirSync(join(root, "workspaces"), { recursive: true, mode: 0o700 });
    await command([
      "git",
      "-C",
      source,
      "worktree",
      "add",
      "-b",
      `feat/factory-${id.slice(0, 16)}`,
      workspace,
      "HEAD",
    ]);
    s.event(
      `workspace:${id}`,
      "workspace",
      { id, workspace },
      `Preserve work, then archive workspace ${workspace} and branch after custody transfer`,
    );
    await superviseSession(e, id, t, workspace, join(root, `worker-${id}.jsonl`));
  } catch (error) {
    e.finish(id, false);
    s.event(`failure:${id}`, "worker-failure", {error: String(error)}, "Reconcile preserved work and native session; never blindly retry");
  } finally {
    s.db.query("UPDATE sessions SET pid=NULL WHERE id=?").run(id);
    s.close();
  }
}
// Shared execution path for admitted workers and owner-run disposable rehearsals.
// This function does not admit work or create qualification evidence.
export async function superviseSession(e: Engine, id: string, t: Ticket, workspace: string, logPath: string) {
  e.s.atomic(() => {
    const session = e.sessions().find(x => x.id === id);
    if (!session || session.pid !== process.pid || session.status !== "starting" || e.s.get("paused") !== false)
      throw Error("owned starting supervisor required");
    if (!e.s.event(`native-start:${id}`, "native-start-attempt", {id}, "Never replay this native start; reconcile retained custody"))
      throw Error("native start already attempted");
  });
  const start = Date.now();
  let child: ReturnType<typeof spawnWorker> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fd: number | undefined;
  let halt: (() => void) | undefined;
  try {
    const settingsPath = logPath + ".settings.json";
    const spec = materializeSettings(workerSpec(t, workspace), settingsPath);
    if (spec.settings) e.s.event(`native-settings:${id}`, "native-settings", {id, path:settingsPath, settings:spec.settings}, "Retain the per-run settings with native receipts; requalify policy changes");
    fd = openSync(logPath, "ax", 0o600);
    child = spawnWorker(spec, workspace, fd);
    e.s.event(`native-process:${id}`, "native-process", {id, pid:child.pid, processGroup:child.pid, identity:child.pid ? processIdentity(child.pid) : null}, "Reconcile process identity and group before archiving; retain native receipts");
    e.register(id, process.pid, spec.nativeId ?? null);
    let stop = false,
      totalTokens = 0,
      completed = false;
    const accounting = new WorkerAccounting();
    let native: NativeReceipt | undefined = spec.nativeId ? new NativeReceipt(t.provider,spec.nativeId,workspace,spec.env.HOME,start) : undefined;
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
        checkStreamModel();
        if(native) {
          const evidence=native.evidence(t.model ?? (t.provider==="codex" ? "gpt-6.1-sol" : "opus"),t.effort ?? "medium");
          e.s.set(`native-evidence:${id}`,evidence);
          if(evidence.conflict) {e.s.set(`stop:${id}`,{reason:"native model/effort conflict"});halt!();}
        }
      } catch(error) {e.s.set(`stop:${id}`,{reason:String(error)});halt!();}
      e.account(id,(Date.now()-start)/1000,totalTokens);
    };
    let stopping: Promise<void> | undefined;
    halt = () => {
      if (stop) return;
      stop = true;
      stopping = child!.stop();
      // Cleanup is awaited below; attach a handler now while stdout is draining.
      void stopping.catch(() => {});
    };
    process.on("SIGTERM", halt);
    process.on("SIGINT", halt);
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
          if(native && native.id!==event.native)throw Error("native ID changed");
          native ??= new NativeReceipt(t.provider,event.native,workspace,spec.env.HOME,start);
          e.register(id, process.pid, event.native);
        }
        if (event.tokens !== undefined) totalTokens = event.tokens;
        if (event.done) completed = true;
        e.account(id, (Date.now() - start) / 1000, totalTokens);
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
      process.off("SIGTERM", halt);
      process.off("SIGINT", halt);
    }
    if (fd !== undefined) closeSync(fd);
    try {
      if (child) {
        try { await child.stop(); }
        finally { await child.exited; }
      }
    } finally { e.s.db.query("UPDATE sessions SET pid=NULL WHERE id=?").run(id); }
  }
}
if (import.meta.main) await runWorker(process.argv[2]);
