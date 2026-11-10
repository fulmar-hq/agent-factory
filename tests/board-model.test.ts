import {githubPage} from './fixtures';
import { test, expect } from "bun:test";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { boardModel, plainText } from "../board/model";
import { intakeLabel, reconcile, type Issue } from "../adapters/github";
import { githubWakes } from "../launcher/wake";
import { config, ticket, now, billing } from "./fixtures";

function fixture() {
  const s = new Store(":memory:"),
    e = new Engine(s, config());
  s.set("paused", false);
  s.set("heartbeat", { at: now, status: "ok" });
  s.set("github:example/demo", { observedAt: now, error: null });
  const add = (
    n: number,
    state = "OPEN",
    labels: string[] = [],
    closedAt?: string,
  ) => {
    const i: Issue = {
      number: n,
      title: `Useful task ${n}`,
      body: "",
      url: `https://github.com/example/demo/issues/${n}`,
      updatedAt: new Date(now).toISOString(),
      state,
      labels: labels.map((name) => ({ name })),
      closedAt,
    };
    s.db
      .query("INSERT INTO tickets VALUES(?,?,?,?)")
      .run(`example/demo#${n}`, JSON.stringify(i), now, "observed");
    return i;
  };
  const session = (n: number, status: string, attempt = 1) => {
    const id = `session-${n}-${attempt}`;
    s.db
      .query(
        "INSERT INTO sessions(id,ticket,owner,provider,status,brief,native_id,started,actual_seconds,actual_tokens,attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        `example/demo#${n}`,
        "builder",
        "codex",
        status,
        JSON.stringify({ ...ticket(n), estimateSeconds: 1800 }),
        `native-${n}`,
        now - 23 * 60000,
        1380,
        1500000,
        attempt,
      );
    return id;
  };
  const ready = (n: number) => {
    const i = add(n, "OPEN", ["state:ready", "kind:unknown", "area:unknown"]);
    i.body = "```factory\n" + JSON.stringify(ticket(n)) + "\n```";
    i.labels.push({ name: intakeLabel("example/demo", i) });
    s.db
      .query("UPDATE tickets SET snapshot=? WHERE id=?")
      .run(JSON.stringify(i), `example/demo#${n}`);
    return i;
  };
  return { s, e, add, session, ready };
}
test("groups one task once, hides archives and old closures, and uses actual closure time", () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    session(1, "running");
    add(2, "OPEN", ["state:review"]);
    session(2, "finished");
    add(3, "CLOSED", [], new Date(now - 60000).toISOString());
    session(3, "finished");
    add(4, "CLOSED", [], new Date(now - 49 * 3600000).toISOString());
    session(4, "finished");
    add(5);
    session(5, "archived");
    add(6);
    session(6, "paused");
    add(7);
    session(7, "unknown");
    add(8, "CLOSED", [], new Date(now - 120000).toISOString());
    add(9);
    session(9, "archived");
    session(9, "running", 2);
    add(10, "CLOSED"); // Unknown closure time is never replaced with updatedAt.
    const m = boardModel(e, {}, now);
    expect(m.running.map((x) => x.id)).toEqual([
      "example/demo#1",
      "example/demo#9",
    ]);
    expect(m.waiting.map((x) => x.status)).toEqual([
      "Waiting for review",
      "Stopped — waiting for a decision",
      "Waiting for investigation",
    ]);
    expect(m.done.map((x) => x.id)).toEqual([
      "example/demo#3",
      "example/demo#8",
    ]);
    expect(m.done[0].status).toBe("Closed");
    expect(m.running[0].session).toBe("native-1");
    expect(m.running[0].progress).toBeCloseTo(1380 / 1800);
  } finally {
    s.close();
  }
});
test("queue keeps reconciliation order, validates approval, omits claimed work and caps at five", () => {
  const { s, e, ready, session, add } = fixture();
  try {
    ready(20);
    ready(2);
    session(2, "finished");
    for (let n = 30; n < 42; n++) ready(n);
    add(90, "OPEN", ["state:ready"]); // a label alone cannot approve a task
    const m = boardModel(e, {}, now);
    expect(m.counts.upNext).toBe(13);
    expect(m.upNext).toHaveLength(5);
    expect(m.more).toBe(8);
    expect(m.upNext[0].id).toBe("example/demo#20");
    expect(m.upNext[1].id).toBe("example/demo#30");
    expect(m.upNext.some((x) => x.id === "example/demo#2")).toBe(false);
  } finally {
    s.close();
  }
});
test("status is plain English, pause wins, prolonged idle and stale evidence need attention", () => {
  const { s, e, ready, add, session } = fixture();
  try {
    ready(1);
    add(2);
    const id = session(2, "finished");
    s.event(
      "exit",
      "worker-exit",
      { id, ok: true },
      "retain",
      now - 2 * 3600000,
    );
    s.db.query("UPDATE sessions SET started=?").run(now - 3 * 3600000);
    expect(boardModel(e, {}, now).status).toBe(
      "Idle — nothing running for 2 h (needs attention)",
    );
    s.db.query("UPDATE sessions SET status='running'").run();
    expect(boardModel(e, {}, now).status).toBe(
      "Working — 1 task running, 1 in the queue",
    );
    s.set("paused", true);
    expect(boardModel(e, {}, now).status).toBe("Paused by you");
    expect(boardModel(e, {}, now, "fr").status).toBe("Mise en pause par vous");
    s.set("heartbeat", { at: now - 240000, status: "ok" });
    expect(boardModel(e, {}, now).notice).toContain("needs attention");
  } finally {
    s.close();
  }
});
test("only genuinely open Vincent questions appear with honest defaults and recorded deadlines", () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    const id = session(1, "paused");
    s.db
      .query(
        "INSERT INTO questions(id,text,at,addressed_to) VALUES(?,?,?,'vincent'),('owner','For owner',?,'owner'),('autonomy:decision','Allow this change?',?,'vincent')",
      )
      .run(`overrun:${id}`, "Internal estimate question", now, now, now);
    s.db
      .query(
        "INSERT INTO questions(id,text,at,answer) VALUES('answered','Old',?,'yes');",
      )
      .run(now);
    s.db
      .query(
        "INSERT INTO questions(id,text,at,resolved_at) VALUES('resolved','Old',?,?)",
      )
      .run(now, now);
    s.set("autonomy-decision:decision", {
      state: "open",
      deadline: now + 3600000,
      default: "not approved",
    });
    const m = boardModel(e, {}, now);
    expect(m.questions).toHaveLength(2);
    expect(m.questions[0].title).toContain("Useful task 1");
    expect(m.questions[0].defaultLine).toContain("No automatic deadline");
    expect(m.questions[1].defaultLine).toContain("not approved");
    expect(m.questions[1].defaultLine).toContain("7:00");
  } finally {
    s.close();
  }
});
test("usage selects actual weekly window and billing never substitutes a wallet balance", () => {
  const { s, e } = fixture();
  try {
    const readings = {
      codex: {
        observedAt: now,
        source: "fixture",
        windows: [
          { used: 0.8, resetsAt: now + 3600000, durationMinutes: 300 },
          { used: 0.18, resetsAt: now + 86400000, durationMinutes: 10080 },
        ],
      },
      billing: billing(),
    };
    let m = boardModel(e, readings, now);
    expect(m.usage[0].percent).toBe(18);
    expect(m.usage[1].percent).toBeNull();
    expect(m.aws.dollars).toBe(11);
    expect(m.aws.ceiling).toBe(75);
    s.set("aws-stop-latched", true);
    m = boardModel(e, readings, now);
    expect(m.aws.stopped).toBe(true);
    expect(m.releases.every((r) => r.status === "Skipped: AWS stopped")).toBe(
      true,
    );
    expect(boardModel(e, readings, now + 86400001).aws.dollars).toBeNull();
    expect(boardModel(e, readings, now + 900001).usage[0].percent).toBeNull();
    expect(
      boardModel(
        e,
        { codex: { ...readings.codex, windows: [readings.codex.windows[0]] } },
        now,
      ).usage[0].percent,
    ).toBeNull();
  } finally {
    s.close();
  }
});
test("release passed requires deployment evidence, never an authorization or successful promotion alone", () => {
  const { s, e } = fixture(),
    day = "2026-11-07";
  try {
    s.db
      .query("INSERT INTO releases VALUES(?,?,?,?,?,?)")
      .run("authorization", day, "qa", "revision", "permission only", now);
    expect(boardModel(e, {}, now).releases[0].status).toBe("Scheduled");
    s.set(`executor:${day}:qa`, { state: "success" });
    s.set(`executor:${day}:promote`, { state: "success" });
    let m = boardModel(e, {}, now);
    expect(m.releases[0].status).toBe("Passed");
    expect(m.releases[1].status).toBe("Checks in progress");
    s.set(`executor:${day}:readback`, { state: "success" });
    m = boardModel(e, {}, now);
    expect(m.releases[1].status).toBe("Passed");
    expect(boardModel(e, {}, now, "fr").releases[1].status).toBe("Réussie");
  } finally {
    s.close();
  }
});
test("each GitHub reconciliation refreshes closures and includes closedAt", async () => {
  const { s, e, add, ready } = fixture();
  ready(1);
  try {
    const closed = {
      ...JSON.parse((s.rows("tickets")[0] as { snapshot: string }).snapshot),
      state: "CLOSED",
      closedAt: new Date(now).toISOString(),
    };
    await reconcile(s, e.c, now, async (args) => {
      expect(args.join(",")).toContain("closedAt");
      return githubPage('issues',[closed]);
    });
    const m = boardModel(e, {}, now);
    expect(m.upNext).toHaveLength(0);
    expect(m.done).toHaveLength(1);
  } finally {
    s.close();
  }
});
test("plain titles remove repository references, hashes, prefixes and code blocks", () => {
  expect(
    plainText(
      "[example/demo] Improve search fulmar-hq/alido#123 " + "a".repeat(64),
    ),
  ).toBe("Improve search");
  expect(plainText("example/demo: Improve search")).toBe("Improve search");
});

