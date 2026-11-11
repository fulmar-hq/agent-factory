# Loop contract

In plain words: the closed-loop work is built as many small packages. This is the one place that says what they must agree on, so that no two of them have to guess a file format, an owner or a message id. It is types, constants and a few pure functions. Nothing calls it yet, so installing it changes no behaviour.

- `launcher/loop-contract.ts` holds the formats.
- `launcher/loop-flags.ts` reads the loop's own switches.
- `scripts/loop-flag.ts` flips one switch.
- `tests/helpers/real-mail-store.ts` lets a test run Alido Mail's real code on a temporary database.

A change to any of these is its own small operator pull request, never bundled into another package. If a package finds the contract is missing something, it stops and asks for that amendment rather than inventing a format.

## What the contract fixes

**Files.** `LOOP_FILES` names every loop file, relative to the private factory directory. Each file has exactly one writer.

| File | Writer | Readers |
| --- | --- | --- |
| `health/heartbeat.json` | health job | anyone |
| `health/ledger.sqlite` | ledger job | ledger job only |
| `health/ledger-heartbeat.json` | ledger job | anyone |
| `health/ledger-inbox/` | any job (adds one file per record) | ledger job only |
| `health/ledger-export.json` | ledger job | tick, health job, morning check |
| `loop-flags.json`, `loop-flags.history.jsonl` | `scripts/loop-flag.ts` | anyone, through `readLoopFlags` |
| `sender-heartbeat.json` (beside the mail store) | the Telegram send function | anyone |

**Heartbeat.** Every watched job writes `{at, behindMs?, alarm?}`. `at` alone proves only that the job ran. `behindMs` says how far behind its newest input it is. `alarm` is a plain reason someone must look. A job may add its own fields. Today's health heartbeat (`{at}`) already fits. A heartbeat older than 15 minutes, or one carrying an alarm, is a problem with that job.

**Class kinds and states.** Kinds: failure, limit, limit-review, evidence-gap, release-input, safeguard-not-proven, instrumentation, proof-owed, operator-overdue. States: open, ticketed, fix-installed, verifying, closed-with-proof, recurred, resolved-no-fix, deferred, waiting-on-human. A class id is lower-case letters, digits and hyphens, at most 64 characters, so it is safe as a folder name. A release input's class id is `release-input-<name>` (`releaseInputClassId`), so the morning check, the rehearsal rule and the warning rule all feed one class.

**Limits are counted, never fixed.** `limit` and `limit-review` are counted and shown by name. They are never ticketed, held or handed to a diagnosis as a defect. The contract only names limits and says how long each normally lasts. It holds no threshold and nothing in it can lift, shorten or bypass a limit.

**Owners.** `ownerRole` is the only place an owner is decided.

- For a release input it returns exactly what the installed rehearsal's `gapOwner` returns. A test checks this for every input name in `launcher/release-readiness.ts`, and a second test writes today's answers down so a change to them is noticed.
- For every other kind it is a coded table: Platform owns failures in the launcher, limits, limit reviews, evidence gaps, instrumentation and the operator queue; Product owns a failure whose fix lives in the product repository; Quality owns a safeguard not proven and, unless the record names another role, a proof still owed.

`gapOwner` gives the Coordinator anything about the AWS sign-in, usage or a pause. The Coordinator is told things; it is never asked to act. So the contract also has `actionRole`: the role that receives the action mail. It is the owner, except that a Coordinator-owned class acts through Platform. `actionRole` never returns the Coordinator, and a test holds it to that. The owner (parity with the rehearsal) and the action recipient (never the Coordinator alone) are two separate answers, so both rules hold.

**Steps only Vincent can do.** The coded list is: a sign-in, his decision on a named operator-only switch, and starting an operator session. Nothing else may be parked as "waiting on a person". `releaseInputHumanStep` says when a release input is a sign-in.

**Message ids for Vincent.** The mail gate decides a message's tier from its id prefix alone. A writer builds the id with `ownerMessageId` and cannot invent a kind or claim a tier.

