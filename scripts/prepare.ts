import {jobEnvironment} from '../launcher/job-environment';
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { root, configAt } from "../launcher/config";
import { randomBytes } from "node:crypto";
import { Store } from "../tracking/store";
await configAt();
mkdirSync(root, { recursive: true, mode: 0o700 });
const s = new Store(join(root, "controller.sqlite"));
if (!existsSync(join(root, "owner-token"))) {
  writeFileSync(join(root, "owner-token"), randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
  s.event(
    "prepare:token",
    "setup",
    { file: "owner-token" },
    "Archive owner-token to rotate it; prepare creates a replacement",
  );
}
const xml = (x: string) =>
  x
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const repo = resolve(import.meta.dir, "..");
const env = `<key>EnvironmentVariables</key><dict>${Object.entries(jobEnvironment(process.env.HOME!,process.execPath,root)).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>`;
for (const [name, args, extra] of [
  [
    "tick",
    [join(repo, "launcher/tick.ts")],
    "<key>StartInterval</key><integer>60</integer>",
  ],
  ["board", [join(repo, "board/server.ts")], "<key>KeepAlive</key><true/>"],
  ["health",[join(repo,"scripts/factory-health-watch.ts")],`<key>StartCalendarInterval</key><array>${Array.from({length:12},(_,i)=>`<dict><key>Minute</key><integer>${i*5}</integer></dict>`).join('')}</array>`],
  ["product-top-up",[join(repo,"scripts/product-top-up.ts")],"<key>StartInterval</key><integer>1200</integer>"],
  ["maintenance",[join(repo,"scripts/maintain-factory.ts"),"--once"],"<key>StartInterval</key><integer>300</integer>"],
] as const) {
  const path = join(root, `com.agent-factory.${name}.plist`);
  if (existsSync(path)) {
    console.log(`Preserved existing ${path}`);
    continue;
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.agent-factory.${name}</string><key>ProgramArguments</key><array>${[process.execPath, ...args].map((x) => `<string>${xml(x)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(repo)}</string>${env}${extra}<key>RunAtLoad</key><${name==='tick'||name==='board'?'true':'false'}/><key>StandardOutPath</key><string>${xml(join(root, `${name}.log`))}</string><key>StandardErrorPath</key><string>${xml(join(root, `${name}.error.log`))}</string></dict></plist>`;
  writeFileSync(path, plist, { mode: 0o600, flag: "wx" });
  s.event(
    `prepare:${name}`,
    "setup",
    { path },
    `Archive ${path}; nothing has been loaded`,
  );
}
s.close();
console.log(
  "Prepared private plists and token. No job loaded. Coordinator review is required before install.",
);
