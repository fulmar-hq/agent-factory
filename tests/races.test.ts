import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../tracking/store";
for (const mode of ["slot", "dollar", "duplicate"])
  test(`simultaneous processes compete for last ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-race-")),
      path = join(dir, "state.sqlite"),
      gate = join(dir, "go"),
      s = new Store(path);
    s.set("paused", false);
    const children = [1, 2].map((n) =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "racer.ts"),
          path,
          String(mode === "duplicate" ? 1 : n),
          mode,
          gate,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    await Bun.sleep(100);
    await Bun.write(gate, "go");
    const out = await Promise.all(
      children.map(async (p) => {
        const text = await new Response(p.stdout).text(),
          err = await new Response(p.stderr).text();
        expect(await p.exited).toBe(0);
        expect(err).toBe("");
        return text.trim();
      }),
    );
    expect(out.sort()).toEqual(["admitted", "refused"]);
    expect(s.rows("sessions")).toHaveLength(1);
    expect(s.rows("debits")).toHaveLength(1);
    s.close();
    rmSync(dir, { recursive: true });
  });
