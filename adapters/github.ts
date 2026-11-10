import {githubBudget,GitHubUnavailable,retryAtFor,recordGithubHttp} from './github-budget';
import { githubPages,openIssuePages } from './github-pages';
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
async function rawCommand(args: string[], cwd?: string, timeoutMs=30000) {
  const p = Bun.spawn(args, {
    cwd,
    env: args[0]==='gh' ? {...process.env,GH_DEBUG:"api"} : process.env,
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
    if(args[0]==='gh' && ['api','issue','pr','label','search'].includes(args[1]??'') && !args.includes('rate_limit'))recordGithubHttp(err,out);
    const diagnostic=args[0]==='gh' ? err.split('\n').filter(line=>/^(?:gh: |GraphQL: |error: |fatal: |Post |Get |HTTP )/.test(line)).slice(-3).join('\n') || 'GitHub command failed; raw debug omitted' : err;
    if (code !== 0) throw Error(`${args[0]} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed (exit ${code})`}: ${diagnostic.slice(-500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
export async function command(args:string[],cwd?:string,timeoutMs=30000) {
  const api=args[0]==='gh' && ['api','issue','pr','label','search'].includes(args[1]??'') && !args.includes('rate_limit');
  if(api)githubBudget('before',args);
  try{return await rawCommand(args,cwd,timeoutMs);}
  catch(error){
    if(api && /rate limit|timed out|timeout|connection|network|resolve host|TLS handshake|EOF|HTTP 50[234]|context deadline|temporary failure/i.test(String(error))){
      let resets:Parameters<typeof retryAtFor>[2];
      if(/rate limit/i.test(String(error)))try{resets=JSON.parse(await rawCommand(['gh','api','rate_limit'],undefined,10000));}catch{}
      const retryAt=retryAtFor(error,Date.now(),resets);githubBudget('failure',args,error,retryAt);
      throw new GitHubUnavailable(String(error),retryAt);
    }
    throw error;
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
  scope:'all'|'open'='all',
) {
  const ready: Ticket[] = [];
  for (const project of Object.values(c.projects)) {
    try {
      const issues = await (scope==='open'?openIssuePages(project.repo,execute):githubPages(project.repo,'issues',execute)) as Issue[];
      s.atomic(() => {
        const open=new Set(issues.map(i=>i.number));
        for(const row of (scope==='open'?s.db.query('SELECT id,snapshot FROM tickets WHERE id LIKE ?').all(project.repo+'#%'):[]) as {id:string;snapshot:string}[]){
          const old=JSON.parse(row.snapshot) as Issue;
          if(old.state==='OPEN'&&!open.has(old.number))s.db.query("UPDATE tickets SET snapshot=?,observed=?,decision='closed in complete open inventory' WHERE id=?").run(JSON.stringify({...old,state:'CLOSED'}),now,row.id);
        }
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
          truncated: false,
          error: null,
        });
      });
    } catch (e) {
      s.set(`github:${project.repo}`, { error: String(e), observedAt: now, retryAt:e instanceof GitHubUnavailable?e.retryAt:now+60000 });
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
