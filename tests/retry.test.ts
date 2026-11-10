import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {TestEngine as Engine} from './fixtures';
import { Store } from "../tracking/store";
import { launchReady } from "../launcher/tick";
import { intakeLabel, issueTicket, type Issue } from "../adapters/github";
import { config, ticket, admission, now } from "./fixtures";

const digest = (n: number) => `ready:${String(n).repeat(43)}`;
const setup = () => {
  const e = new Engine(new Store(":memory:"), config());
  e.pause(false, "owner");
  return e;
};
function archived(e: Engine) {
  const x = e.admit({...ticket(), approvalDigest:digest(1), costCents:25}, admission());
  e.finish(x.id, false);
  e.archive(x.id, "fixture native custody reconciled, no live processes", "owner");
  return x;
}
function approve(e: Engine, label = digest(2)) {
  e.s.event(`approval:${label}`, "intake-approval", {repo:ticket().repo, number:1, label, receipt:"fixture Coordinator review"}, "Withdraw label", Date.now()+1);
  return {...ticket(), approvalDigest:label, costCents:25};
}

test("new digest claims one numbered attempt, retains old custody and irreversible debits", () => {
  const e = setup();
  try {
    const x = archived(e), t = approve(e);
    const y = e.admit(t, {...admission(), retryNoPr:[x.id]});
    expect(y.attempt).toBe(2);
    expect(y.id).not.toBe(x.id);
    expect(e.claimStart(y.id)).toBe(true);
    expect(e.claimStart(y.id)).toBe(false);
    expect(() => e.admit(t, {...admission(), retryNoPr:[x.id]})).toThrow("duplicate");
    e.finish(y.id,false); e.archive(y.id,"fixture second custody", "owner");
    expect(() => e.admit(t, {...admission(), retryNoPr:[x.id,y.id]})).toThrow("duplicate");
    expect(() => e.admit({...t,approvalDigest:digest(1)}, admission())).toThrow("duplicate");
    const z = e.admit(approve(e,digest(3)), {...admission(),retryNoPr:[x.id,y.id]});
    expect(z.attempt).toBe(3);
    expect(e.s.rows("debits")).toHaveLength(3);
    expect(e.s.db.query("SELECT * FROM claims").all()).toHaveLength(3);
    expect(e.sessions().find(s=>s.id===x.id)?.status).toBe("archived");
    // SQLite independently enforces one ticket/digest and one ticket/attempt.
    expect(() => e.s.db.query("UPDATE sessions SET approval_digest=? WHERE id=?").run(digest(1),z.id)).toThrow("UNIQUE");
    expect(() => e.s.db.query("UPDATE sessions SET attempt=1 WHERE id=?").run(z.id)).toThrow("UNIQUE");
  } finally { e.s.close(); }
});

for (const status of ["running", "starting", "unknown", "paused", "finished"]) test(`new approval refuses prior ${status} custody`, () => {
  const e=setup();
  try {
    const x=e.admit({...ticket(),approvalDigest:digest(1)},admission());
    e.s.db.query("UPDATE sessions SET status=? WHERE id=?").run(status,x.id);
    expect(()=>e.admit(approve(e),{...admission(),retryNoPr:[x.id]})).toThrow("custody");
    expect(e.sessions()).toHaveLength(1);
  } finally {e.s.close();}
});

test("archive alone, missing PR proof, missing digest provenance and live supervisor all refuse", () => {
  const e=setup();
  try {
    const x=archived(e), t={...ticket(),approvalDigest:digest(2)};
    expect(()=>e.admit(t,{...admission(),retryNoPr:[x.id]})).toThrow("approval");
    approve(e);
    expect(()=>e.admit(t,admission())).toThrow("PR unknown");
    e.s.db.query("UPDATE sessions SET pid=? WHERE id=?").run(process.pid,x.id);
    expect(()=>e.admit(t,{...admission(),retryNoPr:[x.id]})).toThrow("alive");
    e.s.db.query("UPDATE sessions SET pid=NULL,approval_digest=NULL WHERE id=?").run(x.id);
    expect(()=>e.admit(t,{...admission(),retryNoPr:[x.id]})).toThrow("digest unknown");
  } finally {e.s.close();}
});

test("forged archived status without custody receipt refuses", () => {
  const e=setup();
  try {
    const x=e.admit({...ticket(),approvalDigest:digest(1)},admission());
    e.s.db.query("UPDATE sessions SET status='archived' WHERE id=?").run(x.id);
    expect(()=>e.admit(approve(e),{...admission(),retryNoPr:[x.id]})).toThrow("receipt missing");
  } finally {e.s.close();}
});

