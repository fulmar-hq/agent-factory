import {expect, test} from "bun:test";
import {estimate, history, score, type History} from "../estimator/predict";
import {Store} from "../tracking/store";

const ticket = "fictional/attempts#52";
const receipt = {completed:20_000, seconds:4, tokens:40};
type Attempt = {id:string; status:string; started:number; seconds:number; tokens:number; area:string; kind:string; provider:string};
const success: Attempt = {id:"retry",status:"finished",started:10_000,seconds:4,tokens:40,area:"screen",kind:"fix",provider:"codex"};
const failed: Attempt = {id:"original",status:"archived",started:1_000,seconds:2,tokens:20,area:"backend",kind:"feature",provider:"claude"};
function fixture(attempts: Attempt[], actual: unknown = receipt, archived: Record<string,string> = {}) {
  const s = new Store(":memory:");
  for (const [n, x] of attempts.entries()) {
    s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief,started,actual_seconds,actual_tokens,attempt) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(x.id,ticket,"fictional",x.provider,x.status,JSON.stringify({area:x.area,kind:x.kind,provider:x.provider}),x.started,x.seconds,x.tokens,n+1);
  }
  for (const [id,previousStatus] of Object.entries(archived)) {
    s.event(`archive:${id}`,"session-archive",{id,previousStatus,receipt:"synthetic custody"},"Retain synthetic evidence",30_000);
  }
  s.set(`actual:${ticket}`,actual);
  return s;
}
const expected = {id:ticket,area:"screen",kind:"fix",provider:"codex",started:10_000,completed:20_000,seconds:4,tokens:40,elapsed:10,imported:false};

test("retry receipt joins only its successful attempt regardless of session row order", () => {
  // Give the failed attempt matching counters: its archived failure still cannot
  // supply the receipt's start, elapsed time or features.
  const original = {...failed,seconds:4,tokens:40};
  for (const attempts of [[original,success],[success,original]]) {
    const s = fixture(attempts,receipt,{original:"unknown"});
    try {
      const before = {sessions:s.rows("sessions"),events:s.rows("events"),actual:s.get(`actual:${ticket}`)};
      expect(history(s)).toEqual([expected]);
      expect({sessions:s.rows("sessions"),events:s.rows("events"),actual:s.get(`actual:${ticket}`)}).toEqual(before);
    } finally {s.close();}
  }
});

test("archived success retains the original start and features after another attempt", () => {
  const later = {...failed,status:"finished",started:25_000,seconds:4,tokens:40};
  for (const attempts of [
    [{...success,status:"archived"},later],
    [later,{...success,status:"archived"}],
  ]) {
    const s = fixture(attempts,receipt,{retry:"finished",original:"unknown"});
    try {expect(history(s)).toEqual([expected]);} finally {s.close();}
  }
});

test("multiple completed attempts can be distinguished by retained counters", () => {
  const s = fixture([{...failed,status:"archived"},success],receipt,{original:"finished"});
  try {expect(history(s)).toEqual([expected]);} finally {s.close();}
});

test("ambiguous legacy receipts never choose the newest or last session", () => {
  for (const status of ["finished","archived"]) {
    const earlier = {...failed,status,seconds:4,tokens:40};
    for (const attempts of [[earlier,success],[success,earlier]]) {
      const s = fixture(attempts,receipt,{original:"finished"});
      try {expect(history(s)).toEqual([]);} finally {s.close();}
    }
  }
});

test("a receipt written after archival cannot belong to that archived success", () => {
  const earlier = {...failed,seconds:4,tokens:40};
  for (const attempts of [[earlier,success],[success,earlier]]) {
    const s = fixture(attempts,receipt);
    s.event("early-archive","session-archive",{id:"original",previousStatus:"finished"},"Retain synthetic evidence",9_000);
    try {expect(history(s)).toEqual([expected]);} finally {s.close();}
  }
  const s = fixture([{...success,status:"archived"}],{...receipt,completed:40_000},{retry:"finished"});
  try {expect(history(s)).toEqual([]);} finally {s.close();}
});

