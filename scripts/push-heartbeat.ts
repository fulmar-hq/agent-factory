// The off-machine heartbeat: a check on the factory that still works when the
// Mac, or the Mac's own Telegram sender, is the thing that is broken.
//
//   bun scripts/push-heartbeat.ts push --repo <owner/name> --variable <NAME>
//     Runs on the Mac every 15 minutes (see scripts/install-heartbeat.ts).
//     Writes one repository Actions variable through the existing GitHub
//     budget. It is not a commit and not a branch, so main never moves.
//   bun scripts/push-heartbeat.ts check
//     Runs on a GitHub runner every 30 minutes (.github/workflows/dead-man.yml).
//     Reads that variable, keeps one standing issue up to date and adds one
//     comment when a problem opens and one when it recovers.
//
// Both halves share the value format below, which is why they share a file.
// Static imports are Node built-ins only, so `check` runs on a bare runner
// with nothing installed; `push` loads the launcher's modules when it runs.
//
// The repository is public and a workflow run prints its inputs, so the value
// is public too. Only times, counts and fixed words leave the Mac: an alarm's
// own words never do. docs/dead-man.md is the plain-language copy.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MINUTE = 60_000;
const ZONE = "America/Toronto";

// ------------------------------------------------------------------ value
/** The real variable. Any other name is a drill and can never notify anyone. */
export const HEARTBEAT_VARIABLE = "FACTORY_HEARTBEAT";
const VARIABLE_NAME = /^FACTORY_HEARTBEAT(?:_[A-Z0-9]+)*$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
export const WATCHED = ["tick", "health", "ledger", "sender"] as const;
export type Watched = (typeof WATCHED)[number];
const NAMES: Record<Watched, string> = { tick: "the tick", health: "the health job", ledger: "the ledger job", sender: "the Telegram sender" };
/**
 * What one watched job's heartbeat says, from the loop contract's shape: its
 * time, how far behind it is, and whether it carries an alarm reason (the
 * reason itself stays on the Mac). A file that is not there is "missing"; it
 * is never reported as healthy.
 */
export type JobBeat = { state: "ok"; at: number; behindMs?: number; alarm?: true } | { state: "missing" } | { state: "unreadable" };
/** The variable's value: the pusher's own time, then each watched job. */
export type HeartbeatValue = { version: 1; at: number; jobs: Partial<Record<Watched, JobBeat>> };

// ------------------------------------------------------- push (on the Mac)
/** The tick has no heartbeat file: its last success is one row in the controller store. */
async function tickBeat(dir: string): Promise<JobBeat> {
  const path = join(dir, "controller.sqlite");
  if (!existsSync(path)) return { state: "missing" };
  const { Database } = await import("bun:sqlite");
  let db: InstanceType<typeof Database> | undefined;
  try {
    // Read-only, a one-second wait at most, and closed before any GitHub work.
    db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout=1000");
    const row = db.query("SELECT value FROM kv WHERE key='last-successful-heartbeat'").get() as { value: string } | null;
    if (!row) return { state: "missing" };
    const at: unknown = JSON.parse(row.value)?.at;
    return isTime(at) ? { state: "ok", at } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  } finally {
    db?.close();
  }
}

/** Reads the four watched jobs. It changes nothing and never throws for a bad file. */
export async function collectHeartbeat(dir: string, mailDir: string, now: number): Promise<HeartbeatValue> {
  const { LOOP_FILES, SENDER_HEARTBEAT_FILE, LoopHeartbeatSchema } = await import("../launcher/loop-contract");
  const fileBeat = (path: string): JobBeat => {
    if (!existsSync(path)) return { state: "missing" };
    try {
      const beat = LoopHeartbeatSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!beat.success) return { state: "unreadable" };
      const { at, behindMs, alarm } = beat.data;
      return { state: "ok", at, ...(behindMs === undefined ? {} : { behindMs }), ...(alarm ? { alarm: true } : {}) };
    } catch {
      return { state: "unreadable" };
    }
  };
  return {
    version: 1,
    at: now,
    jobs: {
      tick: await tickBeat(dir),
      health: fileBeat(join(dir, LOOP_FILES.healthHeartbeat)),
      ledger: fileBeat(join(dir, LOOP_FILES.ledgerHeartbeat)),
      sender: fileBeat(join(mailDir, SENDER_HEARTBEAT_FILE)),
    },
  };
}

