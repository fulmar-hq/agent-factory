import { Database } from "bun:sqlite";
import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../tracking/store";
import { root, configAt } from "../launcher/config";
import { mailHook } from "../launcher/telegram";
// Explicit setup only, after review. No polling, sends, historical commands or job loading.
await configAt();
const mail = resolve(
  process.argv[2] ?? join(homedir(), ".alido-private/mail/mail.sqlite"),
);
const link = join(root, "telegram-mail.sqlite");
if (existsSync(link))
  throw Error("Existing integration retained; reconcile before changing it");
const db = new Database(mail, { readwrite: true });
try {
  db.exec("PRAGMA busy_timeout=10000");
  db.transaction(() => {
    db.exec(mailHook);
  }).immediate();
  symlinkSync(mail, link);
  const s = new Store(join(root, "controller.sqlite"));
  try {
    s.event(
      "prepare:telegram",
      "setup",
      { mail },
      "Archive telegram-mail.sqlite symlink; disable factory_command_intake trigger after archiving its SQL; retain commands/messages and reconcile pending commands before disabling",
    );
  } finally {
    s.close();
  }
} finally {
  db.close();
}
console.log(
  "Prepared existing verified-sender mail integration. No job loaded; no messages sent.",
);
