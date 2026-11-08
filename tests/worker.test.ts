import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { config, ticket, admission, qualification, meter } from "./fixtures";
test("real supervisors launch fixture once and terminate its process at 2x", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-worker-")),
    source = join(dir, "repo"),
    bin = join(dir, "bin");
  mkdirSync(source);
  mkdirSync(bin);
  for (const args of [
    ["init", "-q", source],
    [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Synthetic base",
    ],
  ]) {
    const p = Bun.spawnSync(["git", ...args]);
    expect(p.exitCode).toBe(0);
  }
  const time = Date.now(),
    c = config(),
    t = { ...ticket(), estimateSeconds: 0.3 },
    q = { ...qualification(), expiresAt: time + 60000 };
  writeFileSync(join(dir, "config.yaml"), JSON.stringify(c));
  writeFileSync(join(dir, "qualifications.json"), JSON.stringify({ codex: q }));
  writeFileSync(
    join(dir, "repositories.json"),
    JSON.stringify({ "example/demo": source }),
  );
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nif [ "$1" = login ]; then echo 'Logged in using ChatGPT'; exit 0; fi\necho started >> '${dir}/starts'\necho '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000001"}'\ntrap 'exit 0' TERM INT\nwhile :; do /bin/sleep 0.05; done\n`,
    { mode: 0o700 },
  );
  const s = new Store(join(dir, "controller.sqlite")),
    e = new Engine(s, c);
  e.pause(false, "owner");
  const x = e.admit(t, {
    ...admission(),
    now: time,
    meter: {
      ...meter(),
      observedAt: time,
      windows: [
        { used: 0.1, resetsAt: time + 60000 },
        { used: 0.1, resetsAt: time + 60000 },
      ],
    },
    qualification: q,
  });
  s.set("readings", {
    codex: {
      observedAt: time,
      windows: [
        { used: 0.1, resetsAt: time + 60000 },
        { used: 0.1, resetsAt: time + 60000 },
      ],
      source: "fixture",
    },
  });
  e.claimStart(x.id, time);
  const children = [1, 2].map(() =>
    Bun.spawn(
      [process.execPath, join(import.meta.dir, "../launcher/worker.ts"), x.id],
      {
        env: {
          ...process.env,
          FACTORY_PRIVATE_DIR: dir,
          PATH: bin + ":" + process.env.PATH,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  try {
    await Promise.all(
      children.map(async (p) => {
        const err = await new Response(p.stderr).text();
        expect(await p.exited).toBe(0);
        expect(err).toBe("");
      }),
    );
    expect(
      (await Bun.file(join(dir, "starts")).text()).trim().split("\n"),
    ).toHaveLength(1);
    expect(e.sessions()[0].status).toBe("paused");
    expect(e.sessions()[0].native_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(e.sessions()[0].actual_seconds).toBeGreaterThanOrEqual(0.6);
    expect(s.rows("questions")).toHaveLength(1);
  } finally {
    for (const p of children) p.kill();
    s.close();
    rmSync(dir, { recursive: true });
  }
}, 10000);
