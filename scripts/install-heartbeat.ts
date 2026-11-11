// Prepares, and with --install loads, the LaunchAgent that pushes the
// off-machine heartbeat every 15 minutes. Operator use only, after review:
//   bun scripts/install-heartbeat.ts             writes and lints the plist in the private folder; loads nothing
//   bun scripts/install-heartbeat.ts --install   also copies it to ~/Library/LaunchAgents, loads it and reads it back
// Loading is refused between 17:30 and 22:35 Toronto time and during an
// install freeze. Earlier plists are archived, never deleted, with the undo.
// docs/dead-man.md has the full install steps.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { command } from "../adapters/github";
import { root } from "../launcher/config";
import { integrationFreeze } from "../launcher/integration-freeze";
import { jobEnvironment, missingExecutables } from "../launcher/job-environment";
import { LOOP_FILES, inboxFileName, parseInboxRecord } from "../launcher/loop-contract";
import { toronto } from "../launcher/release";
import { loadedReleaseJob } from "../launcher/release-install";
import { HEARTBEAT_VARIABLE } from "./push-heartbeat";

export const HEARTBEAT_LABEL = "com.agent-factory.heartbeat-push";
export const FACTORY_REPOSITORY = "fulmar-hq/agent-factory";
/** Every 15 minutes, off the minutes the five-minute jobs start on. */
export const PUSH_MINUTES = [4, 19, 34, 49] as const;
const DAY = 24 * 60 * 60_000;

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const strings = (values: string[]) => values.map((v) => `<string>${xml(v)}</string>`).join("");

/** The job's definition. It runs the registered installation's pusher, whatever checkout prepared it. */
export function heartbeatPlist(o: { bun: string; repo: string; dir: string; environment: Record<string, string> }) {
  const args = [o.bun, join(o.repo, "scripts/push-heartbeat.ts"), "push", "--repo", FACTORY_REPOSITORY, "--variable", HEARTBEAT_VARIABLE];
  const environment = Object.entries(o.environment)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  const schedule = PUSH_MINUTES.map((minute) => `<dict><key>Minute</key><integer>${minute}</integer></dict>`).join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${HEARTBEAT_LABEL}</string><key>ProgramArguments</key><array>${strings(args)}</array><key>WorkingDirectory</key><string>${xml(o.repo)}</string><key>EnvironmentVariables</key><dict>${environment}</dict><key>StartCalendarInterval</key><array>${schedule}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(join(o.dir, "heartbeat-push.log"))}</string><key>StandardErrorPath</key><string>${xml(join(o.dir, "heartbeat-push.error.log"))}</string></dict></plist>