| Tier | Id | Kinds |
| --- | --- | --- |
| hard stop | `loop:hard-stop:<kind>:<subject>:<day>` | factory-down, disk, spend, human-step |
| 22:00 result | `release-window-result:<day>` | (the id its writer already uses) |
| noon ask | `loop:ask:<kind>:<subject>:<day>` | release-step, dated-step, operator-queue, decision |
| routine | `loop:routine:<kind>:<subject>:<day>` | fix-failed, release-at-risk, idle, other |
| cleared | `loop:cleared:<kind>:<subject>:<day>` | same kinds as routine |

`<day>` is the Toronto date. The condition key is `<kind>:<subject>`. Two writers that raise the same condition on the same day build the same id, so the store keeps one row. A "cleared" row cancels a held routine row with the same condition key. `SHARED_SUBJECTS` lists the subjects several writers share (`tick-dead`, `config-invalid`, `no-heartbeat`, `data-volume`, `aws-wallet`, `aws-sign-in`); use those exact names. Any id `parseOwnerMessageId` does not know is routine and is counted as unknown.

The mail repository cannot import this file. Its tier table must list the prefixes above, and the cross-repository tier test should walk `OWNER_MESSAGE_PREFIXES` so every tier is covered, not only hard stops.

Action mail for a role uses `roleActionId`: `loop:action:<role>:<class id>:<episode>`, one per role, class and episode.

**Proof.** How many real successes close a class is chosen here, before the work starts. A fixer may raise the number and can never lower it (`proofFor`).

| What failed | Successes needed |
| --- | --- |
| a worker or publisher run | 20 successful publications in the same repository |
| a scheduled job | 3 on-schedule successes of that job in a row |
| a release input | present at the next morning check, present at the rehearsal, then passed by the real preflight |
| an alarm | one drill replay and one real delivery |

Limits, limit reviews, proofs still owed and overdue operator items are not closed by proof. They end when their condition ends.

**Expected duration of each limit.** A limit still active past this opens one "limit-review" question for its owner (`limitReviewAt`).

| Limit | Expected to last |
| --- | --- |
| paused with ready work and nothing running | 30 minutes |
| usage stop | until its reset, plus 30 minutes |
| disk admission refused | 2 hours |
| install freeze | until the freeze ends |
| worker unqualified | 2 hours (starting value) |
| usage window missing | 30 minutes (starting value) |
| wallet stop | until the wallet's month ends (starting value) |

The plan gave the first four. The last three are starting values set here and change only in the operator lane. A limit that lasts "until" something needs that time. Without it `limitReviewAt` throws, so an unknown end is seen as an error and never read as "not due".

**Fix lines.** A pull request that fixes a class carries `fixes-failure: <class id>` alone on its own line. Its regression case lives in `regressions/<class id>/`. The check that proves it is named `prove-regression`.

**Ledger inbox.** Any job may drop one JSON file per record into `health/ledger-inbox/`: write a temporary name, then rename to `inboxFileName(record)`. The same fact always lands on the same name, so a retry changes nothing. Record types: declare, issue-link, fix-link, release-input, drill-result, proof-owed, proof-attached, human-step-request. The inbox can only add. A record that would merge, split, defer, accept a risk or dismiss is refused by `parseInboxRecord`; those need a named actor through the ledger's own command. A human-step request is refused unless its step is on the coded list.

**Ledger export.** The tick, the health job and the morning check never open the ledger. The ledger job, and only it, writes `health/ledger-export.json` at the end of every run (temporary name, then rename): the time, the number of nights missed since the last shipped night (null until its one producer has run), and one line per class with its id, kind, state, owner, shadow mark and "needs operator since". Rules and after-ingest steps run inside that job and hand it their values (for example the nights-missed number); none of them writes the file by another route. `usableLedgerExport` is a reader's one check: a missing, unreadable, future-dated or more than 30 minutes old export is "unknown". The reader then keeps what it already holds and clears nothing from it.

## Loop switches

A loop switch says whether one new detector is **acting** or **record-only**. Record-only is today's behaviour and the default.

