import { issueTicket, type Issue } from "../adapters/github";
import type { Engine, Session } from "../launcher/engine";
import { boardQuestions } from "../launcher/questions";
import { toronto, deadlineAt } from "../launcher/release";
import type { Billing, Meter, Ticket } from "../launcher/config";
import { monthAt } from "../wallet/ledger";

export type Language = "en" | "fr";
const copy = {
  en: {
    unknown: "Unavailable",
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
    unknown: "Indisponible",
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
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b/g, "")
    .replace(/\b[a-f0-9]{32,64}\b/gi, "")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "")
    .replace(/^\s*(?:\[[^\]]+\]|[\w.-]+\/[\w.-]+\s*[:—-])\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
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
      try {
        brief = issueTicket(id.slice(0, id.lastIndexOf("#")), i) ?? {};
      } catch {}
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
      seconds: x?.actual_seconds ?? null,
      tokens: x?.actual_tokens ?? null,
      estimateSeconds: brief.estimateSeconds ?? null,
      progress:
        brief.estimateSeconds && x
          ? Math.min(1, x.actual_seconds / brief.estimateSeconds)
          : null,
      issue: githubURL(i.url),
      pr,
      session: x?.native_id ?? null,
      sessionStatus: x?.status ?? null,
      status: "",
      at: null as number | null,
      technical: { issue: i, session: x ?? null },
    };
  }
  const running: ReturnType<typeof task>[] = [],
    upNext: ReturnType<typeof task>[] = [],
    waiting: ReturnType<typeof task>[] = [],
    done: ReturnType<typeof task>[] = [];
  for (const row of rows) {
    const i = snapshots.get(row.id)!,
      x = latest.get(row.id);
    if (!i.title || x?.status === "archived") continue;
    const labels = (i.labels ?? []).map((l) => l.name),
      item = task(row.id, i, x);
    if (i.state === "CLOSED") {
      // Editing an old closed issue must never bring it back into Done.
      const at = Date.parse(i.closedAt ?? "");
      if (Number.isFinite(at) && at <= now && now - at <= 48 * 3600000) {
        item.status = t.closed;
        item.at = at;
        done.push(item);
      }
      continue;
    }
    if (i.state !== "OPEN") continue;
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
    if (item.status) waiting.push(item);
  }
  running.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  done.sort((a, b) => b.at! - a.at!);
  const questions = boardQuestions(s).questions.map((q) => {
    const x = q.id.startsWith("overrun:")
      ? sessions.find((x) => x.id === q.id.slice(8))
      : undefined;
    const i = x ? snapshots.get(x.ticket) : undefined;
    const decision = q.id.startsWith("autonomy:")
      ? s.get<{ deadline?: number; default?: string; state?: string }>(
          `autonomy-decision:${q.id.slice(9)}`,
        )
      : null;
    const fallback =
      decision?.default === "not approved"
        ? t.notApproved
        : x
          ? t.stoppedDefault
          : t.notApproved;
    return {
      id: q.id,
      title: x
        ? t.extension(
            plainText(
              i?.title || parse<Partial<Ticket>>(x.brief, {}).title || "",
            ) || t.task,
          )
        : plainText(q.text),
      defaultLine: decision?.deadline
        ? t.deadline(time(decision.deadline), fallback)
        : x
          ? t.noDeadline
          : t.noDecisionDeadline,
      task: x && i ? task(x.ticket, i, x) : null,
      technical: q,
    };
  });
  const lastExit = events.find((ev) => ev.kind === "worker-exit")?.at;
  const lastStart = sessions.reduce((at, x) => Math.max(at, x.started ?? 0), 0);
  const idleSince = Math.max(lastExit ?? 0, lastStart);
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
    const window =
      provider === "codex"
        ? weekly
        : (weekly ??
          meter?.windows.reduce((a, b) => (a.used > b.used ? a : b)));
    const fresh =
      meter &&
      now >= meter.observedAt &&
      now - meter.observedAt <= e.c.usage_gates.max_meter_age_minutes * 60000 &&
      window &&
      window.resetsAt > now;
    return { provider, percent: fresh ? Math.round(window.used * 100) : null };
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
  return {
    now,
    lang,
    status,
    paused: s.get("paused") === true,
    notice: delayed ? t.stale : sourceError ? t.sources : null,
    usage,
    aws,
    nextRelease: { ...next, time: time(next.at), tomorrow: minute >= 1290 },
    questions,
    running,
    upNext: upNext.slice(0, 10),
    more: Math.max(0, upNext.length - 10),
    waiting,
    done,
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
