import { test, expect } from "bun:test";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { boardModel, plainText } from "../board/model";
import { intakeLabel, reconcile, type Issue } from "../adapters/github";
import { githubWakes } from "../launcher/wake";
import { config, ticket, now, billing } from "./fixtures";

function fixture() {
  const s = new Store(":memory:"),
    e = new Engine(s, config());
  s.set("paused", false);
  s.set("heartbeat", { at: now, status: "ok" });
  s.set("github:example/demo", { observedAt: now, error: null });
  const add = (
    n: number,
    state = "OPEN",
    labels: string[] = [],
    closedAt?: string,
  ) => {
    const i: Issue = {
      number: n,
      title: `Useful task ${n}`,
      body: "",
      url: `https://github.com/example/demo/issues/${n}`,
      updatedAt: new Date(now).toISOString(),
      state,
      labels: labels.map((name) => ({ name })),
      closedAt,
    };
    s.db
      .query("INSERT INTO tickets VALUES(?,?,?,?)")
      .run(`example/demo#${n}`, JSON.stringify(i), now, "observed");
    return i;
  };
  const session = (n: number, status: string, attempt = 1) => {
    const id = `session-${n}-${attempt}`;
    s.db
      .query(
        "INSERT INTO sessions(id,ticket,owner,provider,status,brief,native_id,started,actual_seconds,actual_tokens,attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        `example/demo#${n}`,
        "builder",
        "codex",
        status,
        JSON.stringify({ ...ticket(n), estimateSeconds: 1800 }),
        `native-${n}`,
        now - 23 * 60000,
        1380,
        1500000,
        attempt,
      );
    return id;
  };
  const ready = (n: number) => {
    const i = add(n, "OPEN", ["state:ready", "kind:unknown", "area:unknown"]);
    i.body = "```factory\n" + JSON.stringify(ticket(n)) + "\n```";
    i.labels.push({ name: intakeLabel("example/demo", i) });
    s.db
      .query("UPDATE tickets SET snapshot=? WHERE id=?")
      .run(JSON.stringify(i), `example/demo#${n}`);
    return i;
  };
  return { s, e, add, session, ready };
}
test("groups one task once, hides archives and old closures, and uses actual closure time", () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    session(1, "running");
    add(2, "OPEN", ["state:review"]);
    session(2, "finished");
    add(3, "CLOSED", [], new Date(now - 60000).toISOString());
    session(3, "finished");
    add(4, "CLOSED", [], new Date(now - 49 * 3600000).toISOString());
    session(4, "finished");
    add(5);
    session(5, "archived");
    add(6);
    session(6, "paused");
    add(7);
    session(7, "unknown");
    add(8, "CLOSED", [], new Date(now - 120000).toISOString());
    add(9);
    session(9, "archived");
    session(9, "running", 2);
    add(10, "CLOSED"); // Unknown closure time is never replaced with updatedAt.
    const m = boardModel(e, {}, now);
    expect(m.running.map((x) => x.id)).toEqual([
      "example/demo#1",
      "example/demo#9",
    ]);
    expect(m.waiting.map((x) => x.status)).toEqual([
      "Waiting for review",
      "Stopped — waiting for a decision",
      "Waiting for investigation",
    ]);
    expect(m.done.map((x) => x.id)).toEqual([
      "example/demo#3",
      "example/demo#8",
    ]);
    expect(m.done[0].status).toBe("Closed");
    expect(m.running[0].session).toBe("native-1");
    expect(m.running[0].progress).toBeCloseTo(1380 / 1800);
  } finally {
    s.close();
  }
});
test("queue keeps reconciliation order, validates approval, omits claimed work and caps at ten", () => {
  const { s, e, ready, session, add } = fixture();
  try {
    ready(20);
    ready(2);
    session(2, "finished");
    for (let n = 30; n < 42; n++) ready(n);
    add(90, "OPEN", ["state:ready"]); // a label alone cannot approve a task
    const m = boardModel(e, {}, now);
    expect(m.counts.upNext).toBe(13);
    expect(m.upNext).toHaveLength(10);
    expect(m.more).toBe(3);
    expect(m.upNext[0].id).toBe("example/demo#20");
    expect(m.upNext[1].id).toBe("example/demo#30");
    expect(m.upNext.some((x) => x.id === "example/demo#2")).toBe(false);
  } finally {
    s.close();
  }
});
test("status is plain English, pause wins, prolonged idle and stale evidence need attention", () => {
  const { s, e, ready, add, session } = fixture();
  try {
    ready(1);
    add(2);
    const id = session(2, "finished");
    s.event(
      "exit",
      "worker-exit",
      { id, ok: true },
      "retain",
      now - 2 * 3600000,
    );
    s.db.query("UPDATE sessions SET started=?").run(now - 3 * 3600000);
    expect(boardModel(e, {}, now).status).toBe(
      "Idle — nothing running for 2 h (needs attention)",
    );
    s.db.query("UPDATE sessions SET status='running'").run();
    expect(boardModel(e, {}, now).status).toBe(
      "Working — 1 task running, 1 in the queue",
    );
    s.set("paused", true);
    expect(boardModel(e, {}, now).status).toBe("Paused by you");
    expect(boardModel(e, {}, now, "fr").status).toBe("Mise en pause par vous");
    s.set("heartbeat", { at: now - 240000, status: "ok" });
    expect(boardModel(e, {}, now).notice).toContain("needs attention");
  } finally {
    s.close();
  }
});
test("only genuinely open Vincent questions appear with honest defaults and recorded deadlines", () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    const id = session(1, "paused");
    s.db
      .query(
        "INSERT INTO questions(id,text,at,addressed_to) VALUES(?,?,?,'vincent'),('owner','For owner',?,'owner'),('autonomy:decision','Allow this change?',?,'vincent')",
      )
      .run(`overrun:${id}`, "Internal estimate question", now, now, now);
    s.db
      .query(
        "INSERT INTO questions(id,text,at,answer) VALUES('answered','Old',?,'yes');",
      )
      .run(now);
    s.db
      .query(
        "INSERT INTO questions(id,text,at,resolved_at) VALUES('resolved','Old',?,?)",
      )
      .run(now, now);
    s.set("autonomy-decision:decision", {
      state: "open",
      deadline: now + 3600000,
      default: "not approved",
    });
    const m = boardModel(e, {}, now);
    expect(m.questions).toHaveLength(2);
    expect(m.questions[0].title).toContain("Useful task 1");
    expect(m.questions[0].defaultLine).toContain("No automatic deadline");
    expect(m.questions[1].defaultLine).toContain("not approved");
    expect(m.questions[1].defaultLine).toContain("7:00");
  } finally {
    s.close();
  }
});
test("usage selects actual weekly window and billing never substitutes a wallet balance", () => {
  const { s, e } = fixture();
  try {
    const readings = {
      codex: {
        observedAt: now,
        source: "fixture",
        windows: [
          { used: 0.8, resetsAt: now + 3600000, durationMinutes: 300 },
          { used: 0.18, resetsAt: now + 86400000, durationMinutes: 10080 },
        ],
      },
      billing: billing(),
    };
    let m = boardModel(e, readings, now);
    expect(m.usage[0].percent).toBe(18);
    expect(m.usage[1].percent).toBeNull();
    expect(m.aws.dollars).toBe(11);
    expect(m.aws.ceiling).toBe(75);
    s.set("aws-stop-latched", true);
    m = boardModel(e, readings, now);
    expect(m.aws.stopped).toBe(true);
    expect(m.releases.every((r) => r.status === "Skipped: AWS stopped")).toBe(
      true,
    );
    expect(boardModel(e, readings, now + 86400001).aws.dollars).toBeNull();
    expect(boardModel(e, readings, now + 900001).usage[0].percent).toBeNull();
    expect(
      boardModel(
        e,
        { codex: { ...readings.codex, windows: [readings.codex.windows[0]] } },
        now,
      ).usage[0].percent,
    ).toBeNull();
  } finally {
    s.close();
  }
});
test("release passed requires deployment evidence, never an authorization or successful promotion alone", () => {
  const { s, e } = fixture(),
    day = "2026-11-07";
  try {
    s.db
      .query("INSERT INTO releases VALUES(?,?,?,?,?,?)")
      .run("authorization", day, "qa", "revision", "permission only", now);
    expect(boardModel(e, {}, now).releases[0].status).toBe("Scheduled");
    s.set(`executor:${day}:qa`, { state: "success" });
    s.set(`executor:${day}:promote`, { state: "success" });
    let m = boardModel(e, {}, now);
    expect(m.releases[0].status).toBe("Passed");
    expect(m.releases[1].status).toBe("Checks in progress");
    s.set(`executor:${day}:readback`, { state: "success" });
    m = boardModel(e, {}, now);
    expect(m.releases[1].status).toBe("Passed");
    expect(boardModel(e, {}, now, "fr").releases[1].status).toBe("Réussie");
  } finally {
    s.close();
  }
});
test("each GitHub reconciliation refreshes closures and includes closedAt", async () => {
  const { s, e, add, ready } = fixture();
  ready(1);
  try {
    const closed = {
      ...JSON.parse((s.rows("tickets")[0] as { snapshot: string }).snapshot),
      state: "CLOSED",
      closedAt: new Date(now).toISOString(),
    };
    await reconcile(s, e.c, now, async (args) => {
      expect(args.join(",")).toContain("closedAt");
      return JSON.stringify([closed]);
    });
    const m = boardModel(e, {}, now);
    expect(m.upNext).toHaveLength(0);
    expect(m.done).toHaveLength(1);
  } finally {
    s.close();
  }
});
test("plain titles remove repository references, hashes, prefixes and code blocks", () => {
  expect(
    plainText(
      "[example/demo] Improve search fulmar-hq/alido#123 " + "a".repeat(64),
    ),
  ).toBe("Improve search");
  expect(plainText("example/demo: Improve search")).toBe("Improve search");
});

