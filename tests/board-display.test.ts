import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { Store } from "../tracking/store";
import { Engine, usageGate } from "../launcher/engine";
import { boardModel, type Language } from "../board/model";
import type { Meter } from "../launcher/config";
import { config, now, billing } from "./fixtures";

const weeklyClaude = (used = 0.4567): Meter => ({
  observedAt: now,
  nativeProvider: "claude",
  source: "fictional private source receipt",
  windows: [
    { used: 0.12, resetsAt: now + 3600000, name: "five_hour" },
    { used, resetsAt: now + 86400000, name: "seven_day", durationMinutes: 10080 },
  ],
});
function display(readings: Parameters<typeof boardModel>[1], at = now, lang: Language = "en") {
  const s = new Store(":memory:");
  try { return boardModel(new Engine(s, config()), readings, at, lang); }
  finally { s.close(); }
}

test("Claude keeps last known weekly percent and age; stale display never changes admission", () => {
  const s = new Store(":memory:"), c = config(), e = new Engine(s, c);
  const readings = { claude: weeklyClaude(), billing: billing() };
  const original = JSON.stringify(readings);
  try {
    for (const [age, freshness] of [[0, "fresh"], [900000, "fresh"], [900001, "stale"], [86400001, "stale"]] as const) {
      const at = now + age;
      const gate = () => usageGate(readings.claude, false, at, c, "claude");
      if (freshness === "stale") expect(gate).toThrow("usage stale");
      else expect(gate).not.toThrow();
      const m = boardModel(e, readings, at);
      expect(m.usage[1]).toMatchObject({ percent: 45.6, resetsAt: now + 86400000, ageSeconds: age / 1000, freshness, tone: freshness === "fresh" ? "ok" : "rest" });
      if (freshness === "stale") expect(gate).toThrow("usage stale");
    }
    // An expired reset alone marks the retained number stale; no fresh zero is invented.
    readings.claude.windows[1].resetsAt = now;
    expect(boardModel(e, readings, now).usage[1]).toMatchObject({ percent: 45.6, freshness: "stale", ageSeconds: 0, tone: "rest" });
    expect(() => usageGate(readings.claude, true, now, c, "claude")).toThrow("usage stale");
    readings.claude.windows[1].resetsAt = now + 86400000;
    expect(JSON.stringify(readings)).toBe(original);
    expect(s.rows("events")).toEqual([]);
    expect(c.usage_gates.admit_below).toBe(0.70);
    expect(c.usage_gates.stop_at).toBe(0.90);
    for (const [used, reason] of [[0.70, "high benefit only"], [0.90, "usage stop"]] as const) {
      readings.claude.windows[1].used = used;
      expect(boardModel(e, readings, now).usage[1].percent).toBe(used * 100);
      expect(() => usageGate(readings.claude, false, now, c, "claude")).toThrow(reason);
    }
  } finally { s.close(); }
});

test("unknown weekly evidence stays unknown, real zero stays zero, and Codex freshness is unchanged", () => {
  const valid = weeklyClaude();
  for (const claude of [undefined,
    { ...valid, windows: [valid.windows[0]] },
    { ...valid, observedAt: now + 1 },
    { ...valid, observedAt: NaN },
    { ...valid, nativeProvider: "codex" as const },
    { ...valid, windows: [{ ...valid.windows[1], used: 1.1 }] },
    { ...valid, windows: [{ ...valid.windows[1], used: NaN }] },
  ]) {
    expect(display({ claude }).usage[1]).toMatchObject({ percent: null, freshness: "unknown", ageSeconds: null, resetsAt: null, tone: "rest" });
  }
  expect(display({ claude: weeklyClaude(0) }).usage[1]).toMatchObject({ percent: 0, freshness: "fresh" });
  expect(display({ claude: weeklyClaude(0) }, now + 900001).usage[1]).toMatchObject({ percent: 0, freshness: "stale" });
  expect(display({ codex: { ...valid, nativeProvider: "codex" } }, now + 900001).usage[0].percent).toBeNull();
  const publicView = JSON.stringify(display({ claude: valid, billing: { ...billing(), receipt: "fictional private billing receipt" } }));
  expect(publicView).not.toContain("fictional private");
  expect(publicView).not.toContain('"source"');
  expect(publicView).not.toContain('"receipt"');
});

