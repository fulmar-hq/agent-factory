// Prepares the LaunchAgent for the morning release-inputs check and, with
// --install, loads it. Operator only, after the source is installed.
//
//   bun scripts/install-release-morning.ts            writes the definition into the private directory; loads nothing
//   bun scripts/install-release-morning.ts --install  also loads it and reads it back
//
// The program, working directory and PATH are copied from the loaded
// rehearsal job, never from this shell, and the readback must match them. A
// job that reads back differently is unloaded again before this fails.
// It refuses to load anything during the 17:30–22:35 install freeze.
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { command } from "../adapters/github";
import { root } from "../launcher/config";
import { integrationFreeze } from "../launcher/integration-freeze";
import { toronto } from "../launcher/release";
import { loadedReleaseJob } from "../launcher/release-install";
import { FREEZE_FROM, FREEZE_UNTIL, MORNING_LABEL, morningJobDefinition } from "../launcher/release-morning";

const install = process.argv.includes("--install");
const now = Date.now();
if (install && ((toronto(now).minute >= FREEZE_FROM && toronto(now).minute < FREEZE_UNTIL) || integrationFreeze(root, now))) throw Error("the morning check is not loaded during an install freeze (17:30–22:35 America/Toronto)");
if (!(await command(["readlink", "/etc/localtime"])).trim().endsWith("/America/Toronto")) throw Error("launchd calendar requires system timezone America/Toronto");

const domain = `gui/${process.getuid!()}`;
const service = `${domain}/${MORNING_LABEL}`;
const rehearsalRaw = await command(["launchctl", "print", `${domain}/com.agent-factory.release.rehearsal-early`]);
const rehearsal = loadedReleaseJob(rehearsalRaw);
const loadedVariable = (raw: string, name: string) => {
  const rows = [...raw.matchAll(new RegExp(`^\\t\\t${name} => (.+)$`, "gm"))];
  if (rows.length !== 1) throw Error(`loaded ${name} absent or ambiguous`);
  return rows[0]![1]!;
};
if (loadedVariable(rehearsalRaw, "FACTORY_PRIVATE_DIR") !== root || loadedVariable(rehearsalRaw, "TZ") !== "America/Toronto") throw Error("the loaded rehearsal job uses another private directory or timezone");
const script = join(rehearsal.directory, "scripts/release-morning.ts");
if (!existsSync(script)) throw Error(`${script} is not installed yet; install the source first`);
const expected = { program: rehearsal.program, args: [rehearsal.program, script], directory: rehearsal.directory, path: rehearsal.path };

const archive = join(root, "receipts", `release-morning-install-${now}`);
mkdirSync(archive, { recursive: true, mode: 0o700 });
const prepared = join(root, `${MORNING_LABEL}.plist`);
if (existsSync(prepared)) copyFileSync(prepared, join(archive, `${MORNING_LABEL}.plist`));
writeFileSync(prepared, morningJobDefinition({ program: expected.program, directory: expected.directory, path: expected.path, privateDir: root }), { mode: 0o600 });
await command(["plutil", "-lint", prepared]);
writeFileSync(join(archive, "undo.txt"), `launchctl bootout ${service}\nThen move ~/Library/LaunchAgents/${MORNING_LABEL}.plist into this folder. Keep the release-morning events, mail and ledger inbox records.\n`);

if (!install) {
  console.log(JSON.stringify({ prepared, loaded: false, sameAsRehearsal: { program: expected.program, directory: expected.directory, path: expected.path }, archive }));
} else {
  const installed = join(homedir(), "Library/LaunchAgents", `${MORNING_LABEL}.plist`);
  let loaded: string | undefined;
  try {
    loaded = await command(["launchctl", "print", service]);
  } catch (error) {
    if (!/Could not find (?:service|specified service)/i.test(String(error))) throw error;
  }
  if (loaded) {
    // Replace only a job that is this one and is not running.
    const old = loadedReleaseJob(loaded);
    if (!old.args[1]?.endsWith("/scripts/release-morning.ts") || !/^\tstate = not running$/m.test(loaded) || /^\tpid = /m.test(loaded)) throw Error(`${MORNING_LABEL} is running or is not this job; leave it`);
    await command(["launchctl", "bootout", service]);
  }
  mkdirSync(dirname(installed), { recursive: true });
  if (existsSync(installed)) copyFileSync(installed, join(archive, `${MORNING_LABEL}.installed.plist`));
  copyFileSync(prepared, installed);
  await command(["launchctl", "bootstrap", domain, installed]);
  let actual: ReturnType<typeof loadedReleaseJob>;
  try {
    const readback = await command(["launchctl", "print", service]);
    actual = loadedReleaseJob(readback);
    if (actual.program !== expected.program || actual.directory !== expected.directory || actual.path !== expected.path || JSON.stringify(actual.args) !== JSON.stringify(expected.args) || loadedVariable(readback, "FACTORY_PRIVATE_DIR") !== root)
      throw Error("the loaded definition differs from the rehearsal job");
  } catch (error) {
    // Never leave a job scheduled that did not read back as intended.
    const refused = join(archive, `${MORNING_LABEL}.refused.plist`);
    try {
      await command(["launchctl", "bootout", service]);
      renameSync(installed, refused);
    } catch (undo) {
      throw Error(`${MORNING_LABEL} did not read back as intended (${String(error)}) and could not be unloaded (${String(undo)}); follow ${archive}/undo.txt now`);
    }
    throw Error(`${MORNING_LABEL} did not read back as intended (${String(error)}); it was unloaded again and its definition kept as ${refused}`);
  }
  console.log(JSON.stringify({ installed, loaded: true, sameAsRehearsal: { program: actual.program, directory: actual.directory, path: actual.path }, archive }));
}
