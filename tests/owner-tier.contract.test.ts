// A hard stop must never be silently downgraded. The mail gate decides a
// message's tier from its id alone, from a coded table in the mail repository.
// This test builds every hard-stop id the launcher can build and checks that
// the real mail code sends each one at once, even with the day's count spent.
// A hard-stop kind the mail table does not list is held like routine mail, and
// that fails here.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthReleaseWindows } from "../launcher/factory-health";
import { HEALTH_HARD_STOPS, healthBridge, healthHardStopId, type HealthHardStop } from "../launcher/factory-health-runtime";
import { HARD_STOP_KINDS, OWNER_MESSAGE_PREFIXES, SHARED_SUBJECTS, ownerMessageId, parseOwnerMessageId, type HardStopKind } from "../launcher/loop-contract";
import { openRealMailStore, realMailSource } from "./helpers/real-mail-store";

const M = 60_000;
// Two o'clock in the afternoon in Toronto, today: away from the gate's fixed slots.
const tonight = healthReleaseWindows(Date.now())[0]!, day = tonight.day, AT = tonight.startAt - 6 * 60 * M;
const KINDS = Object.keys(HARD_STOP_KINDS) as HardStopKind[];
/** Every hard-stop id a launcher writer can build today: each kind with each shared subject. */
const hardStopIds = (kinds: readonly HardStopKind[] = KINDS) =>
  kinds.flatMap(kind => Object.values(SHARED_SUBJECTS).map(subject => ownerMessageId({ tier: "hard-stop", kind, subject, day })));

type Mail = { path: string; send(now: number): Promise<unknown>; sentAt(id: string): number | null };
/**
 * Spends the day's routine count, then writes one more routine row and every
 * hard stop, and runs one more send cycle. The routine row must be left
 * unsent (otherwise nothing was being held and the test proves nothing), and
 * every hard stop must have been sent.
 */
async function proveHardStopTier(mail: Mail, ids: string[]) {
  const write = (id: string, text: string) => {
    const bridge = healthBridge(mail.path);
    try { bridge.send(id, "Vincent", text, true); } finally { bridge.close(); }
  };
  for (let i = 0; i < 6; i++) write(ownerMessageId({ tier: "routine", kind: "other", subject: `filler-${i}`, day }), `Routine filler ${i}.`);
  await mail.send(AT);
  const control = ownerMessageId({ tier: "routine", kind: "other", subject: "control", day });
  write(control, "Routine control row.");
  for (const id of ids) write(id, `Hard stop ${id}.`);
  await mail.send(AT + M);
  return { controlHeld: mail.sentAt(control) === null, unsent: ids.filter(id => mail.sentAt(id) === null) };
}

describe("hard-stop ids", () => {
  test("every one the launcher can build reads back as a hard stop of a known kind", () => {
    const ids = hardStopIds();
    expect(ids).toHaveLength(KINDS.length * Object.keys(SHARED_SUBJECTS).length);
    for (const id of ids) expect(parseOwnerMessageId(id)).toMatchObject({ tier: "hard-stop", day });
    expect(new Set(ids.map(id => parseOwnerMessageId(id)!.conditionKey)).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(OWNER_MESSAGE_PREFIXES["hard-stop"])).toBe(true);
  });
  test("the health job's hard stops are among them", () => {
    for (const condition of Object.keys(HEALTH_HARD_STOPS) as HealthHardStop[]) expect(hardStopIds()).toContain(healthHardStopId(condition, AT));
  });
});

// The check itself, against a stand-in gate, so that it is known to fail when
// a kind is missing. This part runs everywhere, including CI.
describe("the tier check, against a stand-in gate", () => {
  function standIn(listed: readonly HardStopKind[]): Mail & { close(): void } {
    const path = join(mkdtempSync(join(tmpdir(), "owner-tier-")), "mail.sqlite"), db = new Database(path);
    db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,wake_id TEXT);
      CREATE TABLE telegram_messages(message_id INTEGER PRIMARY KEY,mail_id TEXT,sent_at INTEGER);`);
    const table = listed.map(kind => `${OWNER_MESSAGE_PREFIXES["hard-stop"]}${kind}:`);
    let routine = 2, message = 0;
    return {
      path,
      close: () => db.close(),
      sentAt: id => (db.query("SELECT sent_at FROM telegram_messages WHERE mail_id=?").get(id) as { sent_at: number } | null)?.sent_at ?? null,
      // Sends what its table lists, and two routine rows a day; holds the rest.
      send: async now => {
        for (const { id } of db.query("SELECT id FROM messages WHERE wake_state='pending' ORDER BY rowid").all() as { id: string }[]) {
          if (table.some(prefix => id.startsWith(prefix)) || routine-- > 0) db.query("INSERT INTO telegram_messages VALUES(?,?,?)").run(++message, id, now);
          db.query("UPDATE messages SET wake_state=? WHERE id=?").run(db.query("SELECT 1 FROM telegram_messages WHERE mail_id=?").get(id) ? "woken" : "held", id);
        }
      },
    };
  }
  test("passes when the table lists every hard-stop kind", async () => {
    const mail = standIn(KINDS);
    try { expect(await proveHardStopTier(mail, hardStopIds())).toEqual({ controlHeld: true, unsent: [] }); } finally { mail.close(); }
  });
  for (const removed of KINDS) test(`fails when '${removed}' is removed from the table`, async () => {
    const mail = standIn(KINDS.filter(kind => kind !== removed));
    try { expect(await proveHardStopTier(mail, hardStopIds())).toEqual({ controlHeld: true, unsent: hardStopIds([removed]) }); } finally { mail.close(); }
  });
});

// The real mail table. The mail checkout is a separate repository: it is absent
// in this repository's CI, and until the gate is installed it has no tier
// table. In both cases this is skipped, and a skipped test is not proof. Run
// it on the Mac with FACTORY_REQUIRE_MAIL_SOURCE=1 before install and after any
// change to the mail table; there a missing checkout or table is a failure.
const source = realMailSource();
const table = source !== null && existsSync(join(source, "src/owner-budget.ts"));
describe.skipIf(!table && process.env.FACTORY_REQUIRE_MAIL_SOURCE !== "1")("hard stops in the real mail table", () => {
  test("every hard-stop id the launcher can build is sent in the next cycle with the day's count spent", async () => {
    if (!table) throw Error("the mail checkout has no tier table (src/owner-budget.ts), so no hard-stop kind has an entry");
    const mail = await openRealMailStore();
    try {
      const result = await proveHardStopTier({ path: mail.path, send: now => mail.sendToVincent(now), sentAt: mail.telegramSentAt }, hardStopIds());
      // A routine row was sent after six others: nothing is being held, so the hard stops prove nothing.
      expect(result.controlHeld).toBe(true);
      expect(result.unsent).toEqual([]);
      expect(mail.revision).toMatch(/^[a-f0-9]{40}$/);
    } finally { mail.close(); }
  });
});