`;
  return { args, body };
}

/**
 * What can only be seen after install is written down as a proof still owed,
 * with a date and a role, in the ledger's inbox. The same fact always lands on
 * the same file, so installing again does not move a due date.
 */
export function oweProofs(dir: string, now: number): string[] {
  const owed = [
    { proofId: "off-machine-heartbeat-drills", role: "Quality", dueAt: now + 3 * DAY, what: "Run the three drills in docs/dead-man.md on the drill variable and the drill issue, outside 17:30-22:35, and attach each result." },
    { proofId: "off-machine-check-actions-minutes", role: "Platform", dueAt: now + 7 * DAY, what: "Measure the Actions minutes the off-machine heartbeat check used in 7 days. If the monthly projection passes a quarter of the allowance, move the check to hourly and restate the detection time in docs/dead-man.md." },
  ];
  const inbox = join(dir, LOOP_FILES.ledgerInbox);
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  return owed.map((proof) => {
    const checked = parseInboxRecord({ version: 1, id: `proof-owed:${proof.proofId}`, at: now, source: "install-heartbeat", type: "proof-owed", ...proof });
    if (!checked.ok) throw Error(checked.reason);
    const target = join(inbox, inboxFileName(checked.record));
    if (existsSync(target)) return target;
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(checked.record) + "\n", { mode: 0o600 });
    renameSync(temporary, target);
    return target;
  });
}

export type InstallOptions = {
  install: boolean;
  dir?: string;
  home?: string;
  bun?: string;
  uid?: number;
  now?: number;
  execute?: (args: string[]) => Promise<string>;
  which?: (name: string, path: string) => string | null;
};

export async function installHeartbeat(o: InstallOptions) {
  const dir = o.dir ?? root,
    home = o.home ?? homedir(),
    bun = o.bun ?? process.execPath,
    uid = o.uid ?? process.getuid!(),
    now = o.now ?? Date.now(),
    execute = o.execute ?? command;
  // The registered installation owns scheduled jobs. Never pin launchd to a trial copy.
  const repo = realpathSync(JSON.parse(readFileSync(join(dir, "repositories.json"), "utf8"))[FACTORY_REPOSITORY]);
  const environment = jobEnvironment(home, bun, dir);
  const { args, body } = heartbeatPlist({ bun, repo, dir, environment });
  if (o.install) {
    const minute = toronto(now).minute;
    if (minute >= 1050 && minute < 1355) throw Error("refused: nothing is installed between 17:30 and 22:35 Toronto time");
    const freeze = integrationFreeze(dir, now);
    if (freeze) throw Error(`refused: an install freeze is active (${freeze})`);
    if (missingExecutables(environment.PATH, ["gh"], o.which).length) throw Error("refused: gh is not on the scheduled PATH, so the job could never push");
    if (!existsSync(join(repo, "scripts/push-heartbeat.ts"))) throw Error("refused: the registered installation has no scripts/push-heartbeat.ts yet; install the merged source first");
  }
  const service = `gui/${uid}/${HEARTBEAT_LABEL}`,
    installed = join(home, "Library/LaunchAgents", `${HEARTBEAT_LABEL}.plist`),
    prepared = join(dir, `${HEARTBEAT_LABEL}.plist`),
    archive = join(dir, "receipts", `heartbeat-install-${now}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  if (existsSync(prepared)) copyFileSync(prepared, join(archive, "prepared-before.plist"));
  writeFileSync(prepared, body, { mode: 0o600 });
  await execute(["plutil", "-lint", prepared]);
  writeFileSync(
    join(archive, "undo.txt"),
    `launchctl bootout ${service}\nThen move ${installed} into this folder; do not delete it.\nKeep the variable and the standing issue. With the job unloaded the off-machine check reports "no heartbeat from the Mac" after about an hour. To stop the check as well, remove the FACTORY_HEARTBEAT_ISSUE repository variable (see docs/dead-man.md).\n`,
    { mode: 0o600 },
  );
  if (!o.install) return { installed: false as const, prepared, archive };

  mkdirSync(dirname(installed), { recursive: true });
  if (existsSync(installed)) copyFileSync(installed, join(archive, "installed-before.plist"));
  let loaded = true;
  try {
    await execute(["launchctl", "print", service]);
  } catch (error) {
    if (!/Could not find (?:service|specified service)/i.test(String(error))) throw error;
    loaded = false;
  }
  if (loaded) await execute(["launchctl", "bootout", service]);
  copyFileSync(prepared, installed);
  await execute(["launchctl", "bootstrap", `gui/${uid}`, installed]);
  // Read back what launchd actually loaded; the file alone proves nothing.
  const actual = loadedReleaseJob(await execute(["launchctl", "print", service]));
  if (actual.program !== bun || actual.directory !== repo || actual.path !== environment.PATH || JSON.stringify(actual.args) !== JSON.stringify(args))
    throw Error(`${HEARTBEAT_LABEL} is loaded with a different definition from its plist; keep ${archive} as evidence`);
  return { installed: true as const, prepared, archive, plist: installed, service, replaced: loaded, proofsOwed: oweProofs(dir, now) };
}

if (import.meta.main) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--install")) throw Error("usage: install-heartbeat.ts [--install]");
  console.log(JSON.stringify(await installHeartbeat({ install: flags.includes("--install") })));
}
