import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexReading } from "../adapters/usage";
import { usageGate } from "../launcher/engine";
import { now, config } from "./fixtures";
test("partial native usage stays real, drops content and credits, blocks missing window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-")),
    d = new Date(now),
    today = join(
      dir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
  mkdirSync(today, { recursive: true });
  writeFileSync(
    join(today, "fixture.jsonl"),
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      payload: {
        private: "never retained",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 3,
            resets_at: Math.floor(now / 1000) + 3600,
          },
          secondary: null,
          credits: { balance: "123" },
        },
      },
    }) + "\n",
  );
  try {
    const m = await codexReading(now, dir);
    expect(m?.windows[0].used).toBe(0.03);
    expect(JSON.stringify(m)).not.toMatch(/private|credits|123/);
    expect(() => usageGate(m, true, now, config())).toThrow("window missing");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
