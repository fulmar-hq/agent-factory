import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobEnvironment, plistEnvironment } from "../launcher/job-environment";
import { LOOP_FILES, parseInboxRecord } from "../launcher/loop-contract";
import { FACTORY_REPOSITORY, HEARTBEAT_LABEL, PUSH_MINUTES, heartbeatPlist, installHeartbeat } from "../scripts/install-heartbeat";
import { HEARTBEAT_VARIABLE } from "../scripts/push-heartbeat";

const at = (clock: string) => Date.parse(`2026-11-11T${clock}:00-05:00`);
const bun = "/Users/fictional/.bun/bin/bun";

/** A fictional Mac: a private folder, a home and a registered checkout. launchd is a recording stand-in. */
function machine(o: { pusher?: boolean; loaded?: boolean; loadedPath?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "heartbeat-install-"))),
    dir = join(base, "private"),
    home = join(base, "home"),
    checkout = join(base, "agent-factory");
  for (const path of [dir, home, join(checkout, "scripts")]) mkdirSync(path, { recursive: true });
  if (o.pusher !== false) writeFileSync(join(checkout, "scripts/push-heartbeat.ts"), "// fixture\n");
  writeFileSync(join(dir, "repositories.json"), JSON.stringify({ [FACTORY_REPOSITORY]: checkout }));
  const environment = jobEnvironment(home, bun, dir),
    expected = heartbeatPlist({ bun, repo: checkout, dir, environment });
  const calls: string[] = [];
  let loaded = o.loaded ?? false;
  const print = `\tprogram = ${bun}\n\targuments = {\n${expected.args.map((a) => `\t\t${a}\n`).join("")}\t}\n\tworking directory = ${checkout}\n\tenvironment = {\n\t\tPATH => ${o.loadedPath ?? environment.PATH}\n\t}\n`;
  const execute = async (args: string[]) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "launchctl" && args[1] === "print") {
      if (!loaded) throw Error("launchctl failed (exit 113): Could not find service");
      return print;
    }
    if (args[0] === "launchctl" && args[1] === "bootout") loaded = false;
    if (args[0] === "launchctl" && args[1] === "bootstrap") loaded = true;
    return "";
  };
  const options = { dir, home, bun, uid: 501, execute, which: (name: string) => `/fictional/bin/${name}` };
  return { dir, home, checkout, environment, expected, calls, options, installed: join(home, "Library/LaunchAgents", `${HEARTBEAT_LABEL}.plist`) };
}

