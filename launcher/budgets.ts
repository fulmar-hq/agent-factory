import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("UTC date required");
    const dir = join(home, ".codex/sessions", date.replaceAll("-", "/"));
    let names: string[] = []; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.filter(n => n.endsWith(".jsonl"))) {
      const path = join(dir, name), rows = turnTokens(readFileSync(path, "utf8"),torontoDay);
      if (rows.length) { samples.push(...rows); sources.push(path); }
    }
  }
  if (samples.length < 5) throw Error("five completed native turns required");
  samples.sort((a,b) => a-b);
  const p90 = samples[Math.ceil(samples.length * .9)-1];
  return { tokens: Math.ceil(p90 / 1000000) * 1000000, p90, samples: samples.length, sources, dates, torontoDay };
}
