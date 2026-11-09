const words = {
  en: {
    today: "Today",
    questions: "Needs you",
    running: "Running now",
    upNext: "Up next",
    waiting: "Waiting",
    done: "Done",
    releases: "Releases",
    doneNote: "Last 48 h",
    releasesNote: "Tonight · Toronto time",
    nothing: "Nothing needs you.",
    noRunning: "Nothing running right now.",
    noQueue: "Nothing in the queue.",
    noWaiting: "Nothing waiting.",
    noDone: "Nothing completed in the last 48 hours.",
    more: (n) => `+${n} more`,
    showAll: (n) => `Show all ${n}`,
    showFewer: "Show fewer",
    weekly: "Codex weekly",
    claude: "Claude usage",
    unavailable: "unavailable",
    awsStopped: "AWS stopped",
    next: "Next",
    tomorrow: "tomorrow",
    started: (age) => `Started ${age} ago`,
    ago: (age) => `${age} ago`,
    less: "less than 1 min",
    progress: (used, estimate) => `${used} of ${estimate}`,
    over: "Over estimate",
    close: "Close",
    details: "Task details",
    releaseDetails: "Release details",
    questionDetails: "Your decision",
    owner: "Owner",
    time: "Time used",
    tokens: "Tokens used",
    issue: "GitHub issue",
    pr: "Pull request",
    session: "Open session",
    noSession: "No saved session yet",
    copy: "Copy session",
    copied: "Copied",
    select: "Select and copy the session value",
    technical: "Technical details",
    controls: "Local controls",
    token: "Owner token",
    save: "Use token",
    pause: "Pause",
    resume: "Resume",
    saved: "Token saved for this tab",
    recorded: "Recorded",
    error: "Unable to refresh — showing the last update. Retrying…",
    loadingError: "Unable to load the factory. Retrying…",
    updated: (t) => `Updated ${t}`,
    refresh: "Updates every 15 seconds",
    skip: "Skip to tasks",
    answer: "Your answer",
    send: "Record answer",
    localAnswer: "To answer, open the board on the Mini.",
    stop: "Stop and preserve work",
    archive: "Archive reconciled session",
    receipt: "Custody receipt",
    noUsage: "Not recorded",
    language: "Language / Langue",
  },
  fr: {
    today: "Aujourd’hui",
    questions: "À vous de décider",
    running: "En cours",
    upNext: "À venir",
    waiting: "En attente",
    done: "Terminées",
    releases: "Livraisons",
    doneNote: "Dernières 48 h",
    releasesNote: "Ce soir · heure de Toronto",
    nothing: "Rien ne demande votre attention.",
    noRunning: "Aucune tâche en cours.",
    noQueue: "Aucune tâche à venir.",
    noWaiting: "Rien en attente.",
    noDone: "Aucune tâche terminée dans les dernières 48 heures.",
    more: (n) => `+${n} autres`,
    showAll: (n) => `Tout afficher (${n})`,
    showFewer: "Afficher moins",
    weekly: "Codex hebdomadaire",
    claude: "Utilisation Claude",
    unavailable: "indisponible",
    awsStopped: "AWS arrêté",
    next: "Prochaine",
    tomorrow: "demain",
    started: (age) => `Démarrée il y a ${age}`,
    ago: (age) => `il y a ${age}`,
    less: "moins de 1 min",
    progress: (used, estimate) => `${used} sur ${estimate}`,
    over: "Estimation dépassée",
    close: "Fermer",
    details: "Détails de la tâche",
    releaseDetails: "Détails de livraison",
    questionDetails: "Votre décision",
    owner: "Responsable",
    time: "Temps utilisé",
    tokens: "Jetons utilisés",
    issue: "Ticket GitHub",
    pr: "Demande de fusion",
    session: "Ouvrir la session",
    noSession: "Aucune session enregistrée",
    copy: "Copier la session",
    copied: "Copié",
    select: "Sélectionnez et copiez la valeur de session",
    technical: "Détails techniques",
    controls: "Commandes locales",
    token: "Jeton du propriétaire",
    save: "Utiliser le jeton",
    pause: "Suspendre",
    resume: "Reprendre",
    saved: "Jeton enregistré pour cet onglet",
    recorded: "Enregistré",
    error:
      "Actualisation impossible — dernières données affichées. Nouvelle tentative…",
    loadingError: "Chargement impossible. Nouvelle tentative…",
    updated: (t) => `Actualisé à ${t}`,
    refresh: "Actualisation toutes les 15 secondes",
    skip: "Aller aux tâches",
    answer: "Votre réponse",
    send: "Enregistrer la réponse",
    localAnswer: "Pour répondre, ouvrez le tableau sur le Mini.",
    stop: "Arrêter et conserver le travail",
    archive: "Archiver la session réconciliée",
    receipt: "Preuve de garde",
    noUsage: "Non enregistré",
    language: "Language / Langue",
  },
};
const $ = (id) => document.getElementById(id),
  node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
