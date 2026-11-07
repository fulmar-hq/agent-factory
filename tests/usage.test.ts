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

import {claudeReading, claudeMetadata} from "../adapters/usage";
test("Claude local structured subscription windows feed 70/90 gates without model calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-claude-"));
  mkdirSync(join(dir,"project"));
  const record = (used:number, timestamp = now) => ({timestamp:new Date(timestamp).toISOString(),
    rate_limits:{five_hour:{used_percentage:used,resets_at:now/1000+3600},seven_day:{used_percentage:12,resets_at:now/1000+604800}},
    message:"private prompt", usage:{input_tokens:10000}});
  try {
    writeFileSync(join(dir,"project","session.jsonl"),[record(70),record(0,now+1000)].map(x => JSON.stringify(x)).join("\n"));
    const reading = await claudeReading(now,dir);
    expect(reading?.windows.map(x=>x.used)).toEqual([.7,.12]);
    expect(JSON.stringify(reading)).not.toMatch(/private|input_tokens/);
    expect(()=>usageGate(reading,false,now,config())).toThrow("high benefit");
    expect(()=>usageGate(reading,true,now,config())).not.toThrow();
    expect(()=>usageGate(claudeMetadata(record(90)),true,now,config())).toThrow("usage stop");
    expect(()=>usageGate(claudeMetadata(record(1,now-900001)),true,now,config())).toThrow("stale");
    expect(claudeMetadata({timestamp:new Date(now).toISOString(),message:JSON.stringify(record(1))})).toBeUndefined();
    expect(claudeMetadata({...record(1),rate_limits:{five_hour:{used_percentage:101,resets_at:now/1000+3600}}})).toBeUndefined();
    expect(()=>usageGate(claudeMetadata({...record(1),rate_limits:{five_hour:record(1).rate_limits.five_hour}}),true,now,config())).toThrow("window missing");
  } finally {rmSync(dir,{recursive:true});}
});