test("waiting uses the tick’s read-only PR evidence and never invents passing checks", async () => {
  const { s, e, add, session } = fixture();
  try {
    add(1);
    const id = session(1, "finished"),
      url = "https://github.com/example/demo/pull/2";
    s.event("published", "launcher-publish", { id, url }, "retain", now);
    const execute = async () =>
      githubPage('pullRequests',[
        {
          number: 2,
          url,
          headRefOid: "a".repeat(40),
          reviews: [],
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ status: "IN_PROGRESS" }],
        },
      ]);
    await githubWakes(s, e.c, execute, now);
    expect(boardModel(e, {}, now).waiting[0].status).toBe("Waiting for checks");
    s.set(`board-pr:${url}`, {
      at: now,
      pending: false,
      failed: true,
      review: "APPROVED",
    });
    expect(boardModel(e, {}, now).waiting[0].status).toBe(
      "Waiting for checks to be fixed",
    );
    s.set(`board-pr:${url}`, {
      at: now,
      pending: false,
      failed: false,
      review: "APPROVED",
    });
    expect(boardModel(e, {}, now).waiting[0].status).toBe(
      "Waiting for tonight’s release",
    );
    expect(boardModel(e, {}, now + 180001).waiting[0].status).toBe(
      "Waiting for review",
    );
    expect(boardModel(e, {}, now).done).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("failed or truncated GitHub reads cannot advertise a claimable queue", () => {
  const { s, e, ready } = fixture();
  try {
    ready(1);
    s.set("github:example/demo", { at: now, error: "unavailable" });
    let m = boardModel(e, {}, now);
    expect(m.counts.upNext).toBe(0);
    expect(m.notice).toContain("GitHub");
    s.set("github:example/demo", { observedAt: now, truncated: true });
    expect(boardModel(e, {}, now).counts.upNext).toBe(0);
  } finally {
    s.close();
  }
});

test("elapsed uses session start, activity uses log evidence, owner runs count", () => {
  const {s,e,add,session} = fixture();
  try {
    add(1);const id=session(1,"running");
    s.db.query("UPDATE sessions SET actual_seconds=2").run();
    const m=boardModel(e,{},now,"en",{activity:{[id]:now-60000},ownerRuns:[{id:"quality/run-fictional",title:"Check calendar labels",owner:"quality",started:now-300000,lastActivity:now-20000,estimateSeconds:null}]});
    expect(m.running[0].seconds).toBe(1380);
    expect(m.running[0].lastActivity).toBe(now-60000);
    expect(m.running[1].ownerRun).toBe(true);
    expect(m.counts.running).toBe(2);
    expect(m.hero.soft).toBe("2 tasks running");
  } finally {s.close();}
});

test("completed timings and median come from real start and finish evidence", () => {
  const {s,e,add,session}=fixture();
  try {
    for(const [n,duration,ago] of [[1,600,60],[2,2400,120],[3,1800,180]]) {
      add(n,"CLOSED",[],new Date(now-ago*1000).toISOString());const id=session(n,"finished");
      s.db.query("UPDATE sessions SET started=?,actual_seconds=1 WHERE id=?").run(now-(duration+ago)*1000,id);
      s.event(`exit-${n}`,"worker-exit",{id,ok:true},"retain",now-ago*1000);
    }
    const m=boardModel(e,{},now);
    expect(m.completed).toEqual({count:3,medianSeconds:1800,over:1});
    expect(m.done[0].seconds).toBe(600);
    expect(m.done[1].seconds).toBe(2400);
    expect(m.done[0].at).toBe(now-60000);
    expect(m.done[0].started).toBe(now-660000);
  } finally{s.close();}
});

test("an old completed worker does not reappear because its issue closed today",()=>{
  const {s,e,add,session}=fixture();
  try {
    add(1,"CLOSED",[],new Date(now-60000).toISOString());const id=session(1,"finished");
    s.db.query("UPDATE sessions SET started=?").run(now-51*3600000);
    s.event("old-exit","worker-exit",{id,ok:true},"retain",now-50*3600000);
    expect(boardModel(e,{},now).done).toHaveLength(0);
  }finally{s.close();}
});

test("closed intake keeps its expected duration without inventing an actual duration",()=>{
  const {s,e,add}=fixture();
  try{
    const i=add(1,"CLOSED",[],new Date(now-60000).toISOString());
    i.body='```factory\n'+JSON.stringify(ticket(1))+'\n```';
    s.db.query("UPDATE tickets SET snapshot=? WHERE id=?").run(JSON.stringify(i),'example/demo#1');
    const item=boardModel(e,{},now).done[0];
    expect(item.estimateSeconds).toBe(ticket(1).estimateSeconds);
    expect(item.seconds).toBeNull();
    expect(boardModel(e,{},now).completed.medianSeconds).toBeNull();
  }finally{s.close();}
});

test("legacy questions are condensed; browser questions keep their local deadline and safe default",()=>{
  const {s,e}=fixture();
  try{
    const text='Use tabs_context_mcp on tabId=123 at https://example.test/?token=secret then inspect the very long output before 2026-11-07T23:00:00.000Z';
    s.db.query("INSERT INTO questions(id,text,at) VALUES(?,?,?)").run('browser:fake',text,now);
    s.set('browser-job:fake',{deadline:now+3600000,request:{goal:'Check service'}});
    const q=boardModel(e,{},now).questions[0];
    expect(q.title.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(q.context.split(/(?<=[.!?])\s/)).toHaveLength(1);
    expect(q.default).toBe('not done');
    expect(q.defaultLine).toContain('7:00');
    expect(JSON.stringify(q)).not.toMatch(/tabs_context|tabId|token=secret|2026-11-07T/);
  }finally{s.close();}
});

test("valid structured questions retain choices; malformed data falls back safely",()=>{
  const {s,e}=fixture();
  try{
    s.db.query("INSERT INTO questions(id,text,at) VALUES(?,?,?)").run('choice',JSON.stringify({title:'Keep AWS off tonight?',context:'The release needs AWS to run.',choices:[{label:'Keep off',value:'off'},{label:'On tonight',value:'on'}],default:'stays off',deadline:now+3600000}),now);
    let q=boardModel(e,{},now).questions[0];
    expect(q.title).toBe('Keep AWS off tonight?');expect(q.choices[1].value).toBe('on');
    s.db.query("UPDATE questions SET text=?").run('{"title":23,"choices":"broken","default":123}');
    q=boardModel(e,{},now).questions[0];expect(q.title).toBe('Review a work decision');
    expect(q.choices.length).toBeGreaterThan(0);
  }finally{s.close();}
});

test("full retained capacity never claims idle",()=>{
  const {s,e,add,session}=fixture();
  try{
    for(let n=1;n<=e.c.capacity.start_parallel;n++){add(n);session(n,'paused');}
    expect(boardModel(e,{},now).hero.mode).toBe('paused');
  }finally{s.close();}
});

test("weekly readings never borrow a short Claude window; reset time is real",()=>{
  const {s,e}=fixture();
  try{
    const meter={observedAt:now,source:'fictional',windows:[{used:.4,resetsAt:now+60000,durationMinutes:300}]};
    expect(boardModel(e,{claude:meter},now).usage[1].percent).toBeNull();
    meter.windows[0].durationMinutes=10080;
    expect(boardModel(e,{claude:meter},now).usage[1].resetsAt).toBe(now+60000);
  }finally{s.close();}
});

test("titles strip conventional commits and issue numbers",()=>{
  expect(plainText('example/demo: fix(board): #123 — Repair the board (#125)')).toBe('Repair the board');
});

test("owner-run titles derive from the first sentence without setup instructions", async()=>{
  const {ownerTitle}=await import('../board/runtime');
  expect(ownerTitle('You are Alido · Product (board) in ~/Developer/example (pull first). Repair it.')).toBe('Repair it');
  expect(ownerTitle('Repair the booking timezone. Preserve the work.')).toBe('Repair the booking timezone');
});

test("idle duration includes the last owner-run result",()=>{
  const {s,e}=fixture();
  try{const m=boardModel(e,{},now,"en",{ownerRuns:[],activity:{},ownerFinishedAt:now-120000});expect(m.hero.mode).toBe('idle');expect(m.hero.soft).toBe('for 2 min');}finally{s.close();}
});

test("board colours use policy gates, independent AWS spend, and real log timestamps",()=>{
  const {s,e,add,session}=fixture();
  try {
    add(1); const id=session(1,'running');
    e.c.board.quiet_after_minutes=5;
    e.c.wallet.aws.stop_at_actual=24;
    e.c.wallet.aws.planned_usd=60;
    const readings={codex:{observedAt:now,source:'fictional',windows:[{used:.7,resetsAt:now+86400000,durationMinutes:10080}]},billing:{...billing(),postedCents:2752,unpostedCents:0}};
    s.set('aws-stop-latched',true);
    let m=boardModel(e,readings,now,'en',{activity:{[id]:now-300000},ownerRuns:[]});
    expect(m.usage[0].tone).toBe('warn');expect(m.usage[1].tone).toBe('rest');
    expect(m.aws.tone).toBe('ok');expect(m.aws.stopped).toBe(true);
    expect(m.running[0].quiet).toBe(true);expect(m.running[0].over).toBe(false);expect(m.running[0].barTone).toBe('warn');
    expect(m.releases.every(r=>r.tone==='rest')).toBe(true);
    readings.codex.windows[0].used=.9;
    readings.billing.postedCents=6500;
    m=boardModel(e,readings,now,'fr');
    expect(m.usage[0].tone).toBe('bad');expect(m.aws.tone).toBe('warn');
    expect(m.running[0].quiet).toBe(false);expect(m.running[0].barTone).toBe('ok');
    readings.billing.postedCents=6501;
    expect(boardModel(e,readings,now).aws.tone).toBe('bad');
    expect(boardModel(e,readings,now+86400001).aws.tone).toBe('rest');
  } finally{s.close();}
});

test("outcomes and release pills distinguish waiting, stopped, passed and skipped",()=>{
  const {s,e,add,session}=fixture();
  try {
    add(1);session(1,'paused');add(2,'OPEN',['state:checks']);
    for(const [n,labels] of [[3,['state:live']],[4,['state:qa']],[5,[]]] as const) {
      add(n,'CLOSED',[...labels],new Date(now-60000).toISOString());const id=session(n,'finished');
      s.event(`done-${n}`,'worker-exit',{id,ok:true},'retain',now-60000);
    }
    for(const lang of ['en','fr'] as const) {
      const m=boardModel(e,{},now,lang);
      expect(m.waiting.map(x=>x.tone)).toEqual(['bad','info']);
      expect(m.done.map(x=>x.tone)).toEqual(['ok','info','rest']);
      expect(m.done.every(x=>x.barTone==='ok')).toBe(true);
      expect(m.releases.every(r=>r.tone==='info')).toBe(true);
    }
    s.set('executor:2026-11-07:qa',{state:'failure'});
    expect(boardModel(e,{},now).releases[0].tone).toBe('bad');
    s.set('executor:2026-11-07:qa',{state:'success'});
    expect(boardModel(e,{},now).releases[0].tone).toBe('ok');
  }finally{s.close();}
});

test('open PR inventory deduplicates issues, excludes merged work and splits actual waits',async()=>{
  const {recordPulls}=await import('../board/pulls');
  const {s,e,add,session}=fixture();
  try {
    for(let n=1;n<=3;n++) {add(n,'OPEN',['state:review']); const id=session(n,'finished'); s.event('delivery'+n,'launcher-publish',{id,url:`https://github.com/example/demo/pull/${n+10}`},'retain',now);}
    const base={headRefOid:'abc',reviews:[],statusCheckRollup:[]};
    recordPulls(s,'example/demo',[
      {...base,number:11,url:'https://github.com/example/demo/pull/11',title:'Fix booking',reviewDecision:'APPROVED',closingIssuesReferences:[{number:1,url:'https://github.com/example/demo/issues/1'}]},
      {...base,number:12,url:'https://github.com/example/demo/pull/12',title:'Repair email',reviewDecision:'CHANGES_REQUESTED',closingIssuesReferences:[{number:2,url:'https://github.com/example/demo/issues/2'}]},
      {...base,number:14,url:'https://github.com/example/demo/pull/14',title:'Check search',statusCheckRollup:[{status:'IN_PROGRESS'}]},
      {...base,number:15,url:'https://github.com/example/demo/pull/15',title:'Review timezone'},
    ],now);
    const m=boardModel(e,{},now);
    expect(m.waiting).toHaveLength(4);
    expect(m.waiting.map(x=>x.waitGroup)).toEqual(['release','fix','checks','review']);
    expect(m.waiting.some(x=>x.id==='example/demo#3')).toBe(false);
    expect(new Set(m.waiting.map(x=>x.pr)).size).toBe(4);
  }finally{s.close();}
});

test('owner run uses task text, real identity, explicit/configured/median estimates and work link',async()=>{
  const {ownerIdentity,ownerSummary,ownerEstimate}=await import('../board/runtime');
  const brief='You are Alido · Product (board) in ~/Developer/example (pull first).\n1. Apply the colour system to the board.\n2. Show all four meters without clipping.';
  expect(ownerIdentity(brief,'launcher')).toBe('product');
  expect(ownerSummary(brief).title).toBe('Apply the colour system to the board');
  expect(ownerSummary('You are Alido · Product.\nDetails open as a small centred pop-up window on tablet/desktop (rounded); phones keep the bottom sheet.').title).toBe('Show details in a small centred pop-up window on tablet/desktop');
  expect(ownerSummary(brief).purpose).toContain('Show all four meters');
  expect(ownerEstimate(600,1800,[100,200])).toBe(600);
  expect(ownerEstimate(undefined,1800,[100,200])).toBe(1800);
  expect(ownerEstimate(undefined,undefined,[100,200,300,400])).toBe(250);
  expect(ownerEstimate(undefined,undefined,[])).toBeNull();
  const {s,e}=fixture();try {
    const m=boardModel(e,{},now,'en',{activity:{},ownerRuns:[{id:'launcher/run-example',...ownerSummary(brief),owner:'product',started:now-600000,lastActivity:now-10000,estimateSeconds:1800}]});
    expect(m.running[0].owner).toBe('Product');expect(m.running[0].purpose).toContain('colour system');expect(m.running[0].issue).toContain('/api/owner-work?');
  }finally{s.close();}
});
