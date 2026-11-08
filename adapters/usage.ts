import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MeterSchema, type Meter } from "../launcher/config";

type File = { path: string; size: number; modified: number };
// Fixed-depth native directories only: no transcripts, credentials or credits retained.
async function receipts(base: string, depth: number): Promise<File[]> {
  const files: File[] = [];
  try {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const path = join(base, entry.name);
      if (entry.isDirectory() && depth > 0) files.push(...await receipts(path, depth - 1));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path);
          files.push({ path, size: info.size, modified: info.mtimeMs });
        } catch { /* A disappearing receipt must not hide the other evidence. */ }
      }
    }
  } catch { /* A missing directory is unknown evidence. */ }
  return files;
}
async function newest(files: File[], now: number, parse: (x: unknown) => Meter | undefined) {
  let best: Meter | undefined;
  for (const file of files.sort((a, b) => b.modified - a.modified).slice(0, 20)) {
    try {
      const handle = await open(file.path, "r");
      let text: string;
      try {
        const length = Math.min(file.size, 262144), buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, file.size - length);
        text = buf.toString("utf8");
      } finally { await handle.close(); }
      for (const line of text.split("\n")) {
        try {
          const meter = parse(JSON.parse(line));
          if (meter && meter.observedAt <= now && (!best || meter.observedAt > best.observedAt)) best = meter;
        } catch { /* Partial tail lines and invalid metadata supply no evidence. */ }
      }
    } catch { /* Continue through inaccessible receipts. */ }
  }
  return best;
}
export function codexMetadata(x: unknown): Meter | undefined {
  if (!x || typeof x !== "object") return;
  const record = x as Record<string, any>, r = record.payload?.rate_limits;
  if (!r || r.limit_id !== "codex") return;
  const windows = [r.primary, r.secondary].filter(Boolean).map(w => ({
    used: w.used_percent / 100, resetsAt: w.resets_at * 1000,
  }));
  const parsed = MeterSchema.safeParse({ observedAt: Date.parse(record.timestamp), windows,
    source: "native Codex rate-limit receipt" });
  return parsed.success ? parsed.data : undefined;
}
export async function codexReading(now = Date.now(), base = join(homedir(), ".codex", "sessions")): Promise<Meter | undefined> {
  // Active rollouts can live under an earlier day; midnight must not hide them.
  return newest(await receipts(base, 3), now, codexMetadata);
}

// Only structured subscription metadata is quota. Never infer it from tokens,
// status=allowed, prose, reset expiry, or the receipt file's modification time.
export function claudeMetadata(x: unknown): Meter | undefined {
  if (!x || typeof x !== "object") return;
  const record = x as Record<string, any>;
  const limits = record.rate_limits;
  const unified = record.type === "rate_limit_event" ? record.rate_limit_info?.unifiedWindows : undefined;
  if (!limits && !unified) return;
  const windows = ["five_hour", "seven_day"].flatMap(key => {
    const w = limits?.[key] ?? unified?.[key];
    if (!w) return [];
    const reset = w.resets_at ?? w.resetsAt;
    return [{ used: limits?.[key] ? w.used_percentage / 100 : w.utilization,
      resetsAt: typeof reset === "number" ? reset * 1000 : Date.parse(reset) }];
  });
  const parsed = MeterSchema.safeParse({ observedAt: Date.parse(record.timestamp), windows,
    source: "native Claude rate-limit receipt" });
  return parsed.success ? parsed.data : undefined;
}
export async function claudeReading(now = Date.now(), base = join(homedir(), ".claude", "projects")): Promise<Meter | undefined> {
  return newest(await receipts(base, 1), now, claudeMetadata);
}
export async function localReadings(now = Date.now()) {
  const [codex, claude] = await Promise.all([codexReading(now), claudeReading(now)]);
  return { codex, claude };
}
