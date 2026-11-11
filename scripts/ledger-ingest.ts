#!/usr/bin/env bun
// The ledger job: the one program that writes the failure ledger. launchd runs
// it every five minutes, apart from the tick. It reads what the factory already
// records (controller events, the health incident tables and tick.log), files
// each failure under a named class and writes a heartbeat and an export file.
//
// It records only: no mail, no issue, no hold, no model, no child process.
// Source databases are opened read-only for one bounded statement and closed
// again, so no lock or snapshot is ever held between batches. A run stops
// itself after 60 seconds and carries on from the same place next time.
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../launcher/config";
import { diskReading, requireDiskCapacity, type DiskReading } from "../launcher/disk";
import { NORMALISER } from "../launcher/fingerprint";
import { LEDGER_COMMANDS_DIR, Ledger, RULES_DIR, STEPS_DIR, clip, loadFolder, verifyCommand, type Finding, type LedgerRule, type LedgerStep, type RuleInput, type SourceEvent, type SourceIncident, type SourceName, type TickLine } from "../launcher/ledger";
import { LOOP_FILES, parseInboxRecord, type ClassKind, type LoopHeartbeat } from "../launcher/loop-contract";
import { readLoopFlags, type LoopSwitch } from "../launcher/loop-flags";

const MINUTE = 60_000;
/** The ledger's own bounds. None of them is a factory limit and none can be set from outside this file. */
export const RUN_LIMIT_MS = 60_000;
export const BEHIND_ALARM_MS = 15 * MINUTE;
export const ALARM_RUNS = 3;
export const BATCH_ROWS = 200;
const ROWS_PER_RUN = 5000;
const LOG_BATCH_BYTES = 256 * 1024;
const LOG_BYTES_PER_RUN = 8 * 1024 * 1024;
const DROPPED_FILES_PER_RUN = 200;
const DROPPED_FILE_BYTES = 64 * 1024;

export const SOURCE_FILES: Record<SourceName, string> = {
  controller: "controller.sqlite",
  "controller-alerts": "health/controller-alerts.sqlite",
  "idle-queue": "health/idle-queue.sqlite",
  "health-state": "health/state.sqlite",
};
/** The only way this job opens a source database: read-only, never created, never written. */
export function openSource(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON");
  return db;
}
/**
 * One statement, at most 200 rows, then the database is closed again: nothing
 * is held while the caller works. Only the first statement of `sql` ever runs.
 */
export function sourceRows<T>(path: string, sql: string, params: (string | number | null)[] = []): T[] {
  const db = openSource(path);
  try {
    const rows: T[] = [];
    for (const row of db.query(sql).iterate(...params)) if (rows.push(row as T) >= BATCH_ROWS) break;
    return rows;
  } finally {
    db.close();
  }
}

// What the job itself records, before any rule file exists. Everything it
// opens is record-only until this loop switch is turned on.
const RECORDED_UNDER: LoopSwitch = "ledger-rules-silent-failures";
/** Health incident types this job knows. An unknown type is a gap in the ledger, never guessed to be a failure or a limit. */
const INCIDENT_KINDS: Record<string, ClassKind> = {
  "factory-tick-error": "failure",
  "factory-idle-queue": "failure",
  "factory-paused-ready": "limit",
  "factory-queue-observation": "evidence-gap",
};
const INCIDENT_TABLES = [
  { source: "controller-alerts", select: "id,at,summary,NULL AS detail" },
  { source: "idle-queue", select: "id,opened AS at,NULL AS summary,substr(evidence,1,4096) AS detail" },
] as const;

