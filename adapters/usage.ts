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