export type PushOptions = {
  repo: string;
  variable: string;
  /** Where the watched files are. Only a drill may point these away from the live folders. */
  dir?: string;
  mailDir?: string;
  /** Where the GitHub budget is kept. Always the live factory folder outside tests. */
  budgetDir?: string;
  now?: number;
  run?: (args: string[]) => Promise<string>;
};
export type PushResult = { pushed: true; value: HeartbeatValue } | { pushed: false; skipped: "github-unavailable"; retryAt: number };

/**
 * Collects the value and writes the variable. When GitHub is in backoff, or
 * cannot be reached, it skips quietly: the variable then goes stale and the
 * off-machine check says so. Any other failure is thrown.
 */
export async function pushHeartbeat(o: PushOptions): Promise<PushResult> {
  if (!REPOSITORY.test(o.repo)) throw Error("push needs --repo <owner/name>");
  if (!VARIABLE_NAME.test(o.variable)) throw Error(`push needs --variable ${HEARTBEAT_VARIABLE}, or ${HEARTBEAT_VARIABLE}_<NAME> for a drill`);
  const { root } = await import("../launcher/config");
  const { mailPath } = await import("../launcher/alerts");
  const { command } = await import("../adapters/github");
  const { GitHubUnavailable, githubContext } = await import("../adapters/github-budget");
  const liveMail = dirname(mailPath()),
    dir = resolve(o.dir ?? root),
    mailDir = resolve(o.mailDir ?? liveMail);
  if (o.variable === HEARTBEAT_VARIABLE && (dir !== root || mailDir !== resolve(liveMail))) throw Error("refused: the real variable is only written from the live folders; a drill uses its own variable");
  const value = await collectHeartbeat(dir, mailDir, o.now ?? Date.now());
  // Every GitHub call goes through the launcher's budget and backoff.
  const run = o.run ?? ((args: string[]) => command(args));
  const write = (method: "PATCH" | "POST", path: string) => run(["gh", "api", "--method", method, path, "-f", `name=${o.variable}`, "-f", `value=${JSON.stringify(value)}`]);
  try {
    await githubContext.run(o.budgetDir ?? root, async () => {
      try {
        await write("PATCH", `repos/${o.repo}/actions/variables/${o.variable}`);
      } catch (error) {
        // The first push ever: the variable does not exist yet.
        if (!/HTTP 404/.test(String(error))) throw error;
        await write("POST", `repos/${o.repo}/actions/variables`);
      }
    });
  } catch (error) {
    if (error instanceof GitHubUnavailable) return { pushed: false, skipped: "github-unavailable", retryAt: error.retryAt };
    throw error;
  }
  return { pushed: true, value };
}

// ------------------------------------------------- judge (on the runner)
/** A watched time older than this, measured at the check, is a problem. */
export const STALE_MS = 45 * MINUTE;
/** A hard stop the sender has held this long is a problem. Equal to the contract's HEARTBEAT_STALE_MS. */
export const HARD_STOP_UNSENT_MS = 15 * MINUTE;
/** A problem opens after this many bad checks in a row, and recovers after as many clean ones. */
export const CHECKS_TO_OPEN = 2;
export const CHECKS_TO_RECOVER = 2;
/** A check this soon after the last one is the same look twice, so it is not counted. */
export const MIN_CHECK_GAP_MS = 10 * MINUTE;
const CLOCK_SLACK_MS = 10 * MINUTE;

const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const minutes = (ms: number) => Math.round(ms / MINUTE);