function eventFinding(e: SourceEvent): Finding | null {
  if (e.kind !== "worker-failure") return null;
  let error: unknown;
  try {
    error = JSON.parse(e.data).error;
  } catch {
    // The stored event was longer than the 4 KB that was read.
    error = e.data.match(/"error":"((?:[^"\\]|\\.)*)/)?.[1];
  }
  return { kind: "failure", text: typeof error === "string" && error ? error : e.data, at: e.at, source: "worker-failure", ref: e.id, switch: RECORDED_UNDER, evidence: { ref: `controller.sqlite events ${e.id}`, excerpt: e.data } };
}
function tickFinding(line: TickLine): Finding | null {
  if (line.status !== "error") return null;
  return { kind: "failure", text: line.error || "tick failed with no message", at: line.at, source: "tick-error", ref: String(line.at), switch: RECORDED_UNDER, evidence: { ref: `tick.log@${line.offset}`, excerpt: line.raw } };
}
function incidentFinding(i: SourceIncident): Finding {
  const type = i.id.split(":")[0]!,
    kind = INCIDENT_KINDS[type];
  const evidence = { ref: `${SOURCE_FILES[i.source]} incidents ${i.id}`, excerpt: i.detail ?? i.summary ?? undefined };
  if (!kind) return { kind: "instrumentation", text: `unrecognised ${i.source} incident type ${type}`, summary: `The ledger has no kind for ${i.source} incident type "${type}"`, at: i.at, source: i.source, ref: i.id, switch: RECORDED_UNDER, evidence };
  return { kind, text: `${type}: ${i.summary ?? i.source}`, summary: i.summary ?? `${i.source} incident ${type}`, at: i.at, source: i.source, ref: i.id, switch: RECORDED_UNDER, evidence };
}

// ----------------------------------------------------------------- reading
type Guard = { expired(): boolean; pause(): Promise<void> };
/** `start` is where a never-read source began; it is kept so a reconciliation knows the period. */
type Cut<T> = { rows: T[]; start: number | null; cursor: number | null; caughtUp: boolean };

/**
 * Reads a table forward from a row cursor in bounded batches. Only what was
 * fully read moves the cursor. A source's starting place is fixed the first
 * time it is seen, even by a run that has no time left to read it, so nothing
 * that arrives after that is ever skipped.
 */
async function readTable<T extends { seq: number }>(path: string, table: string, select: string, where: string, params: string[], cursor: number | null, fromStart: boolean, guard: Guard): Promise<Cut<T>> {
  const top = sourceRows<{ top: number }>(path, `SELECT coalesce(max(rowid),0) AS top FROM ${table}`)[0]!.top;
  let at = cursor ?? (fromStart ? 0 : top);
  if (at > top) at = 0; // the source was replaced by an older or a new file
  const start = at,
    rows: T[] = [];
  while (at < top) {
    await guard.pause();
    if (guard.expired() || rows.length >= ROWS_PER_RUN) return { rows, start, cursor: at, caughtUp: false };
    const batch = sourceRows<T>(path, `SELECT rowid AS seq,${select} FROM ${table} WHERE rowid>? AND rowid<=? ${where} ORDER BY rowid LIMIT ${BATCH_ROWS}`, [at, top, ...params]);
    rows.push(...batch);
    at = batch.length < BATCH_ROWS ? top : batch[batch.length - 1]!.seq;
  }
  return { rows, start, cursor: at, caughtUp: true };
}

/** Reads whole lines of tick.log forward from a byte cursor. A line that is not a tick result is skipped and counted. */
async function readTickLog(path: string, cursor: number | null, fromStart: boolean, guard: Guard): Promise<Cut<TickLine> & { corrupt: number }> {
  if (!existsSync(path)) return { rows: [], start: 0, cursor: 0, caughtUp: true, corrupt: 0 };
  const size = statSync(path).size;
  let at = cursor ?? (fromStart ? 0 : size),
    corrupt = 0,
    used = 0;
  if (at > size) at = 0; // rotated or truncated
  const start = at,
    rows: TickLine[] = [];
  while (at < size) {
    await guard.pause();
    if (guard.expired() || used >= LOG_BYTES_PER_RUN) return { rows, start, cursor: at, caughtUp: false, corrupt };
    const bytes = Buffer.alloc(Math.min(LOG_BATCH_BYTES, size - at));
    const fd = openSync(path, "r");
    let got: number;
    try {
      if (fstatSync(fd).size < at) return { rows, start, cursor: 0, caughtUp: false, corrupt };
      got = readSync(fd, bytes, 0, bytes.length, at);
    } finally {
      closeSync(fd);
    }
    used += got;
    const end = bytes.subarray(0, got).lastIndexOf(10);
    if (end < 0) {
      if (got < LOG_BATCH_BYTES) break; // an unfinished last line: wait for the rest
      corrupt++; // one line longer than a whole batch
      at += got;
      continue;
    }
    let offset = at;
    for (const line of bytes.subarray(0, end).toString().split("\n")) {
      const lineOffset = offset;
      offset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { at?: unknown; status?: unknown; error?: unknown };
        if (!Number.isSafeInteger(parsed.at) || (parsed.at as number) <= 0 || typeof parsed.status !== "string") throw Error("not a tick result");
        rows.push({ offset: lineOffset, at: parsed.at as number, status: parsed.status, error: typeof parsed.error === "string" ? parsed.error : undefined, raw: clip(line) });
      } catch {
        corrupt++;
      }
    }
    at += end + 1;
  }
  return { rows, start, cursor: at, caughtUp: true, corrupt };
}

