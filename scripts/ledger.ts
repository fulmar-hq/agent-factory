#!/usr/bin/env bun
// The ledger's operator command. Looking is read-only. The five commands that
// reduce are the whole list; each needs the local owner token, a named actor
// and a reason, and each is carried out by the ledger job on its next run, so
// the job stays the only writer:
//   bun scripts/ledger.ts show [<class id>]
//   bun scripts/ledger.ts reductions
//   bun scripts/ledger.ts reconcile
//   bun scripts/ledger.ts merge <class> <other class> --actor "<name>" --reason "<why>"
//   bun scripts/ledger.ts split <class> --signature "<signature>" [--signature ...] --summary "<line>" --actor "<name>" --reason "<why>"
//   bun scripts/ledger.ts defer <class> --until <YYYY-MM-DD> --actor "<name>" --reason "<why>"
//   bun scripts/ledger.ts accept-risk <class> --until <YYYY-MM-DD> --actor "<name>" --reason "<why>"
//   bun scripts/ledger.ts dismiss <class> --actor "<name>" --reason "<why>"
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../launcher/config";
import { LEDGER_COMMANDS_DIR, Ledger, signCommand, type OperatorCommand } from "../launcher/ledger";
import { LOOP_FILES, REDUCING_TRANSITIONS } from "../launcher/loop-contract";
import { SOURCE_FILES, sourceRows } from "./ledger-ingest";