export function parseHeartbeatValue(raw: string): HeartbeatValue | null {
  let v: { version?: unknown; at?: unknown; jobs?: Record<string, { state?: unknown; at?: unknown; behindMs?: unknown; alarm?: unknown } | undefined> };
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v?.version !== 1 || !isTime(v.at) || typeof v.jobs !== "object" || v.jobs === null) return null;
  const jobs: HeartbeatValue["jobs"] = {};
  for (const job of WATCHED) {
    const b = v.jobs[job];
    if (b === undefined) continue;
    if (b?.state === "missing") jobs[job] = { state: "missing" };
    else if (b?.state === "ok" && isTime(b.at) && (b.behindMs === undefined || isTime(b.behindMs)) && (b.alarm === undefined || b.alarm === true))
      jobs[job] = { state: "ok", at: b.at, ...(b.behindMs === undefined ? {} : { behindMs: b.behindMs }), ...(b.alarm ? { alarm: true } : {}) };
    else jobs[job] = { state: "unreadable" };
  }
  return { version: 1, at: v.at, jobs };
}

/** One look: the problems in plain words, one row per watched job, and which jobs have ever reported. */
export type Reading = { problems: string[]; rows: [string, string][]; seen: Watched[]; pushedAt: number | null };

/**
 * One look at the value. `seenBefore` is every job that has reported at least
 * once: a job never seen is listed as not reporting yet, and one that reported
 * before and has gone missing is a problem.
 */
export function judgeHeartbeat(raw: string | undefined, now: number, seenBefore: readonly Watched[] = []): Reading {
  const blocked = "(Mac down, or its GitHub access blocked)";
  const only = (text: string, pushedAt: number | null = null): Reading => ({ problems: [text], rows: [], seen: [...seenBefore], pushedAt });
  if (!raw?.trim()) return only(`no heartbeat from the Mac yet ${blocked}`);
  const value = parseHeartbeatValue(raw);
  if (!value) return only("the pushed heartbeat cannot be read");
  if (value.at > now + CLOCK_SLACK_MS) return only("the Mac's heartbeat is dated in the future", value.at);
  // An old value says nothing about the jobs, so only the Mac itself is named.
  if (now - value.at > STALE_MS) return only(`no heartbeat from the Mac for ${minutes(now - value.at)} minutes ${blocked}`, value.at);
  const problems: string[] = [],
    rows: [string, string][] = [],
    seen: Watched[] = [];
  for (const job of WATCHED) {
    const beat = value.jobs[job],
      name = NAMES[job];
    if (!beat) continue; // the pusher no longer lists it, so it is forgotten
    if (beat.state === "missing") {
      if (!seenBefore.includes(job)) {
        rows.push([name, "not reporting yet (not judged, and not counted as healthy)"]);
        continue;
      }
      seen.push(job);
      problems.push(`${name} has stopped writing its heartbeat`);
      rows.push([name, "heartbeat missing (it reported before)"]);
      continue;
    }
    seen.push(job);
    if (beat.state === "unreadable") {
      problems.push(`${name}'s heartbeat cannot be read`);
      rows.push([name, "heartbeat cannot be read"]);
      continue;
    }
    const age = now - beat.at,
      last = `last ${job === "tick" ? "succeeded" : "ran"} ${minutes(age)} minutes ago`,
      found: string[] = [];
    if (beat.at > now + CLOCK_SLACK_MS) found.push("has a heartbeat dated in the future");
    else if (age > STALE_MS) found.push(last);
    if (beat.alarm) found.push("reports an alarm (its reason is in its heartbeat file on the Mac)");
    if (job === "sender" && (beat.behindMs ?? 0) > HARD_STOP_UNSENT_MS) found.push(`has held a hard stop unsent for ${minutes(beat.behindMs!)} minutes`);
    problems.push(...found.map((text) => `${name} ${text}`));
    rows.push([name, found.length ? found.join("; ") : last]);
  }
  return { problems, rows, seen, pushedAt: value.at };
}

// ----------------------------------------------------------- episodes
export type Notice = { kind: "open" | "remind" | "recover"; problems: string[]; since: number };
/** Kept between checks in the standing issue's own text. */
export type CheckState = {
  version: 1;
  variable: string;
  /** The last check that was counted. */
  checkedAt: number;
  /** Bad checks in a row. */
  bad: number;
  /** Clean checks in a row while a problem is open. */
  good: number;
  open: { since: number; noticeAt: number; problems: string[] } | null;
  seen: Watched[];
  /** A notice decided but not yet confirmed delivered. A later run sends it first. */
  pending: Notice | null;
};
export const initialCheckState = (variable: string): CheckState => ({ version: 1, variable, checkedAt: 0, bad: 0, good: 0, open: null, seen: [], pending: null });