/** Files other programs dropped for the ledger, oldest name first. Handled files are moved aside, never deleted. */
function dropped(folder: string): { name: string; path: string; raw: unknown; problem?: string }[] {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const out: ReturnType<typeof dropped> = [];
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort().slice(0, DROPPED_FILES_PER_RUN)) {
    const path = join(folder, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size > DROPPED_FILE_BYTES) out.push({ name, path, raw: null, problem: "larger than 64 KB" });
      else out.push({ name, path, raw: JSON.parse(readFileSync(path, "utf8")) });
    } catch (error) {
      out.push({ name, path, raw: null, problem: `unreadable: ${String(error)}` });
    }
  }
  return out;
}
function moveAside(file: { name: string; path: string }, folder: string, outcome: "applied" | "refused") {
  try {
    mkdirSync(join(folder, outcome), { recursive: true, mode: 0o700 });
    renameSync(file.path, join(folder, outcome, file.name));
  } catch {
    // The record is on file in the ledger; a file left behind is skipped next run.
  }
}
function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

// --------------------------------------------------------------- one run
export type IngestOptions = {
  /** The private factory directory. */
  dir: string;
  now?: () => number;
  rulesDir?: string;
  stepsDir?: string;
  disk?: () => DiskReading;
  /** Where a never-run ledger starts. The installed job starts at the present; history is a separate backfill. */
  startAt?: "end" | "beginning";
  /** Runs before every source batch, with no database open. Tests slow the read loop here. */
  betweenBatches?: () => Promise<void> | void;
  log?: (line: string) => void;
};
export type RunReport = {
  at: number;
  behindMs: number;
  alarm?: string;
  newestIngestedAt: number | null;
  occurrences: number;
  classesOpened: number;
  reopened: number;
  corruptLines: number;
  fingerprintFallbacks: number;
  inboxApplied: number;
  inboxRefused: number;
  commandsApplied: number;
  commandsRefused: number;
  ruleErrors: string[];
  sourceErrors: string[];
  stoppedAtLimit: boolean;
  countsOnly: boolean;
  skipped?: string;
};

export async function ingestOnce(o: IngestOptions): Promise<RunReport> {
  const clock = o.now ?? Date.now,
    log = o.log ?? console.error,
    lock = join(o.dir, "health/ledger.lock");
  mkdirSync(join(o.dir, "health"), { recursive: true, mode: 0o700 });
  const empty = (at: number): RunReport => ({ at, behindMs: 0, newestIngestedAt: null, occurrences: 0, classesOpened: 0, reopened: 0, corruptLines: 0, fingerprintFallbacks: 0, inboxApplied: 0, inboxRefused: 0, commandsApplied: 0, commandsRefused: 0, ruleErrors: [], sourceErrors: [], stoppedAtLimit: false, countsOnly: false });
  // One run at a time. A lock left by a killed run is taken over after two run limits.
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // The other run has just finished.
    }
    if (age < 2 * RUN_LIMIT_MS) return { ...empty(clock()), skipped: "another ledger run holds the lock" };
  }
  try {
    return await run(o, clock, log, empty(clock()));
  } catch (error) {
    // The heartbeat must not depend on the ledger opening: a broken run is loud, not silent.
    const report = { ...empty(clock()), alarm: clip(`ledger run failed: ${String(error)}`, 500) };
    writeJson(join(o.dir, LOOP_FILES.ledgerHeartbeat), { at: report.at, alarm: report.alarm } satisfies LoopHeartbeat);
    return report;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Taken over by a later run.
    }
  }
}

