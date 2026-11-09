import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MeterSchema, type Meter } from "../launcher/config";
import { spawn } from "node:child_process";

// Installed app-server protocol: initialize -> account/rateLimits/read. No
// thread/turn, model call, reset credit consumption or login operation.
export function codexStatusMetadata(raw: unknown, observedAt: number): Meter | undefined {
  if (!raw || typeof raw !== "object") return;
  const result = raw as Record<string, any>;
  const r = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (!r || r.limitId !== "codex") return;
  const meter = codexMetadata({ timestamp: new Date(observedAt).toISOString(), payload: { rate_limits: {
    limit_id: "codex", ...Object.fromEntries(["primary", "secondary"].map(key => [key, r[key] ? {
      used_percent: r[key].usedPercent, resets_at: r[key].resetsAt,
      window_minutes: r[key].windowDurationMins ?? undefined,
    } : null])),
  } } });
  return meter ? {...meter, source: "native Codex account/rateLimits/read"} : undefined;
}
export async function codexStatus(argv = ["codex", "app-server", "--stdio"], timeoutMs = 8000): Promise<Meter | undefined> {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    let pending = "", bytes = 0, settled = false, initialized = false;
    const finish = (meter?: Meter) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(meter);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", () => finish());
    child.on("exit", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) return finish();
      pending += chunk.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.id === 1 && !initialized) {
            if (response.error || !response.result) return finish();
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
          } else if (response.id === 2 && initialized) {
            return finish(response.error ? undefined : codexStatusMetadata(response.result, Date.now()));
          }
        } catch { /* A malformed status response supplies no evidence. */ }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_factory_usage", version: "0.1.0" }, capabilities: null } });
  });
}

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
  const windows = ["primary", "secondary"].filter(key => r[key]).map(key => {
    const w = r[key];
    return ({ name: key, durationMinutes: w.window_minutes,
    used: w.used_percent / 100, resetsAt: w.resets_at * 1000,
  }); });
  const parsed = MeterSchema.safeParse({ observedAt: Date.parse(record.timestamp), windows,
    nativeProvider: "codex", source: "native Codex rate-limit receipt" });
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
    return [{ name: key, used: limits?.[key] ? w.used_percentage / 100 : w.utilization,
      resetsAt: typeof reset === "number" ? reset * 1000 : Date.parse(reset) }];
  });
  const parsed = MeterSchema.safeParse({ observedAt: Date.parse(record.timestamp), windows,
    nativeProvider: "claude", source: "native Claude rate-limit receipt" });
  return parsed.success ? parsed.data : undefined;
}
export async function claudeReading(now = Date.now(), base = join(homedir(), ".claude", "projects")): Promise<Meter | undefined> {
  return newest(await receipts(base, 1), now, claudeMetadata);
}
export async function localReadings(now = Date.now(), sources = {
  receipt: () => codexReading(now), claude: () => claudeReading(now), status: () => codexStatus(),
}) {
  const [receipt, claude, status] = await Promise.all([sources.receipt(), sources.claude(), sources.status()]);
  return { codex: status && (!receipt || status.observedAt > receipt.observedAt) ? status : receipt, claude };
}
