import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from "node:fs";
import { join } from "node:path";
// Complete populations only: these are resource ceilings, never sampling limits.
export const CALIBRATION_BOUNDS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  files: 128,
  aggregateBytes: 32 * 1024 * 1024,
  directoryEntries: 1024,
});

function readCalibrationFile(path: string, remainingBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error("calibration refused: regular JSONL file required");
    if (stat.size > CALIBRATION_BOUNDS.fileBytes) throw Error("calibration refused: file byte bound exceeded");
    if (stat.size > remainingBytes) throw Error("calibration refused: aggregate byte bound exceeded");
    // One extra byte proves EOF rather than treating a prefix as a complete file.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size || fstatSync(fd).size !== stat.size)
      throw Error("calibration refused: JSONL file changed during read");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
// Native cumulative counters include cached input. Completed-turn deltas, not
// text length or provider percentages, calibrate the local observed-token budget.
export function turnTokens(lines: string, torontoDay?:string): number[] {
  let total = 0, baseline = 0;
  const samples: number[] = [];
  for (const line of lines.split("\n")) {
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (x.type !== "event_msg") continue;
    const p = x.payload;
    const n = p?.info?.total_token_usage?.total_tokens;
    if (p?.type === "token_count" && Number.isSafeInteger(n) && n >= total) total = n;
    if (["task_complete", "task_completed"].includes(p?.type)) {
      if (total > baseline && (!torontoDay || (typeof x.timestamp === "string" && new Date(x.timestamp).toLocaleDateString("en-CA",{timeZone:"America/Toronto"})===torontoDay))) samples.push(total - baseline);
      baseline = total;
    }
  }
  return samples;
}
export function calibrateTokens(home: string, torontoDay:string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(torontoDay))throw Error("Toronto day required");
  const dates=[0,86400000].map(n=>new Date(Date.parse(torontoDay+"T00:00Z")+n).toISOString().slice(0,10));
  const samples: number[] = [];
  const sources: string[] = [];
  let files = 0, entries = 0, bytes = 0;
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("UTC date required");
    const dir = join(home, ".codex/sessions", date.replaceAll("-", "/"));
    let directory, entry;
    try {
      directory = opendirSync(dir);
      // Bun may defer open errors until the first directory read.
      entry = directory.readSync();
    } catch (error) {
      directory?.closeSync();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      for (; entry; entry = directory.readSync()) {
        if (++entries > CALIBRATION_BOUNDS.directoryEntries) throw Error("calibration refused: directory entry bound exceeded");
        if (!entry.name.endsWith(".jsonl")) continue;
        if (++files > CALIBRATION_BOUNDS.files) throw Error("calibration refused: file count bound exceeded");
        const path = join(dir, entry.name);
        const content = readCalibrationFile(path, CALIBRATION_BOUNDS.aggregateBytes - bytes);
        bytes += content.length;
        const rows = turnTokens(content.toString("utf8"), torontoDay);
        if (rows.length) {
          for (const row of rows) samples.push(row);
          sources.push(path);
        }
      }
    } finally { directory.closeSync(); }
  }
  if (samples.length < 5) throw Error("five completed native turns required");
  samples.sort((a,b) => a-b);
  const p90 = samples[Math.ceil(samples.length * .9)-1];
  return { tokens: Math.ceil(p90 / 1000000) * 1000000, p90, samples: samples.length, sources, dates, torontoDay };
}
