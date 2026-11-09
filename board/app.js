const words = {
  en: {
    title: "Today",
    controls: "Controls",
    token: "Owner token",
    save: "Use token",
    questions: "Questions",
    tickets: "Tickets",
    sessions: "Sessions",
    overshoot: "Overshoot",
    cached: "Cached tokens (included)",
    nextTurn: "Next turn blocked",
    releases: "Releases",
    owners: "Owners",
    pause: "Pause",
    resume: "Resume",
    paused: "Paused",
    running: "Admissions open",
    none: "No records",
    unknown: "Unverified",
    usage: "usage",
    stale: "Stale — starts blocked",
    blocked: "Starts blocked",
    highOnly: "High benefit only",
    open: "Below 70%",
    weeklyOnly: "weekly only",
    age: "minutes old",
    estimator: "Estimator vs mean",
    wallet: "Available wallet",
    slots: "Slots",
    capacity: "Worker capacity",
    currentCapacity: "Current admission limit",
    ceiling: "Controller maximum (not supplied)",
    occupied: "Occupied / admission limit (includes retained custody)",
    retained: "Paused / unknown custody",
    busy: "Starting/running busy fraction (sampled)",
    pressure: "Memory pressure",
    failures: "Failure rate · trailing hour",
    dwell: "Healthy dwell at sample",
    growth: "Growth status / hold reason",
    sample: "Controller sample",
    missingCapacity: "Controller evidence unavailable",
    staleCapacity: "Stale or invalid sample — current growth status unknown",
    evidenceUnknown: "Unknown",
    minutes: "min",
    noDwell: "Not accumulating",
    pressureValues: { normal: "Normal", warning: "Warning", critical: "Critical", unknown: "Unknown" },
    growthReasons: {
      "memory pressure not normal": "Memory pressure not normal",
      "occupancy below threshold": "Starting/running occupancy below threshold",
      "failure rate too high": "Failure rate too high",
      "collecting healthy hour": "Collecting a healthy hour",
      "added one slot after healthy hour": "Added one slot after a healthy hour",
      "maximum capacity": "Maximum capacity reached",
    },
    heartbeat: "Heartbeat",
    reconciled:"Last successful reconciliation",
    seconds: "seconds ago",
    answer: "Answer",
    stop: "Stop and preserve",
    archive: "Archive reconciled session",
    custody: "Custody receipt",
    proof: "Proof",
    source: "Sources",
    error: "Unable to read local evidence",
    authorization: "Token saved for this tab",
    sent: "Recorded",
    refresh: "Local evidence refreshed",
  },
  fr: {
    title: "Aujourd’hui",
    controls: "Commandes",
    token: "Jeton du propriétaire",
    save: "Utiliser le jeton",
    questions: "Questions",
    tickets: "Tickets",
    sessions: "Sessions",
    overshoot: "Dépassement",
    cached: "Jetons en cache (inclus)",
    nextTurn: "Prochain tour bloqué",
    releases: "Livraisons",
    owners: "Responsables",
    pause: "Suspendre",
    resume: "Reprendre",
    paused: "En pause",
    running: "Admissions ouvertes",
    none: "Aucun enregistrement",
    unknown: "Non vérifié",
    usage: "utilisation",
    stale: "Périmé — démarrages bloqués",
    blocked: "Démarrages bloqués",
    highOnly: "Bénéfice élevé seulement",
    open: "Moins de 70 %",
    weeklyOnly: "hebdomadaire seulement",
    age: "minutes écoulées",
    estimator: "Estimation / moyenne",
    wallet: "Budget disponible",
    slots: "Places",
    capacity: "Capacité des agents",
    currentCapacity: "Limite d’admission actuelle",
    ceiling: "Maximum du contrôleur (non fourni)",
    occupied: "Places occupées / limite d’admission (garde conservée incluse)",
    retained: "Garde en pause / inconnue",
    busy: "Fraction occupée en démarrage/exécution (échantillon)",
    pressure: "Pression mémoire",
    failures: "Taux d’échec · dernière heure",
    dwell: "Durée saine à l’échantillon",
    growth: "État de croissance / motif de blocage",
    sample: "Échantillon du contrôleur",
    missingCapacity: "Données du contrôleur indisponibles",
    staleCapacity: "Échantillon périmé ou invalide — croissance actuelle inconnue",
    evidenceUnknown: "Inconnu",
    minutes: "min",
    noDwell: "Aucune accumulation",
    pressureValues: { normal: "Normale", warning: "Avertissement", critical: "Critique", unknown: "Inconnue" },
    growthReasons: {
      "memory pressure not normal": "Pression mémoire non normale",
      "occupancy below threshold": "Occupation en démarrage/exécution sous le seuil",
      "failure rate too high": "Taux d’échec trop élevé",
      "collecting healthy hour": "Collecte d’une heure saine",
      "added one slot after healthy hour": "Une place ajoutée après une heure saine",
      "maximum capacity": "Capacité maximale atteinte",
    },
    heartbeat: "Dernier signal",
    reconciled:"Dernière synchronisation réussie",
    seconds: "secondes",
    answer: "Répondre",
    stop: "Arrêter et conserver",
    archive: "Archiver la session réconciliée",
    custody: "Preuve de garde",
    proof: "Preuve",
    source: "Sources",
    error: "Lecture des données locales impossible",
    authorization: "Jeton enregistré pour cet onglet",
    sent: "Enregistré",
    refresh: "Données locales actualisées",
  },
};
let data,
  lang = "en";
