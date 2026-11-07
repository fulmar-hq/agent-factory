import { join } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { configAt, root } from "../launcher/config";
import { Store } from "../tracking/store";
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
      "supported: pause, resume, qa-accepted REV DAY RECEIPT, release qa|production REV RECEIPT, clear-aws-stop RECEIPT",
    );
} finally {
  s.close();
}
