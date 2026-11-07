import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import {
  factoryCommand,
  mailHook,
  processTelegramMail,
} from "../launcher/telegram";
import { config, ticket, admission } from "./fixtures";

test("verified commands retain custody, refuse ambiguity, and cannot replay a resume", () => {
  const s = new Store(":memory:"),
    c = config(),
    e = new Engine(s, c);
  try {
    factoryCommand(s, c, "resume", "resume");
    const a = e.admit(ticket(1), admission());
    expect(factoryCommand(s, c, "status", "status")).toContain(
      "1 retained sessions",
    );
    // A second repository's retained session is enough to make a short number ambiguous.
    s.db
      .query(
        "INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES('other','second/demo#1','builder','codex','running','{}')",
      )
      .run();
    expect(factoryCommand(s, c, "ambiguous", "stop 1")).toContain("ambiguous");
    expect(s.get(`stop:${a.id}`)).toBeNull();
    expect(factoryCommand(s, c, "stop", "stop example/demo#1")).toContain(
      "Stop requested",
    );
    expect(e.sessions().find((x) => x.id === a.id)?.status).toBe("paused");
    expect(
      s.db.query("SELECT session FROM claims WHERE session=?").get(a.id),
    ).not.toBeNull();
    factoryCommand(s, c, "pause", "pause");
    factoryCommand(s, c, "resume", "resume");
    expect(s.get("paused")).toBe(true); // old resume cannot undo a later pause
    expect(() => factoryCommand(s, c, "resume", "pause")).toThrow(
      "identity changed",
    );
    expect(factoryCommand(s, c, "invalid", "stop 1; resume")).toContain(
      "Use status",
    );
    expect(factoryCommand(s, c, "missing", "stop 999")).toContain(
      "No retained",
    );
    expect(
      s.rows("events").every((x) => (x as { undo: string }).undo.length > 0),
    ).toBe(true);
  } finally {
    s.close();
  }
});

test("mail hook suppresses chat wakes only for verified private roots and queues one reply across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-mail-")),
    path = join(dir, "mail.sqlite");
  const db = new Database(path),
    s = new Store(join(dir, "controller.sqlite"));
  try {
    db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,reply_to TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,forward_of TEXT,acked_at INTEGER,ack_note TEXT);
      CREATE TRIGGER operator_intake AFTER INSERT ON messages WHEN NEW.sender_app='telegram'
      BEGIN UPDATE messages SET recipient='Mail Operator',recipient_app='codex' WHERE id=NEW.id; END;`);
    db.exec(mailHook);
    const insert = (
      id: string,
      sender: string,
      app: string,
      ref: string,
      forward: string | null,
      command: string,
    ) =>
      db
        .query(
          "INSERT INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,summary,body,thread_id,state,wake_state,forward_of) VALUES(?,?,1,?,?,?,'Coordinator','claude',?,'','thread','unread','pending',?)",
        )
        .run(id, id, sender, app, ref, command, forward);
    insert("good", "Vincent", "telegram", "telegram:100", null, "pause");
    insert("forged", "Vincent", "codex", "telegram:101", null, "resume");
    insert(
      "forward",
      "Vincent",
      "telegram",
      "telegram:102",
      "parent",
      "resume",
    );
    insert(
      "malformed",
      "Vincent",
      "telegram",
      "telegram:103junk",
      null,
      "resume",
    );
    insert(
      "group",
      "Vincent",
      "telegram",
      "telegram-group:1:2:3",
      null,
      "resume",
    );
    insert(
      "normal",
      "Vincent",
      "telegram",
      "telegram:104",
      null,
      "Help with calendar",
    );
    expect(db.query("SELECT id FROM factory_commands").all()).toEqual([
      { id: "good" },
    ]);
    expect(
      db.query("SELECT state,wake_state FROM messages WHERE id='good'").get(),
    ).toEqual({ state: "acked", wake_state: "none" });
    expect(
      db.query("SELECT wake_state FROM messages WHERE id='normal'").get(),
    ).toEqual({ wake_state: "pending" });
    // Simulate a crash after the controller commits, before the mail reply is queued.
    factoryCommand(s, config(), "good", "pause");
    factoryCommand(s, config(), "later", "resume");
    expect(processTelegramMail(s, config(), path)).toBe(1);
    expect(s.get("paused")).toBe(false);
    expect(processTelegramMail(s, config(), path)).toBe(0);
    expect(
      db
        .query(
          "SELECT recipient,recipient_app,wake_state FROM messages WHERE id='factory-reply:good'",
        )
        .get(),
    ).toEqual({
      recipient: "Vincent",
      recipient_app: "telegram",
      wake_state: "pending",
    });
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM messages WHERE id='factory-reply:good'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db.query("SELECT response FROM factory_commands WHERE id='good'").get(),
    ).not.toBeNull();
    // Telegram batches may share one millisecond; arrival order wins over random mail IDs.
    insert("z-first", "Vincent", "telegram", "telegram:105", null, "resume");
    insert("a-last", "Vincent", "telegram", "telegram:106", null, "pause");
    expect(processTelegramMail(s, config(), path)).toBe(2);
    expect(s.get("paused")).toBe(true);
  } finally {
    db.close();
    s.close();
    rmSync(dir, { recursive: true });
  }
});

test("explicit hook preparation preserves old mail and refuses replacing an integration", async () => {
  const { writeFileSync, existsSync, lstatSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "factory-mail-setup-"));
  const path = join(dir, "mail.sqlite"),
    db = new Database(path);
  try {
    writeFileSync(join(dir, "config.yaml"), JSON.stringify(config()));
    db.exec(
      "CREATE TABLE messages(id TEXT PRIMARY KEY,sender TEXT,sender_app TEXT,sender_ref TEXT,forward_of TEXT,body TEXT,summary TEXT,created_at INTEGER,state TEXT,wake_state TEXT,acked_at INTEGER,ack_note TEXT); INSERT INTO messages(id,sender,sender_app,sender_ref,body,summary,created_at,state,wake_state) VALUES('old','Vincent','telegram','telegram:1','','resume',1,'unread','pending');",
    );
    const run = () =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/prepare-telegram.ts"),
          path,
        ],
        {
          env: { ...process.env, FACTORY_PRIVATE_DIR: dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    expect(await run().exited).toBe(0);
    expect(lstatSync(join(dir, "telegram-mail.sqlite")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      db.query("SELECT count(*) AS n FROM factory_commands").get(),
    ).toEqual({ n: 0 });
    expect(db.query("SELECT state FROM messages WHERE id='old'").get()).toEqual(
      { state: "unread" },
    );
    expect(await run().exited).not.toBe(0);
    expect(existsSync(join(dir, "com.agent-factory.tick.plist"))).toBe(false);
    const state = new Store(join(dir, "controller.sqlite"));
    try {
      expect(state.rows("events").length).toBe(1);
      expect(state.get("paused")).toBe(true);
    } finally {
      state.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
