# Failure ledger

In plain words: the factory already notices and logs problems, but each sighting stands alone, so 33 failures with one cause look like 33 problems. The ledger is one list of named problem classes. A small background job reads what the factory already records and files every failure under its class. In this first version it records only: it sends no mail, opens no issue, holds no work and touches no limit.

- `launcher/ledger.ts` holds the whole schema, every transition and the loader for rule and step files.
- `launcher/fingerprint.ts` turns a failure's text into a signature.
- `scripts/ledger-ingest.ts` is the ledger job.
- `scripts/ledger.ts` is the operator command.
- `scripts/install-ledger.ts` prepares and loads the job.

The shared formats (kinds, states, owners, the inbox, the heartbeat, the export) come from the [loop contract](loop-contract.md). Later packages add files beside these; they do not edit them.

## One writer

Only the ledger job opens `health/ledger.sqlite` for writing. launchd runs it every five minutes (at minutes 2, 7, 12 …, two minutes after the health job), at background priority, apart from the tick. The tick, the health job and every other program read `health/ledger-export.json`, never the ledger. A lock folder keeps two runs from overlapping.

The operator command may open the ledger read-only to look (`show`, `reductions`, `reconcile`). It never writes it.

## What the job reads

| Source | What becomes an occurrence | Kind |
| --- | --- | --- |
| `controller.sqlite`, `events` | every `worker-failure` event | failure |
| `tick.log` | every line with `"status":"error"` | failure |
| `health/controller-alerts.sqlite`, `incidents` | `factory-tick-error` | failure |
| | `factory-paused-ready` | limit |
| `health/idle-queue.sqlite`, `incidents` | `factory-idle-queue` | failure |
| | `factory-queue-observation` | evidence-gap |
| either incident table | a type the job does not know | instrumentation |

