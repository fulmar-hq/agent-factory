import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Synthetic DOM readback: executes the shipped board renderer, not a browser.
class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  attributes: Record<string, string> = {};
  constructor(public tagName = "div") {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
const source = readFileSync(new URL("../board/app.js", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const controller = {
  slots: 6, at: now, busy: 5 / 6, pressure: "normal", failureRate: 0.2,
  healthySince: now - 30 * 60000, reason: "collecting healthy hour",
};
function render(c: unknown = controller, language = "en", at = now) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), documentElement: {} },
    fetch: () => new Promise(() => {}), setInterval: () => {},
    snapshot: {
      now: at, paused: false, slots: { used: 8, max: 6, controller: c },
      sessions: ["starting", "running", "running", "running", "running", "paused", "unknown", "unknown"].map(
        (status, i) => ({ status, ticket: `fictional/${i}` }),
      ),
      usage: {}, usageAdmission: {}, qualifications: {}, estimator: { evaluation: {} },
      wallet: { awsCents: 0, otherCents: 0 }, questions: [], tickets: [], releases: [], owners: [],
    },
    language,
  });
  runInContext(source, context);
  runInContext("data = snapshot; lang = language; render();", context);
  const rows = () => Object.fromEntries(get("capacity-evidence").children.map(row =>
    row.children.map(child => child.textContent),
  ));
  return { get, rows, context };
}

test("capacity uses controller samples and distinguishes retained custody from occupancy", () => {
  const { rows, get } = render();
  expect(rows()).toEqual({
    "Current admission limit": "6",
    "Controller maximum (not supplied)": "Unknown",
    "Occupied / admission limit (includes retained custody)": "8 / 6",
    "Paused / unknown custody": "1 / 2",
    "Starting/running busy fraction (sampled)": "83.3%",
    "Memory pressure": "Normal",
    "Failure rate · trailing hour": "20%",
    "Healthy dwell at sample": "30 min",
    "Growth status / hold reason": "Collecting a healthy hour",
    "Controller sample": new Date(now).toLocaleString("en"),
  });
  expect(get("capacity-status").textContent).toBe("");
});

test("missing evidence never becomes zero, normal pressure or a healthy dwell", () => {
  const { rows, get } = render(null);
  expect(get("capacity-status").textContent).toBe("Controller evidence unavailable");
  for (const key of ["Memory pressure", "Failure rate · trailing hour", "Healthy dwell at sample",
    "Starting/running busy fraction (sampled)", "Growth status / hold reason"])
    expect(rows()[key]).toBe("Unknown");
  expect(rows()["Current admission limit"]).toBe("6");
});

test("stale and future samples cannot imply current health or extend the sampled dwell", () => {
  for (const at of [now + 120001, now - 1]) {
    const { get, rows } = render(controller, "en", at);
    expect(get("capacity-status").textContent).toContain("current growth status unknown");
    expect(rows()["Healthy dwell at sample"]).toBe(at > now ? "30 min" : "Unknown");
  }
});

test("real pressure states, zero rates and stopped dwell render honestly", () => {
  for (const [pressure, label] of [["normal", "Normal"], ["warning", "Warning"],
    ["critical", "Critical"], ["unknown", "Unknown"]]) {
    const { rows } = render({ ...controller, pressure, failureRate: 0, busy: 0,
      healthySince: null, reason: "memory pressure not normal" });
    expect(rows()["Memory pressure"]).toBe(label);
    expect(rows()["Failure rate · trailing hour"]).toBe("0%");
    expect(rows()["Starting/running busy fraction (sampled)"]).toBe("0%");
    expect(rows()["Healthy dwell at sample"]).toBe("Not accumulating");
  }
  const { rows } = render({ ...controller, busy: -1, failureRate: 2, pressure: "unexpected" });
  expect(rows()["Memory pressure"]).toBe("Unknown");
  expect(rows()["Failure rate · trailing hour"]).toBe("Unknown");
  expect(rows()["Starting/running busy fraction (sampled)"]).toBe("Unknown");
});

test("French evidence and each known growth reason survive a language change without duplicate rows", () => {
  for (const [reason, translated] of [
    ["memory pressure not normal", "Pression mémoire non normale"],
    ["occupancy below threshold", "Occupation en démarrage/exécution sous le seuil"],
    ["failure rate too high", "Taux d’échec trop élevé"],
    ["collecting healthy hour", "Collecte d’une heure saine"],
    ["added one slot after healthy hour", "Une place ajoutée après une heure saine"],
    ["maximum capacity", "Capacité maximale atteinte"],
  ]) {
    const { rows, get, context } = render({ ...controller, reason }, "fr");
    expect(rows()["État de croissance / motif de blocage"]).toBe(translated);
    expect(rows()["Pression mémoire"]).toBe("Normale");
    expect(rows()["Taux d’échec · dernière heure"]).toBe("20%");
    runInContext('lang = "en"; render();', context);
    expect(get("capacity-evidence").children).toHaveLength(10);
    expect(get("pause").textContent).toBe("Pause");
  }
});

test("unknown reason is inert text and capacity adds no scheduling controls", () => {
  const reason = '<img src=x onerror="throw Error()">';
  const { rows } = render({ ...controller, reason });
  expect(rows()["Growth status / hold reason"]).toBe(reason);
  const html = readFileSync(new URL("../board/index.html", import.meta.url), "utf8");
  const panel = html.split('aria-labelledby="capacity-title"')[1]!.split("</section>")[0]!;
  expect(panel).toContain('<h2 id="capacity-title">');
  expect(panel).toContain('id="capacity-status" role="status"');
  expect(panel).toContain('<dl id="capacity-evidence"');
  expect(panel).not.toMatch(/<(button|input|select)\b/);
  const css = readFileSync(new URL("../board/style.css", import.meta.url), "utf8");
  expect(css).toContain("minmax(min(100%, 240px), 1fr)");
  expect(css).toContain("button:focus-visible");
  expect(css).toContain("summary:focus-visible");
});
