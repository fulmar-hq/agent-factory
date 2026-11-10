// Explicit, harmless owner-run live check. No admission, qualification, daemon,
// release, or production controller rows are created by this script.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { browserArgs, browserCommand, browserNativeEvidence, verifyBrowserPageReceipt } from "../adapters/browser";
import { BrowserNeeded, BrowserResult, browserBrief, readBrowserJSON, type BrowserJob } from "../launcher/browser";
import { root } from "../launcher/config";
import { verifySubscription } from "../adapters/workers";

export async function rehearseBrowser(url:string,cwd:string) {
  const at=Date.now(),native=randomUUID(),dir=join(root,"browser-rehearsals",native);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const job:BrowserJob={id:native,kind:"browser",parent:"owner-run-harmless-rehearsal",issue:1,repo:"example/rehearsal",state:"starting",at,deadline:at+300000,runDeadline:at+300000,nonce:randomUUID(),native,
    request:BrowserNeeded.parse({result:"BROWSER_NEEDED",url,goal:"Read the board status line verbatim. If a sign-in page appears, stop and report it without interacting.",noCliApi:"This rehearsal explicitly tests the authenticated Chrome browser path, not an HTTP/CLI substitute.",expectedEvidence:"Exact visible status line, or the exact sign-in blocker; tab creation and closure."})};
  const path=join(dir,"result.json"),brief=browserBrief(job,path);
  writeFileSync(join(dir,"brief.txt"),brief,{mode:0o600});
  await verifySubscription("claude");
  const started=await browserCommand(browserArgs(job,brief,path),cwd);
  writeFileSync(join(dir,"start.txt"),started,{mode:0o600});
  const handle=started.match(/backgrounded\s*·\s*([a-f0-9]{8,36})/)?.[1];
  if(!handle)throw Error(`unverified background start; retained ${dir}`);
  console.info(JSON.stringify({handle,dir,status:"started"}));
  try {
    while(Date.now()<job.deadline) {
      await new Promise(r=>setTimeout(r,5000));
      const agents=JSON.parse(await browserCommand(["claude","agents","--json","--all"])) as {sessionId:string;state?:string;status?:string}[];
      const a=agents.find(a=>a.sessionId.startsWith(handle));
      if(a?.status==="idle" || ["blocked","done","stopped"].includes(a?.state ?? "")) {
        const receipt=BrowserResult.parse(readBrowserJSON(path));
        if(receipt.nonce!==job.nonce)throw Error("rehearsal nonce mismatch");
        const proof=browserNativeEvidence(a!.sessionId,cwd);
        writeFileSync(join(dir,"native-evidence.json"),JSON.stringify(proof),{mode:0o600});
        if(!proof.verified)throw Error("rehearsal native evidence unverified");
        verifyBrowserPageReceipt(receipt,proof);
        job.native=a!.sessionId;
        writeFileSync(join(dir,"job.json"),JSON.stringify(job),{mode:0o600});
        console.info(JSON.stringify({native:job.native,receipt,nativeVerified:proof.verified}));
        return {job,dir,receipt};
      }
    }
    throw Error("live browser rehearsal timeout");
  } finally {await browserCommand(["claude","stop",handle]);}
}
if(import.meta.main)await rehearseBrowser(process.argv[2] ?? "https://factory.goalido.com",process.argv[3] ?? process.cwd());
