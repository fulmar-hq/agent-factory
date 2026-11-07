import {test, expect} from "bun:test";
import {estimate, score, history, type History} from "../estimator/predict";
import {closedHistory, refreshHistory} from "../estimator/refresh";
import {Store} from "../tracking/store";
const row = (n:number, value:number):History => ({id:String(n),area:"screen",kind:"feature",provider:"codex",started:1000+n*1000,completed:1500+n*1000,seconds:value,tokens:value*10,elapsed:value*2,imported:false});
test("held-out recent estimator must beat mean on time and usage, or use mean", () => {
  const rows = Array.from({length:50},(_,n) => row(n, n < 20 ? 100 : 10));
  expect(score(rows).status).toBe("better");
  expect(estimate(rows,rows[0],100000).method).toBe("recent-five");
  const steady = Array.from({length:50},(_,n) => row(n,10));
  expect(score(steady).status).toBe("not-better");
  expect(estimate(steady,steady[0],100000).method).toBe("mean");
});
test("prediction excludes future, overlapping and migrated rows; unknown stays unknown", () => {
  const rows = [row(0,10),{...row(1,10000),imported:true},row(20,10000)];
  expect(estimate(rows,rows[0],2000).helperHours).toBe(10/3600);
  expect(estimate(rows,{area:"other",kind:"other",provider:"claude"},2000).tokens).toBeNull();
  expect(score(rows).status).toBe("not-better");
  expect(estimate([row(0,10)],rows[0],1200).helperHours).toBeNull();
});
test("GitHub timings are elapsed only, imported issues excluded, refresh preserves failures", async () => {
  const s = new Store(":memory:");
  const issue = {number:1,createdAt:"2026-01-01T00:00:00Z",closedAt:"2026-01-02T00:00:00Z",labels:[]};
  expect(closedHistory("fictional/repo","issue",[{...issue,body:"Imported from https://linear.app/example"}])[0].imported).toBe(true);
  const rows = closedHistory("fictional/repo","issue",[issue]);
  expect(rows[0].seconds).toBeNull(); expect(rows[0].tokens).toBeNull(); expect(rows[0].elapsed).toBe(86400);
  expect(closedHistory("fictional/repo","issue",[{...issue,labels:[{name:"migrated"}]}])[0].imported).toBe(true);
  try {
    await refreshHistory(s,async () => JSON.stringify([issue]));
    expect(history(s)).toHaveLength(4);
    const before = s.get("estimate-history");
    await expect(refreshHistory(s,async () => {throw Error("offline");})).rejects.toThrow("offline");
    expect(s.get("estimate-history")).toEqual(before);
    expect(s.rows("events")).toHaveLength(1);
  } finally {s.close();}
});

import {Engine} from "../launcher/engine";
import {ticket, admission, config} from "./fixtures";
test("reservation freezes pre-start forecast; completion stores native actuals, never resetting original bounds", () => {
  const s = new Store(":memory:"), e = new Engine(s,config()), t = ticket();
  s.set("paused",false);
  s.set("estimate-history",[{...row(0,100),area:"unknown",kind:"unknown"}]);
  try {
    const x = e.admit(t,admission());
    const key = `estimate:${t.repo}#${t.number}`, frozen = s.get(key);
    expect(frozen).toMatchObject({method:"mean",helperHours:100/3600,tokens:1000});
    s.set("estimate-history",[row(0,500)]);
    e.claimStart(x.id,admission().now);
    e.account(x.id,2,20,admission().now+2000);
    e.finish(x.id,true);
    expect(s.get(key)).toEqual(frozen);
    expect(s.get(`actual:${t.repo}#${t.number}`)).toMatchObject({seconds:2,tokens:20});
    expect(JSON.parse(e.sessions()[0].brief).estimateSeconds).toBe(t.estimateSeconds);
    expect(history(s).some(r=>r.id===`${t.repo}#${t.number}`)).toBe(true);
  } finally {s.close();}
});
