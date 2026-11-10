import {githubPage} from './fixtures';
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { Engine } from "../launcher/engine";
import { Store } from "../tracking/store";
import { observeBilling, available } from "../wallet/ledger";
import { issueTicket, type Issue } from "../adapters/github";
import { config, ticket, admission, billing, now } from "./fixtures";
const setup = () => {
  const e = new Engine(new Store(":memory:"), config());
  e.pause(false, "owner");
  return e;
};
for (const [name, b] of Object.entries({
  missing: undefined,
  stale: { ...billing(), observedAt: now - 86400001 },
  future: { ...billing(), observedAt: now + 1 },
  month: { ...billing(), month: "2026-10" },
  hold: { ...billing(), projectedCents: 6000 },
}))
  test(`#1 zero-dollar AWS refuses ${name}`, () => {
    const e = setup();
    try {
      expect(() =>
        e.admit(
          { ...ticket(), wallet: "aws", costCents: 0 },
          { ...admission(), billing: b },
        ),
      ).toThrow();
      expect(e.s.rows("debits")).toHaveLength(0);
    } finally {
      e.s.close();
    }
  });
test("#1 zero-dollar AWS refuses latched stop with low reading", () => {
  const e = setup();
  try {
    observeBilling(e.s, e.c, { ...billing(), postedCents: 6500 }, now);
    expect(() =>
      e.admit({ ...ticket(), wallet: "aws" }, admission()),
    ).toThrow();
  } finally {
    e.s.close();
  }
});
for (const b of [
  { ...billing(), postedCents: 6000, unpostedCents: 500 },
  { ...billing(), projectedCents: 7500 },
])
  test(`#2 latch boundary ${b.postedCents}/${b.projectedCents} and re-latch audit`, () => {
    const e = setup();
    try {
      observeBilling(e.s, e.c, b, now);
      expect(e.s.get("aws-stop-latched")).toBe(true);
      observeBilling(e.s, e.c, billing(), now);
      expect(available(e.s, e.c, "aws", now, billing())).toBe(0);
      observeBilling(e.s, e.c, b, now);
      expect(
        e.s.rows("events").filter((x: any) => x.kind === "wallet-stop"),
      ).toHaveLength(1);
      e.s.set("aws-stop-latched", false);
      observeBilling(e.s, e.c, b, now);
      expect(
        e.s.rows("events").filter((x: any) => x.kind === "wallet-stop"),
      ).toHaveLength(2);
    } finally {
      e.s.close();
    }
  });
for (const path of ["./src/app", "src/./app", "SRC/APP", "src/sub/../app"])
  test(`#3 conflicting path ${path}`, () => {
    const e = setup();
    try {
      e.admit({ ...ticket(), paths: ["src/app"] }, admission());
      expect(() =>
        e.admit({ ...ticket(2), paths: [path] }, admission()),
      ).toThrow("path");
    } finally {
      e.s.close();
    }
  });
