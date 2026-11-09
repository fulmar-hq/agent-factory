#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Watchdog, WatchdogSnapshotSchema } from "../launcher/watchdog";

// Explicit paths only: never discover private configuration or contact services.
// bun scripts/watchdog.ts --state PRIVATE/watchdog.sqlite --input snapshot.json
// Input uses epoch milliseconds, complete ready/free-capacity evidence, actual
// last ticket state advancement (not heartbeat), and explicit Toronto windows.
// Receipt completeness must come from a successful authoritative executor read.
export function watchdogCli(args: string[]) {
  if (args.length !== 4 || args[0] !== "--state" || !args[1] || args[2] !== "--input" || !args[3])
    throw Error("Usage: bun scripts/watchdog.ts --state PATH --input SNAPSHOT.json");
  const snapshot = WatchdogSnapshotSchema.parse(JSON.parse(readFileSync(args[3], "utf8")));
  const watchdog = new Watchdog(args[1]);
  try { return { status: "ok", ...watchdog.poll(snapshot), notification: "local outbox only; no message delivered" }; }
  finally { watchdog.close(); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(watchdogCli(process.argv.slice(2)))); }
  catch (error) {
    console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
