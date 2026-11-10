import { githubPages } from './github-pages';
import { createHash, randomUUID } from "node:crypto";
import { TicketSchema, type Config, type Ticket } from "../launcher/config";
import { Store } from "../tracking/store";
export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  closedAt?: string | null;
  state: string;
  labels: { name: string }[];
};
export async function command(args: string[], cwd?: string, timeoutMs=30000) {
  const p = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut=false;
  const timer = setTimeout(() => {timedOut=true;p.kill();}, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw Error(`${args[0]} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed (exit ${code})`}: ${err.slice(0, 500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
export function intakeLabel(repo: string, i: Issue): string {
  const blocks = [...i.body.matchAll(/```factory\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) throw Error("one factory intake block required");
  return (
    "ready:" +
    createHash("sha256")
      .update(`${repo}#${i.number}\n${blocks[0][1]}`)
      .digest("base64url")
  );
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
  const approvals = i.labels.filter((x) => x.name.startsWith("ready:"));
  if (approvals.length !== 1 || approvals[0].name !== intakeLabel(repo, i))
    throw Error("approved intake changed or approval missing");
  // Only repository triage+ can attach the content-bound approval label.
  return TicketSchema.parse({
    ...JSON.parse(match[1]),
    repo,
    number: i.number,
    title: i.title,
    approvalDigest: intakeLabel(repo, i),
  });
}
export async function reconcile(
  s: Store,
  c: Config,
  now = Date.now(),
  execute = command,
) {
  const ready: Ticket[] = [];
  for (const project of Object.values(c.projects)) {
    try {
      const issues = await githubPages(project.repo,'issues',execute) as Issue[];
      const repositoryReady:Ticket[]=[];
      s.atomic(() => {
        for (const i of issues) {
          const id = `${project.repo}#${i.number}`;
          let decision = "observed";
          try {
            const t = issueTicket(project.repo, i);
            if (t) repositoryReady.push(t);
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
          truncated: false,
          error: null,
        });
      });
      ready.push(...repositoryReady);
    } catch (e) {
      try{s.set(`github:${project.repo}`, { error: String(e), observedAt: now });}
      catch{console.error(`GitHub failure receipt unavailable for ${project.repo}; candidates remain refused.`);}
    }
  }
  return ready;
}

export async function validateIntake(t: Ticket, execute = command) {
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
}

export async function markBuilding(t: Ticket, s: Store, execute = command) {
  await validateIntake(t, execute);
  await setBuilding(t, s, execute);
}

export async function setBuilding(t: Ticket, s: Store, execute = command) {
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

// Owner-token control invokes this; label writes also require GitHub triage+ authority.
export async function approveIntake(
  repo: string,
  number: number,
  s: Store,
  receipt: string,
  execute = command,
  expectedDigest?: string,
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !receipt?.trim()
  )
    throw Error("repo, issue number and owner receipt required");
  const i = JSON.parse(
    await execute([
      "gh",
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,body,url,updatedAt,state,labels",
    ]),
  ) as Issue;
  if (i.number !== number) throw Error("issue identity mismatch");
  const label = intakeLabel(repo, i);
  if (expectedDigest && label !== expectedDigest) throw Error("intake changed during policy review");
  const labels = i.labels.filter(
    (x) => !x.name.startsWith("ready:") && !x.name.startsWith("state:"),
  );
  if (
    !issueTicket(repo, {
      ...i,
      labels: [...labels, { name: label }, { name: "state:ready" }],
    })
  )
    throw Error("open issue required for approval");
  await execute([
    "gh",
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    "0E8A16",
    "--description",
    "Owner-approved factory intake digest",
    "--force",
  ]);
  const remove = i.labels.filter(
    (x) =>
      (x.name.startsWith("ready:") || x.name.startsWith("state:")) &&
      x.name !== label &&
      x.name !== "state:ready",
  );
  await execute([
    "gh",
    "issue",
    "edit",
    String(number),
    "--repo",
    repo,
    ...remove.flatMap((x) => ["--remove-label", x.name]),
    "--add-label",
    label,
    "--add-label",
    "state:ready",
  ]);
  s.event(
    randomUUID(),
    "intake-approval",
    { repo, number, label, receipt },
    "Remove the ready and digest labels to withdraw approval; retain receipt and existing custody.",
  );
}
