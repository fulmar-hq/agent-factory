import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tick } from "../launcher/tick";
import { Store } from "../tracking/store";
import { config } from "./fixtures";
test("two idle ticks and controlled relaunch call no models and preserve read-only config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-idle-")),
    bin = join(dir, "bin"),
    calls = join(dir, "calls");
  mkdirSync(bin);
  const raw = JSON.stringify(config());
  writeFileSync(join(dir, "config.yaml"), raw);
  for (const name of ["gh", "codex", "claude"])
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${calls}'\nif [ "$1" = '--version' ]; then echo fixture; elif [ "$1" = issue ]; then echo '[]'; else exit 81; fi\n`,
      { mode: 0o700 },
    );
  const old = process.env.PATH;
  process.env.PATH = bin;
  try {
    await tick(dir);
    await tick(dir);
    const text = await Bun.file(calls).text();
    expect(text).not.toMatch(/exec| -p| --bg|login|auth/);
    expect((text.match(/issue list/g) || []).length).toBe(2);
    expect(await Bun.file(join(dir, "config.yaml")).text()).toBe(raw);
    const s = new Store(join(dir, "controller.sqlite"));
    expect(s.get("paused")).toBe(true);
    expect(s.rows("sessions")).toHaveLength(0);
    expect(s.get<{ status: string }>("heartbeat")?.status).toBe("ok");
    s.close();
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true });
  }
});
