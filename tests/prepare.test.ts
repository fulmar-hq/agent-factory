import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "./fixtures";
import { Store } from "../tracking/store";
test("preparation writes minute plist without loading, preserves existing files and pause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-prepare-"));
  writeFileSync(join(dir, "config.yaml"), JSON.stringify(config()));
  const run = async () => {
    const p = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../scripts/prepare.ts")],
      {
        env: { ...process.env, FACTORY_PRIVATE_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(p.stdout).text(),
      err = await new Response(p.stderr).text();
    expect(await p.exited).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("No job loaded");
  };
  try {
    await run();
    const plist = await Bun.file(
      join(dir, "com.agent-factory.tick.plist"),
    ).text();
    expect(plist).toContain("<key>StartInterval</key><integer>60</integer>");
    expect(plist).toContain("launcher/tick.ts");
    const token = await Bun.file(join(dir, "owner-token")).text();
    expect(token).toHaveLength(64);
    writeFileSync(
      join(dir, "com.agent-factory.board.plist"),
      "preserved unsaved draft",
    );
    await run();
    expect(await Bun.file(join(dir, "owner-token")).text()).toBe(token);
    expect(
      await Bun.file(join(dir, "com.agent-factory.board.plist")).text(),
    ).toBe("preserved unsaved draft");
    const s = new Store(join(dir, "controller.sqlite"));
    expect(s.get("paused")).toBe(true);
    expect(s.rows("events")).toHaveLength(6);
    s.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
