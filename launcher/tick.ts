import {githubContext,unavailable} from '../adapters/github-budget';
import {githubHealth,recordLateGithubFailure} from './github-health';
import {mkdirSync,openSync,closeSync} from "node:fs";
import {diskReading,observeDisk} from "./disk";
import { resolveQuestions } from "./questions";
import {claimableReady,reviewPublished} from './queue';
import {observeClaimProgress} from './watchdog';
import { memoryPressure, reconcileCapacity } from "./capacity";
import { applyOwnerResults, autoApprove, supply, failures, expireDecisions, autonomyEffects } from "./autonomy";
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
import { branchFor, isDeliveryRepo, executableTest } from "../adapters/delivery";
import { Store } from "../tracking/store";
import { localReadings } from "../adapters/usage";
import { verifySubscription } from "../adapters/workers";
import { observeBilling } from "../wallet/ledger";
import { reconcile, command, validateIntake, setBuilding } from "../adapters/github";
import {recoverWorkers,localWakes,githubWakes,pendingWakes,dispatchWake,spawnOwner} from "./wake";
import {qualificationAlerts,watchdogAlert,diskCapacityAlert,healthOwnsAlerts} from "./alerts";
import {scheduleCodexRenewal} from "./codex-renewal";

import { reconcileBrowsers } from "./browser";
import { nativeBrowserPorts } from "../adapters/browser";
import { qualificationFor } from "./usage-push-policy";
export async function launchReady(e: Engine, t: Ticket, a: Admission & { qualifications?: unknown }, spawn: (id: string) => void, execute = command, clock = Date.now) {
  if(!e.slots().free)throw Error('slots full');
  if(isDeliveryRepo(t.repo))executableTest(t.test);
  const prior = e.retryPrior(t);
  const retryNoPr: string[] = [];
  for (const x of prior) {
    const prs: unknown = JSON.parse(await execute(["gh", "pr", "list", "--repo", t.repo, "--head", branchFor(x.id), "--state", "all", "--limit", "1", "--json", "number"]));
    if (!Array.isArray(prs) || prs.length) throw Error("retry prior PR exists or unknown");
    retryNoPr.push(x.id);
  }
  await validateIntake(t, execute);
  // No await between fresh validation and the atomic reservation/spawn attempt.
  const session = e.s.atomic(() => {
    const now = clock();
    const qualification = Object.hasOwn(a, "qualifications") ? qualificationFor(a.qualifications, e.c, t, now) : a.qualification;
    const session = e.admit(t, { ...a, qualification, retryNoPr, now });
    if (!e.claimStart(session.id)) throw Error("start refused");
    spawn(session.id);
    return session;
  });
  // Once spawned, a label failure must never roll back custody or retry work.
  try {
    await setBuilding(t, e.s, execute);
  } catch (error) {
    if(unavailable(error))recordLateGithubFailure(e.s,error);
    e.s.event(`label-failure:${session.id}`, "github-state-failure", { error: String(error) }, "Reconcile labels; retain the stable launch claim.");
  }
  return session;
}
export function spawnSupervisor(id: string, dir: string) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "worker-entry.ts"), id], {
    env: { ...process.env, FACTORY_PRIVATE_DIR: dir },
    // launchd terminates the tick's remaining process group when the tick exits.
    // unref alone only releases Bun's event loop; it does not create a new group.
    detached: true,
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  p.unref();
}
export async function tick(dir=root){return githubContext.run(dir,()=>tickOnce(dir));}
async function tickOnce(dir:string) {
  const c = await configAt(join(dir, "config.yaml")),
    s = new Store(join(dir, "controller.sqlite"));
  let claimed = 0;
  try {
    const e = new Engine(s, c),
      now = Date.now();
    observeDisk(s,diskReading(dir,now));
    diskCapacityAlert(s,now);
    const priorHeartbeat=s.get<{ready?:number|null;lastKnownReady?:number|null}>('heartbeat');
    s.set("heartbeat", { at: now, status: "reconciling",lastKnownReady:priorHeartbeat?.ready??priorHeartbeat?.lastKnownReady??null });
    const qualifications = ((await optionalJSON(join(dir, "qualifications.json"))) ?? {}) as Record<string, Qualification>;
    if(!healthOwnsAlerts(dir,now))qualificationAlerts(s, qualifications, now);
    localWakes(s,c,[],qualifications,now);

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
      if (x.started && ["starting", "running"].includes(x.status)) {
        const clock=s.get<{at:number;seconds:number}>(`active-clock:${x.id}`);
        e.account(x.id, clock ? clock.seconds+(now-clock.at)/1000 : (now-x.started)/1000, x.actual_tokens, now);
      }
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
    for (const provider of ["codex", "claude"] as const) e.refreshUsage(provider, r[provider], Date.now());
    const evaluateRenewal=()=>{try {const renewal=scheduleCodexRenewal(e,dir,join(import.meta.dir,".."),versions.codex!,id=>{
      mkdirSync(join(dir,"logs"),{recursive:true,mode:0o700});const fd=openSync(join(dir,"logs",`codex-renewal-${id}.log`),"ax",0o600);
      try{const child=Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/renew-codex.ts"),id],{env:{...process.env,FACTORY_PRIVATE_DIR:dir},detached:true,stdin:"ignore",stdout:fd,stderr:fd});child.unref();}finally{closeSync(fd);}
    });s.set("codex-renewal-evaluation",renewal);}catch(error){s.set("codex-renewal-evaluation",{state:"refused",at:Date.now(),nextCheckAt:Date.now()+60000,error:String(error)});s.event(crypto.randomUUID(),"codex-renewal-scheduler-refusal",{error:String(error)},"Retain refusal; qualification and capacity gates remain closed");}};
    evaluateRenewal();

    observeBilling(s, c, r.billing, now);
    await autonomyEffects(s,()=>reconcileBrowsers(e,dir,nativeBrowserPorts(e,dir,id=>spawnSupervisor(id,dir)),Date.now()));
    reconcileCapacity(s,c,e.active().filter(x=>["starting","running"].includes(x.status)).length,await memoryPressure(),now);
    expireDecisions(s,now);
    failures(e,now);
    let autoResolved = resolveQuestions(e,now);
    let observed = await reconcile(s,c,now,command,'open');
    let health=githubHealth(s,c,now);
    if(health){s.set('heartbeat',health);return health;}
    recoverWorkers(e,now);
    if(await reviewPublished(e))observed=await reconcile(s,c,now,command,'open');
    health=githubHealth(s,c,Date.now());
    if(health){s.set('heartbeat',health);return health;}
    let ready = claimableReady(e,observed);
    const autoApproved=c.autonomy && s.get("paused")===false ? await autonomyEffects(s,async()=>{
      await applyOwnerResults(e,dir,r.billing,now);
      ready=claimableReady(e,await reconcile(s,c,now,command,'open'));
      const count=await autoApprove(e,ready,r.billing,now,undefined,dir);
      if(count)ready=claimableReady(e,await reconcile(s,c,now,command,'open'));
      return count;
    }) ?? 0 : 0;
    health=githubHealth(s,c,Date.now());
    if(health){s.set('heartbeat',health);return health;}
    localWakes(s,c,ready,{},now);
    let ownerReconciled=true;
    try {await githubWakes(s,c,command,now);}
    catch(error){ownerReconciled=false;recordLateGithubFailure(s,error);s.event(crypto.randomUUID(),"owner-reconciliation-failure",{error:String(error)},"Retain the last successful timestamp; retry read-only reconciliation");}
    health=githubHealth(s,c,Date.now());
    if(health){s.set('heartbeat',health);return health;}
    if(ownerReconciled && Object.values(c.projects).every(p=>{
      const state=s.get<{error?:string;truncated?:boolean}>(`github:${p.repo}`);return state && !state.error && !state.truncated;
    }))s.set("last-successful-reconciliation",Date.now());
    const verified = new Set<string>();
    const installations = ((await optionalJSON(
      join(dir, "repositories.json"),
    )) ?? {}) as Record<string, string>;
    const refusals: { ticket: string; reason: string }[] = [];
    // Reconciliation may outlive a worker cohort. Reserve renewal before new
    // ordinary claims consume the slots that became free during those reads.
    evaluateRenewal();
    for (const t of ready) {
      if(!e.slots().free)break;
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
          qualifications,
          recoverUsage: true,
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
        if(unavailable(error)){recordLateGithubFailure(s,error);break;}
      }
      if(githubHealth(s,c,Date.now()))break;
    }
    const degraded=()=>{
      const health=githubHealth(s,c,Date.now());
      if(!health)return;
      const heartbeat={...health,claimed,refusals,autoApproved,autoResolved};
      s.set('heartbeat',heartbeat);return heartbeat;
    };
    let failed=degraded();if(failed)return failed;
    // The lease may wait; recheck immediately inside its effects boundary too.
    await autonomyEffects(s,async()=>{if(!githubHealth(s,c,Date.now()))supply(e,ready,Date.now(),{claimed,refusals});});
    failed=degraded();if(failed)return failed;
    if(s.get("paused")===false)for(const w of pendingWakes(s)){
      failed=degraded();if(failed)return failed;
      dispatchWake(s,w,id=>spawnOwner(id,dir));
    }
    failed=degraded();if(failed)return failed;
    autoResolved += resolveQuestions(e);
    const heartbeat = { at: Date.now(), status: ownerReconciled ? "ok" : "degraded", ready: ready.length,
      paused: s.get("paused") === true, autoApproved, autoResolved, claimed, refusals };
    observeClaimProgress(e,heartbeat);
    watchdogAlert(s,heartbeat.at);
    s.set("heartbeat", heartbeat);
    s.set("last-successful-heartbeat",heartbeat);
    return heartbeat;
  } catch(error) {
    if(!unavailable(error))throw error;
    recordLateGithubFailure(s,error);
    const health=githubHealth(s,c,Date.now())!;
    const heartbeat={...health,claimed};s.set('heartbeat',heartbeat);return heartbeat;
  } finally {
    s.close();
  }
}
// launchd routes stdout to tick.log; exactly one summary for success or error.
export async function tickSummary(run: () => Promise<{ at: number; status: string; ready: number|null; paused?: boolean; claimed?: number; refusals?: { ticket: string; reason: string }[] }> = () => tick(), emit = console.info) {
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
