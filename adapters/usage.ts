import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MeterSchema, type Meter } from "../launcher/config";
// Read only the rate-limit metadata from bounded tails of today's local native receipts.
// Never retain prompts, responses, credentials or credit balances.
export async function codexReading(
  now = Date.now(),
  base = join(homedir(), ".codex", "sessions"),
): Promise<Meter | undefined> {
  const date = new Date(now),
    dir = join(
      base,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    );
  try {
    const files = (
      await Promise.all(
        (await readdir(dir))
          .filter((x) => x.endsWith(".jsonl"))
          .map(async (name) => ({ name, stat: await stat(join(dir, name)) })),
      )
    )
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 5);
    let best: Meter | undefined;
    for (const file of files) {
      const handle = await open(join(dir, file.name), "r");
      let text = "";
      try {
        const length = Math.min(file.stat.size, 262144),
          buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, file.stat.size - length);
        text = buf.toString("utf8");
      } finally {
        await handle.close();
      }
      for (const line of text.split("\n"))
        try {
          const x = JSON.parse(line),
            r = x.payload?.rate_limits;
          if (!r || r.limit_id !== "codex") continue;
          const windows = [r.primary, r.secondary].filter(Boolean).map((w) => ({
            used: w.used_percent / 100,
            resetsAt: w.resets_at * 1000,
          }));
          const parsed = MeterSchema.safeParse({
            observedAt: Date.parse(x.timestamp),
            windows,
            source: "native Codex rate-limit receipt",
          });
          if (
            parsed.success &&
            parsed.data.observedAt <= now &&
            (!best || parsed.data.observedAt > best.observedAt)
          )
            best = parsed.data;
        } catch {}
    }
    return best;
  } catch {
    return undefined;
  }
}

// Claude status-line/session metadata only. Token totals and prose are never quota.
export function claudeMetadata(x: unknown): Meter | undefined {
  if (!x || typeof x !== "object") return;
  const record = x as Record<string, any>;
  const limits = record.rate_limits;
  if (!limits || typeof limits !== "object") return;
  const windows = [limits.five_hour, limits.seven_day].filter(Boolean).map(w => ({
    used: w.used_percentage / 100,
    resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : Date.parse(w.resets_at),
  }));
  const parsed = MeterSchema.safeParse({ observedAt: Date.parse(record.timestamp), windows,
    source: "native Claude rate-limit receipt" });
  return parsed.success ? parsed.data : undefined;
}
export async function claudeReading(now = Date.now(), base = join(homedir(), ".claude", "projects")): Promise<Meter | undefined> {
  try {
    const files: {path: string; size: number; modified: number}[] = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name), info = await stat(path);
        files.push({path, size: info.size, modified: info.mtimeMs});
      }
    }
    let best: Meter | undefined;
    for (const file of files.sort((a,b) => b.modified-a.modified).slice(0,5)) {
      const handle = await open(file.path, "r");
      try {
        const length = Math.min(file.size, 262144), buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, file.size-length);
        for (const line of buf.toString("utf8").split("\n")) {
          try {
            const meter = claudeMetadata(JSON.parse(line));
            if (meter && meter.observedAt <= now && (!best || meter.observedAt > best.observedAt)) best = meter;
          } catch {}
        }
      } finally { await handle.close(); }
    }
    return best;
  } catch { return undefined; }
}
export async function localReadings(now = Date.now()) {
  const [codex, claude] = await Promise.all([codexReading(now), claudeReading(now)]);
  return { codex, claude };
}
