import { expect, test } from "bun:test";
import { history } from "../estimator/predict";
import { refreshHistory } from "../estimator/refresh";
import { Store } from "../tracking/store";

const repo = "fictional/history";
const issue = {
  number: 7, createdAt: "2026-01-01T00:00:00Z", closedAt: "2026-01-02T00:00:00Z",
  labels: [{name:"area:controller"}, {name:"kind:fix"}], body: "Fictional completed work",
};
const now = Date.parse("2026-02-01T00:00:00Z");
const snapshot = (s: Store) => ({
  history: s.get("estimate-history"), source: s.get("estimate-history-source"), events: s.rows("events"),
});

// Every refresh, including setup, uses injected output and an in-memory database.
async function withPrior(run: (s: Store) => Promise<void>) {
  const s = new Store(":memory:");
  try {
    await refreshHistory(s, async () => JSON.stringify([issue]), now, [repo]);
    s.event("fictional-existing-event", "fixture", {}, "Retain fictional evidence", now);
    await run(s);
  } finally { s.close(); }
}

const invalidResponses: [string, unknown][] = [
  ["null", null], ["object", {}], ["array-like object", {length:0}],
  ["string", "closed"], ["number", 1], ["boolean", false],
  ["null row", [null]], ["array row", [[]]], ["missing fields", [{}]],
  ["missing labels", [{...issue, labels:undefined}]],
  ["null labels", [{...issue, labels:null}]],
  ["object labels", [{...issue, labels:{name:"imported"}}]],
  ["null label", [{...issue, labels:[null]}]],
  ["missing label name", [{...issue, labels:[{}]}]],
  ["numeric label name", [{...issue, labels:[{name:1}]}]],
  ["object body", [{...issue, body:{text:"imported"}}]],
  ["null body", [{...issue, body:null}]],
  ...[undefined, null, "7", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(
    number => [`invalid identity ${String(number)}`, [{...issue, number}]] as [string, unknown]),
  ["duplicate identity", [issue, issue]],
];
for (const field of ["createdAt", "closedAt"] as const) {
  for (const value of [undefined, null, 123, "", "not-a-date", "2026-02-30T00:00:00Z", "2026-01-01"]) {
    invalidResponses.push([`${field}: ${String(value)}`, [{...issue, [field]:value}]]);
  }
}
invalidResponses.push(
  ["equal dates", [{...issue, closedAt:issue.createdAt}]],
  ["reversed dates", [{...issue, closedAt:"2025-12-31T23:59:59Z"}]],
  ["invalid derived timestamp", [{...issue, createdAt:"1970-01-01T00:00:00Z"}]],
  ["bad row after valid row", [issue, {...issue, number:8, closedAt:"invalid"}]],
  ["invalid imported row", [{...issue, labels:[{name:"imported"}], closedAt:"invalid"}]],
);

for (const [name, response] of invalidResponses) {
  test(`failed refresh preserves history, source and events: ${name}`, async () => {
    await withPrior(async s => {
      const before = snapshot(s);
      await expect(refreshHistory(s, async () => JSON.stringify(response), now + 1, [repo])).rejects.toThrow();
      expect(snapshot(s)).toEqual(before);
    });
  });
}

test("invalid JSON and bounded/truncated responses preserve all prior evidence", async () => {
  await withPrior(async s => {
    const before = snapshot(s);
    for (const response of ["{", JSON.stringify(Array.from({length:10000}, (_, i) => ({...issue, number:i+1})))]) {
      await expect(refreshHistory(s, async () => response, now + 1, [repo])).rejects.toThrow();
      expect(snapshot(s)).toEqual(before);
    }
  });
});

test("late repository failures discard all staged repositories and kinds", async () => {
  await withPrior(async s => {
    const before = snapshot(s);
    for (const failure of ["execute", "shape", "interval", "truncated"]) {
      const calls: string[][] = [];
      const execute = async (args: string[]) => {
        calls.push(args);
        if (calls.length < 4) return JSON.stringify([{...issue, number:8}]);
        if (failure === "execute") throw Error("fictional offline source");
        if (failure === "shape") return "{}";
        if (failure === "truncated") return JSON.stringify(Array(10000).fill(issue));
        return JSON.stringify([{...issue, closedAt:issue.createdAt}]);
      };
      await expect(refreshHistory(s, execute, now + 1, [repo, "fictional/second"])).rejects.toThrow();
      expect(calls.map(args => [args[1], args[4]])).toEqual([
        ["issue", repo], ["pr", repo], ["issue", "fictional/second"], ["pr", "fictional/second"],
      ]);
      expect(snapshot(s)).toEqual(before);
    }
  });
});

test("valid imported rows remain excluded and all measurements stay elapsed only", async () => {
  await withPrior(async s => {
    const imported = [
      {...issue, number:8, labels:[{name:"imported"}]},
      {...issue, number:9, labels:[{name:"migrated"}]},
      {...issue, number:10, body:"https://linear.app/fictional/issue/FIC-1"},
      {...issue, number:11, body:"Imported from fictional tracker"},
      {...issue, number:12, body:"Migrated from fictional tracker"},
    ];
    const rows = [issue, ...imported];
    const calls: string[][] = [];
    const execute = async (args: string[]) => { calls.push(args); return JSON.stringify(rows); };
    const beforeEvents = s.rows("events").length;
    expect(await refreshHistory(s, execute, now + 1, [repo, repo])).toEqual({count:12});
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(5)).toEqual(["--state", "closed", "--limit", "10000", "--json", "number,createdAt,closedAt,labels,body"]);
    }
    const stored = s.get<unknown[]>("estimate-history")!;
    expect(stored).toHaveLength(12);
    for (const row of stored) expect(row).toMatchObject({seconds:null, tokens:null, elapsed:86400, provider:"unknown"});
    expect(stored.filter(row => (row as {imported:boolean}).imported)).toHaveLength(10);
    expect(history(s).map(row => row.id)).toEqual([`${repo}:issue:7`, `${repo}:pr:7`]);
    expect(s.get("estimate-history-source")).toMatchObject({count:12, observedAt:now+1});
    expect(s.rows("events")).toHaveLength(beforeEvents+1);
    const event = s.rows("events").find(row => (row as {at:number}).at === now+1) as {data:string};
    expect(JSON.parse(event.data)).toEqual({rows:stored, observedAt:now+1});
  });
});

test("a valid empty response can replace history", async () => {
  await withPrior(async s => {
    expect(await refreshHistory(s, async () => "[]", now + 1, [repo])).toEqual({count:0});
    expect(s.get("estimate-history")).toEqual([]);
    expect(s.get("estimate-history-source")).toMatchObject({count:0, observedAt:now+1});
  });
});
