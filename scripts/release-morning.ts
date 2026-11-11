// Runs the morning release-inputs check once. The LaunchAgent starts it at
// 09:00, 12:00, 16:45 and 17:35; it can also be run by hand at any time. It
// collects readiness the way the rehearsal does (the same reads, no release
// effect, no wallet observation) and prints its report as one JSON line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseBilling } from "../adapters/billing";
import { claudeStatus, localReadings } from "../adapters/usage";
import { configAt, root, type Billing } from "../launcher/config";
import { toronto } from "../launcher/release";
import { withReleaseAuth } from "../launcher/release-auth";
import { readReleaseBatch, type ReleaseBatch } from "../launcher/release-batch";
import { installedRevision, runMorningCheck } from "../launcher/release-morning";
import { collectReleaseReadiness } from "../launcher/release-readiness";
import { Store } from "../tracking/store";
import { awsRefusal } from "../wallet/ledger";
import { releaseAvailable } from "../wallet/release";

const checkout = join(import.meta.dir, "..");
let revision: string | undefined;
try {
  revision = installedRevision(checkout);
} catch {
  // The check reports an unreadable revision itself.
}
const s = new Store(join(root, "controller.sqlite"));
try {
  const evidence: Record<string, unknown> = {};
  const report = await runMorningCheck({
    dir: root,
    store: s,
    installed: () => revision ?? installedRevision(checkout),
    evidence,
    collect: async (now) => {
      const c = await configAt(join(root, "config.yaml"));
      let batch: ReleaseBatch | undefined;
      try {
        batch = readReleaseBatch(root, toronto(now).day);
      } catch {
        // No batch for today yet is a finding, not a crash.
      }
      let billing: Billing | undefined;
      let billingRefusal: string | null;
      try {
        billing = await withReleaseAuth(root, () => releaseBilling(root));
        // Judged as of now: is the billing read working and the wallet open. The preflight takes its own reading at 19:00.
        billingRefusal = awsRefusal(s, c, now, billing);
        if (!billingRefusal && releaseAvailable(s, c, billing, Bun.YAML.parse(readFileSync(join(root, "config.yaml"), "utf8")), now) < 100) billingRefusal = "release wallet insufficient";
      } catch (error) {
        billingRefusal = String(error);
      }
      const [readings, quota] = await Promise.all([localReadings(), claudeStatus()]);
      if (quota && (!readings.claude || quota.observedAt > readings.claude.observedAt)) readings.claude = quota;
      // The usage reading beside the release gate. Reported only; the gate is not touched.
      const used = (meter?: { windows: { used: number }[] }) => (meter ? Math.max(...meter.windows.map((w) => w.used)) : null);
      evidence.usage = { releaseGate: c.usage_gates.admit_below, codex: used(readings.codex), claude: used(readings.claude) };
      const brake = s.get("aws-stop-latched") === true ? "AWS stop latched" : s.get("paused") !== false ? "factory paused" : null;
      return collectReleaseReadiness({ dir: root, config: c, store: s, brake, carrier: batch, billingRefusal, billingEvidence: billing, factorySource: revision, readings });
    },
  });
  console.log(JSON.stringify(report));
  if (report.failures.length) process.exitCode = 1;
} catch (error) {
  s.event(`release-morning-failure:${Date.now()}`, "release-morning-failure", { error: String(error) }, "Retain the failure; the next scheduled run starts fresh");
  console.error(String(error));
  process.exitCode = 1;
} finally {
  s.close();
}
