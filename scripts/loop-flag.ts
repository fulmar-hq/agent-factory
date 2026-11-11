// Flips one loop switch, or shows them. Operator use only:
//   bun scripts/loop-flag.ts show
//   bun scripts/loop-flag.ts set <switch> acting --actor "<name>" --parity-report <file>
//   bun scripts/loop-flag.ts set <switch> record-only --actor "<name>" --reason "<why>"
// Turning a detector on needs a named actor and the parity report that shows
// what it would have done. Turning it back to record-only is the safe
// direction and needs a name and a reason. Every flip is appended to the
// history file before the switch file is replaced, so the record never lags.
import { timingSafeEqual, createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "../launcher/config";
import { LOOP_FILES } from "../launcher/loop-contract";
import { LOOP_MODES, LOOP_SWITCHES, LoopFlagsFileSchema, readLoopFlags, type LoopFlagsFile, type LoopMode, type LoopSwitch } from "../launcher/loop-flags";

export type LoopFlip = { dir?: string; name: string; mode: string; actor?: string; parityReport?: string; reason?: string; now?: number };

export function flipLoopSwitch(o: LoopFlip) {
  const dir = o.dir ?? root,
    now = o.now ?? Date.now();
  if (!Object.hasOwn(LOOP_SWITCHES, o.name)) throw Error(`unknown loop switch "${o.name}". Limits and operator-only switches live in the private factory config, not here.`);
  if (!(LOOP_MODES as readonly string[]).includes(o.mode)) throw Error(`mode must be one of: ${LOOP_MODES.join(", ")}`);
  const name = o.name as LoopSwitch,
    mode = o.mode as LoopMode,
    actor = o.actor?.trim() ?? "";
  if (actor.length < 2) throw Error("refused: a flip needs --actor, the name of the person or role flipping it");
  let report: { parityReport: string; parityReportSha256: string } | undefined;
  if (mode === "acting") {
    if (!o.parityReport?.trim()) throw Error("refused: turning a switch on needs --parity-report, the file showing what it would have done");
    const path = resolve(o.parityReport);
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) throw Error("not a file");
      bytes = readFileSync(path);
    } catch (error) {
      throw Error(`refused: parity report cannot be read at ${path} (${String(error)})`);
    }
    if (!bytes.length) throw Error(`refused: parity report at ${path} is empty`);
    report = { parityReport: path, parityReportSha256: createHash("sha256").update(bytes).digest("hex") };
  } else if (!o.reason?.trim()) throw Error("refused: turning a switch back to record-only needs --reason");

  // Start from the last good state, so a flip also repairs a damaged file.
  const before = readLoopFlags(dir);
  if (before.modes[name] === mode && before.source !== "last-good") throw Error(`${name} is already ${mode}`);
  const after: LoopFlagsFile = LoopFlagsFileSchema.parse({
    version: 1,
    switches: { ...before.entries, [name]: { mode, actor, at: now, ...report, ...(o.reason?.trim() ? { reason: o.reason.trim() } : {}) } },
  });
  const record = { at: now, actor, switch: name, from: before.modes[name], to: mode, ...report, reason: o.reason?.trim() || undefined, repaired: before.alarm ?? undefined, after };
  appendFileSync(join(dir, LOOP_FILES.switchHistory), JSON.stringify(record) + "\n", { mode: 0o600 });
  const target = join(dir, LOOP_FILES.switches),
    temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(after, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, target);
  return { switch: name, from: before.modes[name], to: mode, actor, at: now, repaired: before.alarm };
}

if (import.meta.main) {
  const [command, name, mode, ...rest] = process.argv.slice(2);
  if (command === "show") console.log(JSON.stringify(readLoopFlags(), null, 2));
  else if (command === "set" && name && mode) {
    // The same local owner authorization as scripts/control.ts: never given to workers.
    const expected = (await Bun.file(join(root, "owner-token")).text()).trim(),
      provided = process.env.FACTORY_OWNER_TOKEN ?? "";
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw Error("owner authorization required");
    const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
    console.log(JSON.stringify(flipLoopSwitch({ name, mode, actor: option("--actor"), parityReport: option("--parity-report"), reason: option("--reason") })));
  } else throw Error('usage: loop-flag.ts show | set <switch> <acting|record-only> --actor "<name>" [--parity-report <file>] [--reason "<why>"]');
}