| Switch | When acting |
| --- | --- |
| `idle-observation-gap` | the changed idle observation-gap rule may send |
| `health-blind-state` | the health evaluator's "blind" state replaces the old result |
| `health-reason-change` | an open health episode speaks when its reasons change, and missed nights stay visible |
| `ledger-rules-silent-failures` | classes from the silent-failure, job-log and deadline rules may open issues and mail |
| `ledger-rules-stuck-work` | classes from the stuck-work and outcome rules may open issues and mail |
| `ledger-rules-limit-reviews` | a limit running past its expected duration may ask its owner |
| `ledger-rules-running-out` | classes that warn before something runs out may open issues and mail |
| `class-restart-hold` | restart holds are keyed on the failure class |

These switches cannot touch a limit. Usage gates, capacity, the wallet, the release schedule, failure-class admission, the fix-up allowance and release headroom live in the private factory config, which only the operator edits. The switch file accepts only the names above and the two modes. A test checks every switch name against every field of the config schema, and that a switch file naming any config field is rejected.

**Reading.** `readLoopFlags()` returns the modes and an `alarm`. A caller puts a non-null `alarm` in its heartbeat.

- No file and no history: nothing was ever flipped. Every switch is record-only and there is no alarm.
- A file that is missing after a flip, unreadable or malformed changes no switch. The last good state from the history file stands, and `alarm` says why.

**Flipping.** Operator only. The command needs the same local owner token as `scripts/control.ts`.

```
bun scripts/loop-flag.ts show
bun scripts/loop-flag.ts set <switch> acting --actor "<name>" --parity-report <file>
bun scripts/loop-flag.ts set <switch> record-only --actor "<name>" --reason "<why>"
```

Turning a switch on is refused without an actor and a parity report: a readable, non-empty file showing what the detector would have done. Its path and SHA-256 are recorded. Turning a switch back to record-only is the safe direction; it needs a name and a reason, not a report, so a noisy detector can be silenced at once. Every flip is appended to `loop-flags.history.jsonl` before `loop-flags.json` is replaced. A flip also repairs a damaged file from the last good state.

## Install and undo

Installing is the ordinary reviewed source install. No job is loaded and no file is created. Then, in the same recorded operator step:

1. Read `autonomy.auto_approval.protected_paths` in the private factory config and record the value.
2. Add the entries of `LOOP_PROTECTED_PATHS`: `launcher/loop-contract.ts`, `launcher/loop-flags.ts`, `scripts/loop-flag.ts` and `loop-flags.json`.
3. Read the value back and record it beside the first one.

The switch data file lives in the private factory directory, outside every repository, so no builder's ticket can claim it. Its entry on the list also stops anyone adding a file of that name to the repository.

Undo: remove those entries with the same before-and-after record, and revert the source change. To return every switch to record-only, flip each acting one back with a reason; keep the history file.

## The real-mail-store test helper

A hand-made `messages` table proves only that a row was written. `openRealMailStore()` opens the mail checkout's own store code on a temporary database and runs its own delivery steps:

- `wakeClaude(address)` runs the wake a Claude chat's mail server runs. An fyi row written by the launcher ends `digested` with no state set by hand.
- `sendToVincent()` runs the one send function for Vincent and returns the texts a stand-in Telegram connection received. `telegramSentAt(id)` is set only after that.
- `ringCodex()` runs the Codex ringer. Only addresses passed as `codexThreads` have a thread. A role with no thread fails with "no thread in the Codex map", exactly as it does live, so a test cannot pass by pretending a role can be woken.
- `load("owner-budget")` loads another module of the mail checkout, for the cross-repository tier test.

Only the three outside connections are stand-ins (a Claude chat's socket, the Codex queue command, the Telegram connection). Every path is redirected to the temporary directory, and the helper refuses to run if the mail code has a setting it does not redirect. It never touches the live mail store, a real chat or the real bot.

The mail checkout is found at `~/Developer/alido-agent-mail`, or at `FACTORY_MAIL_SOURCE`. It is a separate repository, so it is absent in this repository's CI. Tests that use the helper are skipped there (`describe.skipIf(!realMailSource())`) and run wherever the checkout exists. A skipped test is not proof. Before a loop package installs, run its contract tests on the Mac with `FACTORY_REQUIRE_MAIL_SOURCE=1`, which turns a missing checkout into a failure, and record the mail revision the helper reports.
