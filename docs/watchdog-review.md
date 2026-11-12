# PR48 watchdog challenge — issue36 / review issue119

Review date: 2026-11-09. **Disposition: FAIL for recovery-evidence integrity;
independent acceptance admission NOT RUN pending reviewer-custody verification;
integration readiness NOT RUN pending owner reconciliation.** Passing isolated
tests do not authorize merge, activation, notification or release.

## Immutable scope and independence

- Head: `3ed8a8d3cefe6f8666350edfab648cf0257e4cbe`.
- Base/parent: `b157ad17f7cb26960992174a427669df37b95e2b`.
- Exact diff: only `launcher/watchdog.ts` (168 additions),
  `scripts/watchdog.ts` (24), `tests/watchdog.test.ts` (255): 447 additions.
- This reviewer did not implement or modify those files in this session. The
  original implementation worker's native identity is absent from the accessible
  evidence. The Git author/committer name is publication metadata, not worker
  identity. **Reviewer independence is NOT RUN/unconfirmed**, not inferred from
  a fresh review assignment. Product/launcher must compare retained native worker
  identities before accepting this as independent evidence. Any collision means
  NOT RUN with a different independent reviewer as next actor. The observations
  below are reproducible provisional challenge evidence, not a custody waiver.
- The supplied intake reports issue36/full-diff inspection, bounded searches with
  no matching challenge, no PR48 comments/reviews/inline threads, and no report-path
  collision among 35 known PR file lists. Those inventories were not freshly
  authenticated here and do not prove complete current custody. Launcher must
  recheck OPEN PR48 and immutable head/base, duplicates, active/ready claims and
  policy before creation/admission/publication; this report creates no new lane.