test("incompatible or unsupported legacy receipts remain excluded", () => {
  const cases: {attempts:Attempt[]; actual?:unknown; archived?:Record<string,string>}[] = [
    {attempts:[{...success,seconds:5}]},
    {attempts:[{...success,tokens:41}]},
    {attempts:[{...success,started:20_000}]},
    {attempts:[{...success,started:21_000}]},
    {attempts:[{...success,status:"unknown"}]},
    {attempts:[{...success,status:"running"}]},
    {attempts:[{...success,status:"paused"}]},
    {attempts:[{...success,status:"archived"}]},
    {attempts:[{...success,status:"archived"}],archived:{retry:"unknown"}},
    {attempts:[success],actual:{...receipt,seconds:-1}},
    {attempts:[success],actual:{...receipt,tokens:"40"}},
    {attempts:[success],actual:{seconds:4,tokens:40}},
    {attempts:[success],actual:null},
  ];
  for (const c of cases) {
    const s = fixture(c.attempts,c.actual === undefined ? receipt : c.actual,c.archived);
    try {expect(history(s)).toEqual([]);} finally {s.close();}
  }
});

test("single completed attempt stays compatible and zero usage stays unknown", () => {
  for (const status of ["finished","archived"]) {
    const s = fixture([{...success,status}],receipt,{retry:"finished"});
    try {expect(history(s)).toEqual([expected]);} finally {s.close();}
  }
  const s = fixture([{...success,seconds:0,tokens:0}],{...receipt,seconds:0,tokens:0});
  try {
    expect(history(s)).toEqual([{...expected,seconds:null,tokens:null}]);
    expect(estimate(history(s),success,30_000)).toMatchObject({helperHours:null,tokens:null,elapsedHours:10/3600});
  } finally {s.close();}
});

const trainingRow = (n:number):History => ({id:String(n).padStart(3,"0"),area:"screen",kind:"fix",provider:"codex",
  started:1_000+n*1_000,completed:1_500+n*1_000,seconds:n<20 ? 100 : 10,tokens:n<20 ? 1000 : 100,elapsed:n<20 ? 200 : 20,imported:false});

test("shuffled training has identical chronological evaluation and forecasts without mutation", () => {
  const rows = Array.from({length:50},(_,n) => trainingRow(n));
  const evaluation = score(rows), prediction = estimate(rows,success,100_000);
  expect(evaluation.status).toBe("better");
  for (const shuffled of [[...rows].reverse(),[...rows.filter((_,n)=>n%2),...rows.filter((_,n)=>!(n%2))]]) {
    const before = structuredClone(shuffled);
    shuffled.forEach(Object.freeze);
    Object.freeze(shuffled);
    expect(score(shuffled)).toEqual(evaluation);
    expect(estimate(shuffled,success,100_000)).toEqual(prediction);
    expect(shuffled).toEqual(before);
  }
});

test("recent five resolves completion ties deterministically and excludes future/imported rows", () => {
  const rows = Array.from({length:7},(_,n) => ({...trainingRow(n),started:1_000,completed:2_000,seconds:n+1,tokens:(n+1)*10,elapsed:(n+1)*2}));
  const evaluation = {...score([]),status:"better"};
  const input = [rows[5],rows[0],rows[6],rows[2],rows[4],rows[1],rows[3],
    {...trainingRow(8),seconds:99_999,imported:true},{...trainingRow(9),completed:100_000}];
  const before = structuredClone(input);
  expect(estimate(input,success,10_000,evaluation)).toMatchObject({method:"recent-five",helperHours:5/3600,tokens:50,elapsedHours:10/3600});
  expect(estimate([...input].reverse(),success,10_000,evaluation)).toEqual(estimate(input,success,10_000,evaluation));
  expect(input).toEqual(before);
});