test("AWS shows existing actual dollars and percent of the unchanged ceiling, never missing as zero", () => {
  const actual = { ...billing(), postedCents: 2500, unpostedCents: 500, fixedCents: 1000, projectedCents: 7000 };
  const m = display({ billing: actual });
  expect(m.aws).toMatchObject({ dollars: 30, percent: 40, ceiling: 75, freshness: "fresh", ageSeconds: 0 });
  expect(display({ billing: { ...actual, postedCents: 0, unpostedCents: 0 } }).aws).toMatchObject({ dollars: 0, percent: 0, freshness: "fresh" });
  expect(display({ billing: { ...actual, postedCents: 8000 } }).aws.percent).toBeCloseTo(113.3);
  expect(display({ billing: actual }, now + 86400000).aws.dollars).toBe(30);
  for (const [reading, at, freshness] of [
    [undefined, now, "unknown"],
    [{ ...actual, observedAt: now + 1 }, now, "unknown"],
    [{ ...actual, postedCents: NaN }, now, "unknown"],
    [actual, now + 86400001, "stale"],
    [{ ...actual, month: "2026-10" }, now, "stale"],
  ] as const) {
    expect(display({ billing: reading }, at).aws).toMatchObject({ dollars: null, percent: null, ceiling: 75, freshness });
  }
  const s = new Store(":memory:"), e = new Engine(s, config());
  try {
    s.set("aws-stop-latched", true);
    expect(boardModel(e, { billing: actual }, now).aws).toMatchObject({ dollars: 30, percent: 40, stopped: true });
    expect(s.get("aws-stop-latched")).toBe(true);
  } finally { s.close(); }
});

// Run the real browser script with a small DOM surface; no browser, network or controls are used.
async function renderedBand(model: ReturnType<typeof boardModel>, lang: Language) {
  const elements = new Map<string, { innerHTML: string; textContent: string; hidden: boolean; addEventListener(): void; setAttribute(): void; querySelectorAll(): never[] }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", hidden: false, addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; } });
    return elements.get(id)!;
  };
  const requests: string[] = [];
  runInNewContext(readFileSync(join(import.meta.dir, "../board/app.js"), "utf8"), {
    document: { getElementById: element, documentElement: {}, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { hostname: "127.0.0.1", search: "" },
    localStorage: { getItem: () => lang },
    URLSearchParams,
    fetch: async (path: string) => { requests.push(path); return { ok: true, json: async () => model }; },
    setInterval() {},
  });
  // Drain the mocked fetch/json microtasks and render without polling or real timers.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(element("connection").textContent).not.toContain("Retrying");
  expect(requests).toEqual([`/api/board?lang=${lang}`]);
  const html = element("app").innerHTML;
  expect(html).toContain('<section class="band">');
  return html.slice(0, html.indexOf('</section>') + '</section>'.length);
}

test("EN/FR board renders retained Claude age and stale/unknown labels plus billing dollars/percent", async () => {
  for (const lang of ["en", "fr"] as const) {
    const stale = display({ claude: weeklyClaude(), billing: { ...billing(), postedCents: 2500, unpostedCents: 500 } }, now + 3600000, lang);
    let html = await renderedBand(stale, lang);
    expect(html).toContain('45.6 %');
    expect(html).toContain(lang === "en" ? "Stale" : "Périmé");
    expect(html).toContain(lang === "en" ? "Observed 1 h ago" : "Relevé il y a 1 h");
    expect(html).toContain(lang === "en" ? "$30.00" : "30,00 $");
    expect(html).toContain(lang === "en" ? "$75" : "75 $");
    expect(html).toContain("40 %");
    expect(html).not.toContain("At limit");
    html = await renderedBand(display({}, now, lang), lang);
    expect(html).toContain(lang === "en" ? "Unknown" : "Inconnu");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("0 %");
    html = await renderedBand(display({ claude: weeklyClaude(0), billing: { ...billing(), postedCents: 0, unpostedCents: 0 } }, now, lang), lang);
    expect(html).toContain('value="0"');
    expect(html).toContain(lang === "en" ? "Observed less than 1 min ago" : "Relevé il y a moins de 1 min");
    // Only the missing Codex reading is unknown; real Claude/AWS zero is visible.
    expect(html.match(new RegExp(lang === "en" ? "Unknown" : "Inconnu", "g"))).toHaveLength(1);
  }
});