test("waiting uses the tick’s read-only PR evidence and never invents passing checks", async () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    const id = session(1, "finished"),
      url = "https://github.com/example/demo/pull/2";
    s.event("published", "launcher-publish", { id, url }, "retain", now);
    const execute = async () =>
      JSON.stringify([
        {
          number: 2,
          url,
          headRefOid: "a".repeat(40),
          reviews: [],
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ status: "IN_PROGRESS" }],
        },
      ]);
    await githubWakes(s, e.c, execute, now);
    expect(boardModel(e, {}, now).waiting[0].status).toBe("Waiting for checks");
    s.set(`board-pr:${url}`, {
      at: now,
      pending: false,
      failed: true,
      review: "APPROVED",
    });
    expect(boardModel(e, {}, now).waiting[0].status).toBe(
      "Waiting for checks to be fixed",
    );
    s.set(`board-pr:${url}`, {
      at: now,
      pending: false,
      failed: false,
      review: "APPROVED",
    });
    expect(boardModel(e, {}, now).waiting[0].status).toBe(
      "Waiting for tonight’s release",
    );
    expect(boardModel(e, {}, now + 180001).waiting[0].status).toBe(
      "Waiting for review",
    );
    expect(boardModel(e, {}, now).done).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("failed or truncated GitHub reads cannot advertise a claimable queue", () => {
  const { s, e, ready } = fixture();
  try {
    ready(1);
    s.set("github:example/demo", { at: now, error: "unavailable" });
    let m = boardModel(e, {}, now);
    expect(m.counts.upNext).toBe(0);
    expect(m.notice).toContain("GitHub");
    s.set("github:example/demo", { observedAt: now, truncated: true });
    expect(boardModel(e, {}, now).counts.upNext).toBe(0);
  } finally {
    s.close();
  }
});
