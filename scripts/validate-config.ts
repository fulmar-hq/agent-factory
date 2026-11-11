// Checks a factory config file against ConfigSchema. It reads; it changes nothing.
//   bun scripts/validate-config.ts            the live config
//   bun scripts/validate-config.ts <file>     a proposed config, before it goes live
// Exit 0 when the file passes. Exit 1 with one line per failing field.
// To make a checked file the live config, use scripts/set-config.ts.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "../launcher/config";
import { CONFIG_GUARD_FILES, checkConfig, type ConfigProblem } from "../launcher/config-guard";

export function validateConfigFile(path: string): { ok: boolean; path: string; problems: ConfigProblem[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, path, problems: [{ field: "(whole file)", message: `cannot be read: ${String(error)}` }] };
  }
  const check = checkConfig(text);
  return { ok: check.ok, path, problems: check.ok ? [] : check.problems };
}
/** One line per failing field, for a person to read. */
export const problemLines = (problems: ConfigProblem[]) => problems.map((problem) => `  ${problem.field}: ${problem.message}`).join("\n");

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0]?.startsWith("-")) {
    console.error("usage: validate-config.ts [file]");
    process.exit(2);
  }
  const result = validateConfigFile(args[0] ? resolve(args[0]) : join(root, CONFIG_GUARD_FILES.live));
  if (result.ok) console.log(`config ok: ${result.path}`);
  else {
    console.error(`config rejected: ${result.path}\n${problemLines(result.problems)}`);
    process.exit(1);
  }
}
