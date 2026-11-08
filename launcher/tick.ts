import { join } from "node:path";
import { Engine, type Admission } from "./engine";
import {
  configAt,
  root,
  inputs,
  optionalJSON,
  type Qualification,
  type Ticket,
} from "./config";
import { Store } from "../tracking/store";
import { localReadings } from "../adapters/usage";
import { verifySubscription } from "../adapters/workers";
import { observeBilling } from "../wallet/ledger";
import { reconcile, command, validateIntake, setBuilding } from "../adapters/github";
import { qualificationAlerts } from "./alerts";
export async function launchReady(e: Engine, t: Ticket, a: Admission, spawn: (id: string) => void, execute = command, clock = Date.now) {
  await validateIntake(t, execute);
  // No await between fresh validation and the atomic reservation/spawn attempt.
  const session = e.s.atomic(() => {
    const session = e.admit(t, { ...a, now: clock() });
    if (!e.claimStart(session.id)) throw Error("start refused");
    spawn(session.id);
    return session;
  });
  // Once spawned, a label failure must never roll back custody or retry work.
  try {
    await setBuilding(t, e.s, execute);
  } catch (error) {
    e.s.event(`label-failure:${session.id}`, "github-state-failure", { error: String(error) }, "Reconcile labels; retain the stable launch claim.");
  }
  return session;
}
export function spawnSupervisor(id: string, dir: string) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "worker.ts"), id], {
    env: { ...process.env, FACTORY_PRIVATE_DIR: dir },
    // launchd terminates the tick's remaining process group when the tick exits.
    // unref alone only releases Bun's event loop; it does not create a new group.
    detached: true,
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  p.unref();
}
export async function tick(dir = root) {
  const c = await configAt(join(dir, "config.yaml")),
    s = new Store(join(dir, "controller.sqlite"));
  try {
    const e = new Engine(s, c),
      now = Date.now();
    s.set("heartbeat", { at: now, status: "reconciling" });
    const qualifications = ((await optionalJSON(join(dir, "qualifications.json"))) ?? {}) as Record<string, Qualification>;
    qualificationAlerts(s, qualifications, now);
    const versions: Record<string, string> = { bun: Bun.version };
    for (const cmd of ["codex", "claude", "gh"])
      try {
        versions[cmd] = (await command([cmd, "--version"])).split("\n")[0];
      } catch {
        versions[cmd] = "unavailable";
      }
    s.set("versions", versions);
    // Never replay starting/running/unknown records. The persistent claim retains custody.
    for (const x of e.active()) {
      if (x.started && ["starting", "running"].includes(x.status))
        e.account(x.id, (now - x.started) / 1000, x.actual_tokens, now);
      const current = e.sessions().find((a) => a.id === x.id)!;
      if (current.status === "paused" || s.get("paused") === true)
        s.set(`stop:${x.id}`, {
          at: now,
          reason: "checkpoint and stop requested",
        });
    }
    const r = await inputs(dir);
    const local = dir === root ? await localReadings(now) : { codex: undefined, claude: undefined };
    for (const provider of ["codex", "claude"] as const) {
      const meter = local[provider];
      if (meter && (!r[provider] || meter.observedAt > r[provider]!.observedAt)) r[provider] = meter;
    }
    s.set("readings", r);
    observeBilling(s, c, r.billing, now);
    const ready = await reconcile(s, c, now);
    const verified = new Set<string>();
    const installations = ((await optionalJSON(
      join(dir, "repositories.json"),
    )) ?? {}) as Record<string, string>;
    const refusals: { ticket: string; reason: string }[] = [];
    let claimed = 0;
    for (const t of ready) {
      try {
        if (!installations[t.repo])
          throw Error("repository workspace not configured");
        if (!verified.has(t.provider)) {
          await verifySubscription(t.provider);
          verified.add(t.provider);
        }
        const session = await launchReady(e, t, {
          now: Date.now(),
          meter: r[t.provider],
          billing: r.billing,
          qualification: qualifications[t.provider],
        }, (id) => spawnSupervisor(id, dir));
        s.db
          .query("UPDATE tickets SET decision=? WHERE id=?")
          .run("claimed", session.ticket);
        claimed++;
      } catch (error) {
        refusals.push({ ticket: `${t.repo}#${t.number}`, reason: String(error) });
        s.db
          .query("UPDATE tickets SET decision=? WHERE id=?")
          .run(String(error), `${t.repo}#${t.number}`);
      }
    }
    const heartbeat = { at: Date.now(), status: "ok", ready: ready.length,
      paused: s.get("paused") === true, claimed, refusals };
    s.set("heartbeat", heartbeat);
    return heartbeat;
  } finally {
    s.close();
  }
}
// launchd routes stdout to tick.log; exactly one summary for success or error.
export async function tickSummary(run: () => Promise<{ at: number; status: string; ready: number; paused?: boolean; claimed?: number; refusals?: { ticket: string; reason: string }[] }> = () => tick(), emit = console.info) {
  try {
    const result = await run();
    emit(JSON.stringify(result));
    return result;
  } catch (error) {
    emit(JSON.stringify({ at: Date.now(), status: "error", error: String(error) }));
    throw error;
  }
}
if (import.meta.main) {
  try { await tickSummary(); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
