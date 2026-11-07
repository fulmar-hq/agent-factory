import { join } from "node:path";
import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { Engine, usageGate } from "./engine";
import { configAt, root, optionalJSON, QualificationSchema } from "./config";
import { Store } from "../tracking/store";
import {
  workerSpec,
  sessionEvent,
  verifySubscription,
} from "../adapters/workers";
import { command } from "../adapters/github";
export async function runWorker(id: string) {
  const c = await configAt(),
    s = new Store(join(root, "controller.sqlite")),
    e = new Engine(s, c);
  const x = e.sessions().find((x) => x.id === id);
  // Atomic supervisor custody: two supervisor processes cannot both start the same reservation.
  if (
    !x ||
    x.status !== "starting" ||
    !s.atomic(
      () =>
        s.db
          .query(
            "UPDATE sessions SET pid=? WHERE id=? AND status='starting' AND pid IS NULL",
          )
          .run(process.pid, id).changes === 1,
    )
  ) {
    s.close();
    return;
  }
  const t = JSON.parse(x.brief),
    start = Date.now();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let fd: number | undefined;
  let halt: (() => void) | undefined;
  try {
    const qs = (await optionalJSON(
      join(root, "qualifications.json"),
    )) as Record<string, unknown> | null;
    const q = QualificationSchema.parse(qs?.[t.provider]);
    if (
      q.expiresAt <= start ||
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
    const spec = workerSpec(t, workspace);
    fd = openSync(join(root, `worker-${id}.jsonl`), "ax", 0o600);
    child = Bun.spawn(spec.argv, {
      cwd: workspace,
      env: spec.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: fd,
    });
    e.register(id, process.pid, spec.nativeId ?? null);
    let stop = false,
      totalTokens = 0,
      completed = false;
    halt = () => {
      if (stop) return;
      stop = true;
      child?.kill("SIGTERM");
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 3000);
    };
    process.on("SIGTERM", halt);
    process.on("SIGINT", halt);
    timer = setInterval(() => {
      e.account(id, (Date.now() - start) / 1000, totalTokens);
      const state = e.sessions().find((a) => a.id === id);
      if (
        s.get("paused") !== false ||
        s.get(`stop:${id}`) ||
        state?.status === "paused"
      )
        halt!();
    }, 500);
    let pending = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      writeSync(fd, text);
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const event = sessionEvent(t.provider, line);
        if (event.native) e.register(id, process.pid, event.native);
        if (event.tokens !== undefined) totalTokens += event.tokens;
        if (event.done) completed = true;
        e.account(id, (Date.now() - start) / 1000, totalTokens);
        if (e.sessions().find((x) => x.id === id)?.status === "paused") halt();
      }
    }
    const code = await child.exited;
    clearInterval(timer);
    if (killTimer) clearTimeout(killTimer);
    closeSync(fd);
    fd = undefined;
    if (stop)
      s.db.query("UPDATE sessions SET status='paused' WHERE id=?").run(id);
    else e.finish(id, code === 0 && completed);
  } catch (error) {
    e.finish(id, false);
    s.event(
      `failure:${id}`,
      "worker-failure",
      { error: String(error) },
      "Reconcile preserved work and native session; never blindly retry",
    );
  } finally {
    if (timer) clearInterval(timer);
    if (killTimer) clearTimeout(killTimer);
    if (halt) {
      process.off("SIGTERM", halt);
      process.off("SIGINT", halt);
    }
    if (fd !== undefined) closeSync(fd);
    if (child) {
      child.kill("SIGTERM");
      const finalKill = setTimeout(() => child?.kill("SIGKILL"), 3000);
      try {
        await child.exited;
      } finally {
        clearTimeout(finalKill);
      }
    }
    s.db.query("UPDATE sessions SET pid=NULL WHERE id=?").run(id);
    s.close();
  }
}
if (import.meta.main) await runWorker(process.argv[2]);
