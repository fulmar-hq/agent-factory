import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualificationAlerts } from "../launcher/alerts";
import { Store } from "../tracking/store";
import { now, qualification } from "./fixtures";

const expiresAt = now + 3600000;
const id = `qualification-expiry:codex:${expiresAt}`;
const summary = `Factory codex qualification expires at ${new Date(expiresAt).toISOString()}; requalify before more work.`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const message = () => ({
  id, send_id:id, created_at:now, sender:"Factory Desk", sender_app:"codex", sender_ref:"factory-launcher",
  recipient:"Vincent", recipient_app:"telegram", kind:"fyi", reply:"none", summary, body:"", thread_id:id,
  depth:0, hash:hash(summary), state:"unread", wake_state:"pending",
});

function fixture(run: (db: Database, s: Store, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "factory-alert-readback-"));
  const path = join(dir, "mail.sqlite"), db = new Database(path), s = new Store(":memory:");
  try {
    db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)`);
    run(db, s, path);
  } finally { s.close(); db.close(); rmSync(dir, {recursive:true}); }
}

function insert(db: Database, row: ReturnType<typeof message>) {
  db.query(`INSERT INTO messages (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function alert(s: Store, path: string, at = now) {
  qualificationAlerts(s, {codex:{...qualification(), expiresAt}}, at, path);
}

function expectFailure(s: Store, diagnostic: string) {
  expect(s.get(id)).toBeNull();
  expect(s.rows("events")).toHaveLength(1);
  expect(s.rows("events")[0]).toMatchObject({id:`alert-failure:${id}`, kind:"qualification-alert-failure"});
  expect(JSON.parse((s.rows("events")[0] as {data:string}).data).error).toContain(diagnostic);
}

const conflicts = {
  send_id:"other-send", sender:"Other Desk", sender_app:"other", sender_ref:"other-launcher",
  recipient:"Other recipient", recipient_app:"other", kind:"request", reply:"required", body:"other content",
  thread_id:"qualification-expiry:claude:1", depth:1, hash:"wrong-hash", summary:"different content",
};
for (const [field, value] of Object.entries(conflicts)) {
  test(`conflicting stable ID with different ${field} fails without changing the bridge row`, () => {
    fixture((db, s, path) => {
      const row = {...message(), [field]:value};
      insert(db, row);
      const before = db.query("SELECT * FROM messages").all();
      alert(s, path);
      alert(s, path, now + 1);
      expectFailure(s, "readback conflict");
      expect(db.query("SELECT * FROM messages").all()).toEqual(before);
    });
  });
}

test("self-consistent wrong provider/expiry content still fails readback", () => {
  for (const wrong of [summary.replace("codex", "claude"), summary.replace(new Date(expiresAt).toISOString(), new Date(expiresAt + 1).toISOString())]) {
    fixture((db, s, path) => {
      const row = {...message(), summary:wrong, hash:hash(wrong)};
      insert(db, row);
      alert(s, path);
      expectFailure(s, "readback conflict");
      expect(db.query("SELECT * FROM messages").all()).toEqual([row]);
    });
  }
});

test("ignored insert with no row retains failure and can retry after repair", () => {
  fixture((db, s, path) => {
    db.exec("CREATE TRIGGER ignore_alert BEFORE INSERT ON messages BEGIN SELECT RAISE(IGNORE); END");
    alert(s, path);
    expectFailure(s, "readback missing");
    expect(db.query("SELECT * FROM messages").all()).toEqual([]);
    db.exec("DROP TRIGGER ignore_alert");
    alert(s, path);
    expect(s.get(id)).toMatchObject({queuedAt:now, path});
    expect(s.rows("events").map(row => (row as {kind:string}).kind)).toEqual([
      "qualification-alert-failure", "qualification-expiry-alert",
    ]);
    expect(db.query("SELECT * FROM messages").all()).toEqual([message()]);
  });
});

for (const recovery of [
  {name:"matching crash recovery", at:now + 1, state:"unread", wake:"pending"},
  {name:"expiry-boundary recovery", at:expiresAt + 1, state:"unread", wake:"pending"},
  {name:"advanced delivery state", at:expiresAt + 1, state:"read", wake:"delivered"},
]) {
  test(`${recovery.name} accepts retained content without rewriting or resending`, () => {
    fixture((db, s, path) => {
      const row = {...message(), state:recovery.state, wake_state:recovery.wake};
      insert(db, row);
      alert(s, path, recovery.at);
      expect(s.get(id)).toEqual({queuedAt:recovery.at, path});
      expect(s.rows("events")).toHaveLength(1);
      expect(s.rows("events")[0]).toMatchObject({id, kind:"qualification-expiry-alert"});
      expect(JSON.parse((s.rows("events")[0] as {data:string}).data)).toEqual({provider:"codex", expiresAt, summary});
      alert(s, path, recovery.at + 1);
      expect(db.query("SELECT * FROM messages").all()).toEqual([row]);
      expect(s.rows("events")).toHaveLength(1);
    });
  });
}

test("already-expired crash recovery verifies and retains the expired summary", () => {
  fixture((db, s, path) => {
    const expired = "Factory codex qualification expired; requalify before more work.";
    const row = {...message(), created_at:expiresAt, summary:expired, hash:hash(expired)};
    insert(db, row);
    alert(s, path, expiresAt + 1);
    expect(s.get(id)).toEqual({queuedAt:expiresAt + 1, path});
    expect(s.rows("events")).toHaveLength(1);
    expect(s.rows("events")[0]).toMatchObject({id, kind:"qualification-expiry-alert"});
    expect(JSON.parse((s.rows("events")[0] as {data:string}).data).summary).toBe(expired);
    expect(db.query("SELECT * FROM messages").all()).toEqual([row]);
  });
});
