import { prepareDelivery } from "../adapters/delivery";
import { calibrateTokens } from "../launcher/budgets";
import { spawnSupervisor } from "../launcher/tick";
import {existsSync,realpathSync} from "node:fs";
import {NativeReceipt} from "../adapters/native";
import {WorkerAccounting} from "../adapters/workers";
import {processIdentity} from "../launcher/process";
import { join } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { configAt, root } from "../launcher/config";
import { Store } from "../tracking/store";
import { approveIntake } from "../adapters/github";
import { Engine } from "../launcher/engine";
// Local protected executor interface. Never give this token to workers.
const expected = (await Bun.file(join(root, "owner-token")).text()).trim(),
  provided = process.env.FACTORY_OWNER_TOKEN ?? "";
if (
  provided.length !== expected.length ||
  !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
)
  throw Error("owner authorization required");
const s = new Store(join(root, "controller.sqlite")),
  e = new Engine(s, await configAt());
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "pause" || action === "resume")
    e.pause(action === "pause", "owner");
  else if(action==="register-owner") {
    const [owner,path,nativeArg,pidArg,receipt]=args;
    const role=e.c.owners[owner],native=nativeArg==="new" ? undefined : nativeArg;
    if(!role || !path || !existsSync(path) || !receipt || !/^\d+$/.test(pidArg ?? ""))throw Error("owner, existing workspace, native ID/new, PID/0 and receipt required");
    const workspace=realpathSync(path),pid=Number(pidArg) || undefined;
    if(native && !/^[a-f0-9-]{36}$/.test(native))throw Error("native ID refused");
    if(native) {
      const started=role.harness==="codex" ? Number.parseInt(native.replaceAll("-","").slice(0,12),16) : Date.now();
      const proof=new NativeReceipt(role.harness,native,workspace,process.env.HOME!,started),accounting=new WorkerAccounting();
      for(let i=0;i<256;i++){proof.poll(accounting);if(proof.caughtUp)break;}
      if(!proof.evidence(role.model,role.effort).bound || !proof.caughtUp)throw Error("owner native custody unverified");
    }
    const identity=pid ? processIdentity(pid) : undefined;if(pid && !identity)throw Error("owner process absent");
    const previous=s.get<{pid?:number;identity?:string;native?:string;wake?:string}>(`owner-runtime:${owner}`);
    if(previous?.wake){const last=s.get<{state:string;cleanupVerified?:boolean}>(`owner-wake:${previous.wake}`);if(last && (["starting","running"].includes(last.state) || last.cleanupVerified!==true))throw Error("owner wake custody unresolved");}
    if(previous?.pid && processIdentity(previous.pid)===previous.identity && previous.native!==native)throw Error("existing owner is active");
    s.atomic(()=>{s.set(`owner-runtime:${owner}`,{workspace,native,pid,identity});s.event(randomUUID(),"owner-registration",{owner,workspace,native,pid,identity,receipt,previous},"Reconcile active native custody before restoring prior registration; retain sessions and logs");});
  }
  else if (action === "clear-restart-hold") {
    const [repo,provider,cause,receipt]=args;
    if(!Object.values(e.c.projects).some(p=>p.repo===repo) || !["codex","claude"].includes(provider) || !["budget","sandbox","test","publisher","timeout","unknown"].includes(cause) || !receipt?.trim())throw Error("enrolled repo, provider, cause and repair receipt required");
    const key=`restart-held:${repo}:${provider}:${cause}`;
    s.atomic(()=>{const previous=s.get(key);s.set(key,null);s.event(randomUUID(),"restart-hold-cleared",{repo,provider,cause,receipt,previous},"Restore the prior hold after reconciling new attempts; preserve all failure evidence");});
  }
  else if (action === "calibrate-tokens") {
    const [dates,receipt] = args;
    if (!receipt) throw Error("calibration receipt required");
    const calibration = calibrateTokens(process.env.HOME!,dates);
    s.atomic(() => {
      s.set("token-calibration:codex",calibration.tokens);
      s.event(randomUUID(),"token-calibration",{...calibration,receipt},"Append a new owner calibration; preserve frozen original estimates");
    });
    console.log(JSON.stringify({...calibration,sources:calibration.sources.length}));
  }
  else if (action === "prepare-delivery") {
    const [id,receipt]=args;
    const x=e.sessions().find(x=>x.id===id);
    if(!x || x.pid!==null || !["finished","paused"].includes(x.status) || !receipt)throw Error("stopped custody and receipt required");
    const t=JSON.parse(x.brief);
    if(t.repo!=="fulmar-hq/alido")throw Error("delivery repository refused");
    const repos=await Bun.file(join(root,"repositories.json")).json();
    const archive=join(root,"runs","delivery",id,randomUUID());
    await prepareDelivery(join(root,"workspaces",id),repos[t.repo],archive,id);
    s.event(randomUUID(),"delivery-workspace",{id,receipt,archive},"Archive replacement links and restore saved originals; preserve source edits and history");
    console.log(archive);
  }
  else if (action === "qualify-delivery") {
    throw Error("publisher blocked: legacy delivery qualification cannot authorize launcher publication; full v2 native isolation and verified published-tree evidence required");
  }
  else if (action === "continue-session") console.log(e.continueSession(args[0],args[1],()=>spawnSupervisor(args[0],root)));
  else if (action === "approve-intake")
    await approveIntake(args[0], Number(args[1]), s, args[2]);
  else if (action === "archive") e.archive(args[0], args[1], "owner");
  else if (action === "qa-accepted") {
    const [revision, day, receipt] = args;
    if (
      !/^[a-f0-9]{40}$/.test(revision ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ||
      !receipt
    )
      throw Error(
        "revision, Toronto day and independent Quality receipt required",
      );
    if (
      !s.db
        .query(
          "SELECT id FROM releases WHERE day=? AND stage='qa' AND revision=?",
        )
        .get(day, revision)
    )
      throw Error("QA authorization missing");
    s.atomic(() => {
      s.set("qa-acceptance", { revision, day, receipt });
      s.event(
        randomUUID(),
        "qa-accepted",
        { revision, day, receipt },
        "Append corrected acceptance; do not erase the original",
      );
    });
  } else if (action === "release") {
    const [stage, revision, receipt] = args;
    if (stage !== "qa" && stage !== "production") throw Error("unknown stage");
    console.log(e.release(stage, revision, receipt, "release"));
  } else if (action === "clear-aws-stop") {
    if (!args[0]) throw Error("owner decision receipt required");
    s.atomic(() => {
      s.set("aws-stop-latched", false);
      s.event(
        randomUUID(),
        "owner-clear-aws-stop",
        { receipt: args[0] },
        "Restore aws-stop-latched=true; caps are unchanged",
      );
    });
  } else
    throw Error(
      "supported: clear-restart-hold REPO PROVIDER CAUSE REPAIR-RECEIPT, register-owner ROLE WORKSPACE NATIVE/new PID/0 RECEIPT, prepare-delivery SESSION RECEIPT, qualify-delivery RECEIPT, calibrate-tokens TORONTO-DAY RECEIPT, continue-session SESSION RECEIPT, approve-intake REPO ISSUE OWNER-RECEIPT, archive SESSION CUSTODY-RECEIPT, pause, resume, qa-accepted REV DAY RECEIPT, release qa|production REV RECEIPT, clear-aws-stop RECEIPT",
    );
} finally {
  s.close();
}
