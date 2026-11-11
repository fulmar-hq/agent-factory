// Contract tests against the real Alido Mail code. A hand-made `messages`
// table proves only that a row was written; it cannot say what Alido Mail then
// does with it. This helper opens the mail checkout's own store code on a
// temporary database and runs its own delivery steps, with stand-ins only for
// the three outside connections (a Claude chat's socket, the Codex queue
// command and the Telegram connection). It never touches the live mail store,
// a real chat or the real bot.
//
// The mail checkout is a separate repository, so it is absent in this
// repository's CI: tests that need it use `test.skipIf(!realMailSource())`
// and say so. Set FACTORY_REQUIRE_MAIL_SOURCE=1 to make absence a failure.
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the mail checkout is, or null. FACTORY_MAIL_SOURCE overrides the usual place. */
export function realMailSource(): string | null {
  const source = process.env.FACTORY_MAIL_SOURCE ?? join(homedir(), "Developer/alido-agent-mail");
  if (existsSync(join(source, "src/store.ts")) && existsSync(join(source, "src/wake.ts"))) return source;
  if (process.env.FACTORY_REQUIRE_MAIL_SOURCE === "1") throw Error(`Alido Mail checkout not found at ${source}`);
  return null;
}

export type MailRow = { id: string; sender: string; recipient: string; recipient_app: string; kind: string; summary: string; body: string; state: string; wake_state: string; wake_id: string | null };
export type RealMailStore = {
  /** The mail checkout and its commit, for the test's receipt. */
  source: string;
  revision: string | null;
  /** Pass `path` to the writer under test (its mail path argument, or FACTORY_MAIL_DB). */
  dir: string;
  path: string;
  db: Database;
  row(id: string): MailRow | null;
  /** When Alido Mail recorded the Telegram send for this mail, or null if it never did. */
  telegramSentAt(id: string): number | null;
  /** Runs the wake a Claude chat's own mail server runs for `address`. True when a wake was posted. */
  wakeClaude(address: string, now?: number): Promise<boolean>;
  /** Runs the Codex ringer. Only addresses given in `codexThreads` have a thread; the rest fail as they do live. */
  ringCodex(now?: number): Promise<number>;
  /** Runs the one send function for Vincent. Returns the texts the stand-in Telegram connection received. */
  sendToVincent(now?: number): Promise<string[]>;
  /** Another module of the mail checkout by file name, for example "owner-budget". */
  load(module: string): Promise<any>;
  close(): void;
};

export async function openRealMailStore(options: { codexThreads?: Record<string, string> } = {}): Promise<RealMailStore> {
  const source = realMailSource();
  if (!source) throw Error("Alido Mail checkout not found; guard the test with test.skipIf(!realMailSource())");
  const load = (module: string) => import(join(source, "src", `${module}.ts`));
  const [store, wake, telegram, config, directories] = await Promise.all(["store", "wake", "telegram", "config", "directory"].map(load));
  const dir = mkdtempSync(join(tmpdir(), "real-mail-store-"));
  const at = (name: string) => join(dir, name);
  const cfg = config.loadConfig({
    db: at("mail.sqlite"),
    cloudBudgetFile: at("budget.md"),
    claudeLiveDir: at("claude-live"),
    claudeDesktopDir: at("claude-desktop"),
    codexStateDb: at("codex-state.sqlite"),
    codexThreadMap: at("codex-threads.json"),
    activeCoordinatorFile: at("active-coordinator"),
    codexBin: "/bin/false",
    codexQueueDb: at("codex-queue.sqlite"),
    telegramEnv: at("telegram.env"),
    telegramApi: "http://127.0.0.1:9",
    telegramGroupFile: at("telegram-group.json"),
    claudeAppLog: at("main.log"),
    claudeProjectsDir: at("projects"),
    reapLog: at("reap.log"),
    reapCodex: false,
    awsStatusScript: "/nonexistent/aws-login-status.sh",
    awsLoginScript: "/nonexistent/aws-login.sh",
    awsWatch: false,
  });
  // Fail closed if the mail code ever gains a setting this helper does not
  // redirect: nothing may point at the real home directory or a real service.
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value !== "string") continue;
    if ((value.startsWith(homedir()) && !value.startsWith(dir)) || /^https?:\/\/(?!127\.0\.0\.1[:/])/.test(value)) throw Error(`mail setting "${key}" is not redirected to the temporary directory`);
  }
  writeFileSync(cfg.codexThreadMap, JSON.stringify(options.codexThreads ?? {}));
  // A made-up bot identity: the stand-in connection below is what receives the text.
  writeFileSync(cfg.telegramEnv, "TELEGRAM_BOT_TOKEN=0:stand-in\nTELEGRAM_CHAT_ID=1\n", { mode: 0o600 });
  const db: Database = store.openStore(cfg.db);
  const directory = new directories.Directory(cfg);
  const git = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]);
  // Alido Mail waits a few seconds for a burst to settle before it wakes anyone.
  const soon = () => Date.now() + config.LIMITS.settleMs + 1000;
  let telegramMessage = 0;
  return {
    source,
    revision: git.exitCode === 0 ? git.stdout.toString().trim() : null,
    dir,
    path: cfg.db,
    db,
    row: (id) => db.query("select id,sender,recipient,recipient_app,kind,summary,body,state,wake_state,wake_id from messages where id=?").get(id) as MailRow | null,
    telegramSentAt: (id) => (db.query("select sent_at from telegram_messages where mail_id=?").get(id) as { sent_at: number } | null)?.sent_at ?? null,
    wakeClaude: (address, now = soon()) => wake.wakeSelfClaude(db, cfg, address, at("claude.sock"), now, async () => ({ ok: true, detail: "stand-in socket" })),
    ringCodex: (now = soon()) =>
      wake.ringCodex(
        db,
        cfg,
        directory,
        "real-mail-store-test",
        now,
        async (_bin: string, thread: string) => ({ ok: true, detail: `Queued message stand-in for thread ${thread}` }),
        async () => ({ ok: true, detail: "stand-in open" }),
      ),
    sendToVincent: async (now = Date.now()) => {
      const texts: string[] = [];
      await telegram.deliverToVincent(db, cfg, "real-mail-store-test", now, {
        sendMessage: async (text: string) => (texts.push(text), { ok: true, messageId: ++telegramMessage }),
        getUpdates: async () => ({ ok: true, updates: [] }),
        react: async () => ({ ok: true }),
      });
      return texts;
    },
    load,
    close: () => db.close(),
  };
}