test("#4 owner archive releases slots and paths, retains custody/debits and duplicate guard", () => {
  const e = setup();
  try {
    const x = e.admit({ ...ticket(), costCents: 50 }, admission());
    e.finish(x.id, false);
    const y = e.admit(ticket(2), admission());
    e.account(y.id, 200, 0);
    expect(() => e.admit(ticket(3), admission())).toThrow("slots");
    e.archive(x.id, "fixture reconciled", "owner");
    e.archive(y.id, "fixture paused reconciled", "owner");
    expect(
      e.admit({ ...ticket(3), paths: ticket().paths }, admission()).status,
    ).toBe("reserved");
    expect(() => e.admit(ticket(), admission())).toThrow("duplicate");
    expect(available(e.s, e.c, "other", now)).toBe(50);
    expect(
      e.s.rows("events").filter((x: any) => x.kind === "session-archive"),
    ).toHaveLength(2);
  } finally {
    e.s.close();
  }
});
test("#5 body edit after hash approval refuses", () => {
  const block = JSON.stringify(ticket());
  const label =
    "ready:" +
    createHash("sha256").update(`example/demo#1\n${block}`).digest("base64url");
  const i: Issue = {
    number: 1,
    title: "Synthetic",
    state: "OPEN",
    url: "https://github.com/example/demo/issues/1",
    updatedAt: "2026-11-07",
    labels: [
      { name: "state:ready" },
      { name: "kind:fix" },
      { name: "area:demo" },
      { name: label },
    ],
    body: `\`\`\`factory\n${block}\n\`\`\``,
  };
  expect(issueTicket("example/demo", i)).toBeTruthy();
  const edited = {
    ...i,
    body: `\`\`\`factory\n${JSON.stringify({ ...ticket(), costCents: 999999, benefit: "high", paths: ["."] })}\n\`\`\``,
  };
  expect(() => issueTicket("example/demo", edited)).toThrow(
    "approved intake changed",
  );
});
test("#4 archive refuses helpers, missing receipt and live supervisors", () => {
  const e = setup();
  try {
    const x = e.admit(ticket(), admission());
    expect(() => e.archive(x.id, "receipt", "helper")).toThrow("owner");
    expect(() => e.archive(x.id, "receipt", "owner")).toThrow("archivable");
    e.claimStart(x.id, now);
    e.register(x.id, process.pid, "fixture-native");
    e.finish(x.id, false);
    expect(() => e.archive(x.id, "", "owner")).toThrow("receipt");
    expect(() => e.archive(x.id, "receipt", "owner")).toThrow("alive");
    expect(e.sessions()[0].native_id).toBe("fixture-native");
    expect(e.active()).toHaveLength(1);
  } finally {
    e.s.close();
  }
});
test("#3 old mixed-case claims conflict and root/traversal paths refuse", () => {
  const e = setup();
  try {
    const x = e.admit({ ...ticket(), paths: ["src/old"] }, admission());
    e.s.db
      .query("UPDATE claims SET path=? WHERE session=?")
      .run("SRC/Old", x.id);
    expect(() =>
      e.admit({ ...ticket(2), paths: ["src/old/file.ts"] }, admission()),
    ).toThrow("path claimed");
    for (const path of [
      ".",
      "./",
      "../src",
      "src/../old",
      "/src",
      "src\\old",
      "src//old",
    ])
      expect(() =>
        e.admit({ ...ticket(2), paths: [path] }, admission()),
      ).toThrow("paths");
  } finally {
    e.s.close();
  }
});
test("#5 approval command binds the observed block; refresh and launch refuse later edits", async () => {
  const { approveIntake, reconcile, markBuilding } = await import(
    "../adapters/github"
  );
  const s = new Store(":memory:");
  let i: Issue = {
    number: 1,
    title: "Synthetic",
    state: "OPEN",
    url: "https://github.com/example/demo/issues/1",
    updatedAt: "2026-11-07",
    labels: [{ name: "kind:fix" }, { name: "area:demo" }],
    body: `\`\`\`factory\n${JSON.stringify(ticket())}\n\`\`\``,
  };
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes("view")) return JSON.stringify(i);
    if (args.includes("graphql")) return githubPage("issues",[i]);
    if (args.includes("edit")) {
      for (let n = 0; n < args.length; n++)
        if (args[n] === "--add-label") i.labels.push({ name: args[n + 1] });
    }
    return "";
  };
  try {
    await approveIntake("example/demo", 1, s, "fixture owner review", exec);
    const t = issueTicket("example/demo", i)!;
    expect(await reconcile(s, config(), now, exec)).toHaveLength(1);
    i = {
      ...i,
      body: `\`\`\`factory\n${JSON.stringify({ ...ticket(), costCents: 20 })}\n\`\`\``,
    };
    expect(await reconcile(s, config(), now, exec)).toHaveLength(0);
    expect((s.rows("tickets")[0] as any).decision).toContain(
      "approved intake changed",
    );
    await expect(markBuilding(t, s, exec)).rejects.toThrow(
      "approved intake changed",
    );
    expect(calls.filter((args) => args.includes("edit"))).toHaveLength(1);
    expect(
      s.rows("events").filter((x: any) => x.kind === "intake-approval"),
    ).toHaveLength(1);
  } finally {
    s.close();
  }
});