for (const kind of ["launcher-publish","worker-delivery"]) test(`retained ${kind} refuses even with empty remote readback`, () => {
  const e=setup();
  try {
    const x=archived(e); e.s.event("delivery",kind,{id:x.id,url:"https://github.com/example/demo/pull/3"},"Retain PR");
    expect(()=>e.admit(approve(e),{...admission(),retryNoPr:[x.id]})).toThrow("PR exists");
  } finally {e.s.close();}
});

for (const result of ["exists","error","invalid","none","spawn-failure"]) test(`launch retry verifies all-state PR readback: ${result}`, async () => {
  const e=setup();
  try {
    const x=archived(e);
    const i:Issue={number:1,title:"Synthetic work",state:"OPEN",updatedAt:"2026-11-08",url:"fixture",body:`\`\`\`factory\n${JSON.stringify(ticket())}\n\`\`\``,labels:[]};
    i.labels=["state:ready","kind:fix","area:demo",intakeLabel(ticket().repo,i)].map(name=>({name}));
    const t=issueTicket(ticket().repo,i)!; approve(e,t.approvalDigest);
    let spawned=0; const calls:string[][]=[];
    const execute=async(args:string[])=>{
      calls.push(args);
      if(args.includes("pr")) {
        expect(args).toContain("all"); expect(args).toContain(`feat/factory-${x.id.slice(0,16)}`);
        if(result==="error")throw Error("offline");
        return result==="exists" ? '[{"number":3}]' : result==="invalid" ? '{}' : '[]';
      }
      if(args.includes("view"))return JSON.stringify(i);
      return "";
    };
    const run=()=>launchReady(e,t,admission(),()=>{if(result==="spawn-failure")throw Error("spawn failed");spawned++;},execute,()=>now);
    if(result==="none") {
      const y=await run(); expect(y.attempt).toBe(2); expect(spawned).toBe(1);
      await expect(run()).rejects.toThrow("duplicate");
      expect(calls.filter(c=>c.includes("pr"))).toHaveLength(1);
    } else {
      await expect(run()).rejects.toThrow(); expect(spawned).toBe(0);
      expect(e.sessions()).toHaveLength(1);expect(e.s.rows("debits")).toHaveLength(1);
    }
  } finally {e.s.close();}
});

test("legacy migration preserves IDs, claims and debits and derives only original approved digest", () => {
  const path=join(mkdtempSync(join(tmpdir(),"factory-migration-")),"state.sqlite");
  const s=new Store(path);s.set("paused",false);
  const e=new Engine(s,config());const x=e.admit(ticket(),admission());s.close();
  const d=new Database(path);
  // Reproduce the exact v1 session schema/index while retaining child claims.
  d.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE old_sessions(id TEXT PRIMARY KEY,ticket TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,brief TEXT NOT NULL,native_id TEXT,pid INTEGER,started INTEGER,actual_seconds REAL NOT NULL DEFAULT 0,actual_tokens REAL NOT NULL DEFAULT 0,checkpoint INTEGER NOT NULL DEFAULT 0,link_verified INTEGER NOT NULL DEFAULT 0);
    INSERT INTO old_sessions SELECT id,ticket,owner,provider,status,brief,native_id,pid,started,actual_seconds,actual_tokens,checkpoint,link_verified FROM sessions;
    DROP TABLE sessions; ALTER TABLE old_sessions RENAME TO sessions;`);
  d.query("INSERT INTO events VALUES(?,?,?,?,?)").run("old-approval","intake-approval",now-1,JSON.stringify({repo:ticket().repo,number:1,label:digest(1),receipt:"fixture"}),"Retain");
  d.query("INSERT INTO events VALUES(?,?,?,?,?)").run("new-approval","intake-approval",now+1,JSON.stringify({repo:ticket().repo,number:1,label:digest(2),receipt:"fixture"}),"Retain");d.close();
  for(let i=0;i<2;i++) {
    const migrated=new Store(path);
    expect((migrated.rows("sessions")[0] as any).id).toBe(x.id);
    expect((migrated.rows("sessions")[0] as any).approval_digest).toBe(digest(1));
    expect((migrated.rows("sessions")[0] as any).attempt).toBe(1);
    expect(migrated.db.query("SELECT * FROM sessions_v1_archive").all()).toHaveLength(1);
    expect(migrated.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.db.query("SELECT * FROM claims").all()).toHaveLength(1);
    expect(migrated.rows("debits")).toHaveLength(1);migrated.close();
  }
});