const zoned = (at: number, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, hourCycle: "h23", ...options }).format(at);
const day = (at: number) => zoned(at, { year: "numeric", month: "2-digit", day: "2-digit" });
const clock = (at: number) => `${day(at)} ${zoned(at, { hour: "2-digit", minute: "2-digit" })}`;
/** An open problem is said again once a day, at the first check from 09:00 Toronto on a later day. */
const reminderDue = (noticeAt: number, now: number) => day(now) > day(noticeAt) && Number(zoned(now, { hour: "2-digit" })) >= 9;

/** Advances the state by one check. At most one notice comes out of it. */
export function stepCheck(prior: CheckState, reading: Reading, now: number): CheckState {
  if (now >= prior.checkedAt && now - prior.checkedAt < MIN_CHECK_GAP_MS) return { ...prior, pending: null };
  const texts = reading.problems,
    isBad = texts.length > 0;
  const next: CheckState = { ...prior, checkedAt: now, seen: reading.seen, bad: isBad ? prior.bad + 1 : 0, good: !isBad && prior.open ? prior.good + 1 : 0, pending: null };
  if (!prior.open) {
    if (next.bad >= CHECKS_TO_OPEN) {
      next.open = { since: now, noticeAt: now, problems: texts };
      next.pending = { kind: "open", problems: texts, since: now };
    }
  } else if (isBad) {
    next.open = { ...prior.open, problems: texts };
    if (reminderDue(prior.open.noticeAt, now)) {
      next.open.noticeAt = now;
      next.pending = { kind: "remind", problems: texts, since: prior.open.since };
    }
  } else if (next.good >= CHECKS_TO_RECOVER) {
    next.open = null;
    next.good = 0;
    next.pending = { kind: "recover", problems: prior.open.problems, since: prior.open.since };
  }
  return next;
}

// ------------------------------------------------------ the issue's text
const MARKER = "factory-heartbeat-state";
const STATE_BLOCK = new RegExp(`<!-- ${MARKER}(?: (\\{.*\\}))? -->`);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** "no-marker": not a heartbeat issue, so it is never written. null: a heartbeat issue with no usable state yet. */
export function readCheckState(body: string): CheckState | null | "no-marker" {
  const block = body.match(STATE_BLOCK);
  if (!block) return "no-marker";
  try {
    const s = JSON.parse(block[1] ?? "null") as CheckState | null;
    const openOk = s?.open === null || (!!s?.open && isCount(s.open.since) && isCount(s.open.noticeAt) && isTexts(s.open.problems));
    const pendingOk = s?.pending === null || (!!s?.pending && ["open", "remind", "recover"].includes(s.pending.kind) && isCount(s.pending.since) && isTexts(s.pending.problems));
    if (s?.version !== 1 || typeof s.variable !== "string" || !isCount(s.checkedAt) || !isCount(s.bad) || !isCount(s.good) || !openOk || !pendingOk || !isTexts(s.seen)) return null;
    return { ...s, seen: WATCHED.filter((job) => s.seen.includes(job)) };
  } catch {
    return null;
  }
}

const list = (texts: string[]) => texts.map((t) => `- ${t}`).join("\n");

