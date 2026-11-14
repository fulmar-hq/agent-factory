import { prepareDelivery } from "../adapters/delivery";
import { calibrateTokens } from "../launcher/budgets";
import { spawnSupervisor } from "../launcher/tick";
import { join } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { configAt, root } from "../launcher/config";
import { Store } from "../tracking/store";
import { approveIntake } from "../adapters/github";
import { Engine, pauseOwner } from "../launcher/engine";
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
    e.pause(action === "pause", "owner",args[0]===undefined?undefined:pauseOwner(args[0]));
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
  else if (action === "continue-session") console.log(e.continueSession(args[0],args[1],()=>spawnSupervisor(args[0],root)));
  else if (action === "approve-intake")
    await approveIntake(args[0], Number(args[1]), s, args[2]);
  else if (action === "archive") e.archive(args[0], args[1], "owner");
  else if (action === "clear-aws-stop") {
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
      "supported: clear-restart-hold REPO PROVIDER CAUSE REPAIR-RECEIPT, prepare-delivery SESSION RECEIPT, calibrate-tokens TORONTO-DAY RECEIPT, continue-session SESSION RECEIPT, approve-intake REPO ISSUE OWNER-RECEIPT, archive SESSION CUSTODY-RECEIPT, pause, resume, clear-aws-stop RECEIPT",
    );
} finally {
  s.close();
}
