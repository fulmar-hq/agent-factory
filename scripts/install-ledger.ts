#!/usr/bin/env bun
// Prepares the ledger job and, with --install, loads it. Operator use only,
// after the source is reviewed, merged and installed:
//   bun scripts/install-ledger.ts            writes and lints the job definition; starts nothing
//   bun scripts/install-ledger.ts --install  also loads it into launchd
// The job imports every file in launcher/rules/ and launcher/ledger-steps/
// into an unsandboxed process. So loading is refused until those folders and
// the ledger's own files are on protected_paths in the private factory config.
// This script never edits that config; it reads it and records what it saw.
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { command } from "../adapters/github";
import { configAt, root } from "../launcher/config";
import { jobEnvironment, missingExecutables } from "../launcher/job-environment";
import { LEDGER_COMMANDS_DIR, LEDGER_PROTECTED_PATHS } from "../launcher/ledger";
import { LOOP_FILES, inboxFileName, parseInboxRecord } from "../launcher/loop-contract";

const label = "com.agent-factory.ledger";
const install = process.argv.includes("--install");
// The registered installation owns scheduled jobs, whichever worktree this runs from.
const repositories = await Bun.file(join(root, "repositories.json")).json();
const repo = realpathSync(repositories["fulmar-hq/agent-factory"]);
const script = join(repo, "scripts/ledger-ingest.ts");
const environment = jobEnvironment(homedir(), process.execPath, root);

const config = await configAt();
const listed = config.autonomy?.auto_approval.protected_paths ?? [];
const missing = LEDGER_PROTECTED_PATHS.filter((path) => !listed.includes(path));
const receipt = join(root, "receipts", `ledger-install-${Date.now()}`);
mkdirSync(receipt, { recursive: true, mode: 0o700 });
writeFileSync(join(receipt, "protected-paths.json"), JSON.stringify({ at: Date.now(), install, protectedPaths: listed, required: LEDGER_PROTECTED_PATHS, missing }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ protectedPaths: { required: LEDGER_PROTECTED_PATHS, missing }, receipt }));

if (install) {
  if (missing.length) throw Error(`refused: add these to autonomy.auto_approval.protected_paths in the private factory config first, then run again: ${missing.join(", ")}`);
  if (!existsSync(script)) throw Error("refused: the registered factory checkout does not have scripts/ledger-ingest.ts yet; install the reviewed source first");
  if ((await command(["git", "branch", "--show-current"], repo)).trim() !== "main" || (await command(["git", "status", "--porcelain"], repo)).trim()) throw Error("refused: clean registered factory main required");
  const tools = missingExecutables(environment.PATH, ["bun"]);
  if (tools.length) throw Error(`refused: missing from the scheduled PATH: ${tools.join(", ")}`);
}

// Every five minutes, two minutes after the health job, at background priority.
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const text = (value: string) => `<string>${xml(value)}</string>`;
const minutes = Array.from({ length: 12 }, (_, n) => `<dict><key>Minute</key><integer>${n * 5 + 2}</integer></dict>`).join("");
const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key>${text(label)}<key>ProgramArguments</key><array>${text(process.execPath)}${text(script)}</array><key>WorkingDirectory</key>${text(repo)}<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key>${text(value)}`).join("")}</dict><key>StartCalendarInterval</key><array>${minutes}</array><key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/><key>StandardOutPath</key>${text(join(root, "ledger.log"))}<key>StandardErrorPath</key>${text(join(root, "ledger.error.log"))}</dict></plist>
`;
const prepared = join(root, `${label}.plist`);
if (existsSync(prepared)) copyFileSync(prepared, join(receipt, `${label}.plist`));
writeFileSync(prepared, body, { mode: 0o600 });
await command(["plutil", "-lint", prepared]);
for (const folder of [LOOP_FILES.ledgerInbox, LEDGER_COMMANDS_DIR]) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });

const domain = `gui/${process.getuid!()}`;
const undo = `launchctl bootout ${domain}/${label}\nArchive ~/Library/LaunchAgents/${label}.plist. Keep health/ledger.sqlite, the inbox and this receipt.\nRemove the ledger entries from protected_paths only together with a signed source revert.\n`;
writeFileSync(join(receipt, "undo.txt"), undo, { mode: 0o600 });

if (install) {
  const installed = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  mkdirSync(dirname(installed), { recursive: true });
  if (existsSync(installed)) copyFileSync(installed, join(receipt, `${label}.installed.plist`));
  const loaded = () => command(["launchctl", "print", `${domain}/${label}`]).then((out) => out, () => null);
  if (await loaded()) {
    await command(["launchctl", "bootout", `${domain}/${label}`]);
    for (let waited = 0; (await loaded()) && waited < 20; waited++) await Bun.sleep(500);
  }
  copyFileSync(prepared, installed);
  await command(["launchctl", "bootstrap", domain, installed]);
  const readback = await loaded();
  if (!readback?.includes(script)) throw Error("the loaded job does not run the ledger job from the registered checkout");
  writeFileSync(join(receipt, "loaded.txt"), readback, { mode: 0o600 });
  // Two things can only be seen a day after loading. Each becomes a dated item in the ledger itself.
  const at = Date.now();
  for (const [proofId, what] of [
    ["ledger-reconciles-first-day", "After 24 hours `bun scripts/ledger.ts reconcile` shows difference 0: every worker-failure event and failed tick is exactly one occurrence"],
    ["ledger-leaves-the-tick-alone", "After 24 hours the tick's 95th-percentile duration is within 10% of the day before, and tick.log and health.log hold no 'database is locked'"],
  ] as const) {
    const owed = parseInboxRecord({ version: 1, id: `install-ledger:${proofId}`, at, source: "install-ledger", type: "proof-owed", proofId, what, dueAt: at + 24 * 3_600_000, role: "Platform" });
    if (!owed.ok) throw Error(owed.reason);
    const target = join(root, LOOP_FILES.ledgerInbox, inboxFileName(owed.record));
    writeFileSync(`${target}.tmp`, JSON.stringify(owed.record), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }
}
console.log(JSON.stringify({ [install ? "installed" : "prepared"]: label, definition: prepared, undo: join(receipt, "undo.txt") }));