export function renderIssue(state: CheckState, reading: Reading, now: number): string {
  const status = state.open
    ? `**Status: PROBLEM since ${clock(state.open.since)}.**${state.good ? " One clean check so far; it counts as recovered if the next check is clean too." : ""}`
    : state.bad
      ? "**Status: watching.** One bad check; a notice goes out if the next check is bad too."
      : "**Status: OK.**";
  const pushed = reading.pushedAt === null ? "Nothing readable has been pushed." : `The Mac last pushed ${minutes(Math.max(0, now - reading.pushedAt))} minutes before this check.`;
  const table = reading.rows.length ? `\n\n| Watched | Reading |\n| --- | --- |\n${reading.rows.map(([name, text]) => `| ${name} | ${text} |`).join("\n")}` : "";
  const problems = reading.problems.length ? `\n\nProblems at this check:\n\n${list(reading.problems)}` : "";
  // ">" is escaped so nothing inside the state can close the comment early.
  return `${status}

Last check: ${clock(now)} (${ZONE}). Variable \`${state.variable}\`. ${pushed}${table}${problems}

This issue is the standing record of the off-machine heartbeat check (\`docs/dead-man.md\`). The check rewrites this text every time it runs, and comments once when a problem opens and once when it recovers. Times are Toronto time. Do not edit the line below.

<!-- ${MARKER} ${JSON.stringify(state).replaceAll(">", "\\u003e")} -->
`;
}

export function noticeComment(notice: Notice, owner: string, now: number): string {
  if (notice.kind === "recover") return `**Recovered.** The heartbeat was clean on ${CHECKS_TO_RECOVER} checks in a row. The problem was open for about ${minutes(now - notice.since)} minutes (since ${clock(notice.since)}).\n\n${owner}`;
  const lead = notice.kind === "open" ? `**Problem.** The off-machine check saw this on ${CHECKS_TO_OPEN} checks in a row:` : `**Still a problem** (since ${clock(notice.since)}):`;
  return `${lead}\n\n${list(notice.problems)}\n\n${owner}\n\nOne more comment follows when it recovers.`;
}

/** The one plain line for Telegram. */
export function telegramLine(notice: Notice): string {
  return `${notice.kind === "open" ? "The factory needs a look" : `The factory still needs a look, since ${clock(notice.since)}`}: ${notice.problems.join("; ")}. This comes from GitHub, not from the Mac.`;
}

// ------------------------------------------------------------ the check
export type CheckInput = {
  variable: string;
  /** The variable's value as the workflow read it; empty when it was never written. */
  value: string | undefined;
  /** The issue to write to. */
  issue: number;
  /** The real standing issue. Only a check that writes to it may notify anyone. */
  standingIssue: number | null;
  /** The owner's GitHub login. */
  owner: string | null;
};
export type CheckIo = {
  now: () => number;
  issueBody: () => Promise<string>;
  saveBody: (body: string) => Promise<void>;
  comment: (body: string) => Promise<void>;
  /** Sends one line to the owner; null when no Telegram secret is stored. Resolves false when it could not send. */
  telegram: ((text: string) => Promise<boolean>) | null;
};

export async function runCheck(input: CheckInput, io: CheckIo): Promise<{ state: CheckState; reading: Reading; sent: Notice[] }> {
  if (!VARIABLE_NAME.test(input.variable)) throw Error(`refused: the variable must be ${HEARTBEAT_VARIABLE} or ${HEARTBEAT_VARIABLE}_<NAME>`);
  // A drill can never write to the real issue, so it can neither raise nor clear a real problem.
  const real = input.issue === input.standingIssue;
  if (real && input.variable !== HEARTBEAT_VARIABLE) throw Error("refused: the standing issue only takes the real variable; a drill needs its own issue");
  const now = io.now(),
    stored = readCheckState(await io.issueBody());
  if (stored === "no-marker") throw Error(`refused: issue #${input.issue} is not a heartbeat issue (its text has no ${MARKER} line)`);
  let state = stored ?? initialCheckState(input.variable);
  if (state.variable !== input.variable) throw Error(`refused: issue #${input.issue} follows ${state.variable}, not ${input.variable}`);
  const owner = input.owner && /^[A-Za-z0-9-]{1,39}$/.test(input.owner) ? input.owner : null,
    sent: Notice[] = [];
  const deliver = async (notice: Notice) => {
    // Telegram carries the opening and the daily reminder. With it, GitHub
    // mentions the owner only when Telegram could not send.
    const told = real && io.telegram && notice.kind !== "recover" ? await io.telegram(telegramLine(notice)) : false;
    const who = !real
      ? "Owner: nobody is notified (this is a drill issue)."
      : !owner
        ? "Owner: not set (the FACTORY_HEARTBEAT_OWNER variable is empty or not a login)."
        : told
          ? `Owner: ${owner} (told on Telegram).`
          : io.telegram && notice.kind === "recover"
            ? `Owner: ${owner}.`
            : `Owner: @${owner}`;
    await io.comment(noticeComment(notice, who, now));
    sent.push(notice);
  };
  // A notice a failed run decided but could not confirm goes out first.
  if (state.pending) {
    await deliver(state.pending);
    state = { ...state, pending: null };
  }
  const reading = judgeHeartbeat(input.value, now, state.seen);
  state = stepCheck(state, reading, now);
  // Saved before it is sent: a failure after this repeats the notice, it never loses it.
  await io.saveBody(renderIssue(state, reading, now));
  if (state.pending) {
    await deliver(state.pending);
    state = { ...state, pending: null };
    await io.saveBody(renderIssue(state, reading, now));
  }
  return { state, reading, sent };
}

