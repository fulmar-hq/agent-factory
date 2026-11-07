import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  db: Database;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO kv VALUES('paused','true');
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,undo TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'event log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'event log is append-only'); END;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,ticket TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,brief TEXT NOT NULL,native_id TEXT,pid INTEGER,started INTEGER,actual_seconds REAL NOT NULL DEFAULT 0,actual_tokens REAL NOT NULL DEFAULT 0,checkpoint INTEGER NOT NULL DEFAULT 0,link_verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS claims(path TEXT NOT NULL,session TEXT NOT NULL REFERENCES sessions(id),PRIMARY KEY(path,session));
      CREATE TABLE IF NOT EXISTS debits(id TEXT PRIMARY KEY,session TEXT NOT NULL,source TEXT NOT NULL,month TEXT NOT NULL,cents INTEGER NOT NULL CHECK(cents>=0),at INTEGER NOT NULL,receipt TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS no_debit_update BEFORE UPDATE ON debits BEGIN SELECT RAISE(ABORT,'debit ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS no_debit_delete BEFORE DELETE ON debits BEGIN SELECT RAISE(ABORT,'debit ledger is append-only'); END;
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,observed INTEGER NOT NULL,decision TEXT);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,day TEXT NOT NULL,stage TEXT NOT NULL,revision TEXT NOT NULL,receipt TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(day,stage));
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,text TEXT NOT NULL,answer TEXT,at INTEGER NOT NULL);
    `);
  }
  get<T>(key: string): T | null {
    const row = this.db.query("SELECT value FROM kv WHERE key=?").get(key) as {
      value: string;
    } | null;
    return row ? JSON.parse(row.value) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .query(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  event(
    id: string,
    kind: string,
    data: unknown,
    undo: string,
    at = Date.now(),
  ) {
    return (
      this.db
        .query("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)")
        .run(id, kind, at, JSON.stringify(data), undo).changes === 1
    );
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  rows(table: string) {
    if (
      ![
        "sessions",
        "events",
        "debits",
        "tickets",
        "releases",
        "questions",
      ].includes(table)
    )
      throw Error("table");
    return this.db.query(`SELECT * FROM ${table}`).all();
  }
  close() {
    this.db.close();
  }
}
