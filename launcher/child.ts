import { spawn } from "node:child_process";
import type { WorkerSpec } from "../adapters/workers";
// A private process group lets stop reach ordinary shell/tool descendants even
// when the native CLI exits first. Escaped groups still require boundary proof.
export function spawnWorker(spec: WorkerSpec, cwd: string, stderr: number) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", stderr],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let stopping: Promise<void> | undefined;
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, value); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  return {
    pid: child.pid,
    stdout: child.stdout!,
    exited,
    stop: () => stopping ??= (async () => {
      if (!signal("SIGTERM")) return;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!child.pid) return;
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          throw error;
        }
      }
      signal("SIGKILL");
    })(),
  };
}
