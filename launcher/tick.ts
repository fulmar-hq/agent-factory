import { existsSync } from "node:fs";
import { processTelegramMail } from "./telegram";
import { join } from "node:path";
import { Engine } from "./engine";
import {
  configAt,
  root,
  inputs,
  optionalJSON,
  type Qualification,
} from "./config";
import { Store } from "../tracking/store";
import { codexReading } from "../adapters/usage";
import { verifySubscription } from "../adapters/workers";
import { observeBilling } from "../wallet/ledger";
import { reconcile, command, markBuilding } from "../adapters/github";
export async function tick(dir = root) {
  const c = await configAt(join(dir, "config.yaml")),
    s = new Store(join(dir, "controller.sqlite"));
  try {
    const e = new Engine(s, c),
      now = Date.now();
    s.set("heartbeat", { at: now, status: "reconciling" });
    const mailPath = join(dir, "telegram-mail.sqlite");
    if (existsSync(mailPath)) processTelegramMail(s, c, mailPath);
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
    const ready = await reconcile(s, c, now),
      r = await inputs(dir);
    const local = dir === root ? await codexReading(now) : undefined;
    if (local && (!r.codex || local.observedAt > r.codex.observedAt))
      r.codex = local;
    s.set("readings", r);
    observeBilling(s, c, r.billing, now);
    const qualifications = ((await optionalJSON(
      join(dir, "qualifications.json"),
    )) ?? {}) as Record<string, Qualification>;
    const verified = new Set<string>();
    const installations = ((await optionalJSON(
      join(dir, "repositories.json"),
    )) ?? {}) as Record<string, string>;
    for (const t of ready) {
      try {
        if (!installations[t.repo])
          throw Error("repository workspace not configured");
        if (!verified.has(t.provider)) {
          await verifySubscription(t.provider);
          verified.add(t.provider);
        }
        const session = e.admit(t, {
          now: Date.now(),
          meter: r[t.provider],
          billing: r.billing,
          qualification: qualifications[t.provider],
        });
        // Claim is durable BEFORE spawn. Crash here sacrifices liveness, never uniqueness.
        if (e.claimStart(session.id)) {
          await markBuilding(t, s);
          const p = Bun.spawn(
            [process.execPath, join(import.meta.dir, "worker.ts"), session.id],
            {
              env: { ...process.env, FACTORY_PRIVATE_DIR: dir },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          );
          p.unref();
        }
        s.db
          .query("UPDATE tickets SET decision=? WHERE id=?")
          .run("claimed", session.ticket);
      } catch (error) {
        s.db
          .query("UPDATE tickets SET decision=? WHERE id=?")
          .run(String(error), `${t.repo}#${t.number}`);
      }
    }
    s.set("heartbeat", { at: Date.now(), status: "ok", ready: ready.length });
  } finally {
    s.close();
  }
}
if (import.meta.main) await tick();
