import { test, expect } from "bun:test";
import { usageTone, spendTone, timingTone } from "../board/tones";
import { config, now } from "./fixtures";

test("usage tones use raw evidence at both configured gates", () => {
  const gates = config().usage_gates;
  for (const [used, tone] of [[0,"ok"],[.69999,"ok"],[.7,"warn"],[.89999,"warn"],[.9,"bad"],[1,"bad"],[null,"rest"]] as const)
    expect(usageTone(used,gates)).toBe(tone);
  // The display helper consumes the policy rather than embedding 70/90 literals.
  expect(usageTone(.6,{admit_below:.5,stop_at:.8})).toBe("warn");
  expect(usageTone(.8,{admit_below:.5,stop_at:.8})).toBe("bad");
});

test("AWS spend colours include both plan boundaries without consulting the latch", () => {
  for (const [dollars,tone] of [[0,"ok"],[59.99,"ok"],[60,"warn"],[65,"warn"],[65.01,"bad"],[null,"rest"]] as const)
    expect(spendTone(dollars,60,65)).toBe(tone);
  expect(spendTone(30,25,29)).toBe("bad");
});

test("timing uses exact seconds and a configurable log-write quiet boundary", () => {
  expect(timingTone(1800,1800,now-899999,now,15)).toEqual({over:false,quiet:false,barTone:"ok"});
  expect(timingTone(1800.01,1800,now,now,15)).toEqual({over:true,quiet:false,barTone:"warn"});
  expect(timingTone(600,1800,now-900000,now,15)).toEqual({over:false,quiet:true,barTone:"warn"});
  expect(timingTone(600,1800,now-300000,now,5).quiet).toBe(true);
  expect(timingTone(600,1800,now-300000,now,15).quiet).toBe(false);
  expect(timingTone(600,1800,null,now,15).quiet).toBe(false);
  expect(timingTone(600,null,null,now,15).barTone).toBe("rest");
  expect(timingTone(null,1800,null,now,15).barTone).toBe("rest");
  expect(timingTone(600,1800,now+1,now,15).quiet).toBe(false);
  expect(timingTone(1800,1800,null,now,15).barTone).toBe("ok");
});
