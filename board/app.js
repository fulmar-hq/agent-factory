
(function () {
  'use strict';

  /* ---------- Words ---------- */
  var STR = {
    en: {
      updated: 'Updated {t}', fOver: '{n} over', fQuiet: '{n} quiet', fFix: '{n} need a fix', noAct: 'No activity for {d}', high: 'High', atLimit: 'At limit', legend: 'What the colours mean', lgOk: 'Moving', lgInfo: 'Waiting', lgWarn: 'Attention', lgBad: 'Stopped', lgRest: 'Inactive', idleShort: 'Nothing is running. 12 tasks are ready.', flowLabel: 'Flow', fRunning: 'Running', f48: '48 h',
      usedOf: '{u} of about {d}', overLine: '{u}, past its {d} estimate', lastAct: 'Last activity {d} ago', ownerRun: 'Owner run',
      doneTitle: 'Recently completed', doneSum: '{n} done in 48 h · typical task {d} · {o} ran over', tookLine: 'took {u} · expected {d}',
      todayAt: 'Today, {t}', started: 'Started', finished: 'Finished', took: 'Took', expected: 'Expected',
      working: 'Working', workingSoft: '6 tasks running', workingLede: 'The last task finished 14 min ago.',
      idle: 'Idle', idleSoft: 'for 1 h 16 min', idleLede: 'Nothing is running, and 12 tasks are ready to start.',
      needs: 'Needs you', needsSoft: '1 question', needsLede: 'The 6 running tasks carry on while you decide.',
      paused: 'Paused', pausedSoft: 'by you', pausedLede: 'Since {t}. Nothing new starts until you resume.',
      resume: 'Resume',
      codex: 'Codex this week', claude: 'Claude this week', aws: 'AWS this month', nextRelease: 'Next release',
      resets: 'Resets {d} {t}', wed: 'Wed', fri: 'Fri', sat: 'Sat',
      of: 'of', awsStopped: 'AWS stopped', awsOnTonight: 'Turns on at {t} tonight', awsStays: 'Stays off tonight', awsPending: 'Waiting for your answer',
      test: 'test', live: 'live', today: 'Today',
      needsYou: 'Needs you', nothingNeeds: 'Nothing needs you.',
      askEyebrow: '1 question',
      askTitle: 'Turn AWS on for tonight’s release?',
      askCtx: 'AWS is off to save money, and tonight’s release can’t run without it.',
      stayOff: 'Stay off', onTonight: 'On for tonight · about $1.50',
      askDefault: 'If you don’t answer by {t}: stays off',
      choseOff: 'You chose to keep AWS off tonight.', choseOn: 'You chose AWS on for tonight.', change: 'Change',
      running: 'Running now', nothingRunning: 'Nothing is running.', nothingRunningPaused: 'Nothing runs while paused.',
      ofAbout: 'of about {d}', over: 'past its {d} estimate',
      upNext: 'Up next', moreN: '+{n} more', showLess: 'Show fewer',
      waiting: 'Waiting', gChecks: 'Checks running', gRelease: 'Tonight’s release', gFix: 'Needs a fix',
      andMore: 'and {n} more',
      done: 'Done', last48: 'last 48 hours', showAll: 'Show all {n}', sampleNote: 'This mockup holds {a} of the {n} sample rows.',
      oLive: 'Live', oTest: 'On test site', oClosed: 'Closed',
      ago: '{d} ago', yesterday: 'Yesterday, {t}', dayAt: '{d}, {t}',
      tonight: 'Tonight', testRelease: 'Test release', liveRelease: 'Live release',
      testDesc: 'Today’s work goes to the test site and gets checked.', liveDesc: 'The same tested version goes live.',
      sScheduled: 'Scheduled', sSkippedAws: 'Skipped: AWS is off', sPassed: 'Passed', sFailed: 'Failed', sSkippedFail: 'Skipped: test release failed', sPending: 'Waiting for your answer',
      owner: 'Owner', timeUsed: 'Time used', status: 'Status', estimate: 'Estimate',
      viewWork: 'View the work', tech: 'Technical details', close: 'Close',
      stRunning: 'Running now', stNext: 'Up next, number {n}', stWaiting: 'Waiting: {g}',
      notStarted: 'Not started',
      tIssue: 'Issue', tBranch: 'Branch', tPr: 'Pull request', tCommit: 'Commit', tChecks: 'Checks',
      Product: 'Product', Platform: 'Platform', Release: 'Release', Quality: 'Quality',
      mockTitle: 'Mockup states', mockNote: 'For review only. This box is not part of the real page.',
      mockDesk: 'Desk', mWorking: 'Working', mIdle: 'Idle', mNeeds: 'Needs you', mPaused: 'Paused',
      mockTonight: 'Tonight’s release', mSched: 'Scheduled', mSkip: 'Skipped', mPass: 'Passed', mFail: 'Failed',
      dRunning: 'The factory is working on this right now. When it finishes, it joins tonight’s release.',
      dNext: 'This is ready and starts as soon as a worker is free. Nothing is needed from you.',
      dChecks: 'The work is finished and automatic checks are running on it. If they pass, it joins tonight’s release.',
      dRelease: 'This is finished and checked. It goes to the test site at 8:00 PM and live at 9:30 PM.',
      dFix: 'A check found a problem with this work. The owner is fixing it before it can be released.',
      dLive: 'This is finished and customers have it now. It went out with the live release.',
      dTest: 'This is finished and on the test site. It has not gone live yet.',
      dClosed: 'This was finished without needing a release. Nothing changed for customers.'
    },
    fr: {
      updated: 'Mis à jour à {t}', fOver: '{n} en retard', fQuiet: '{n} sans activité', fFix: '{n} à corriger', noAct: 'Aucune activité depuis {d}', high: 'Élevé', atLimit: 'À la limite', legend: 'Ce que signifient les couleurs', lgOk: 'En marche', lgInfo: 'En attente', lgWarn: 'Attention', lgBad: 'Arrêté', lgRest: 'Inactif', idleShort: 'Rien n’est en cours. 12 tâches sont prêtes.', flowLabel: 'Parcours', fRunning: 'En cours', f48: '48 h',
      usedOf: '{u} sur environ {d}', overLine: '{u}, estimation de {d} dépassée', lastAct: 'Actif il y a {d}', ownerRun: 'Routine',
      doneTitle: 'Terminé récemment', doneSum: '{n} terminées en 48 h · tâche type {d} · {o} en dépassement', tookLine: 'a pris {u} · prévu {d}',
      todayAt: 'Aujourd’hui, {t}', started: 'Début', finished: 'Fin', took: 'Durée', expected: 'Prévu',
      working: 'En marche', workingSoft: '6 tâches en cours', workingLede: 'La dernière tâche s’est terminée il y a 14 min.',
      idle: 'Inactif', idleSoft: 'depuis 1 h 16 min', idleLede: 'Rien n’est en cours, et 12 tâches sont prêtes à démarrer.',
      needs: 'Besoin de vous', needsSoft: '1 question', needsLede: 'Les 6 tâches en cours continuent pendant que vous décidez.',
      paused: 'En pause', pausedSoft: 'à votre demande', pausedLede: 'Depuis {t}. Rien de nouveau ne démarre avant la reprise.',
      resume: 'Reprendre',
      codex: 'Codex cette semaine', claude: 'Claude cette semaine', aws: 'AWS ce mois-ci', nextRelease: 'Prochaine mise en ligne',
      resets: 'Remise à zéro {d} {t}', wed: 'mer.', fri: 'ven.', sat: 'sam.',
      of: 'sur', awsStopped: 'AWS arrêté', awsOnTonight: 'S’allume à {t} ce soir', awsStays: 'Reste éteint ce soir', awsPending: 'En attente de votre réponse',
      test: 'test', live: 'en ligne', today: 'Aujourd’hui',
      needsYou: 'Besoin de vous', nothingNeeds: 'Rien n’a besoin de vous.',
      askEyebrow: '1 question',
      askTitle: 'Allumer AWS pour la mise en ligne de ce soir ?',
      askCtx: 'AWS est éteint pour économiser, et la mise en ligne de ce soir ne peut pas se faire sans lui.',
      stayOff: 'Laisser éteint', onTonight: 'Allumer ce soir · environ 1,50 $',
      askDefault: 'Sans réponse avant {t} : reste éteint',
      choseOff: 'Vous avez choisi de laisser AWS éteint ce soir.', choseOn: 'Vous avez choisi d’allumer AWS ce soir.', change: 'Modifier',
      running: 'En cours', nothingRunning: 'Rien n’est en cours.', nothingRunningPaused: 'Rien ne tourne pendant la pause.',
      ofAbout: 'sur environ {d}', over: 'dépasse l’estimation de {d}',
      upNext: 'À venir', moreN: '+{n} autres', showLess: 'En montrer moins',
      waiting: 'En attente', gChecks: 'Vérifications en cours', gRelease: 'Mise en ligne de ce soir', gFix: 'À corriger',
      andMore: 'et {n} autres',
      done: 'Terminé', last48: '48 dernières heures', showAll: 'Tout afficher ({n})', sampleNote: 'Cette maquette contient {a} des {n} lignes d’exemple.',
      oLive: 'En ligne', oTest: 'Sur le site de test', oClosed: 'Fermé',
      ago: 'il y a {d}', yesterday: 'Hier, {t}', dayAt: '{d}, {t}',
      tonight: 'Ce soir', testRelease: 'Mise en test', liveRelease: 'Mise en ligne',
      testDesc: 'Le travail du jour va sur le site de test et y est vérifié.', liveDesc: 'La même version testée passe en ligne.',
      sScheduled: 'Prévue', sSkippedAws: 'Annulée : AWS est éteint', sPassed: 'Réussie', sFailed: 'Échouée', sSkippedFail: 'Annulée : la mise en test a échoué', sPending: 'En attente de votre réponse',
      owner: 'Responsable', timeUsed: 'Temps utilisé', status: 'État', estimate: 'Estimation',
      viewWork: 'Voir le travail', tech: 'Détails techniques', close: 'Fermer',
      stRunning: 'En cours', stNext: 'À venir, numéro {n}', stWaiting: 'En attente : {g}',
      notStarted: 'Pas commencé',
      tIssue: 'Ticket', tBranch: 'Branche', tPr: 'Demande de fusion', tCommit: 'Commit', tChecks: 'Vérifications',
      Product: 'Produit', Platform: 'Plateforme', Release: 'Livraison', Quality: 'Qualité',
      mockTitle: 'États de la maquette', mockNote: 'Pour la revue seulement. Cette boîte ne fait pas partie de la vraie page.',
      mockDesk: 'Tableau', mWorking: 'En marche', mIdle: 'Inactif', mNeeds: 'Besoin de vous', mPaused: 'En pause',
      mockTonight: 'Mise en ligne de ce soir', mSched: 'Prévue', mSkip: 'Annulée', mPass: 'Réussie', mFail: 'Échouée',
      dRunning: 'L’usine y travaille en ce moment. Une fois terminée, la tâche rejoint la mise en ligne de ce soir.',
      dNext: 'La tâche est prête et démarre dès qu’une place se libère. Rien n’est attendu de vous.',
      dChecks: 'Le travail est terminé et les vérifications automatiques tournent. Si elles passent, il rejoint la mise en ligne de ce soir.',
      dRelease: 'C’est terminé et vérifié. Mise en test à 20 h 00, puis en ligne à 21 h 30.',
      dFix: 'Une vérification a trouvé un problème. Le responsable le corrige avant la mise en ligne.',
      dLive: 'C’est terminé et les clients l’ont maintenant. C’est parti avec la mise en ligne.',
      dTest: 'C’est terminé et sur le site de test. Ce n’est pas encore en ligne.',
      dClosed: 'Terminé sans mise en ligne nécessaire. Rien n’a changé pour les clients.'
    }
  };

  var RUNNING = [], NEXT = [], WAITING = [], DONE = [], DONE_TOTAL = 0, ITEMS = {}, data;
  var S = { hl: null, lang: 'en', mode: 'working', open: {}, moreNext: false, allDone: false, sheet: null };
  try { var saved = localStorage.getItem('fd-lang'); if (saved === 'fr' || saved === 'en') S.lang = saved; } catch (e) {}
  var local = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]';
  var request = 0;
  /* ---------- Helpers ---------- */
  function t(key, vars) {
    var s = (STR[S.lang][key] !== undefined) ? STR[S.lang][key] : (STR.en[key] !== undefined ? STR.en[key] : key);
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function clock(h, m) {
    var mm = (m < 10 ? '0' : '') + m;
    if (S.lang === 'fr') return h + ' h ' + mm;
    return ((h % 12) || 12) + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function dur(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function when(w) {
    if (w.ago !== undefined) return t('ago', { d: dur(w.ago) });
    if (w.y) return t('yesterday', { t: clock(w.y[0], w.y[1]) });
    return t('dayAt', { d: t(w.day).replace(/^./, function (c) { return c.toUpperCase(); }), t: clock(w.at[0], w.at[1]) });
  }
  function title(x) { return esc(S.lang === 'fr' && x.fr ? x.fr : x.t); }
  function money(n) {
    if (S.lang === 'fr') return String(n).replace('.', ',') + ' $';
    return '$' + n;
  }
  var CHEV = '<svg class="chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var OUT = { live: ['oLive', 'good'], test: ['oTest', 'info'], closed: ['oClosed', 'quiet'] };

  function heroMode() { return data.hero.mode; }
  function runCount() { return RUNNING.length; }
  var ARROW = '<svg class="flow-arrow" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function bar(pct, tone) { return '<span class="track" aria-hidden="true"><progress max="100" value="' + Math.max(0, Math.min(100, pct || 0)) + '" class="' + (tone || 'rest') + '"></progress></span>'; }
  function pillTone(tone) { return {ok:'good',info:'info',warn:'warn',bad:'bad',rest:'quiet'}[tone] || 'quiet'; }
  function localTime(at, date) {
    if (!at) return '—';
    var d = new Date(at), c = clock(d.getHours(), d.getMinutes());
    return date ? new Intl.DateTimeFormat(S.lang === 'fr' ? 'fr-CA' : 'en-CA', {month:'short',day:'numeric'}).format(at) + ', ' + c : c;
  }
  function band() {
    var m = heroMode(), dot = m === 'working' ? 'is-working' : (m === 'needs' ? 'is-warn' : '');
    function meter(label, value, pct, sub, tone) {
      return '<div class="meter"><div class="meter-label">' + esc(t(label)) + '</div><div class="meter-value num">' + value + '</div>' +
        (pct === null ? '' : bar(pct, tone)) + '<div class="meter-sub num">' + sub + '</div></div>';
    }
    var meters = data.usage.map(function (u) {
      var reset = u.resetsAt ? new Intl.DateTimeFormat(S.lang === 'fr' ? 'fr-CA' : 'en-CA', { weekday: 'short' }).format(u.resetsAt) : '';
      return meter(u.provider, u.percent === null ? '—' : u.percent + ' %', u.percent === null ? 0 : u.percent,
        (u.tone === 'warn' || u.tone === 'bad' ? '<span class="pill ' + pillTone(u.tone) + '">' + esc(t(u.tone === 'bad' ? 'atLimit' : 'high')) + '</span>' : '') + esc(u.percent === null ? t('notAvailable') : t('resets', { d: reset, t: localTime(u.resetsAt) })), u.tone);
    }).join('');
    return '<section class="band"><div class="status" aria-live="polite"><h1><span class="dot ' + dot + '" aria-hidden="true"></span>' + esc(data.hero.title) +
      ' <span class="soft">' + esc(data.hero.soft) + '</span></h1><div class="status-line"><p class="lede">' + esc(data.questions.length ? data.hero.lede : t('nothingNeeds')) + '</p></div></div><div class="meters">' + meters +
      meter('aws', (data.aws.dollars === null ? '—' : money(data.aws.dollars.toFixed(2))) + ' <span class="unit">' + esc(t('of')) + ' ' + money(data.aws.ceiling) + '</span>', data.aws.dollars === null ? 0 : data.aws.dollars / data.aws.ceiling * 100,
        data.aws.stopped ? '<span class="pill bad">' + esc(t('awsStopped')) + '</span>' : esc(data.aws.dollars === null ? t('notAvailable') : t('today')), data.aws.tone) +
      meter('nextRelease', localTime(data.nextRelease.at) + ' <span class="unit">' + esc(t(data.nextRelease.name === 'QA' ? 'test' : 'live')) + '</span>', null,
        localTime(data.nextLiveAt) + ' ' + esc(t('live'))) + '</div></section>';
  }
  function tonight() {
    return '<section class="tstrip" aria-label="' + esc(t('tonight')) + '"><span class="tstrip-label">' + esc(t('tonight')) + '</span><div class="tsteps">' +
      data.releases.map(function (r, i) { return (i ? ARROW.replace('flow-arrow', 't-arrow') : '') + '<div class="tstep"><span class="t-time num">' + localTime(r.at) + '</span><span class="t-name">' + esc(t(i ? 'liveRelease' : 'testRelease')) + '</span><span class="pill ' + pillTone(r.tone) + '">' + esc(r.label) + '</span></div>'; }).join('') + '</div></section>';
  }
  function flow() {
    var total = WAITING.reduce(function (a, g) { return a + g.total; }, 0);
    var over = RUNNING.filter(function(x){return x.over;}).length;
    var quiet = RUNNING.filter(function(x){return x.quiet;}).length;
    var fix = data.waiting.filter(function(x){return x.waitGroup === 'fix';}).length;
    function cell(k, n, label, tone, lines, calm) {
      return '<button type="button" class="flow-cell" data-act="flow" data-v="' + k + '" data-k="flow-' + k + '" aria-pressed="' + (S.hl === k) + '">' +
        '<span class="flow-n num"><span class="sdot ' + tone + '" aria-hidden="true"></span>' + n + '</span><span class="flow-l">' + esc(t(label)) + '</span>' + (lines || []).map(function(line){return '<span class="flow-t num' + (calm ? ' calm' : '') + '">' + esc(line) + '</span>';}).join('') + '</button>';
    }
    return '<nav class="flow" aria-label="' + esc(t('flowLabel')) + '">' +
      cell('next', data.counts.upNext, 'upNext', 'rest') + ARROW + cell('running', runCount(), 'fRunning', runCount() ? 'ok' : 'rest', [over ? t('fOver',{n:over}) : '',quiet ? t('fQuiet',{n:quiet}) : ''].filter(Boolean)) + ARROW +
      cell('waiting', total, 'waiting', 'info', fix ? [t('fFix',{n:fix})] : []) + ARROW + cell('done', DONE_TOTAL, 'done', 'ok', [t('f48')], true) + '</nav>';
  }

  function hasAsk() { return data.questions.length > 0; }
  function needs() {
    return data.questions.map(function (q, i) {
      ITEMS['q' + i] = Object.assign({ kind: 'question' }, q);
      return '<section class="ask" aria-label="' + esc(t('needsYou')) + '"><div class="ask-text"><h2><button type="button" data-act="open" data-v="q' + i + '" data-k="q' + i + '">' + esc(q.title) + '</button></h2><p class="ctx">' + esc(q.context) + '</p></div><div class="ask-side"><div class="ask-choices">' +
        q.choices.map(function (c, ci) { return '<button type="button" class="btn' + (ci ? ' primary' : '') + '" data-act="answer" data-v="' + i + ':' + ci + '" data-k="answer-' + i + '-' + ci + '">' + esc(c.label) + '</button>'; }).join('') +
        '</div><p class="ask-default">' + esc(q.defaultLine) + '</p></div></section>';
    }).join('');
  }
  function col(key, head, count, body, tone) {
    return '<section class="col' + (S.hl === key ? ' hl' : '') + '" id="col-' + key + '">' +
      '<div class="sec-head"><h2 id="h-' + key + '" tabindex="-1"><span class="sdot ' + (tone || 'rest') + '" aria-hidden="true"></span>' + esc(t(head)) + '</h2>' + count + '</div>' +
      '<div class="col-body" data-scroll="' + key + '">' + body + '</div></section>';
  }

  function running() {
    var n = runCount(), body;
    if (!n) {
      body = '<p class="quiet-line">' + esc(t(S.mode === 'paused' ? 'nothingRunningPaused' : 'nothingRunning')) + '</p>';
    } else {
      body = '<ul class="rows">' + RUNNING.map(function (x) {
        var over = x.over;
        var pct = Math.min(100, Math.round(x.estimateSeconds ? x.seconds / x.estimateSeconds * 100 : 0));
        return '<li><button type="button" class="row run" data-act="open" data-v="' + x.id + '" data-k="' + x.id + '">' +
          '<span class="row-top"><span class="row-title">' + title(x) + '</span><span class="chips">' +
            (x.run ? '<span class="chip line">' + esc(t('ownerRun')) + '</span>' : '') + '<span class="chip">' + esc(t(x.o)) + '</span></span></span>' +
          bar(pct, x.barTone) +
          '<span class="row-foot"><span class="est num' + (over ? ' over' : '') + '">' +
            esc(t(over ? 'overLine' : 'usedOf', { u: dur(x.used), d: x.est === null ? '—' : dur(x.est) })) + '</span>' +
            '<span class="act num' + (x.quiet ? ' quiet' : '') + '">' + esc(x.act === null ? t('notAvailable') : t(x.quiet ? 'noAct' : 'lastAct', { d: dur(x.act) })) + '</span></span>' +
          '</button></li>';
      }).join('') + '</ul>';
    }
    return col('running', 'running', '<span class="count num">' + n + '</span>', body, n ? 'ok' : 'rest');
  }

  function upNext() {
    var body = '<ol class="rows' + (S.moreNext ? '' : ' clip') + '">' + NEXT.map(function (x, i) {
        return '<li' + (i >= 5 ? ' class="extra"' : '') + '><button type="button" class="row next" data-act="open" data-v="' + x.id + '" data-k="' + x.id + '">' +
          '<span class="pos num" aria-hidden="true">' + x.pos + '</span><span class="row-title">' + title(x) + '</span></button></li>';
      }).join('') + '</ol>' +
      (data.counts.upNext > 5 ? '<button type="button" class="more small-only" data-act="moreNext" data-k="moreNext" aria-expanded="' + S.moreNext + '">' +
        esc(S.moreNext ? t('showLess') : t('moreN', { n: data.counts.upNext - 5 })) + '</button>' : '');
    return col('next', 'upNext', '<span class="count num">' + data.counts.upNext + '</span>', body);
  }

  function waiting() {
    var total = WAITING.reduce(function (a, g) { return a + g.total; }, 0);
    var body = '<ul class="groups">' + WAITING.map(function (g) {
        var open = !!S.open[g.k];
        var rest = g.total - g.items.length;
        return '<li class="group' + (open ? ' open' : '') + '"><button type="button" class="group-btn" data-act="group" data-v="' + g.k + '" data-k="g-' + g.k + '" aria-expanded="' + open + '" aria-controls="gb-' + g.k + '">' +
          '<span class="group-name"><span class="sdot ' + (g.k === 'fix' ? 'warn' : 'info') + '" aria-hidden="true"></span>' + esc(t(g.label)) + '<span class="count num">' + g.total + '</span></span>' + CHEV + '</button>' +
          '<div class="group-body" id="gb-' + g.k + '"><ul class="rows">' +
          g.items.map(function (x) {
            return '<li class="g-item"><button type="button" class="row" data-act="open" data-v="' + x.id + '" data-k="' + x.id + '"><span class="row-title">' + title(x) + '</span></button></li>';
          }).join('') + '</ul>' +
          (g.total > 3 ? '<button type="button" class="more g-more" data-act="group" data-v="' + g.k + '" data-k="gm-' + g.k + '">' + esc(t('moreN', { n: g.total - 3 })) + '</button>' : '') +
          (rest > 0 ? '<p class="note">' + esc(t('andMore', { n: rest })) + '</p>' : '') +
          '</div></li>';
      }).join('') + '</ul>';
    return col('waiting', 'waiting', '<span class="count num">' + total + '</span>', body, 'info');
  }

  function done() {
    var body = '<p class="summary num">' + esc(t('doneSum', { n: DONE_TOTAL, d: data.completed.medianSeconds === null ? '—' : dur(Math.round(data.completed.medianSeconds / 60)), o: data.completed.over })) + '</p>' +
      '<ul class="rows' + (S.allDone ? '' : ' clip') + '">' + DONE.map(function (x, i) {
        var o = OUT[x.out], over = x.over;
        var pct = Math.min(100, Math.round(x.estimateSeconds ? x.seconds / x.estimateSeconds * 100 : 0));
        return '<li' + (i >= 5 ? ' class="extra"' : '') + '><button type="button" class="row flat" data-act="open" data-v="' + x.id + '" data-k="' + x.id + '">' +
          '<span class="row-title">' + title(x) + '</span>' +
          '<span class="trail"><span class="pill ' + o[1] + '">' + esc(t(o[0])) + '</span><span class="when num">' + when(x.w) + '</span></span>' +
          '<span class="took">' + bar(pct, x.barTone) + '' +
          '<span class="est num' + (over ? ' over' : '') + '">' + esc(t('tookLine', { u: x.seconds === null ? '—' : dur(x.used), d: x.est === null ? '—' : dur(x.est) })) + '</span></span>' +
          '</button></li>';
      }).join('') + '</ul>' +
      (S.allDone || DONE_TOTAL <= 5 ? '' : '<button type="button" class="more small-only" data-act="allDone" data-k="allDone">' + esc(t('showAll', { n: DONE_TOTAL })) + '</button>');
    return col('done', 'doneTitle', '<span class="count num">' + DONE_TOTAL + '</span>', body, 'ok');
  }

  function doneFacts(x) {
    function f(k, v, cls) { return '<div><dt>' + esc(t(k)) + '</dt><dd class="num' + (cls || '') + '">' + esc(v) + '</dd></div>'; }
    return f('started', localTime(x.started, true)) + f('finished', localTime(x.at, true)) +
      f('took', x.seconds === null ? '—' : dur(x.used), x.over ? ' over' : '') + f('expected', x.est === null ? '—' : dur(x.est));
  }
  function technical(x) {
    var fields = x.technical || {};
    return '<details class="tech"><summary>' + esc(t('tech')) + CHEV + '</summary><dl>' + Object.keys(fields).map(function (k) {
      return '<div><dt>' + esc(t(k)) + '</dt><dd>' + esc(fields[k]) + '</dd></div>';
    }).join('') + '</dl></details>';
  }
  function sheetHtml(x) {
    if (x.kind === 'question') return '<h2 id="sheet-title" tabindex="-1">' + esc(x.title) + '</h2><p class="sheet-desc">' + esc(x.context) + '</p><p class="summary">' + esc(x.defaultLine) + '</p>' + technical(x);
    var status = x.kind === 'done' ? t(OUT[x.out][0]) : x.kind === 'running' ? t('stRunning') : x.kind === 'next' ? t('stNext', {n:x.pos}) : x.status;
    return '<h2 id="sheet-title" tabindex="-1">' + title(x) + '</h2><div class="sheet-status"><span class="pill ' + pillTone(x.tone) + '">' + esc(status) + '</span>' + (x.run ? '<span class="chip line">' + esc(t('ownerRun')) + '</span>' : '') + '</div>' +
      '<p class="sheet-desc">' + esc(x.d) + '</p><dl class="facts"><div><dt>' + esc(t('owner')) + '</dt><dd>' + esc(x.o) + '</dd></div>' +
      (x.kind === 'done' ? doneFacts(x) : '<div><dt>' + esc(t('timeUsed')) + '</dt><dd>' + (x.started ? esc(t('usedOf', {u:dur(x.used),d:x.est === null ? '—' : dur(x.est)})) : esc(t('notStarted'))) + '</dd></div>') + '</dl>' +
      (x.pr || x.issue ? '<a class="btn" href="' + esc(x.pr || x.issue) + '" target="_blank" rel="noopener noreferrer">' + esc(t('viewWork')) + '</a>' : '') + technical(x);
  }
  var sheet = document.getElementById('sheet'), scrim = document.getElementById('scrim'), sheetBody = document.getElementById('sheet-body');
  var closeBtn = document.getElementById('sheet-close'), returnKey = null;
  function openSheet(id) {
    S.sheet = id; returnKey = id;
    sheetBody.innerHTML = sheetHtml(ITEMS[id]);
    sheetBody.scrollTop = 0;
    sheet.removeAttribute('inert');
    sheet.classList.add('open'); scrim.classList.add('open');
    document.querySelector('.wrap').setAttribute('inert', ''); document.body.classList.add('sheet-open');
    var h = document.getElementById('sheet-title'); if (h) h.focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!S.sheet) return;
    S.sheet = null;
    sheet.classList.remove('open'); scrim.classList.remove('open');
    sheet.setAttribute('inert', '');
    document.querySelector('.wrap').removeAttribute('inert'); document.body.classList.remove('sheet-open');
    var back = returnKey && Array.from(document.querySelectorAll('[data-k]')).find(function (el) { return el.dataset.k === returnKey; });
    (back || document.getElementById('lang-' + S.lang)).focus({ preventScroll: true });
  }
  closeBtn.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) {
    if (!S.sheet) return;
    if (e.key === 'Escape') { closeSheet(); return; }
    if (e.key === 'Tab') {
      var f = sheet.querySelectorAll('button, a[href], summary');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement) || document.activeElement.id === 'sheet-title')) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  sheetBody.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="noop"]')) e.preventDefault();
  });

  /* ---------- Render and events ---------- */
  var app = document.getElementById('app');
  function render(focusKey) {
    document.documentElement.lang = S.lang;
    document.getElementById('updated').textContent = t('updated', { t: localTime(data.now) });
    document.getElementById('lang-en').setAttribute('aria-pressed', S.lang === 'en');
    document.getElementById('lang-fr').setAttribute('aria-pressed', S.lang === 'fr');
    closeBtn.setAttribute('aria-label', t('close'));
    var keep = {};
    app.querySelectorAll('[data-scroll]').forEach(function (el) { keep[el.getAttribute('data-scroll')] = el.scrollTop; });
    app.innerHTML = band() + '<div class="mid">' + tonight() + flow() + '</div>' + needs() +
      '<div class="board' + (hasAsk() ? ' with-ask' : '') + '">' + (wide.matches ? upNext() + running() : running() + upNext()) + waiting() + done() + '</div>';
    app.querySelectorAll('[data-scroll]').forEach(function (el) { el.scrollTop = keep[el.getAttribute('data-scroll')] || 0; });
    document.getElementById('legend-sum').innerHTML = esc(t('legend')) + CHEV;
    document.getElementById('legend-list').innerHTML = [['ok','lgOk'],['info','lgInfo'],['warn','lgWarn'],['bad','lgBad'],['rest','lgRest']].map(function(l){return '<li><span class="sdot ' + l[0] + '" aria-hidden="true"></span>' + esc(t(l[1])) + '</li>';}).join('');
    if (S.sheet && !ITEMS[S.sheet]) closeSheet();
    if (focusKey) { var el = Array.from(document.querySelectorAll('[data-k]')).find(function (node) { return node.dataset.k === focusKey; }); if (el) el.focus({ preventScroll: true }); }
  }

  var wide = window.matchMedia('(min-width: 1100px)');
  wide.addEventListener('change', function () { if (data) render(); });
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  async function onAct(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act'), v = b.getAttribute('data-v'), k = b.getAttribute('data-k');
    if (act === 'open') { openSheet(v); return; }
    if (act === 'flow') {
      S.hl = (wide.matches && S.hl === v) ? null : v;
      render(k);
      if (!wide.matches) {
        var target = document.getElementById('col-' + v);
        if (target) target.scrollIntoView({ block: 'start', behavior: calm.matches ? 'auto' : 'smooth' });
      }
      return;
    }
    if (act === 'answer') {
      var parts = v.split(':'), q = data.questions[Number(parts[0])];
      try { await action('/api/answer', {id:q.id,answer:q.choices[Number(parts[1])].value}); } catch (err) { showError(err.message); }
      return;
    }
    if (act === 'group') { S.open[v] = !S.open[v]; k = 'g-' + v; }
    else if (act === 'moreNext') { S.moreNext = !S.moreNext; await refresh(k); return; }
    else if (act === 'allDone') { S.allDone = true; k = 'd5'; }
    else return;
    render(k);
  }
  app.addEventListener('click', onAct);
  document.getElementById('lang').addEventListener('click', function (e) {
    var b = e.target.closest('[data-lang]'); if (!b) return;
    S.lang = b.getAttribute('data-lang');
    try { localStorage.setItem('fd-lang', S.lang); } catch (err) {}
    refresh();
  });

  STR.en.notAvailable = 'not available'; STR.fr.notAvailable = 'non disponible';
  STR.en.gReview = 'Review'; STR.fr.gReview = 'Révision';
  STR.en.localControls = 'Local controls'; STR.fr.localControls = 'Commandes locales';
  STR.en.ownerToken = 'Owner token'; STR.fr.ownerToken = 'Jeton du propriétaire';
  STR.en.useToken = 'Use token'; STR.fr.useToken = 'Utiliser le jeton';
  STR.en.pause = 'Pause'; STR.fr.pause = 'Mettre en pause';
  STR.en.details = 'Details'; STR.fr.details = 'Détails';
  STR.en.session = 'Session'; STR.fr.session = 'Session';
  function showError(message) { var el = document.getElementById('connection'); el.hidden = false; el.textContent = message; }
  async function action(path, body) {
    if (!local) throw Error(S.lang === 'fr' ? 'Ouvrez le tableau sur le Mini pour répondre.' : 'Open the board on the Mini to answer.');
    var response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer ' + (sessionStorage.getItem('owner-token') || '')}, body:JSON.stringify(body) });
    if (!response.ok) throw Error(S.lang === 'fr' ? 'Ajoutez votre jeton dans les commandes locales.' : 'Add your owner token in Local controls.');
    await refresh();
  }
  function prepare(item, kind, i) {
    var x = Object.assign({}, item, { id:kind + ':' + item.id, kind:kind, t:item.title, o:item.owner, d:item.purpose, used:item.seconds === null ? 0 : item.over ? Math.ceil(item.seconds / 60) : Math.round(item.seconds / 60), est:item.estimateSeconds === null ? null : Math.round(item.estimateSeconds / 60), act:item.lastActivity ? Math.max(0, Math.floor((data.now - item.lastActivity) / 60000)) : null, run:!!item.ownerRun, pos:i+1, w:{ago:Math.max(0, Math.round((data.now - item.at) / 60000))} });
    ITEMS[x.id] = x; return x;
  }
  async function refresh(focusKey) {
    var serial = ++request;
    try {
      var response = await fetch('/api/board?lang=' + S.lang + (S.moreNext ? '&more=1' : ''));
      if (!response.ok) throw Error();
      var next = await response.json(); if (serial !== request) return;
      data = next; ITEMS = {};
      RUNNING = data.running.map(function(x,i){return prepare(x,'running',i);});
      NEXT = data.upNext.map(function(x,i){return prepare(x,'next',i);});
      WAITING = ['checks','release','fix','review'].map(function(k){var items=data.waiting.filter(function(x){return x.waitGroup===k;}).map(function(x,i){return prepare(x,'waiting',i);});return {k:k,label:{checks:'gChecks',release:'gRelease',fix:'gFix',review:'gReview'}[k],total:items.length,items:items};}).filter(function(g){return g.total;});
      DONE = data.done.map(function(x,i){return prepare(x,'done',i);}); DONE_TOTAL = data.counts.done48h;
      document.getElementById('connection').hidden = !data.notice;
      document.getElementById('connection').textContent = data.notice || '';
      document.getElementById('controls').hidden = !local;
      document.getElementById('control-title').textContent=t('localControls');
      document.getElementById('token-label').textContent=t('ownerToken');
      document.getElementById('save').textContent=t('useToken');
      document.getElementById('pause').textContent=t(data.paused ? 'resume' : 'pause');
      render(typeof focusKey === 'string' ? focusKey : document.activeElement && document.activeElement.dataset.k);
    } catch (error) { if(serial === request) showError(S.lang === 'fr' ? 'Actualisation retardée. Nouvel essai…' : 'Updates delayed. Retrying…'); }
  }
  document.getElementById('auth').addEventListener('submit', function(e){e.preventDefault();if(!local)return;sessionStorage.setItem('owner-token',document.getElementById('token').value);document.getElementById('token').value='';document.getElementById('auth-result').textContent=S.lang==='fr'?'Jeton enregistré pour cet onglet.':'Token saved for this tab.';});
  document.getElementById('pause').addEventListener('click',async function(){try{await action('/api/pause',{paused:!data.paused});}catch(error){showError(error.message);}});
  refresh();
  setInterval(refresh, 15000);
})();