describe("the heartbeat job's installer", () => {
  test("the definition runs the registered pusher every 15 minutes with the scheduled environment, and pushes the real variable", () => {
    const m = machine();
    expect(m.expected.args).toEqual([bun, join(m.checkout, "scripts/push-heartbeat.ts"), "push", "--repo", FACTORY_REPOSITORY, "--variable", HEARTBEAT_VARIABLE]);
    expect(plistEnvironment(m.expected.body)).toEqual(m.environment);
    expect(m.expected.body).toContain(`<key>Label</key><string>${HEARTBEAT_LABEL}</string>`);
    expect([...m.expected.body.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((x) => Number(x[1]))).toEqual([...PUSH_MINUTES]);
    expect(PUSH_MINUTES.map((minute, i) => (PUSH_MINUTES[(i + 1) % 4]! - minute + 60) % 60)).toEqual([15, 15, 15, 15]);
    expect(m.expected.body).toContain(`<string>${join(m.dir, "heartbeat-push.log")}</string>`);
  });

  test("without --install it writes and lints the plist in the private folder and loads nothing", async () => {
    const m = machine();
    const result = await installHeartbeat({ ...m.options, install: false, now: at("18:00") });
    expect(result.installed).toBe(false);
    expect(m.calls).toEqual(["plutil -lint"]);
    expect(readFileSync(join(m.dir, `${HEARTBEAT_LABEL}.plist`), "utf8")).toBe(m.expected.body);
    expect(existsSync(m.installed)).toBe(false);
    expect(existsSync(join(m.dir, LOOP_FILES.ledgerInbox))).toBe(false);
    expect(readFileSync(join(result.archive, "undo.txt"), "utf8")).toContain(`launchctl bootout gui/501/${HEARTBEAT_LABEL}`);
  });

  test("--install loads the job, reads back what launchd holds, and records the proofs that can only be seen later", async () => {
    const m = machine();
    const now = at("10:00");
    const result = await installHeartbeat({ ...m.options, install: true, now });
    expect(m.calls).toEqual(["plutil -lint", "launchctl print", "launchctl bootstrap", "launchctl print"]);
    expect(readFileSync(m.installed, "utf8")).toBe(m.expected.body);
    if (!result.installed) throw Error("expected an install");
    expect(result.replaced).toBe(false);
    const owed = result.proofsOwed.map((path) => parseInboxRecord(JSON.parse(readFileSync(path, "utf8"))));
    expect(owed.every((r) => r.ok)).toBe(true);
    expect(owed.map((r) => r.ok && r.record.type === "proof-owed" && [r.record.proofId, r.record.role, (r.record.dueAt - now) / 86_400_000])).toEqual([
      ["off-machine-heartbeat-drills", "Quality", 3],
      ["off-machine-check-actions-minutes", "Platform", 7],
    ]);
    // Installing again replaces the loaded job, archives the earlier plist and does not move a due date.
    const again = await installHeartbeat({ ...m.options, install: true, now: now + 3_600_000 });
    if (!again.installed) throw Error("expected an install");
    expect(again.replaced).toBe(true);
    expect(m.calls.slice(4)).toEqual(["plutil -lint", "launchctl print", "launchctl bootout", "launchctl bootstrap", "launchctl print"]);
    expect(readdirSync(again.archive).sort()).toEqual(["installed-before.plist", "prepared-before.plist", "undo.txt"]);
    expect(again.proofsOwed.map((path) => JSON.parse(readFileSync(path, "utf8")).dueAt)).toEqual([now + 3 * 86_400_000, now + 7 * 86_400_000]);
    expect(readdirSync(join(m.dir, LOOP_FILES.ledgerInbox))).toHaveLength(2);
  });

  test("loading is refused from 17:30 to 22:35 Toronto time and during an install freeze, before anything is written", async () => {
    for (const clock of ["17:30", "20:00", "22:34"]) {
      const m = machine();
      await expect(installHeartbeat({ ...m.options, install: true, now: at(clock) })).rejects.toThrow("between 17:30 and 22:35");
      expect(m.calls).toEqual([]);
      expect(existsSync(m.installed) || existsSync(join(m.dir, `${HEARTBEAT_LABEL}.plist`))).toBe(false);
    }
    for (const clock of ["17:29", "22:35"]) expect((await installHeartbeat({ ...machine().options, install: true, now: at(clock) })).installed).toBe(true);
    const frozen = machine();
    writeFileSync(join(frozen.dir, "integration-freeze.json"), JSON.stringify({ version: 1, from: "2026-11-11T09:00:00-05:00", until: "2026-11-11T12:00:00-05:00", reason: "fixture freeze" }));
    await expect(installHeartbeat({ ...frozen.options, install: true, now: at("10:00") })).rejects.toThrow("fixture freeze");
    expect(frozen.calls).toEqual([]);
  });

  test("it refuses a checkout without the pusher, a PATH without gh, and a loaded job that differs from its plist", async () => {
    const early = machine({ pusher: false });
    await expect(installHeartbeat({ ...early.options, install: true, now: at("10:00") })).rejects.toThrow("install the merged source first");
    const noGh = machine();
    await expect(installHeartbeat({ ...noGh.options, which: () => null, install: true, now: at("10:00") })).rejects.toThrow("gh is not on the scheduled PATH");
    expect([...early.calls, ...noGh.calls]).toEqual([]);
    const drifted = machine({ loadedPath: "/usr/bin:/bin" });
    await expect(installHeartbeat({ ...drifted.options, install: true, now: at("10:00") })).rejects.toThrow("different definition");
    expect(existsSync(join(drifted.dir, LOOP_FILES.ledgerInbox))).toBe(false);
  });
});
