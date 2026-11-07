import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { board } from "../board/server";
import { config } from "./fixtures";
test("board binds loopback, shows local data, rejects helper and cross-origin writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-board-"));
  writeFileSync(join(dir, "config.yaml"), JSON.stringify(config()));
  writeFileSync(join(dir, "owner-token"), "a".repeat(64));
  mkdirSync(join(dir, "owners"));
  writeFileSync(join(dir, "owners/builder.md"), "Synthetic custody brief");
  const b = await board(dir, 0),
    base = `http://127.0.0.1:${b.server.port}`;
  try {
    expect(b.server.hostname).toBe("127.0.0.1");
    const state = await (await fetch(base + "/api/state")).json();
    expect(state.paused).toBe(true);
    expect(state.owners[0].brief).toBe("Synthetic custody brief");
    expect(state.usage).toEqual({});
    const post = (token: string, origin: string, path = "/api/pause") =>
      fetch(base + path, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused: false }),
      });
    expect((await post("helper", base)).status).toBe(403);
    expect((await post("a".repeat(64), "https://evil.invalid")).status).toBe(
      403,
    );
    expect((await post("a".repeat(64), base)).status).toBe(200);
    expect((await (await fetch(base + "/api/state")).json()).paused).toBe(
      false,
    );
    expect((await post("a".repeat(64), base, "/api/fund")).status).toBe(400);
    expect(
      (await fetch(base + "/api/state", { headers: { Host: "evil.invalid" } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(base)).headers.get("Content-Security-Policy"),
    ).toContain("frame-ancestors 'none'");
  } finally {
    b.close();
    rmSync(dir, { recursive: true });
  }
});