async function run(o: IngestOptions, clock: () => number, log: (line: string) => void, report: RunReport): Promise<RunReport> {
  const started = report.at,
    deadline = started + RUN_LIMIT_MS,
    fromStart = o.startAt === "beginning";
  const guard: Guard = {
    expired: () => (clock() >= deadline ? (report.stoppedAtLimit = true) : false),
    pause: async () => void (await o.betweenBatches?.()),
  };
  const ledger = new Ledger(join(o.dir, LOOP_FILES.ledger));
  try {
    const flags = readLoopFlags(o.dir);
    // A disk refusal is the disk limit doing its job. The ledger keeps counting and stores no evidence.
    try {
      requireDiskCapacity(o.disk ?? (() => diskReading(o.dir)));
    } catch {
      report.countsOnly = ledger.countsOnly = true;
    }
    if (ledger.meta<number>("started-at") === null) ledger.setMeta("started-at", started);
    if (ledger.meta<number>("normaliser-version") !== NORMALISER.version) ledger.remapSignatures(NORMALISER, started);
    ledger.expireParked(started);

    const fail = (id: string, error: unknown) => {
      report.ruleErrors.push(id);
      log(`ledger rule error ${id}: ${String(error)}`);
      return { kind: "instrumentation", text: `ledger rule or step failed: ${id}`, summary: `Ledger rule or step "${id}" failed`, classId: `rule-error-${id}`, at: started, source: "rule-error", ref: `${id}:${started}`, evidence: { ref: `ledger run ${started}`, excerpt: String((error as Error)?.stack ?? error) } } satisfies Finding;
    };
    const rules = await loadFolder<LedgerRule>(o.rulesDir ?? RULES_DIR),
      steps = await loadFolder<LedgerStep>(o.stepsDir ?? STEPS_DIR);
    const findings: Finding[] = [...rules.errors, ...steps.errors].map((e) => fail(e.id, e.error));

    // 1. Read. Every source is independent: one that cannot be read is retried next run.
    const source = (name: SourceName) => join(o.dir, SOURCE_FILES[name]);
    const cursors: Record<string, number | null> = {},
      starts: Record<string, number | null> = {},
      caughtUp: string[] = [];
    const reading = async <T>(name: string, work: (cursor: number | null) => Promise<Cut<T>>): Promise<T[]> => {
      try {
        const cut = await work(ledger.meta<number>(`cursor:${name}`));
        cursors[name] = cut.cursor;
        starts[name] = cut.start;
        if (cut.caughtUp) caughtUp.push(name);
        return cut.rows;
      } catch (error) {
        report.sourceErrors.push(`${name}: ${String(error)}`);
        return [];
      }
    };
    const kinds = [...new Set(["worker-failure", ...rules.loaded.flatMap((rule) => rule.eventKinds ?? [])])];
    const events = await reading<SourceEvent>("events", (cursor) => readTable(source("controller"), "events", "id,kind,at,substr(data,1,4096) AS data", `AND kind IN (${kinds.map(() => "?").join(",")})`, kinds, cursor, fromStart, guard));
    const tickLines = await reading<TickLine>("tick-log", async (cursor) => {
      const cut = await readTickLog(join(o.dir, "tick.log"), cursor, fromStart, guard);
      report.corruptLines += cut.corrupt;
      return cut;
    });
    const incidents: SourceIncident[] = [];
    for (const table of INCIDENT_TABLES) {
      const path = source(table.source);
      if (!existsSync(path)) caughtUp.push(table.source); // that detector has not run yet
      else incidents.push(...(await reading<Omit<SourceIncident, "source">>(table.source, (cursor) => readTable(path, "incidents", table.select, "", [], cursor, fromStart, guard))).map((row) => ({ ...row, source: table.source })));
    }
    for (const found of [...events.map(eventFinding), ...tickLines.map(tickFinding), ...incidents.map(incidentFinding)]) if (found) findings.push(found);

    // 2. Rules. Each runs alone: one that throws, or runs past the limit, is itself recorded and the rest continue.
    let nightsMissed = ledger.meta<number>("nights-missed");
    const within = async <T>(work: () => T | Promise<T>): Promise<T> => {
      if (guard.expired()) throw Error("not run: the 60-second limit was reached");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Error("stopped: the 60-second limit was reached")), Math.max(0, deadline - clock()))))]);
      } finally {
        clearTimeout(timer);
        guard.expired();
      }
    };
    const classes = ledger.classes();
    const query: RuleInput["query"] = (name, sql, params = []) => {
      if (!Object.hasOwn(SOURCE_FILES, name)) throw Error(`unknown source: ${String(name)}`);
      return sourceRows(source(name), sql, params);
    };
    for (const rule of rules.loaded) {
      try {
        const out = await within(() => rule.run({ now: started, events: events.filter((e) => rule.eventKinds?.includes(e.kind)), tickLines, incidents, classes, flags, query }));
        const list = Array.isArray(out) ? out : out.findings;
        if (!Array.isArray(out) && Number.isSafeInteger(out.nightsMissed) && out.nightsMissed! >= 0) nightsMissed = out.nightsMissed!;
        for (const found of list) findings.push({ ...found, source: `rule:${rule.id}`, switch: rule.switch ?? null });
      } catch (error) {
        findings.push(fail(rule.id, error));
      }
    }

    // 3. Record, and move the cursors, in one transaction: a run that dies here changes nothing.
    const store = (found: Finding) => {
      const done = ledger.record(found, started);
      if (done.duplicate) return;
      report.occurrences++;
      if (done.created) report.classesOpened++;
      if (done.reopened) report.reopened++;
    };
    ledger.atomic(() => {
      for (const found of findings) {
        try {
          store(found);
        } catch (error) {
          store(fail(found.source.startsWith("rule:") ? found.source.slice(5) : "recording", error));
        }
      }
      for (const [name, cursor] of Object.entries(cursors)) if (cursor !== null) ledger.setMeta(`cursor:${name}`, cursor);
      for (const [name, start] of Object.entries(starts)) if (start !== null && ledger.meta(`first-cursor:${name}`) === null) ledger.setMeta(`first-cursor:${name}`, start);
      for (const name of caughtUp) ledger.setMeta(`caught-up:${name}`, started);
      const newest = Math.max(ledger.meta<number>("newest-ingested-at") ?? 0, ...events.map((e) => e.at), ...tickLines.map((l) => l.at), ...incidents.map((i) => i.at));
      if (newest > 0) ledger.setMeta("newest-ingested-at", newest);
    });

    // 4. What other programs dropped. Operator commands are signed; the inbox can only add.
    let token: string | null = null;
    try {
      token = readFileSync(join(o.dir, "owner-token"), "utf8").trim();
    } catch {
      // Without the token every operator command is refused.
    }
    const commandsDir = join(o.dir, LEDGER_COMMANDS_DIR),
      inboxDir = join(o.dir, LOOP_FILES.ledgerInbox);
    for (const [channel, folder] of [["command", commandsDir], ["inbox", inboxDir]] as const) {
      for (const file of dropped(folder)) {
        if (guard.expired()) break;
        const command = channel === "command" && !file.problem ? verifyCommand(file.raw, token) : null,
          record = channel === "inbox" && !file.problem ? parseInboxRecord(file.raw) : null;
        const parsed = command ?? record,
          id = `${channel}:${command?.ok ? command.command.id : record?.ok ? record.record.id : `file:${file.name}`}`,
          type = command?.ok ? command.command.action : record?.ok ? record.record.type : String((file.raw as { type?: unknown } | null)?.type ?? "unknown").slice(0, 40);
        let refusal = file.problem ?? (parsed && !parsed.ok ? parsed.reason : undefined);
        if (!refusal && ledger.received(id)) {
          moveAside(file, folder, "applied"); // the same record dropped twice changes nothing
          continue;
        }
        try {
          if (command?.ok) log(`ledger operator command applied: ${ledger.reduce(command.command, started)} (by ${command.command.actor})`);
          else if (record?.ok) ledger.applyInbox(record.record, started);
        } catch (error) {
          refusal = String((error as Error)?.message ?? error);
        }
        if (refusal) log(`ledger ${channel} record refused (${file.name}, ${type}): ${refusal}`);
        ledger.receive(refusal ? `${id}:${started}` : id, channel, type, started, refusal ? "refused" : "applied", refusal);
        report[channel === "command" ? (refusal ? "commandsRefused" : "commandsApplied") : refusal ? "inboxRefused" : "inboxApplied"]++;
        moveAside(file, folder, refusal ? "refused" : "applied");
      }
    }

    // 5. After-ingest steps, each alone like a rule.
    for (const step of steps.loaded) {
      try {
        const out = await within(() => step.run({ now: started, dir: o.dir, ledger, flags, countsOnly: report.countsOnly }));
        if (out && Number.isSafeInteger(out.nightsMissed) && out.nightsMissed! >= 0) nightsMissed = out.nightsMissed!;
      } catch (error) {
        try {
          store(fail(step.id, error));
        } catch (again) {
          log(`ledger could not record step error ${step.id}: ${String(again)}`);
        }
      }
    }

    // 6. How far behind, the run on file, the export and the heartbeat.
    const ended = clock();
    const sources = ["events", "tick-log", ...INCIDENT_TABLES.map((t) => t.source)];
    const behind = sources.filter((name) => !caughtUp.includes(name)).map((name) => ended - (ledger.meta<number>(`caught-up:${name}`) ?? ledger.meta<number>("started-at") ?? started));
    report.behindMs = Math.max(0, ...behind);
    report.fingerprintFallbacks = ledger.fallbacks;
    report.newestIngestedAt = ledger.meta<number>("newest-ingested-at");
    report.at = ended;
    ledger.atomic(() => {
      if (nightsMissed !== null) ledger.setMeta("nights-missed", nightsMissed);
      ledger.refreshShadow(flags);
      ledger.db.query("INSERT INTO runs(started_at,ended_at,behind_ms,stopped_at_limit,rule_errors,stats) VALUES(?,?,?,?,?,?)").run(started, ended, report.behindMs, report.stoppedAtLimit ? 1 : 0, report.ruleErrors.length, JSON.stringify(report));
    });
    const recent = ledger.db.query(`SELECT behind_ms,stopped_at_limit FROM runs ORDER BY id DESC LIMIT ${ALARM_RUNS}`).all() as { behind_ms: number; stopped_at_limit: number }[];
    const reasons: string[] = [];
    if (recent.length === ALARM_RUNS && recent.every((r) => r.behind_ms > 0) && report.behindMs > BEHIND_ALARM_MS) reasons.push(`the ledger is ${Math.round(report.behindMs / MINUTE)} minutes behind its sources and has not caught up in ${ALARM_RUNS} runs`);
    if (recent.length === ALARM_RUNS && recent.every((r) => r.stopped_at_limit)) reasons.push(`${ALARM_RUNS} runs in a row stopped at the 60-second limit`);
    if (report.ruleErrors.length) reasons.push(`a ledger rule or step failed: ${[...new Set(report.ruleErrors)].join(", ")}`);
    if (flags.alarm) reasons.push(flags.alarm);
    if (reasons.length) report.alarm = clip(reasons.join("; "), 500);
    writeJson(join(o.dir, LOOP_FILES.ledgerExport), ledger.export(ended, nightsMissed));
    writeJson(join(o.dir, LOOP_FILES.ledgerHeartbeat), report satisfies LoopHeartbeat);
    return report;
  } finally {
    ledger.close();
  }
}
if (import.meta.main) {
  console.log(JSON.stringify(await ingestOnce({ dir: root })));
  // A rule still waiting on something after the limit must not keep the job alive.
  process.exit(0);
}