export type Reduction = Pick<OperatorCommand, "action" | "classId" | "actor" | "reason" | "until" | "other" | "signatures" | "summary">;
/** Signs one reducing request and leaves it for the ledger job. Returns the file it wrote. */
export function queueOperatorCommand(dir: string, token: string, request: Reduction, now = Date.now()): string {
  const body = { version: 1 as const, at: now, ...request };
  const id = `${request.action}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20)}`;
  const signed = signCommand({ ...body, id }, token);
  const folder = join(dir, LEDGER_COMMANDS_DIR),
    path = join(folder, `${id}.json`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(signed) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return path;
}

type Side = { source: number; ledger: number; missing: string[] };
export type Reconciliation = { since: number | null; through: { events: number; tickLogBytes: number }; workerFailures: Side; tickErrors: Side; difference: number };
/**
 * Compares what the sources hold with what the ledger recorded, for everything
 * the ledger has read since it started. Each worker-failure event and each
 * failed tick must be exactly one occurrence, so `difference` must be 0.
 * Everything is opened read-only, in bounded batches.
 */
export function reconcile(dir: string): Reconciliation {
  const ledger = new Ledger(join(dir, LOOP_FILES.ledger), { readonly: true });
  try {
    const held = (source: string, refs: string[]) => new Set((ledger.db.query(`SELECT source_ref FROM occurrences WHERE source=? AND source_ref IN (${refs.map(() => "?").join(",") || "NULL"})`).all(source, ...refs) as { source_ref: string }[]).map((row) => row.source_ref));
    const count = (source: string) => (ledger.db.query("SELECT count(*) AS n FROM occurrences WHERE source=?").get(source) as { n: number }).n;
    const side = (source: string): Side => ({ source: 0, ledger: count(source), missing: [] });
    const check = (into: Side, source: string, refs: string[]) => {
      const found = held(source, refs);
      into.source += refs.length;
      for (const ref of refs) if (!found.has(ref) && into.missing.length < 50) into.missing.push(ref);
    };
    const first = (name: string) => ledger.meta<number>(`first-cursor:${name}`) ?? 0,
      last = (name: string) => ledger.meta<number>(`cursor:${name}`) ?? 0;

    const workerFailures = side("worker-failure");
    for (let at = first("events"); at < last("events"); ) {
      const batch = sourceRows<{ seq: number; id: string }>(join(dir, SOURCE_FILES.controller), "SELECT rowid AS seq,id FROM events WHERE rowid>? AND rowid<=? AND kind='worker-failure' ORDER BY rowid LIMIT 200", [at, last("events")]);
      check(workerFailures, "worker-failure", batch.map((row) => row.id));
      if (batch.length < 200) break;
      at = batch[batch.length - 1]!.seq;
    }

    const tickErrors = side("tick-error"),
      log = join(dir, "tick.log"),
      end = last("tick-log");
    if (existsSync(log) && end > first("tick-log")) {
      const fd = openSync(log, "r");
      try {
        let rest = "";
        for (let at = first("tick-log"); at < end; ) {
          const bytes = Buffer.alloc(Math.min(256 * 1024, end - at));
          const got = readSync(fd, bytes, 0, bytes.length, at);
          if (got <= 0) break;
          at += got;
          const lines = (rest + bytes.subarray(0, got).toString("latin1")).split("\n");
          rest = lines.pop() ?? "";
          const refs = lines.flatMap((line) => {
            try {
              const parsed = JSON.parse(line) as { at?: unknown; status?: unknown };
              return parsed.status === "error" && Number.isSafeInteger(parsed.at) ? [String(parsed.at)] : [];
            } catch {
              return [];
            }
          });
          for (let n = 0; n < refs.length; n += 200) check(tickErrors, "tick-error", refs.slice(n, n + 200));
        }
      } finally {
        closeSync(fd);
      }
    }
    const off = (s: Side) => (s.source === s.ledger && !s.missing.length ? 0 : Math.max(Math.abs(s.source - s.ledger), s.missing.length));
    return { since: ledger.meta<number>("started-at"), through: { events: last("events"), tickLogBytes: end }, workerFailures, tickErrors, difference: off(workerFailures) + off(tickErrors) };
  } finally {
    ledger.close();
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const options = (flag: string) => rest.flatMap((value, n) => (rest[n - 1] === flag ? [value] : []));
  const positional = rest.filter((value, n) => !value.startsWith("--") && !rest[n - 1]?.startsWith("--"));
  const path = join(root, LOOP_FILES.ledger);
  if (command === "reconcile") console.log(JSON.stringify(reconcile(root), null, 2));
  else if (command === "show" || command === "reductions") {
    const ledger = new Ledger(path, { readonly: true });
    try {
      if (command === "reductions") console.log(JSON.stringify(ledger.transitions(true), null, 2));
      else if (positional[0]) console.log(JSON.stringify({ class: ledger.classOf(positional[0]), signatures: ledger.signaturesOf(positional[0]), links: ledger.linksOf(positional[0]), evidence: ledger.evidenceOf(positional[0]), history: ledger.transitions().filter((t) => t.classId === positional[0]) }, null, 2));
      else console.log(JSON.stringify(ledger.classes(), null, 2));
    } finally {
      ledger.close();
    }
  } else if ((REDUCING_TRANSITIONS as readonly string[]).includes(command ?? "") && positional[0]) {
    // The same local owner authorization as scripts/control.ts: never given to workers.
    const expected = (await Bun.file(join(root, "owner-token")).text()).trim(),
      provided = process.env.FACTORY_OWNER_TOKEN ?? "";
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw Error("owner authorization required");
    const until = options("--until")[0] ? Date.parse(`${options("--until")[0]}T23:59:59`) : undefined;
    if (until !== undefined && !Number.isFinite(until)) throw Error("--until must be a YYYY-MM-DD date");
    const file = queueOperatorCommand(root, expected, {
      action: command as OperatorCommand["action"],
      classId: positional[0],
      actor: options("--actor")[0] ?? "",
      reason: options("--reason")[0] ?? "",
      until,
      other: command === "merge" ? positional[1] : undefined,
      signatures: command === "split" ? options("--signature") : undefined,
      summary: options("--summary")[0],
    });
    console.log(JSON.stringify({ queued: file, appliedBy: "the ledger job, on its next run (within five minutes); read the result with: bun scripts/ledger.ts reductions" }));
  } else throw Error(`usage: ledger.ts show [<class>] | reductions | reconcile | <${REDUCING_TRANSITIONS.join("|")}> <class> --actor "<name>" --reason "<why>" [--until YYYY-MM-DD] [--signature "<s>" --summary "<line>"]`);
}
