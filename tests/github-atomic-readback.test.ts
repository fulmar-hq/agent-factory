import { expect, test } from "bun:test";
import { intakeLabel, reconcile, type Issue } from "../adapters/github";
import { Store } from "../tracking/store";
import { config, now, ticket } from "./fixtures";

const failingRepo = "example/demo";
const healthyRepo = "example/healthy";

function issue(repo = failingRepo, number = 1): Issue {
  const i: Issue = {
    number,
    title: "Synthetic approved issue",
    body: `\`\`\`factory\n${JSON.stringify(ticket(number))}\n\`\`\``,
    url: `https://github.com/${repo}/issues/${number}`,
    updatedAt: "2026-11-07T23:00:00Z",
    state: "OPEN",
    labels: ["state:ready", "kind:fix", "area:demo"].map(name => ({ name })),
  };
  i.labels.push({ name: intakeLabel(repo, i) });
  return i;
}

function projects(healthyFirst = false) {
  const c = config();
  const healthy = { repo: healthyRepo, owners: ["builder"], tests: "bun test" };
  c.projects = healthyFirst
    ? { healthy, ...c.projects }
    : { ...c.projects, healthy };
  return c;
}

// Every readback is synthetic; no subprocess or GitHub access is used.
function readback(failing: unknown) {
  return async (args: string[]) => {
    expect(args.slice(0, 3)).toEqual(["gh", "issue", "list"]);
    expect(args.slice(args.indexOf("--limit"), args.indexOf("--limit") + 2))
      .toEqual(["--limit", "1000"]);
    const repo = args[args.indexOf("--repo") + 1];
    expect([failingRepo, healthyRepo]).toContain(repo);
    return JSON.stringify(repo === failingRepo ? failing : [issue(healthyRepo)]);
  };
}

async function assertRepositoryFailure(
  failing: unknown,
  inject?: (s: Store) => void,
  healthyFirst = false,
) {
  const s = new Store(":memory:");
  const c = projects(healthyFirst);
  try {
    // Keep prior snapshots for both the row updated early and a later row.
    await reconcile(s, c, now - 1, readback([
      { ...issue(), title: "Prior first snapshot" },
      { ...issue(failingRepo, 2), title: "Prior second snapshot" },
    ]));
    const snapshots = () => s.db.query("SELECT * FROM tickets WHERE id LIKE ? ORDER BY id")
      .all(`${failingRepo}#%`);
    const events = () => s.db.query("SELECT * FROM events WHERE json_extract(data,'$.id') LIKE ? ORDER BY id")
      .all(`${failingRepo}#%`);
    const priorSnapshots = snapshots();
    const priorEvents = events();
    inject?.(s);

    const ready = await reconcile(s, c, now, readback(failing));
    expect(ready.map(t => `${t.repo}#${t.number}`)).toEqual([`${healthyRepo}#1`]);
    expect(snapshots()).toEqual(priorSnapshots);
    expect(events()).toEqual(priorEvents);
    expect(s.get<{ error: string; observedAt: number }>(`github:${failingRepo}`))
      .toMatchObject({ error: expect.any(String), observedAt: now });
    expect(s.get<{ error: string }>(`github:${failingRepo}`)?.error.length).toBeGreaterThan(0);
    expect(s.get(`github:${healthyRepo}`))
      .toEqual({ observedAt: now, count: 1, truncated: false, error: null });
    expect(s.db.query("SELECT observed FROM tickets WHERE id=?").get(`${healthyRepo}#1`))
      .toEqual({ observed: now });
  } finally {
    s.close();
  }
}

for (const healthyFirst of [false, true]) {
  test(`later malformed row rolls back early approved issue (healthy first: ${healthyFirst})`, async () => {
    await assertRepositoryFailure([issue(), null], undefined, healthyFirst);
  });
}

test("later SQLite write failure rolls back snapshots and publishes no candidates", async () => {
  await assertRepositoryFailure([issue(), issue(failingRepo, 2)], s => {
    s.db.exec(`CREATE TRIGGER fail_second_snapshot BEFORE UPDATE ON tickets
      WHEN NEW.id='example/demo#2'
      BEGIN SELECT RAISE(ABORT,'synthetic snapshot write failure'); END`);
  });
});

test("source status write failure after all rows also withholds candidates", async () => {
  await assertRepositoryFailure([issue(), issue(failingRepo, 2)], s => {
    s.db.exec(`CREATE TRIGGER fail_source_status BEFORE UPDATE ON kv
      WHEN NEW.key='github:example/demo' AND json_extract(NEW.value,'$.error') IS NULL
      BEGIN SELECT RAISE(ABORT,'synthetic source status failure'); END`);
  });
});

test("malformed top-level readbacks retain prior snapshots", async () => {
  for (const value of [null, {}, { length: 0 }, "not an array", 3]) {
    await assertRepositoryFailure(value);
  }
});

test("malformed or duplicate row identities fail the whole repository", async () => {
  for (const number of [undefined, null, "2", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assertRepositoryFailure([issue(), { ...issue(failingRepo, 2), number }]);
  }
  await assertRepositoryFailure([issue(), issue()]);
});

test("malformed row fields fail outside the intake refusal handler", async () => {
  for (const fields of [
    { title: null }, { body: null }, { url: null }, { updatedAt: null },
    { state: "unknown" }, { labels: null }, { labels: [{ name: null }] },
  ]) {
    await assertRepositoryFailure([issue(), { ...issue(failingRepo, 2), ...fields }]);
  }
});

test("exact digest and admission gates remain per-issue refusals", async () => {
  const s = new Store(":memory:");
  try {
    const edited = issue(failingRepo, 2);
    edited.body = edited.body.replace("Make synthetic change", "Changed after approval");
    const missingKind = issue(failingRepo, 3);
    missingKind.labels = missingKind.labels.filter(l => !l.name.startsWith("kind:"));
    const closed = { ...issue(failingRepo, 4), state: "CLOSED" };
    const ready = await reconcile(s, config(), now, readback([issue(), edited, missingKind, closed]));
    expect(ready.map(t => t.number)).toEqual([1]);
    expect(s.rows("tickets")).toHaveLength(4);
    expect(s.db.query("SELECT decision FROM tickets WHERE id=?").get(`${failingRepo}#2`))
      .toEqual({ decision: "Error: approved intake changed or approval missing" });
    expect(s.db.query("SELECT decision FROM tickets WHERE id=?").get(`${failingRepo}#3`))
      .toEqual({ decision: "Error: one kind and area label required" });
    expect(s.get(`github:${failingRepo}`))
      .toEqual({ observedAt: now, count: 4, truncated: false, error: null });
  } finally {
    s.close();
  }
});

test("1000-row snapshot commits but refuses all admissions from that repository", async () => {
  const s = new Store(":memory:");
  try {
    const rows = Array.from({ length: 1000 }, (_, n) => issue(failingRepo, n + 1));
    const ready = await reconcile(s, projects(), now, readback(rows));
    expect(ready.map(t => t.repo)).toEqual([healthyRepo]);
    expect(s.rows("tickets")).toHaveLength(1001);
    expect(s.get(`github:${failingRepo}`))
      .toEqual({ observedAt: now, count: 1000, truncated: true, error: null });
  } finally {
    s.close();
  }
});
