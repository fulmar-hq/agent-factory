// The supported way to change the live factory config. Operator use only:
//   bun scripts/set-config.ts <proposed file> --actor "<name>" [--reason "<why>"]
// It checks the proposed file against ConfigSchema first and writes nothing
// when any field fails. A file that passes replaces the live config in one
// rename, so a tick never reads a half-written file. The config it replaces is
// kept under archive/, with a receipt saying who changed it and why.
//
// This script decides nothing about limits. ConfigSchema fixes the usage
// gates, the capacity controller and the release schedule, and a file that
// tries to move them is refused like any other invalid file.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "../launcher/config";
import { CONFIG_GUARD_FILES, checkConfig, rememberGoodConfig } from "../launcher/config-guard";
import { problemLines } from "./validate-config";

export type ConfigChangeRequest = { dir?: string; source: string; actor?: string; reason?: string; now?: number };
/** `archive` is the folder holding the replaced config and this receipt; null when the file was already live. */
export type ConfigChangeReceipt = { changed: boolean; at: number; actor: string; reason?: string; source: string; beforeSha256: string | null; afterSha256: string; archive: string | null };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function setConfig(o: ConfigChangeRequest): ConfigChangeReceipt {
  const dir = o.dir ?? root,
    now = o.now ?? Date.now(),
    actor = o.actor?.trim() ?? "",
    source = resolve(o.source),
    target = join(dir, CONFIG_GUARD_FILES.live);
  if (actor.length < 2) throw Error("refused: a config change needs --actor, the name of the person or role making it");
  let proposed: string;
  try {
    proposed = readFileSync(source, "utf8");
  } catch (error) {
    throw Error(`refused: the proposed config cannot be read at ${source} (${String(error)})`);
  }
  const check = checkConfig(proposed);
  if (!check.ok) throw Error(`refused: the proposed config is invalid, so nothing was written\n${problemLines(check.problems)}`);

  const live = () => {
    try {
      return readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const before = live();
  const receipt = { at: now, actor, reason: o.reason?.trim() || undefined, source, beforeSha256: before === null ? null : sha256(before), afterSha256: sha256(proposed) };
  if (before === proposed) {
    // Already live: nothing to replace, but make sure the guard has its copy.
    rememberGoodConfig(dir, proposed);
    return { changed: false, ...receipt, archive: null };
  }

  // Keep what is being replaced, valid or not, before touching the live file.
  const archive = join(dir, "archive", `set-config-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  if (before !== null) writeFileSync(join(archive, "config.before.yaml"), before, { mode: 0o600, flag: "wx" });
  writeFileSync(join(archive, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });

  // Staged beside the live file so the rename stays on one volume and is atomic.
  const staged = `${target}.${process.pid}.tmp`;
  writeFileSync(staged, proposed, { mode: 0o600 });
  if (live() !== before) {
    rmSync(staged, { force: true });
    throw Error("refused: the live config changed while this ran; check it and retry");
  }
  renameSync(staged, target);
  rememberGoodConfig(dir, proposed);
  return { changed: true, ...receipt, archive };
}

if (import.meta.main) {
  const [source, ...rest] = process.argv.slice(2);
  const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  try {
    if (!source || source.startsWith("-")) throw Error('usage: set-config.ts <proposed file> --actor "<name>" [--reason "<why>"]');
    // The same local owner authorization as scripts/control.ts: never given to workers.
    const expected = (await Bun.file(join(root, "owner-token")).text()).trim(),
      provided = process.env.FACTORY_OWNER_TOKEN ?? "";
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw Error("owner authorization required");
    console.log(JSON.stringify(setConfig({ source, actor: option("--actor"), reason: option("--reason") })));
  } catch (error) {
    console.error((error as Error).message ?? String(error));
    process.exit(1);
  }
}