Repository AGENTS, README and operations were read, including the extracted
snapshot's versions and the later queue-recovery contract. Shared
`/Users/vincent/Developer/working-standards/{MEMORY.md,README.md,projects.md}`
reads failed with `Operation not permitted` (cat exit 1). Recorded adoption stays
`c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no newer policy was adopted.

## Method and command receipts

All execution used fictional SQLite and synthetic clocks. No live controller,
mail DB, provider, credential, native/model call, scheduler, release or real
message was used. No helper was spawned. This leaf changes only this document;
scratch evidence remains outside Git under `.factory-tmp/review-119/`.

The accessible local head and base objects were retained. `git archive HEAD_SHA`
was extracted into the newly created scratch directory, not checked out over
installed files. All **71 tracked snapshot files** were byte-compared against
`git show HEAD_SHA:path` after probes: exit 0, all equal. Existing installed
`node_modules` was linked read-only; scratch `.factory-tmp/home` and `.factory-tmp`
were created before Bun. Original branches and installed dirty files were not
changed. `/usr/bin/git` emitted denied xcrun temp-cache warnings; subsequent
object reads used `/Library/Developer/CommandLineTools/usr/bin/git` successfully.

From the extracted snapshot:

```sh
node node_modules/typescript/bin/tsc --noEmit
HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/watchdog.test.ts
HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file probes.ts
HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file clear-probes.ts
```

| Receipt | Exit and observed result |
| --- | --- |
| Exact snapshot typecheck | 0; no diagnostics |
| Original focused suite | 0; Bun 1.3.14, **11 pass, 0 fail, 86 expect calls**, 1 file |
| CLI children inside original suite | Initial child 0; concurrent children 0/0, empty stderr; combined opened IDs exactly `["watchdog:1"]`; invalid arguments/input children 1/1 as expected |
| Independent scratch probes | 0; **10 groups**, factual assertions passed, including reproduced defects; `.factory-tmp/probe-results.jsonl` within extraction |
| Failed-clear probes | 0; **2 cases**, both tables rolled back; `.factory-tmp/clear-results.jsonl` within extraction |
| Extraction byte comparison | 0; 71/71 tracked files equal |
| PR76/retained dirty-source comparisons | 0 for each of three `diff -u` comparisons; identical module, CLI and contract |
| Approved document assertion and `git diff --check` | 0; required revisions, test path, PR76, restart, independence, verdict and exit text present |

The original suite printed a denied ancestor-directory diagnostic after its
passing test list; its recorded process exit was 0 and the CLI child assertions
passed. This does not qualify unrestricted filesystem access. Probe success means
the reported readbacks were reproduced, not that defective behavior passed
acceptance. SQLite trigger `RAISE(ABORT,...)` aborts a transaction; it does not
call `os.abort`, send SIGABRT or deliberately crash a macOS process. No process
signal test was needed. The full repository suite and hosted CI were NOT RUN in
this bounded, focused approval; no green-CI acceptance inference is made.

## Boundary verdicts

Source lines below refer exclusively to immutable PR48 head unless explicitly
labelled PR76. Synthetic constants: `T=1794139200000` (2026-11-08 12:00Z),
`H=7200000`, `Q=1794186000000` (2026-11-09 01:00Z, Toronto 20:00).
Default work is `{complete:true,readyCount:1,freeSlots:1,lastAdvancedAt:null}`;
default windows are `[]`.

| Boundary | Verdict | Evidence and limit |
| --- | --- | --- |
| Two-hour before/at/after and restart | PASS | At T: none; T+H−1: none; T+H: `watchdog:1`; repeated later polls/restart: no duplicate. Original suite plus scratch episode probe. |
| Actual progress versus heartbeat | PASS | Ready-count/heartbeat changes do not reset dwell; increasing `lastAdvancedAt` clears/restarts it. Original progress test. Upstream truth of that timestamp is NOT RUN. |
| Unknown/ineligible evidence | PASS for incident safety | Unknown before detection resets dwell; unknown during an open stall neither clears nor duplicates its incident/outbox. No-ready/no-slot clears silently. Receipt preservation fails separately below. |
| Recovery then new episode | PASS | Scratch unknown/read/restart/advance/new-stall sequence retained cancelled `watchdog:1` and queued `watchdog:2`, one outbox row each. Clear returned `opened:[],closed:["watchdog:1"],queued:0,delivered:0`. |
| Concurrent/restarted poll uniqueness | PASS | Original two-process CLI race plus restart/idempotence tests; one opened ID, one local queued row per tested episode. Arbitrary crash/endurance histories NOT RUN. |
| Window before/at/after one minute | PASS | Q+59999 none; Q+60000 one incident with complete absent receipts; Q+60001 unknown evidence retained it. Original suite also tests window opening and unknown evidence at exact deadline. |
| Omitted windows | PASS within explicit-input protocol | Omission retains an already-open miss; omission of an unseen window discovers nothing. Scratch unlisted Q+60001 returned no incident. No automatic window enumeration exists. |
| Refusal/execution receipt and retention | PASS | Both kinds clear their own window silently; earlier refusal survives restart/history loss; late refusal cancels one row; no reopened window after later absent receipts. A refusal is not a successful release. |
| Toronto summer/winter | PASS | Original tests accept summer 20:00 (00:00Z), winter 20:00 (01:00Z) and winter 21:30 (02:30Z); reject off-minute times. Summer 21:30 and broader timezone transition cases NOT RUN. |
| Duplicate/future/regressed evidence rejection | PASS for tested validation | Original invalid-time/duplicate-window tests and six scratch rejections cover backwards clock, regressed/null advancement, future advancement, future recovery, duplicate window and future executor receipt; original suite rejects pre-window receipt. Recovery identity conflicts FAIL below. |
| Recovery receipt dedup/conflict handling | FAIL | Creation accepts repeated receipt IDs; later exact repeats deduplicate, but conflicting repeats silently disappear (F1). |
| Recovery during incomplete work read | FAIL | An accepted recovery receipt for an existing stall is not persisted (F2). |
| Outbox payload consistency | FAIL | Appended recovery is absent from the retained queued payload (F3). Clear changes only its state, retaining stale incident fields. |
| Failed-write atomicity/dwell/sequence | PASS | Three insertion failure probes (incident/outbox/state) compared all rows before/after byte-for-byte; each retry opened `watchdog:1`. Two UPDATE failure probes during clear preserved state/incident/outbox together, then cleared silently with exactly one retained row. Original outbox rollback test also passes. |
| Continuous eligible interval across gaps | NOT RUN / unprovable from protocol | Endpoint polls count elapsed time even with a six-hour unobserved gap; see scope below. No scheduling rule was added. |
| Actual notification delivery / A7 endurance | NOT RUN | Local queued/cancelled rows and `delivered:0` only. No sender, actual delivery or endurance rehearsal was performed or implied. |

## Concrete findings and separate repair disposition

### F1 — Recovery receipt identity is inconsistent (FAIL)

`launcher/watchdog.ts:82–86` deduplicates existing-incident attempts only by
receipt string, ignoring conflicting content. Creation at `:112–115` copies
`...attempts` without deduplication. `:163–165` checks future time and symptom,
not receipt identity/content conflicts.

Minimal reproduction: poll defaults at T, then at T+H with two identical attempts
`{symptom:"stalled-work",at:T+H,action:"Fictional recheck",receipt:"fictional-r1",result:"failed"}`.
Incident recovery reads `[local-recheck, fictional-r1, fictional-r1]`, length 3.
At T+H+1 submit the same receipt with action `"Conflicting action"` and result
`"recovered"`: poll succeeds, both retained copies still say `"failed"`.
A separately opened incident receiving its first receipt later retains exactly
one identical repeat, but a subsequent same-ID `"refused"` result is likewise
silently ignored. These are observed identity conflicts, not proof of recovery.

Repair disposition: implementation owner must define/enforce canonical receipt
identity for creation and append, deduplicate exact repeats and visibly reject or
retain conflicts without overwriting evidence. Independent Quality should replay
both creation and append cases on a new immutable head. No repair is made here.

### F2 — Incomplete reads drop valid recovery evidence (FAIL)

At `launcher/watchdog.ts:120`, `complete:false` resets dwell and bypasses the
stall `reconcile` call. Recovery attempts are appended only inside reconcile
(`:80–86`). Schema-valid acceptance therefore does not mean durable retention.

Minimal reproduction: open defaults at T/T+H. At T+H+1 submit
`work:{...defaultWork,complete:false}` and the fictional-r1 attempt above with
`at:T+H+1`. Poll succeeds. Incident stays open and its row still has only the
built-in local recheck; fictional-r1 is absent. Existing tests at
`tests/watchdog.test.ts:199–205` reuse an already-recorded receipt, so they do not
expose loss of a new one during an incomplete read.

Repair disposition: implementation owner should retain independently valid
attempt evidence for an existing incident without treating incomplete symptom
reads as clearance. Quality must verify retained receipt readback across restart.

### F3 — Queued payload omits appended recovery evidence (FAIL)

`launcher/watchdog.ts:115` serializes the initial incident into outbox payload.
Later appends update incident data only (`:98–100`); clear updates incident data
and outbox state only (`:90–94`).

Minimal reproduction: defaults T/T+H open incident. At T+H+1 append fictional-r1
with result `"refused"`. The incident has two recovery entries; parsing the still
queued outbox payload yields only one (local recheck). Clear at T+H+2 with
`readyCount:0`: retained outbox state is `"cancelled"`, payload `closedAt:null`,
while incident `closedAt:1794146400002` and its appended receipt remain present.
Cancellation is correct; the payload is an opening snapshot rather than a
consistent current incident record. No delivery claim follows from either row.

Repair disposition: Product/implementation owner must explicitly choose a
documented immutable opening envelope with authoritative incident lookup, or an
atomically synchronized queued payload, before any sender consumes it. Quality
must verify that chosen contract on append, rollback and clear; do not silently
rewrite retained historical delivery evidence. No sender or source change here.

## Observation and scheduling limits

`work.complete` attests a point-in-time read; the input has no interval coverage,
sample freshness or maximum-gap field. `launcher/watchdog.ts:127–129` subtracts
`since` from the latest clock. Scratch polls at T and T+3H alone open an incident
with `evidence.since:T`. This proves eligible endpoints and elapsed time, not
that work/capacity stayed eligible for the six hours between them. Explicit
unknown polls reset dwell; an entirely unobserved gap does not. Even frequent
synthetic samples cannot prove the truth of upstream observations. The consumer
must state its evidence guarantees; this review invents no cadence/gap policy.

Windows are explicitly supplied, not derived from the clock (`:134`). A first
late complete absent read may detect a listed old window; an omitted window
cannot be detected. Receipt authority, completeness and actual ticket progress
are supplied by a caller, not independently fetched by this module. The built-in
“recovery” is only a local recheck (`:106–113`), not a repair or forced start.

## PR76 and retained dirty integration collision

Read-only object inspection recovered the later queue-recovery commit
`26254e92f170d81e3d714b874c8212882a95c916` (issue75 / PR76 per intake) and
the archived dirty untracked tree
`a41d6fc3e638ea0bc97bfdcf8bbbb8a79e9beae8`. Direct reads of the original
installed `/Users/vincent/Developer/agent-factory/{launcher,scripts}/watchdog.ts`
were sandbox-denied. Live current dirty readback is therefore **NOT RUN**;
retained dirty-object comparison is observed, not a claim of current custody.

The later commit and dirty archive have identical blobs for:

| Path | Later/retained dirty blob |
| --- | --- |
| `launcher/watchdog.ts` | `db82e8128c2c6348222747b9035af8a883dcdb74` |
| `scripts/watchdog.ts` | `866dffc23ee0aebc79d4744322df0c0e74529d38` |
| `docs/queue-recovery.md` | `5c63db0d4f91b72335db5512cc86f72122eea476` |

This is an **actual same-file integration collision**. PR48 exports `Watchdog`
and a snapshot schema with an explicit `--state PATH --input SNAPSHOT` CLI.
The later module imports `Engine`, exports `observeClaimProgress` and
`checkClaimStall` (`PR76 launcher/watchdog.ts:1–34`), and stores claim progress
and watchdog events in the controller Store. Its CLI (`:1–8`) loads configuration
and controller state, calls `checkClaimStall`, then `watchdogAlert`. That CLI was
inspected only and never executed. PR48's focused test success does not establish
compatibility with these consumers.

The later contract deliberately detects zero claims even with an empty/poisoned
queue, closes on claim/pause/full capacity, uses the existing bridge, and leaves
release-window receipts to the release executor. PR48 instead requires positive
readyCount/freeSlots for its snapshot stall and separately accepts window
evidence. Neither branch is declared to supersede the other by this report.

Before any merge, **Product and both implementation owners** must reconcile
same-path ownership, intended symptoms, API/CLI consumers, storage/incident
identities, notification payload authority and release-window responsibility;
retain both lines of work and record a bounded disposition. Independent Quality
then tests the reconciled immutable tree; Release disposition remains separate.
No modules were combined, branches replaced or original PR modified here.

## Next actor and observable restart

Product retains custody of this sole docs-only proposal and F1–F3. Launcher must
first verify distinct reviewer/original-worker native identities and fresh open
source/duplicate/active-ready/policy readbacks. If identities collide, an
independent reviewer is next; if unknown, retain NOT RUN until that comparison is
observable. A public author name, format assertion or green CI is insufficient.

Implementation owners receive the separate repair dispositions and integration
decision; this report does not create tickets or authorize edits. Observable
restart requires a recorded owner disposition plus an exact new head/base,
accessible retained objects/dependencies, and a sandbox that can run the approved
focused commands. Rerun the failed readbacks and original threshold/restart/race
suite there. Missing objects, dependencies or denied subprocess capability must
remain NOT RUN with that concrete prerequisite named; never substitute main or
dirty source. Integration restart also requires an authorized readback of the
current competing source and tests for the chosen consumers.

Issue36 intentionally deferred scheduling/notification integration. Even after
isolated module repair, full A7 delivered-alert and endurance acceptance remain
NOT RUN until separately authorized operational evidence exists. No usage,
qualification, custody, debit or capacity resets are authorized. Preserve this
report, scratch probes/results, fictional databases and original work; undo this
document through a reviewed revert. Launcher alone signs/publishes the unsigned
local proposal after cleanup and snapshot checks; Quality/Release keep their
independent disposition.