const local = location.origin === "http://127.0.0.1:4318";
const expanded = new Set();
let data,
  lang = localStorage.getItem("factory-language") === "fr" ? "fr" : "en",
  request = 0,
  opener;
const w = () => words[lang],
  locale = () => (lang === "fr" ? "fr-CA" : "en-CA");
$("lang").value = lang;
$("controls").hidden = !local;
function duration(seconds) {
  const n = Math.max(0, Math.floor(seconds));
  if (n < 60) return w().less;
  if (n < 3600) return `${Math.floor(n / 60)} min`;
  return `${Math.floor(n / 3600)} h${n % 3600 >= 60 ? " " + Math.floor((n % 3600) / 60) + " min" : ""}`;
}
function age(at) {
  return duration((data.now - at) / 1000);
}
function technical(value) {
  const d = node("details", undefined, "technical");
  d.append(
    node("summary", w().technical),
    node("pre", JSON.stringify(value, null, 2)),
  );
  return d;
}
function button(title, fn) {
  const b = node("button", title);
  b.type = "button";
  b.onclick = fn;
  return b;
}
async function action(path, body) {
  if (!local) return;
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (sessionStorage.getItem("owner-token") || ""),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(w().unavailable);
  $("auth-result").textContent = w().recorded;
  await refresh();
}
function openSheet(title, label, content, source) {
  opener = source;
  $("sheet-title").textContent = title;
  $("sheet-label").textContent = label;
  $("sheet-body").replaceChildren(...content);
  $("close").textContent = w().close;
  $("sheet").showModal();
  $("close").focus();
}
function taskContent(item) {
  const t = w(),
    content = [node("p", item.purpose)],
    dl = node("dl");
  for (const [label, value] of [
    [t.owner, item.owner],
    [t.time, item.seconds === null ? t.noUsage : duration(item.seconds)],
    [
      t.tokens,
      item.tokens === null
        ? t.noUsage
        : new Intl.NumberFormat(locale(), {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(item.tokens),
    ],
  ])
    dl.append(node("dt", label), node("dd", value));
  content.push(dl);
  if (item.status) content.push(node("p", item.status));
  const links = node("div", undefined, "links");
  for (const [label, url] of [
    [t.issue, item.issue],
    [t.pr, item.pr],
  ])
    if (url) {
      const a = node("a", label);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.append(a);
    }
  content.push(links);
  const session = node("div", undefined, "session-value");
  const label = node("label", t.session);
  label.htmlFor = "native-session";
  session.append(label);
  if (item.session) {
    const input = node("input");
    input.id = "native-session";
    input.value = item.session;
    input.readOnly = true;
    const feedback = node("p", "", "quiet");
    feedback.setAttribute("role", "status");
    session.append(
      input,
      button(t.copy, async () => {
        try {
          await navigator.clipboard.writeText(item.session);
          feedback.textContent = t.copied;
        } catch {
          input.focus();
          input.select();
          feedback.textContent = t.select;
        }
      }),
      feedback,
    );
  } else session.append(node("p", t.noSession, "quiet"));
  content.push(session);
  if (local && item.technical.session && item.sessionStatus !== "archived") {
    const x = item.technical.session,
      controls = node("div");
    const feedback = node("p", "");
    feedback.setAttribute("role", "status");
    if (["starting", "running", "reserved"].includes(item.sessionStatus))
      controls.append(
        button(t.stop, async () => {
          try {
            await action("/api/stop", { id: x.id });
            feedback.textContent = t.recorded;
          } catch (e) {
            feedback.textContent = e.message;
          }
        }),
      );
    if (["unknown", "paused", "finished"].includes(item.sessionStatus)) {
      const f = node("form"),
        label = node("label", t.receipt),
        input = node("input"),
        b = node("button", t.archive);
      input.id = "receipt";
      label.htmlFor = "receipt";
      input.required = true;
      input.maxLength = 4000;
      b.type = "submit";
      f.append(label, input, b);
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await action("/api/archive", { id: x.id, receipt: input.value });
          $("sheet").close();
        } catch (e) {
          feedback.textContent = e.message;
        }
      };
      controls.append(f);
    }
    controls.append(feedback);
    content.push(controls);
  }
  content.push(technical(item.technical));
  return content;
}
function row(item, group) {
  const b = node(
    "button",
    undefined,
    `row ${group === "running" ? "running-row" : group === "questions" ? "question-row" : group === "releases" ? "release-row" : ""}`,
  );
  b.type = "button";
  b.dataset.key = item.id;
  const body = node("span", undefined, "row-content");
  body.append(node("span", item.title, "row-title"));
  if (group === "questions")
    body.append(node("span", item.defaultLine, "row-meta"));
  else if (group === "releases") {
    body.append(
      node("span", item.time, "release-time"),
      node("span", item.status, "row-meta"),
    );
  } else if (group === "running") {
    body.append(
      node(
        "span",
        `${item.owner} · ${item.started ? w().started(age(item.started)) : w().unavailable}`,
        "row-meta",
      ),
    );
    if (item.progress !== null) {
      const wrap = node("span", undefined, "progress-wrap"),
        p = node("progress");
      p.value = item.progress;
      p.max = 1;
      p.setAttribute(
        "aria-label",
        w().progress(duration(item.seconds), duration(item.estimateSeconds)),
      );
      const text =
        w().progress(duration(item.seconds), duration(item.estimateSeconds)) +
        (item.seconds > item.estimateSeconds ? ` · ${w().over}` : "");
      wrap.append(p, node("span", text, "progress-label"));
      body.append(wrap);
    }
  } else if (group !== "upNext") {
    body.append(
      node(
        "span",
        item.status + (item.at ? ` · ${w().ago(age(item.at))}` : ""),
        "row-meta",
      ),
    );
  }
  b.append(body, node("span", "›", "chevron"));
  b.lastChild.setAttribute("aria-hidden", "true");
  b.onclick = () => {
    if (group === "questions") {
      const content = [node("p", item.defaultLine)];
      if (item.task) content.push(...taskContent(item.task).slice(0, -1));
      if (local) {
        const f = node("form"),
          label = node("label", w().answer),
          input = node("input"),
          submit = node("button", w().send),
          result = node("p");
        input.id = "answer";
        input.required = true;
        input.maxLength = 4000;
        label.htmlFor = "answer";
        submit.type = "submit";
        result.setAttribute("role", "status");
        f.append(label, input, submit, result);
        f.onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await action("/api/answer", { id: item.id, answer: input.value });
            $("sheet").close();
          } catch (e) {
            result.textContent = e.message;
          }
        };
        content.push(f);
      } else content.push(node("p", w().localAnswer, "quiet"));
      content.push(technical(item.technical));
      openSheet(item.title, w().questionDetails, content, b);
    } else if (group === "releases")
      openSheet(
        item.title,
        w().releaseDetails,
        [node("p", `${item.time} · ${item.status}`), technical(item.technical)],
        b,
      );
    else openSheet(item.title, w().details, taskContent(item), b);
  };
  return b;
}
function render() {
  const t = w(),
    focused = document.activeElement?.dataset?.key;
  document.documentElement.lang = lang;
  document.title = lang === "fr" ? "Fabrique" : "Factory";
  $("today").textContent = t.today;
  $("skip").textContent = t.skip;
  $("status").textContent = data.status;
  $("control-title").textContent = t.controls;
  $("token-label").textContent = t.token;
  $("save").textContent = t.save;
  $("pause").textContent = data.paused ? t.resume : t.pause;
  $("refresh-note").textContent = t.refresh;
  const meters = [];
  for (const u of data.usage)
    meters.push(
      `${u.provider === "codex" ? t.weekly : t.claude} ${u.percent === null ? t.unavailable : u.percent + "%"}`,
    );
  const money = (n) =>
    new Intl.NumberFormat(locale(), {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n);
  meters.push(
    `AWS ${data.aws.dollars === null ? t.unavailable : money(data.aws.dollars)} / ${money(data.aws.ceiling)}`,
  );
  if (data.aws.stopped) meters.push(t.awsStopped);
  meters.push(
    `${t.next} ${data.nextRelease.name} ${data.nextRelease.time}${data.nextRelease.tomorrow ? " · " + t.tomorrow : ""}`,
  );
  $("meters").replaceChildren(...meters.map((text) => node("span", text)));
  $("connection").hidden = !data.notice;
  $("connection").textContent = data.notice || "";
  for (const key of [
    "questions",
    "running",
    "upNext",
    "waiting",
    "done",
    "releases",
  ]) {
    const heading = $(key + "-title");
    heading.firstChild.textContent = t[key] + " ";
    const rows = data[key];
    const collapsible = ["waiting", "done"].includes(key) && rows.length > 6;
    const visible = collapsible && !expanded.has(key) ? rows.slice(0, 6) : rows;
    $(key).replaceChildren(...visible.map((item) => row(item, key)));
    if (collapsible) {
      const toggle = button(
        expanded.has(key) ? t.showFewer : t.showAll(rows.length),
        () => {
          expanded.has(key) ? expanded.delete(key) : expanded.add(key);
          render();
          document
            .querySelector(`[data-key="toggle-${key}"]`)
            ?.focus({ preventScroll: true });
        },
      );
      toggle.dataset.key = `toggle-${key}`;
      toggle.setAttribute("aria-expanded", String(expanded.has(key)));
      $(key).append(toggle);
    }
    if (!rows.length)
      $(key).append(
        node(
          "p",
          t[
            {
              questions: "nothing",
              running: "noRunning",
              upNext: "noQueue",
              waiting: "noWaiting",
              done: "noDone",
            }[key]
          ],
          "quiet",
        ),
      );
    if ($(key + "-count"))
      $(key + "-count").textContent =
        key === "upNext" ? data.counts.upNext : rows.length || "";
  }
  $("done-note").textContent = t.doneNote;
  $("releases-note").textContent = t.releasesNote;
  $("more").hidden = !data.more;
  $("more").textContent = t.more(data.more);
  $("updated").textContent = t.updated(
    new Date(data.now).toLocaleTimeString(locale(), {
      hour: "numeric",
      minute: "2-digit",
    }),
  );
  if (focused)
    Array.from(document.querySelectorAll("[data-key]"))
      .find((el) => el.dataset.key === focused)
      ?.focus({ preventScroll: true });
}
async function refresh() {
  const serial = ++request;
  try {
    const response = await fetch("/api/board?lang=" + lang);
    if (!response.ok) throw Error();
    const next = await response.json();
    if (serial !== request) return;
    data = next;
    render();
  } catch {
    if (serial !== request) return;
    $("connection").hidden = false;
    $("connection").textContent = data ? w().error : w().loadingError;
  }
}
$("close").onclick = () => $("sheet").close();
$("sheet").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const targets = Array.from(
    $("sheet").querySelectorAll("button, a[href], input, summary"),
  ).filter((el) => !el.disabled && el.getClientRects().length);
  const first = targets[0],
    last = targets.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});
$("sheet").addEventListener("close", () => {
  if (opener) {
    const current = Array.from(document.querySelectorAll("[data-key]")).find(
      (el) => el.dataset.key === opener.dataset.key,
    );
    (current || $("lang")).focus({ preventScroll: true });
  }
});
$("sheet").addEventListener("click", (event) => {
  if (event.target === $("sheet")) {
    const rect = $("sheet").getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $("sheet").close();
  }
});
$("lang").onchange = () => {
  lang = $("lang").value;
  localStorage.setItem("factory-language", lang);
  refresh();
};
$("auth").onsubmit = (event) => {
  event.preventDefault();
  if (!local) return;
  sessionStorage.setItem("owner-token", $("token").value);
  $("token").value = "";
  $("auth-result").textContent = w().saved;
};
$("pause").onclick = async () => {
  try {
    await action("/api/pause", { paused: !data.paused });
  } catch (e) {
    $("auth-result").textContent = e.message;
  }
};
refresh();
setInterval(refresh, 15000);