/** The real connections: GitHub's API with the workflow's own token, and Telegram when its secret is stored. */
function githubIo(repo: string, token: string, issue: number, telegramSecret: string | undefined): CheckIo {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory-heartbeat-check" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw Error(`GitHub ${method} issue #${issue}${path} failed: HTTP ${response.status}`);
    return (await response.json()) as { body?: string | null };
  };
  // One secret holds both parts: "<chat id> <bot token>". It is never logged.
  const secret = telegramSecret?.trim().match(/^(-?\d+)[\s/]+(\d+:[A-Za-z0-9_-]+)$/);
  if (telegramSecret?.trim() && !secret) console.log("The Telegram secret is not in the '<chat id> <bot token>' form; the owner is mentioned on GitHub instead.");
  return {
    now: Date.now,
    issueBody: async () => (await api("GET", "")).body ?? "",
    saveBody: async (body) => void (await api("PATCH", "", { body })),
    comment: async (body) => void (await api("POST", "/comments", { body })),
    telegram: secret
      ? async (text) => {
          try {
            const response = await fetch(`https://api.telegram.org/bot${secret[2]}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: secret[1], text }) });
            if (!response.ok) console.log(`Telegram did not accept the line (HTTP ${response.status}); the owner is mentioned on GitHub instead.`);
            return response.ok;
          } catch {
            console.log("Telegram could not be reached; the owner is mentioned on GitHub instead.");
            return false;
          }
        }
      : null,
  };
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  if (mode === "push") {
    const result = await pushHeartbeat({ repo: option("--repo") ?? "", variable: option("--variable") ?? "", dir: option("--dir"), mailDir: option("--mail-dir") });
    console.log(JSON.stringify(result.pushed ? { at: result.value.at, pushed: true, jobs: Object.fromEntries(Object.entries(result.value.jobs).map(([job, beat]) => [job, beat.state])) } : { at: Date.now(), ...result }));
  } else if (mode === "check") {
    const env = process.env,
      issueNumber = (v?: string) => (v && /^[1-9]\d{0,9}$/.test(v.trim()) ? Number(v.trim()) : null),
      issue = issueNumber(env.HEARTBEAT_ISSUE);
    if (!issue) throw Error("HEARTBEAT_ISSUE must be the heartbeat issue's number");
    if (!env.GITHUB_TOKEN || !REPOSITORY.test(env.GITHUB_REPOSITORY ?? "")) throw Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
    const input: CheckInput = { variable: env.HEARTBEAT_VARIABLE || HEARTBEAT_VARIABLE, value: env.HEARTBEAT_VALUE, issue, standingIssue: issueNumber(env.HEARTBEAT_STANDING_ISSUE), owner: env.HEARTBEAT_OWNER?.trim() || null };
    const { state, reading, sent } = await runCheck(input, githubIo(env.GITHUB_REPOSITORY!, env.GITHUB_TOKEN, issue, env.HEARTBEAT_TELEGRAM));
    console.log(JSON.stringify({ issue, variable: input.variable, problems: reading.problems, open: state.open !== null, bad: state.bad, notices: sent.map((n) => n.kind) }));
  } else throw Error("usage: push-heartbeat.ts push --repo <owner/name> --variable <NAME> [--dir <folder> --mail-dir <folder>] | check");
}