An incident type nobody listed is filed as a gap in the ledger itself. It is never guessed to be a failure or a limit. `health/state.sqlite` (the health evaluator's episodes) is not classified here; rule files can read it. No existing detector is edited.

A newly installed ledger starts at the present. Earlier history is a separate backfill.

**How sources are read.** A source database is opened read-only, for one statement of at most 200 rows, and closed again. Nothing is open between batches, so no lock or snapshot is held while the job works or waits. `tick.log` is read in pieces of 256 KB from a byte position. A line that is not a tick result is skipped and counted. A source that cannot be read is retried on the next run and the others carry on.

**Bounds.** A run stops itself after 60 seconds and carries on from the same place next time; whatever it had read is recorded first. One run takes at most 5,000 rows per table and 8 MB of log. These are the ledger's own bounds. None is a factory limit and none can be set from outside the source file.

**Disk.** When disk admission is refused the job writes counts only: each occurrence is still counted against its class, and no evidence is stored. That is the disk limit doing its job, so it is not an alarm.

## Classes

A class is one problem. It has a stable id, given the first time its signature is seen, for example `sqliteerror-database-is-locked-13a2d7`. The id is lower-case and safe as a folder name. Issue links, fix links, regression folders and lesson rows hang on the class id only.

**Signatures.** `fingerprint.ts` strips what changes between sightings (home folders, session and commit ids, times, numbers) and keeps the rest. Signatures map to class ids through a table, and each row stores the normaliser version and the first 500 characters of the raw text. When the normaliser is retuned its version is raised; on the next run the job re-maps every stored sample to its new signature and points it at the class it already had. No class id is created, changed or removed. If two classes now share a signature, the older class keeps it and the newer gets a note; joining them stays an operator's merge. If a text cannot be fingerprinted at all, a hash of the raw text is used and counted.

**Fields.** Kind, state, a one-line summary, owner role, where the fix lives (launcher or product repository), the loop switch that governs it and its record-only ("shadow") mark, first and last seen, occurrence count, "needs operator since", a due date, and for anything parked: until when and why.

- The owner role is set only by the contract's `ownerRole`. No caller can pass one.
- A class is shadow while the loop switch that governs it is not acting. Everything the job itself records is governed by `ledger-rules-silent-failures`. A class with no switch (a declared one, for example) is not shadow.

**Evidence** is a reference plus an excerpt of at most 4 KB, and at most 20 excerpts per class. Every occurrence also keeps its source and reference.

**Kinds:** failure, limit, limit-review, evidence-gap, release-input, safeguard-not-proven, instrumentation, proof-owed, operator-overdue.

A limit doing its job (a usage stop, an unqualified worker, a disk refusal, a pause) is counted. The ledger refuses to ticket it, mark it fixed, verify it, close it "with proof" or park it on a person.

**States and the transitions that add.** Any rule, step or inbox record may cause these.

| Transition | From | To |
| --- | --- | --- |
| (first sight) | | open |
| ticket | open, recurred | ticketed |
| fix-installed | open, ticketed, recurred | fix-installed |
| verify | fix-installed | verifying |
| close-with-proof | verifying | closed-with-proof |
| recur | fix-installed, verifying, closed-with-proof, resolved-no-fix | recurred |
| reopen | resolved-no-fix | open |
| resolve-no-fix | open, ticketed, recurred, waiting-on-human | resolved-no-fix |
| wait-on-human | open, ticketed, recurred | waiting-on-human |
| park-expired | deferred, waiting-on-human | open |

- A close needs the number of real successes the contract's proof table gives for that kind. Fewer is refused.
- A class that had ended and is seen again reopens by itself: "recurred" if it closes by proof, "open" if it simply ends when its condition ends.
- Only a step on the contract's coded list (a sign-in, his decision on a named switch, starting an operator session) can wait on a person, and every wait has an expiry.
- Every transition is appended to a history that cannot be updated or deleted.

**The transitions that reduce.** These are the whole list:

| Command | What it does |
| --- | --- |
| `merge <class> <other>` | Joins two classes of the same kind. The older class keeps its id; the newer stays on file, pointing at it. |
| `split <class> --signature … --summary …` | Makes the named signatures their own class. The part with more occurrences keeps the id and its links. |
| `defer <class> --until <date>` | Parks the class until the date. |
| `accept-risk <class> --until <date>` | Parks the class as an accepted risk until the date. |
| `dismiss <class>` | Ends the class without a fix. |

Each needs `--actor` and `--reason`, and the local owner token (`FACTORY_OWNER_TOKEN`, as for `scripts/control.ts`). Parking is at most 30 days; when it expires the class is open again. `scripts/ledger.ts` does not write the ledger: it signs the request with the owner token and leaves it in `health/ledger-commands/`. The job checks the signature against the `owner-token` file and carries the request out on its next run. A request that is unsigned, altered or signed with anything else is refused and logged, and with no token file every request is refused. `bun scripts/ledger.ts reductions` lists every reducing transition ever applied, with who and why.

On a single-user Mac this is a convention with a signature, not real authentication: sandboxed builders and owner wakes cannot read the token, but an unsandboxed session could.

## The inbox

Any job may drop one JSON file per record in `health/ledger-inbox/` (see the contract for the format). The inbox can only add:

| Record | Effect |
| --- | --- |
| declare | one occurrence of a class named by its signature |
| release-input | one occurrence of that input's class (`release-input-<name>`) |
| issue-link | hangs the issue on the class and moves it to ticketed (refused for a limit) |
| fix-link | hangs the pull request on the class |
| drill-result | evidence on the named class; a failed drill is a safeguard-not-proven occurrence |
| proof-owed | a dated proof-owed class with the named role |
| proof-attached | evidence on that proof, which then ends |
| human-step-request | the class waits on a person for a step on the coded list |

A record of a reducing type, or anything else the contract's parser rejects, is refused, logged to `ledger.error.log`, kept in the ledger's `received` table and moved to `ledger-inbox/refused/`. Applied files move to `ledger-inbox/applied/`. Nothing is deleted. The same record dropped twice changes nothing.

## Rule files and step files

The job loads every `.ts` file in `launcher/rules/` and then, after ingest, every file in `launcher/ledger-steps/`, in name order. Neither folder holds a file yet.

A rule file default-exports `{ id, switch?, eventKinds?, run(input) }`. `run` gets this run's new controller events (only the kinds it asked for), tick lines and health incidents, the current classes, the loop switches, and `query(source, sql, params)` for one bounded read-only statement. It returns findings and may hand over the nights-missed number. A rule never writes anything; the job records what it returns.

A step file default-exports `{ id, run(context) }`. A step may read the ledger and use the adding transitions. The reducing ones are not available to it.

Each rule and step runs alone. One that throws, fails to load, returns something unusable or runs past the 60-second limit becomes a `rule-error-<id>` class, counted once per run, and the rest continue. A rule that blocks without yielding cannot be interrupted from inside the process; the stale heartbeat is what shows it.

Both folders are imported into an unsandboxed job, so they are protected paths (below). A rule or step is added only by a reviewed operator change. Keep statements small and indexed: a slow statement against a health database makes its writer wait.

## Heartbeat, export and reconciliation

`health/ledger-heartbeat.json` is written at the end of every run in the contract's shape: `at`, `behindMs`, an optional `alarm`, plus the run's counts and `newestIngestedAt`, the time of the newest source event ingested. `behindMs` is how long ago the ledger was last caught up with every source; it is 0 when this run read everything. A fresh file alone proves nothing: read `behindMs` and `alarm`.

`alarm` is set when:

- the ledger is more than 15 minutes behind and has not caught up in 3 runs in a row;
- 3 runs in a row stopped at the 60-second limit;
- a rule or step failed in this run;
- the loop switch file could not be trusted;
- the run itself failed (the ledger could not be opened, for example).

It clears by itself on the first run where none of these holds.

`health/ledger-export.json` is written by the job, and only the job, at the end of every run: one line per class and the nights-missed number, which stays null until a rule or step has supplied it.

`bun scripts/ledger.ts reconcile` compares the sources with the ledger for everything read since the ledger started. Every `worker-failure` event and every failed tick must be exactly one occurrence, so `difference` must be 0.

## Install and undo

Operator only, after the source is reviewed, merged and installed. Not inside the release window.

1. `bun scripts/install-ledger.ts` writes and lints the job definition in the private factory directory and records the current `autonomy.auto_approval.protected_paths` in a receipt. It starts nothing.
2. Add the entries it reports as missing to `protected_paths` in the private factory config: `launcher/ledger.ts`, `launcher/fingerprint.ts`, `scripts/ledger-ingest.ts`, `launcher/rules`, `launcher/ledger-steps`, `scripts/ledger.ts`, `scripts/install-ledger.ts`. The installer never edits that config.
3. `bun scripts/install-ledger.ts --install` refuses unless every entry is present and the registered checkout is clean `main`. It then loads `com.agent-factory.ledger`, reads the loaded job back and records a second receipt, which holds the protected paths after the change.
4. Read `health/ledger-heartbeat.json` after the first run.

Two things can only be seen a day later. The installer drops a proof-owed record for each, owned by Platform and due in 24 hours, so they are dated items in the ledger rather than a memory:

- `ledger-reconciles-first-day`: `reconcile` shows difference 0.
- `ledger-leaves-the-tick-alone`: the tick's 95th-percentile duration is within 10% of the day before, and `tick.log` and `health.log` hold no "database is locked".

Undo: `launchctl bootout gui/<uid>/com.agent-factory.ledger`, archive the plist, and revert the source with a signed revert. Keep `health/ledger.sqlite`, the inbox and the receipts. Remove the protected-path entries only together with the source revert.

## Known limits

- The job is not on the scheduled-job list that `scripts/check-job-environment.ts` checks; that list lives in a file this change does not touch.
- Fingerprints can join unrelated failures or split one cause. The backfill measures this, and merge and split are recorded commands.
- The ledger sees only what reaches the controller events, `tick.log` and the two incident tables. A failure that leaves no trace there is not recorded.
