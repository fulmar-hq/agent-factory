import { usageTone, spendTone, timingTone, type Tone } from "./tones";
import { questionFields } from "./questions";
import { slotLimit } from "../launcher/capacity";
import type { BoardEvidence } from "./runtime";
import { issueTicket, type Issue } from "../adapters/github";
import type { Engine, Session } from "../launcher/engine";
import { boardQuestions } from "../launcher/questions";
import { toronto, deadlineAt } from "../launcher/release";
import type { Billing, Meter, Ticket } from "../launcher/config";
import { monthAt } from "../wallet/ledger";

export type Language = "en" | "fr";
const copy = {
  en: {
    unknown: "not available",
    noOwner: "Not assigned",
    task: "Task",
    paused: "Paused by you",
    review: "Waiting for review",
    checks: "Waiting for checks",
    fixChecks: "Waiting for checks to be fixed",
    release: "Waiting for tonight’s release",
    stopped: "Stopped — waiting for a decision",
    investigate: "Waiting for investigation",
    start: "Waiting to start",
    closed: "Closed",
    qa: "Shipped to QA",
    production: "Live in Production",
    scheduled: "Scheduled",
    skipped: "Skipped: AWS stopped",
    failed: "Failed",
    passed: "Passed",
    checking: "Checks in progress",
    missed: "Skipped: release window missed",
    unverified: "Release result unavailable",
    nothing: "Idle — nothing running",
    attention: "needs attention",
    working: "Working",
    queue: (n: number) => `${n} in the queue`,
    running: (n: number) => `${n} ${n === 1 ? "task" : "tasks"} running`,
    idle: (age: string) => `Idle — nothing running for ${age}`,
    stale: "Updates delayed — the factory needs attention",
    sources: "GitHub updates delayed — some tasks may be out of date",
    extension: (title: string) =>
      `“${title}” reached its estimate limit. Allow more work?`,
    noDeadline:
      "No automatic deadline. Without your approval: work stays stopped.",
    deadline: (time: string, fallback: string) =>
      `If you don’t answer by ${time}: ${fallback}`,
    noDecisionDeadline:
      "No automatic deadline. Without your answer: not approved.",
    notApproved: "not approved",
    stoppedDefault: "work stays stopped",
    noSession: "No saved session yet",
  },
  fr: {
    unknown: "non disponible",
    noOwner: "Non attribué",
    task: "Tâche",
    paused: "Mise en pause par vous",
    review: "En attente de révision",
    checks: "En attente des vérifications",
    fixChecks: "En attente de correction des vérifications",
    release: "En attente de la livraison de ce soir",
    stopped: "Arrêtée — en attente d’une décision",
    investigate: "En attente d’une enquête",
    start: "En attente de démarrage",
    closed: "Fermée",
    qa: "Livrée en QA",
    production: "En ligne en Production",
    scheduled: "Prévue",
    skipped: "Annulée : AWS arrêté",
    failed: "Échec",
    passed: "Réussie",
    checking: "Vérifications en cours",
    missed: "Annulée : créneau de livraison manqué",
    unverified: "Résultat de livraison indisponible",
    nothing: "Inactive — aucune tâche en cours",
    attention: "à vérifier",
    working: "En activité",
    queue: (n: number) => `${n} en attente`,
    running: (n: number) =>
      `${n} ${n === 1 ? "tâche en cours" : "tâches en cours"}`,
    idle: (age: string) => `Inactive — aucune tâche en cours depuis ${age}`,
    stale: "Actualisation retardée — la fabrique est à vérifier",
    sources:
      "Actualisation GitHub retardée — certaines tâches peuvent être périmées",
    extension: (title: string) =>
      `« ${title} » a atteint sa limite estimée. Autoriser plus de travail ?`,
    noDeadline:
      "Aucune échéance automatique. Sans votre accord : le travail reste arrêté.",
    deadline: (time: string, fallback: string) =>
      `Sans réponse avant ${time} : ${fallback}`,
    noDecisionDeadline:
      "Aucune échéance automatique. Sans réponse : non approuvé.",
    notApproved: "non approuvé",
    stoppedDefault: "le travail reste arrêté",
    noSession: "Aucune session enregistrée",
  },
};
export function humanTime(seconds: number, lang: Language = "en") {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return lang === "fr" ? "moins de 1 min" : "less than 1 min";
  if (n < 3600) return `${Math.floor(n / 60)} min`;
  const h = Math.floor(n / 3600),
    m = Math.floor((n % 3600) / 60);
  return `${h} h${m ? ` ${m} min` : ""}`;
}
export function plainText(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "")
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b/g, "")
    .replace(/\b[a-f0-9]{32,64}\b/gi, "")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "")
    .replace(/^\s*(?:\[[^\]]+\]|[\w.-]+\/[\w.-]+\s*[:—-])\s*/g, "")
    .replace(/^\s*(?:feat|fix|chore|docs|refactor|test|style|perf|build|ci)(?:\([^)]*\))?!?:\s*/i, "")
    .replace(/^#?\d+\s*[:.—-]\s*/, "")
    .replace(/\s*\(#\d+\)\s*$/g, "")
    .replace(/\b(?:tabs?_\w+(?:_mcp)?|[\w]+_mcp|tab(?:Id| id)\s*[:=]?\s*\d+)\b/gi, "")
    .replace(/\bmcp__\w+\b/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ").trim();
}
export const shortTitle = (value: string) => plainText(value).split(/\s+/).slice(0,12).join(" ").slice(0,100);
const parse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const githubURL = (url?: string) =>
  url &&
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/.test(url)
    ? url
    : null;
export function boardModel(
  e: Engine,
  readings: { codex?: Meter; claude?: Meter; billing?: Billing },
  now = Date.now(),
  lang: Language = "en",
  evidence: BoardEvidence = {ownerRuns:[],activity:{}},
  more = false,
) {
  const s = e.s,
    t = copy[lang],
    locale = lang === "fr" ? "fr-CA" : "en-CA";
  const time = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: "America/Toronto",
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
  const events = s.db
    .query(
      "SELECT kind,at,data FROM events WHERE kind IN ('worker-exit','launcher-publish','worker-delivery') ORDER BY at DESC",
    )
    .all() as { kind: string; at: number; data: string }[];
  const sessions = e.sessions(),
    latest = new Map<string, Session>();
  for (const x of sessions)
    if (!latest.has(x.ticket) || x.attempt > latest.get(x.ticket)!.attempt)
      latest.set(x.ticket, x);
  const rows = s.rows("tickets") as {
    id: string;
    snapshot: string;
    observed: number;
    decision: string;
  }[];
  const snapshots = new Map(
    rows.map((row) => [row.id, parse<Issue>(row.snapshot, {} as Issue)]),
  );
  const ownerName = (owner?: string) =>
    owner
      ? ((lang === "fr"
          ? (
              {
                product: "Produit",
                quality: "Qualité",
                release: "Livraison",
                builder: "Développement",
              } as Record<string, string>
            )[owner]
          : null) ??
        owner.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      : t.noOwner;
  function task(id: string, i: Issue, x?: Session) {
    let brief = x ? parse<Partial<Ticket>>(x.brief, {}) : {};
    if (!x) {
      // Display-only intake evidence: this never confers launch approval.
      const block = i.body?.match(/```factory\s*\n([\s\S]*?)\n```/);
      const raw = block ? parse<Partial<Ticket>>(block[1]!,{}) : {};
      brief = {owner:typeof raw.owner === "string" ? raw.owner : undefined,outcome:typeof raw.outcome === "string" ? raw.outcome : undefined,estimateSeconds:typeof raw.estimateSeconds === "number" && Number.isFinite(raw.estimateSeconds) && raw.estimateSeconds>0 ? raw.estimateSeconds : undefined};
    }
    const published = events.find(
      (ev) =>
        ev.kind !== "worker-exit" &&
        parse<{ id?: string }>(ev.data, {}).id === x?.id,
    );
    const pr = published
      ? githubURL(parse<{ url?: string }>(published.data, {}).url)
      : null;
    return {
      id,
      title: plainText(i.title || brief.title || "") || t.task,
      purpose:
        plainText(brief.outcome || "") || plainText(i.title || "") || t.task,
      owner: ownerName(x?.owner || brief.owner),
      started: x?.started ?? null,
      seconds: x?.started ? Math.max(0, (now - x.started) / 1000) : null,
      lastActivity: x ? evidence.activity[x.id] ?? null : null,
      ownerRun: false,
      waitGroup: "review",
      out: "closed",

      tokens: x?.actual_tokens ?? null,
      estimateSeconds: brief.estimateSeconds ?? null,
      progress:
        brief.estimateSeconds && x
          ? Math.min(1, Math.max(0, (now - (x.started ?? now)) / 1000) / brief.estimateSeconds)
          : null,
      issue: githubURL(i.url),
      pr,
      session: x?.native_id ?? null,
      sessionStatus: x?.status ?? null,
      status: "",
      tone: "rest" as Tone,
      at: null as number | null,
      technical: { tIssue: id, ...(x?.native_id ? {session:x.native_id} : {}) } as Record<string,string>,
    };
  }
  const running: ReturnType<typeof task>[] = [],
    upNext: ReturnType<typeof task>[] = [],
    waiting: ReturnType<typeof task>[] = [],
    done: ReturnType<typeof task>[] = [];
  for (const row of rows) {
    const i = snapshots.get(row.id)!,
      x = latest.get(row.id);
    if (!i.title) continue;
    const labels = (i.labels ?? []).map((l) => l.name),
      item = task(row.id, i, x);
    if (i.state === "CLOSED") {
      // Editing an old closed issue must never bring it back into Done.
      const at = Date.parse(i.closedAt ?? "");
      if (Number.isFinite(at) && at <= now && now - at <= 48 * 3600000) {
        item.status = t.closed;
        const finished = x ? events.find(ev => ev.kind === "worker-exit" && parse<{id?:string}>(ev.data,{}).id === x.id)?.at : null;
        item.at = finished && finished >= (x?.started ?? 0) && finished <= now ? finished : at;
        item.seconds = x?.started && finished ? Math.max(0,(finished-x.started)/1000) : null;
        const released = labels.includes("state:production") || labels.includes("state:live");
        item.out = released ? "live" : labels.includes("state:qa") ? "test" : "closed";
        if (item.at <= now && now-item.at <= 48*3600000) done.push(item);
      }
      continue;
    }
    if (i.state !== "OPEN" || x?.status === "archived") continue;
    if (x && ["starting", "running"].includes(x.status)) {
      running.push(item);
      continue;
    }
    let approved: Ticket | null = null;
    try {
      approved = issueTicket(row.id.slice(0, row.id.lastIndexOf("#")), i);
      if (approved) e.retryPrior(approved);
    } catch {
      approved = null;
    }
    // Preserve the launcher's reconciliation order and its retained-custody gate.
    const source = s.get<{
      error?: string;
      truncated?: boolean;
      observedAt?: number;
    }>(`github:${row.id.slice(0, row.id.lastIndexOf("#"))}`);
    if (
      approved &&
      source &&
      !source.error &&
      !source.truncated &&
      source.observedAt &&
      row.observed >= source.observedAt
    ) {
      item.owner = ownerName(approved.owner);
      item.purpose = plainText(approved.outcome);
      upNext.push(item);
      continue;
    }
    if (x?.status === "paused") item.status = t.stopped;
    else if (x?.status === "unknown") item.status = t.investigate;
    else if (labels.includes("state:checks")) item.status = t.checks;
    else if (
      labels.some((l) =>
        ["state:release", "state:built", "state:qa"].includes(l),
      )
    )
      item.status = t.release;
    else if (labels.includes("state:review") || x?.status === "finished")
      item.status = t.review;
    else if (x?.status === "reserved") item.status = t.start;
    if (item.status === t.review && item.pr) {
      const pr = s.get<{
        at: number;
        pending: boolean;
        failed: boolean;
        review?: string;
      }>(`board-pr:${item.pr}`);
      if (pr && pr.at <= now && now - pr.at <= 180000) {
        if (pr.failed) item.status = t.fixChecks;
        else if (pr.pending) item.status = t.checks;
        else if (pr.review === "APPROVED") item.status = t.release;
      }
    }
    item.waitGroup = item.status === t.checks ? "checks" : item.status === t.release ? "release" : [t.fixChecks,t.stopped,t.investigate].includes(item.status) ? "fix" : "review";
    item.tone = item.status === t.stopped ? "bad" : item.waitGroup === "fix" ? "warn" : "info";
    if (item.status) waiting.push(item);
  }
  running.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  done.sort((a, b) => b.at! - a.at!);
  const questions = boardQuestions(s).questions.map(q => {
    const x = q.id.startsWith("overrun:") ? sessions.find(x=>x.id===q.id.slice(8)) : undefined;
    const i = x ? snapshots.get(x.ticket) : undefined;
    const decision = q.id.startsWith("autonomy:") ? s.get<{deadline?:number;default?:string}>(`autonomy-decision:${q.id.slice(9)}`) : null;
    const browser = q.id.startsWith("browser:") ? s.get<{deadline:number;request?:{goal?:string};blocked?:{blocker?:string}}>(`browser-job:${q.id.slice(8)}`) : null;
    const structured = questionFields(q.text);
    const fallback = plainText(structured?.default ?? (browser ? (lang === "fr" ? "non fait" : "not done") : x ? t.stoppedDefault : t.notApproved));
    const title = x ? (lang === "fr" ? "Continuer : " : "Continue: ") + shortTitle(i?.title || parse<Partial<Ticket>>(x.brief,{}).title || t.task).split(/\s+/).slice(0,10).join(" ") + "?"
      : browser ? (lang === "fr" ? "Le site attend votre aide" : "The site needs your help")
      : shortTitle(structured?.title || (q.text.split(/\s+/).length<=12 && !/[{}]|mcp|tab.?id|https?:/i.test(q.text) ? q.text : (lang === "fr" ? "Vérifier une décision de travail" : "Review a work decision"))) || (lang === "fr" ? "Votre décision est requise" : "Your decision is needed");
    const context = structured?.context ? plainText(structured?.context).split(/(?<=[.!?])\s/)[0]! : x
      ? (lang === "fr" ? "Le travail a atteint sa limite et reste arrêté sans votre accord." : "The work reached its limit and stays stopped without your approval.")
      : browser ? (lang === "fr" ? "Une étape sur le site nécessite votre intervention avant de continuer." : "A step on the site needs your help before work can continue.")
      : (lang === "fr" ? "Une décision est nécessaire pour continuer ce travail." : "A decision is needed before this work can continue.");
    const choices = structured?.choices?.filter(c=>typeof c.label==="string" && typeof c.value==="string").map(c=>({label:shortTitle(c.label),value:c.value})) ?? (browser
      ? [{label:lang === "fr" ? "Pas fait" : "Not done",value:"not done"},{label:lang === "fr" ? "C’est fait, revérifier" : "Done, check again",value:"done"}]
      : [{label:lang === "fr" ? "Laisser arrêté" : "Keep stopped",value:"not approved"},{label:lang === "fr" ? "Demander une prolongation" : "Request an extension",value:"request bounded extension"}]);
    const deadline = structured?.deadline ?? decision?.deadline ?? browser?.deadline ?? null;
    return {id:q.id,title:shortTitle(title),context,choices,default:fallback,deadline,
      defaultLine:deadline ? t.deadline(time(deadline),fallback) : x ? t.noDeadline : t.noDecisionDeadline,
      technical:{details:plainText(structured?.title ? structured?.context || "" : q.text)},task:x && i ? task(x.ticket,i,x) : null};
  });
  for (const owner of evidence.ownerRuns) {
    const item = task(`owner:${owner.id}`, {title:owner.title} as Issue);
    Object.assign(item,{title:shortTitle(owner.title) || t.task,owner:ownerName(owner.owner),started:owner.started,seconds:Math.max(0,(now-owner.started)/1000),estimateSeconds:owner.estimateSeconds,lastActivity:owner.lastActivity,ownerRun:true,purpose:lang === "fr" ? "Travail du responsable en cours." : "An owner is working on this now.",technical:{details:plainText(owner.id)}});
    running.push(item);
  }
  running.sort((a,b)=>(a.started ?? 0)-(b.started ?? 0));
  const lastExit = events.find((ev) => ev.kind === "worker-exit")?.at;
  const lastStart = sessions.reduce((at, x) => Math.max(at, x.started ?? 0), 0);
  const idleSince = Math.max(lastExit ?? 0, lastStart, evidence.ownerFinishedAt ?? 0);
  const idleSeconds = idleSince ? Math.max(0, (now - idleSince) / 1000) : null;
  const heartbeat = s.get<{ at: number; status: string }>("heartbeat");
  const delayed =
    !heartbeat || now - heartbeat.at > 180000 || heartbeat.status === "error";
  const sourceError = Object.values(e.c.projects).some((p) => {
    const source = s.get<{ error?: string; truncated?: boolean }>(
      `github:${p.repo}`,
    );
    return !source || !!source.error || !!source.truncated;
  });
  let status = running.length
    ? `${t.working} — ${t.running(running.length)}, ${t.queue(upNext.length)}`
    : idleSeconds !== null
      ? t.idle(humanTime(idleSeconds, lang))
      : t.nothing;
  if (
    !running.length &&
    (upNext.length || waiting.length) &&
    (idleSeconds === null || idleSeconds >= 3600)
  )
    status += ` (${t.attention})`;
  if (s.get("paused") === true) status = t.paused;
  const usage = (["codex", "claude"] as const).map((provider) => {
    const meter = readings[provider];
    const weekly = meter?.windows.find(
      (w) => w.durationMinutes === 10080 || w.name === "seven_day",
    );
    const window = weekly;
    const fresh =
      meter &&
      now >= meter.observedAt &&
      now - meter.observedAt <= e.c.usage_gates.max_meter_age_minutes * 60000 &&
      window &&
      window.resetsAt > now;
    return { provider, percent: fresh ? Math.floor(window.used * 1000) / 10 : null, resetsAt:fresh ? window.resetsAt : null, tone:usageTone(fresh ? window.used : null,e.c.usage_gates) };
  });
  const billing = readings.billing,
    freshBilling =
      billing &&
      billing.month === monthAt(now) &&
      billing.observedAt <= now &&
      now - billing.observedAt <= 86400000;
  const aws = {
    stopped: s.get("aws-stop-latched") === true,
    dollars: freshBilling
      ? (billing.postedCents + billing.unpostedCents) / 100
      : null,
    ceiling: e.c.wallet.aws.ceiling_usd_month,
    plan: e.c.wallet.aws.planned_usd ?? e.c.wallet.aws.hold_at_projected,
    redAbove: e.c.board.aws_red_above_usd,
  };
  const { day, minute } = toronto(now);
  const releases = (
    [
      { stage: "qa", minute: 1200, name: "QA" },
      { stage: "production", minute: 1290, name: "Production" },
    ] as const
  ).map((r) => {
    const key = r.stage === "qa" ? "qa" : "readback";
    const effect = s.get<{ state: string }>(`executor:${day}:${key}`);
    const promotion =
      r.stage === "production"
        ? s.get<{ state: string }>(`executor:${day}:promote`)
        : null;
    const skip = s.db
      .query("SELECT id FROM events WHERE id=?")
      .get(`executor:${day}:${r.stage}:skipped`);
    const refusal = s.db
      .query(
        "SELECT id FROM events WHERE kind='release-executor' AND json_extract(data,'$.day')=? AND json_extract(data,'$.kind') LIKE 'refused:%'",
      )
      .get(day);
    let state = t.scheduled;
    if (effect?.state === "success") state = t.passed;
    else if (effect?.state === "failure" || promotion?.state === "failure")
      state = t.failed;
    else if (effect || promotion) state = t.checking;
    else if (skip || aws.stopped) state = t.skipped;
    else if (minute > r.minute) state = refusal ? t.failed : t.missed;
    return {
      id: `release:${r.stage}`,
      title: r.name,
      at: deadlineAt(now,r.minute),
      state: state === t.passed ? "passed" : state === t.failed ? "failed" : state === t.skipped || state === t.missed ? "skipped" : state === t.checking ? "checking" : "scheduled",
      tone: state === t.passed ? "ok" : state === t.failed ? "bad" : state === t.skipped || state === t.missed ? "rest" : "info",
      label: state === t.skipped ? (lang === "fr" ? "Annulée : AWS est éteint" : "Skipped: AWS is off") : state,
      time: time(deadlineAt(now, r.minute)),
      status: state,
      technical: { day, effect, promotion },
    };
  });
  const next =
    minute < 1200
      ? { name: "QA", at: deadlineAt(now, 1200) }
      : minute < 1290
        ? { name: "Production", at: deadlineAt(now, 1290) }
        : { name: "QA", at: deadlineAt(now, 1200 + 1440) };
  const durations = done.map(x=>x.seconds).filter((n): n is number=>n !== null).sort((a,b)=>a-b);
  const mid = Math.floor(durations.length/2);
  const medianSeconds = durations.length ? durations.length % 2 ? durations[mid]! : (durations[mid-1]!+durations[mid]!)/2 : null;
  const freeCapacity = e.active().length < slotLimit(s,e.c);
  const mode = s.get("paused") === true ? "paused" : questions.length ? "needs" : running.length ? "working" : freeCapacity ? "idle" : "paused";
  const hero = {mode,title:mode === "paused" ? (lang === "fr" ? "En pause" : "Paused") : mode === "needs" ? (lang === "fr" ? "Besoin de vous" : "Needs you") : mode === "working" ? (lang === "fr" ? "En marche" : "Working") : (lang === "fr" ? "Inactif" : "Idle"),
    soft:mode === "paused" ? (s.get("paused") === true ? (lang === "fr" ? "à votre demande" : "by you") : (lang === "fr" ? "en attente d’une place" : "waiting for a free slot")) : mode === "needs" ? `${questions.length} question${questions.length === 1 ? "" : "s"}` : mode === "working" ? t.running(running.length) : idleSeconds === null ? "" : (lang === "fr" ? "depuis " : "for ")+humanTime(idleSeconds,lang),
    lede:lang === "fr" ? `${running.length} tâches continuent pendant que vous décidez.` : `The ${running.length} running tasks carry on while you decide.`};
  return {
    now,
    hero,
    completed:{count:done.length,medianSeconds,over:done.filter(x=>x.seconds !== null && x.estimateSeconds !== null && x.seconds>x.estimateSeconds).length},
    nextLiveAt:deadlineAt(now,minute < 1290 ? 1290 : 1290+1440),
    lang,
    status,
    paused: s.get("paused") === true,
    notice: delayed ? t.stale : sourceError ? t.sources : null,
    usage,
    aws: {...aws,tone:spendTone(aws.dollars,aws.plan,aws.redAbove)},
    nextRelease: { ...next, time: time(next.at), tomorrow: minute >= 1290 },
    questions,
    running: running.map(x=>({...x,tone:"ok" as Tone,...timingTone(x.seconds,x.estimateSeconds,x.lastActivity,now,e.c.board.quiet_after_minutes)})),
    upNext: more ? upNext : upNext.slice(0, 5),
    more: Math.max(0, upNext.length - 5),
    waiting,
    done: done.map(x=>({...x,tone:x.out === "live" ? "ok" : x.out === "test" ? "info" : "rest",...timingTone(x.seconds,x.estimateSeconds,null,now,e.c.board.quiet_after_minutes)})),
    releases,
    counts: {
      running: running.length,
      upNext: upNext.length,
      waiting: waiting.length,
      done48h: done.length,
      needsYou: questions.length,
    },
  };
}
