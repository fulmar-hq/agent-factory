const words = {
  en: {
    title: "Today",
    controls: "Controls",
    token: "Owner token",
    save: "Use token",
    questions: "Questions",
    tickets: "Tickets",
    sessions: "Sessions",
    releases: "Releases",
    owners: "Owners",
    pause: "Pause",
    resume: "Resume",
    paused: "Paused",
    running: "Admissions open",
    none: "No records",
    unknown: "Unverified",
    usage: "usage",
    wallet: "Available wallet",
    slots: "Slots",
    heartbeat: "Heartbeat",
    seconds: "seconds ago",
    answer: "Answer",
    stop: "Stop and preserve",
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
    releases: "Livraisons",
    owners: "Responsables",
    pause: "Suspendre",
    resume: "Reprendre",
    paused: "En pause",
    running: "Admissions ouvertes",
    none: "Aucun enregistrement",
    unknown: "Non vérifié",
    usage: "utilisation",
    wallet: "Budget disponible",
    slots: "Places",
    heartbeat: "Dernier signal",
    seconds: "secondes",
    answer: "Répondre",
    stop: "Arrêter et conserver",
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
  $("connection").textContent =
    (data.paused ? t.paused : t.running) +
    " · " +
    t.refresh +
    " · " +
    new Date(data.now).toLocaleTimeString(lang);
  $("pause").textContent = data.paused ? t.resume : t.pause;
  empty("summary");
  const cards = [];
  for (const provider of ["codex", "claude"]) {
    const m = data.usage[provider];
    const fresh =
      m &&
      data.now - m.observedAt <= 900000 &&
      m.observedAt <= data.now &&
      m.windows.length >= 2 &&
      m.windows.every((x) => x.resetsAt > data.now);
    cards.push([
      provider + " " + t.usage,
      m
        ? m.windows.map((x) => Math.round(x.used * 100) + "%").join(" / ") +
          (fresh ? "" : " · " + t.unknown)
        : t.unknown,
      m
        ? new Date(m.observedAt).toLocaleString(lang) +
          " · " +
          m.windows
            .map((x) => new Date(x.resetsAt).toLocaleString(lang))
            .join(" / ")
        : data.qualifications[provider],
    ]);
  }
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
        },
        null,
        2,
      ),
    );
    d.append(button(t.stop, () => action("/api/stop", { id: x.id })));
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
