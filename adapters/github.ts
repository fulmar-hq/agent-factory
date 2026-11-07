import { createHash } from "node:crypto";
import { TicketSchema, type Config, type Ticket } from "../launcher/config";
import { Store } from "../tracking/store";
export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  state: string;
  labels: { name: string }[];
};
export async function command(args: string[], cwd?: string) {
  const p = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => p.kill(), 30000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw Error(`${args[0]} failed: ${err.slice(0, 500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
export function issueTicket(repo: string, i: Issue): Ticket | null {
  const states = i.labels.filter((x) => x.name.startsWith("state:"));
  if (
    i.state !== "OPEN" ||
    states.length !== 1 ||
    states[0].name !== "state:ready"
  )
    return null;
  if (
    i.labels.filter((x) => x.name.startsWith("kind:")).length !== 1 ||
    i.labels.filter((x) => x.name.startsWith("area:")).length !== 1
  )
    throw Error("one kind and area label required");
  const match = i.body.match(/```factory\s*\n([\s\S]*?)\n```/);
  if (!match) throw Error("factory intake block missing");
  // An approved ready label and complete bounded intake are both required.
  return TicketSchema.parse({
    ...JSON.parse(match[1]),
    repo,
    number: i.number,
    title: i.title,
  });
}
export async function reconcile(s: Store, c: Config, now = Date.now()) {
  const ready: Ticket[] = [];
  for (const project of Object.values(c.projects)) {
    try {
      const issues = JSON.parse(
        await command([
          "gh",
          "issue",
          "list",
          "--repo",
          project.repo,
          "--state",
          "all",
          "--limit",
          "1000",
          "--json",
          "number,title,body,url,updatedAt,state,labels",
        ]),
      ) as Issue[];
      s.atomic(() => {
        for (const i of issues) {
          const id = `${project.repo}#${i.number}`;
          let decision = "observed";
          try {
            const t = issueTicket(project.repo, i);
            if (t) ready.push(t);
          } catch (e) {
            decision = String(e);
          }
          s.db
            .query(
              "INSERT INTO tickets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,observed=excluded.observed,decision=excluded.decision",
            )
            .run(id, JSON.stringify(i), now, decision);
          s.event(
            `github:${id}:${createHash("sha256").update(JSON.stringify(i)).digest("hex")}`,
            "github-observed",
            { id, updatedAt: i.updatedAt },
            "Read-only snapshot; reconcile again to refresh",
            now,
          );
        }
        s.set(`github:${project.repo}`, {
          observedAt: now,
          count: issues.length,
          truncated: issues.length === 1000,
          error: null,
        });
      });
      // Refuse admissions if the bounded backfill might be incomplete.
      if (issues.length === 1000)
        for (let n = ready.length - 1; n >= 0; n--)
          if (ready[n].repo === project.repo) ready.splice(n, 1);
    } catch (e) {
      s.set(`github:${project.repo}`, { error: String(e), observedAt: now });
    }
  }
  return ready;
}

export async function markBuilding(t: Ticket, s: Store, execute = command) {
  const current = JSON.parse(
    await execute([
      "gh",
      "issue",
      "view",
      String(t.number),
      "--repo",
      t.repo,
      "--json",
      "number,title,body,url,updatedAt,state,labels",
    ]),
  ) as Issue;
  const approved = issueTicket(t.repo, current);
  if (!approved || JSON.stringify(approved) !== JSON.stringify(t))
    throw Error("approved intake changed before launch");
  await execute([
    "gh",
    "issue",
    "edit",
    String(t.number),
    "--repo",
    t.repo,
    "--remove-label",
    "state:ready",
    "--add-label",
    "state:building",
  ]);
  s.event(
    `github-building:${t.repo}#${t.number}`,
    "github-state",
    { repo: t.repo, number: t.number, state: "building" },
    "After reconciling native custody, remove state:building and restore state:ready; the stable claim still prevents a new launch",
  );
}