const $ = (id) => document.getElementById(id),
  w = () => words[lang];
const node = (tag, text) => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
function detail(parent, title, text) {
  const d = document.createElement("details");
  d.append(node("summary", title), node("pre", text));
  parent.append(d);
  return d;
}
function empty(id) {
  $(id).replaceChildren();
}
function renderCapacity() {
  const t = w(), slots = data.slots ?? {}, c = slots.controller;
  const count = (n) => Number.isInteger(n) && n >= 0 ? String(n) : t.evidenceUnknown;
  const fraction = (n) => Number.isFinite(n) && n >= 0 && n <= 1
    ? (n * 100).toLocaleString(lang, { maximumFractionDigits: 1 }) + "%"
    : t.evidenceUnknown;
  const validSample = Number.isFinite(c?.at) && c.at > 0 && c.at <= data.now;
  const fresh = validSample && data.now - c.at <= 120000;
  const retained = (status) => Array.isArray(data.sessions)
    ? count(data.sessions.filter((x) => x.status === status).length)
    : t.evidenceUnknown;
  $("capacity-title").textContent = t.capacity;
  $("capacity-status").textContent = !c ? t.missingCapacity : fresh ? "" : t.staleCapacity;
  const rows = [
    [t.currentCapacity, count(slots.max)],
    // The API's max is the current admission limit, not the policy ceiling.
    [t.ceiling, t.evidenceUnknown],
    [t.occupied, count(slots.used) + " / " + count(slots.max)],
    [t.retained, retained("paused") + " / " + retained("unknown")],
    [t.busy, fraction(c?.busy)],
    [t.pressure, t.pressureValues[c?.pressure] ?? t.evidenceUnknown],
    [t.failures, fraction(c?.failureRate)],
    [t.dwell, validSample && Number.isFinite(c?.healthySince) && c.healthySince > 0 && c.healthySince <= c.at
      ? ((c.at - c.healthySince) / 60000).toLocaleString(lang, { maximumFractionDigits: 1 }) + " " + t.minutes
      : c?.healthySince === null ? t.noDwell : t.evidenceUnknown],
    [t.growth, c?.reason ? t.growthReasons[c.reason] ?? c.reason : t.evidenceUnknown],
    [t.sample, validSample ? new Date(c.at).toLocaleString(lang) : t.evidenceUnknown],
  ];
  empty("capacity-evidence");
  for (const [label, value] of rows) {
    const row = node("div", "");
    row.append(node("dt", label), node("dd", value));
    $("capacity-evidence").append(row);
  }
}
async function action(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (sessionStorage.getItem("owner-token") || ""),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error((await r.json()).error);
  $("auth-result").textContent = w().sent;
  await refresh();
}
function button(text, fn) {
  const b = node("button", text);
  b.onclick = () =>
    fn().catch((e) => {
      $("auth-result").textContent = e.message;
    });
  return b;
}
function render() {
  const t = w();
  document.documentElement.lang = lang;
  $("title").textContent = t.title;
  $("control-title").textContent = t.controls;
  $("token-label").textContent = t.token;
  $("save").textContent = t.save;
  for (const id of ["questions", "tickets", "sessions", "releases", "owners"])
    $(id + "-title").textContent = t[id];
  if (!data) return;
  renderCapacity();
  $("connection").textContent =
    (data.paused ? t.paused : t.running) +
    " · " +
    t.refresh +
    " · " +
    new Date(data.now).toLocaleTimeString(lang);
  $("pause").textContent = data.paused ? t.resume : t.pause;
  empty("summary");
  const cards = [[t.reconciled,data.lastSuccessfulReconciliation ? new Date(data.lastSuccessfulReconciliation).toLocaleString(lang) : t.unknown, ""]];
  for (const provider of ["codex", "claude"]) {
    const m = data.usage[provider];
    const status = data.usageAdmission[provider];
    const weeklyOnly = m?.windows.length === 1 &&
      (m.windows[0].name === "seven_day" || m.windows[0].durationMinutes === 10080);
    cards.push([
      provider + " " + t.usage,
      m
        ? m.windows.map((x) => Math.round(x.used * 100) + "%").join(" / ") +
          " · " + t[status] + (weeklyOnly ? " · " + t.weeklyOnly : "")
        : t.unknown + " · " + t.blocked,
      m
        ? Math.max(0,Math.floor((data.now-m.observedAt)/60000)) + " " + t.age + " · " + new Date(m.observedAt).toLocaleString(lang) +
          " · " +
          m.source + " · " + m.windows
            .map((x) => (x.name ?? "") + " " + new Date(x.resetsAt).toLocaleString(lang))
            .join(" / ")
        : data.qualifications[provider],
    ]);
  }
  cards.push([t.heartbeat, data.paused ? t.paused : t.running,
    (data.heartbeat?.refusals ?? []).map(x => x.ticket + ": " + x.reason).join(" · ")]);
  cards.push([t.estimator, data.estimator.evaluation.status, JSON.stringify(data.estimator.evaluation.ratios)]);
  cards.push(
    [
      t.wallet,
      "AWS $" + (data.wallet.awsCents / 100).toFixed(2),
      "Other $" + (data.wallet.otherCents / 100).toFixed(2),
    ],
    [
      t.slots,
      data.slots.used + " / " + data.slots.max,
      data.heartbeat
        ? Math.round((Date.now() - data.heartbeat.at) / 1000) + " " + t.seconds
        : t.unknown,
    ],
  );
  for (const [label, value, more] of cards) {
    const c = node("div", "");
    c.className = "card";
    c.append(node("small", label), node("strong", value), node("small", more));
    $("summary").append(c);
  }
  for (const id of ["questions", "tickets", "sessions", "releases", "owners"])
    empty(id);
  for (const q of data.questions) {
    const d = detail(
      $("questions"),
      q.text.split("\n")[0],
      q.text + (q.answer ? "\n" + q.answer : ""),
    );
    if (!q.answer) {
      const form = document.createElement("form"),
        input = document.createElement("input");
      input.required = true;
      input.maxLength = 4000;
      input.setAttribute("aria-label", t.answer);
      const b = node("button", t.answer);
      b.type = "submit";
      form.append(input, b);
      form.onsubmit = (ev) => {
        ev.preventDefault();
        action("/api/answer", { id: q.id, answer: input.value }).catch(
          (e) => ($("auth-result").textContent = e.message),
        );
      };
      d.append(form);
    }
  }
  for (const row of data.tickets.filter(
    (row) => JSON.parse(row.snapshot).state === "OPEN",
  )) {
    const i = JSON.parse(row.snapshot);
    const d = detail(
      $("tickets"),
      row.id + " · " + i.title,
      JSON.stringify(
        {
          state: i.state,
          labels: i.labels.map((l) => l.name),
          decision: row.decision,
          estimate: data.estimates[row.id],
          observed: new Date(row.observed).toLocaleString(lang),
        },
        null,
        2,
      ),
    );
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(i.url)) {
      const a = node("a", "GitHub");
      a.href = i.url;
      a.rel = "noreferrer";
      d.append(a);
    }
  }
  for (const x of data.sessions) {
    const d = detail(
      $("sessions"),
      x.ticket + " · " + x.status,
      JSON.stringify(
        {
          owner: x.owner,
          native: x.native_id,
          link: t.unknown,
          seconds: x.actual_seconds,
          tokens: x.actual_tokens,
          [t.cached]:x.budget?.cachedTokens,
          [t.overshoot]:x.budget ? {tokens:x.budget.overshootTokens,seconds:x.budget.overshootSeconds} : null,
          [t.nextTurn]:x.budget?.nextTurnBlocked,
          budget:x.budget,
        },
        null,
        2,
      ),
    );
    if (x.status !== "archived")
      d.append(button(t.stop, () => action("/api/stop", { id: x.id })));
    if (["unknown", "paused", "finished"].includes(x.status)) {
      const form = document.createElement("form"),
        input = document.createElement("input");
      input.required = true;
      input.maxLength = 4000;
      input.setAttribute("aria-label", t.custody);
      input.placeholder = t.custody;
      const submit = node("button", t.archive);
      submit.type = "submit";
      form.append(input, submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        action("/api/archive", { id: x.id, receipt: input.value }).catch(
          (e) => ($("auth-result").textContent = e.message),
        );
      };
      d.append(form);
    }
  }
  for (const r of data.releases)
    detail(
      $("releases"),
      r.day + " · " + r.stage,
      r.revision + "\n" + r.receipt,
    );
  for (const o of data.owners)
    detail($("owners"), o.name + " · " + o.harness, o.brief);
  for (const id of ["questions", "tickets", "sessions", "releases", "owners"])
    if (!$(id).children.length) $(id).append(node("p", t.none));
  $("sources").textContent =
    t.source +
    " · " +
    JSON.stringify({
      github: data.sources,
      versions: data.versions,
      schedule: data.schedule,
    });
}
async function refresh() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw Error();
    data = await r.json();
    render();
  } catch {
    $("connection").textContent = w().error;
  }
}
$("auth").onsubmit = (e) => {
  e.preventDefault();
  sessionStorage.setItem("owner-token", $("token").value);
  $("token").value = "";
  $("auth-result").textContent = w().authorization;
};
$("lang").onchange = (e) => {
  lang = e.target.value;
  render();
};
$("pause").onclick = () =>
  action("/api/pause", { paused: !data.paused }).catch(
    (e) => ($("auth-result").textContent = e.message),
  );
refresh();
setInterval(refresh, 15000);
