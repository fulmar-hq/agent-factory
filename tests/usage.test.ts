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

test("Codex reads active prior-day rollouts and both real windows on every poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-rollout-"));
  const day = join(dir, "2020", "01", "01");
  mkdirSync(day, {recursive:true});
  const path = join(day, "active.jsonl");
  const record = (used:number, at=now) => ({timestamp:new Date(at).toISOString(), payload:{rate_limits:{limit_id:"codex",
    primary:{used_percent:used,resets_at:now/1000+3600},secondary:{used_percent:25,resets_at:now/1000+604800}}}});
  try {
    writeFileSync(path, JSON.stringify(record(10)));
    expect((await codexReading(now,dir))?.windows.map(w=>w.used)).toEqual([.1,.25]);
    writeFileSync(path, JSON.stringify(record(90)));
    const updated = await codexReading(now,dir);
    expect(()=>usageGate(updated,true,now,config())).toThrow("usage stop");
    expect(updated?.observedAt).toBe(now);
  } finally {rmSync(dir,{recursive:true});}
});

test("Claude unified window events require an original timestamp and both windows", () => {
  const event = {type:"rate_limit_event",timestamp:new Date(now).toISOString(),rate_limit_info:{status:"allowed",unifiedWindows:{
    five_hour:{utilization:.12,resetsAt:now/1000+3600},seven_day:{utilization:.45,resetsAt:now/1000+604800}}}};
  expect(claudeMetadata(event)?.windows.map(w=>w.used)).toEqual([.12,.45]);
  expect(claudeMetadata({...event,timestamp:undefined})).toBeUndefined();
  const partial = claudeMetadata({...event,rate_limit_info:{unifiedWindows:{seven_day:event.rate_limit_info.unifiedWindows.seven_day}}});
  expect(()=>usageGate(partial,true,now,config())).toThrow("window missing");
  expect(()=>usageGate(claudeMetadata({...event,timestamp:new Date(now-900001).toISOString()}),true,now,config())).toThrow("stale");
});

import { ConfigSchema } from "../launcher/config";
import { codexMetadata } from "../adapters/usage";
import { Engine } from "../launcher/engine";
import { Store } from "../tracking/store";
import { ticket, admission } from "./fixtures";
const exposedConfig = () => ConfigSchema.parse({...config(), usage_windows: {
  rule: "gate on every window the provider actually exposes; require at least one fresh native window (<= max age); 70/90% thresholds apply to each exposed window; missing data = refuse",
}});
const weekly = (used = 6, at = now) => codexMetadata({timestamp:new Date(at).toISOString(),payload:{rate_limits:{limit_id:"codex",
  primary:{used_percent:used,window_minutes:10080,resets_at:now/1000+604800},secondary:null}}});
test("configured exposed-window policy admits one fresh native weekly window", () => {
  const s = new Store(":memory:"), e = new Engine(s, exposedConfig());
  try {
    e.pause(false,"owner");
    expect(e.admit(ticket(), {...admission(),meter:weekly()}).status).toBe("reserved");
    expect(weekly()).toMatchObject({nativeProvider:"codex",windows:[{name:"primary",durationMinutes:10080,used:.06}]});
    expect(()=>usageGate(weekly(),false,now,config())).toThrow("window missing");
  } finally { s.close(); }
});
test("exposed windows still refuse stale, future, expired, absent and non-native evidence", () => {
  const c = exposedConfig();
  for (const at of [now-900001,now+1]) expect(()=>usageGate(weekly(6,at),true,now,c)).toThrow("stale");
  const expired = weekly()!; expired.windows[0].resetsAt=now;
  expect(()=>usageGate(expired,true,now,c)).toThrow("stale");
  expect(()=>usageGate(undefined,true,now,c)).toThrow("unknown");
  expect(()=>usageGate({...weekly(),windows:[]},true,now,c)).toThrow("unknown");
  expect(()=>usageGate({...weekly(),nativeProvider:undefined},true,now,c)).toThrow("native usage unknown");
  expect(()=>usageGate(weekly(),true,now,c,"claude")).toThrow("native usage unknown");
});
test("70/90 thresholds apply to every exposed window, including a single weekly window", () => {
  const c=exposedConfig();
  expect(()=>usageGate(weekly(70),false,now,c)).toThrow("high benefit only");
  expect(()=>usageGate(weekly(70),true,now,c)).not.toThrow();
  expect(()=>usageGate(weekly(90),true,now,c)).toThrow("usage stop");
  const two=weekly()!;
  two.windows.push({used:.9,resetsAt:now+3600000,name:"secondary"});
  expect(()=>usageGate(two,true,now,c)).toThrow("usage stop");
  two.windows[1].used=.1; two.windows[1].resetsAt=now;
  expect(()=>usageGate(two,true,now,c)).toThrow("stale");
  const claude=claudeMetadata({timestamp:new Date(now).toISOString(),rate_limits:{seven_day:{used_percentage:6,resets_at:now/1000+604800}}});
  expect(()=>usageGate(claude,false,now,c,"claude")).not.toThrow();
  expect(claude?.windows[0].name).toBe("seven_day");
});
