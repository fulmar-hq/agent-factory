import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../launcher/engine";
import { config, ticket, admission } from "./fixtures";
import { Store } from "../tracking/store";
for (const mode of ["slot", "dollar", "duplicate", "retry"])
  test(`simultaneous processes compete for last ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-race-")),
      path = join(dir, "state.sqlite"),
      gate = join(dir, "go"),
      s = new Store(path);
    s.set("paused", false);
    if (mode === "retry") {
      const e = new Engine(s,config());
      const x = e.admit({...ticket(),approvalDigest:`ready:${"1".repeat(43)}`},admission());
      e.finish(x.id,false); e.archive(x.id,"fixture reconciled custody","owner");
      s.event("new-approval","intake-approval",{repo:ticket().repo,number:1,label:`ready:${"2".repeat(43)}`,receipt:"fixture Coordinator review"},"Withdraw label",Date.now()+1);
    }
    const children = [1, 2].map((n) =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "racer.ts"),
          path,
          String(["duplicate","retry"].includes(mode) ? 1 : n),
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
    expect(s.rows("sessions")).toHaveLength(mode === "retry" ? 2 : 1);
    expect(s.rows("debits")).toHaveLength(mode === "retry" ? 2 : 1);
    s.close();
    rmSync(dir, { recursive: true });
  });
