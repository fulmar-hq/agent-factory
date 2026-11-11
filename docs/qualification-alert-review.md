# Qualification alert independent challenge — issue 110

**Source verdict: PASS for issue66's readback repair at the pinned PR69 head.** Both providers pass the independently exercised eligibility, expiry and retained-delivery boundaries. **FAIL for guaranteed marker/success-event recovery:** a deterministic counterexample occurs on both head and base, so it is an inherited audit limitation, not a new regression. Current-main integration, live delivery, renewal and Production acceptance remain **NOT RUN**. Product retains custody; Quality/Release disposition is separate.

## Identity, freshness and existing evidence

- Reviewed head: `abaf94245cb45b6db1cc1cd2acfbe71aaaabbcc4`; tree `8e40b8be170a9e4219588c916e752a7d6afa9bc4`.
- Comparison base: `2c9e529ff5b40a82c339bb7b0f8c4cf6a2192ad3`.
- Reviewer independence: **PASS**. The approved task identifies the source writer native session as `01a1be8d-4947-7092-9966-df7e492af58f`. This review's `CODEX_THREAD_ID` and `CODEX_SESSION_ID` both return `01a1c2eb-c7c6-7341-9896-d36794a32830`, a different native identity. Writer identity comes from the explicit Product instruction; no private transcript was opened. Shared Git attribution is not the independence test. This reviewer made no implementation changes and used no helpers.
- Authenticated read-only GitHub `get_pr_info` before execution and again at 00:50 UTC on 2026-11-10 returned PR69 **open**, unmerged, with those exact head/base SHAs, two files, 145 additions/1 deletion. No substituted main source was executed.
- PR69 comments, submitted reviews and inline threads each returned an empty list. However, the intake's no-duplicate observation is now stale: open issue [109](https://github.com/fulmar-hq/agent-factory/issues/109) already has open report [PR111](https://github.com/fulmar-hq/agent-factory/pull/111), head `5e28ccfb80352d772f55a00d67de636383a1bf21`, changing this same document path. Its exact retained report was read before test execution. It leaves independent acceptance NOT RUN because the writer's native identity was unavailable, and records the inherited event gap below.

This proposal addresses that missing independence evidence and issue110's additional exact-boundary checks. Earlier PR111 results are attributed prior evidence, not counted as commands run here. This is an overlapping document proposal: **Product must reconcile #109/#110 and retain one report publication lane**, preserving PR111 and these receipts. No duplicate GitHub review, comment or implementation repair was posted or created by this worker. This report does not claim the earlier challenge was absent.

Repository AGENTS.md, README.md and docs/operations.md were read, including the extracted reviewed documentation. Local shared working-standards MEMORY.md, README.md and projects.md each returned `Operation not permitted` (combined read exit **1**). Intake also records a 404 for the pinned connected README; that is an intake limitation, not a successful fresh authority read. Retain recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream policy update is inferred. The explicit unsigned-delivery instruction for this ticket overrides the general signed-commit rule only for this local proposal.

## Isolation and actual receipts

Review began 2026-11-10 00:46:44 UTC (Nov 9 evening Toronto) and completed within the 30-active-minute bound. Starting checkout was clean at `e12c4bb440c998244dc0dd5e4202b609d7b26500`; that delivery parent is distinct from the PR69 comparison base. No reset, clean or branch switch occurred.

Unique scratch root `R=.factory-tmp/pr69-review.V6PtXt` was created after `.factory-tmp/home`. Each retained immutable commit was extracted with `git archive --format=tar --output=... SHA` followed by `tar -xf ... -C ...`: **exit 0** for head and base preparations. The head snapshot is `$R/head`, the base `$R/base`. Installed read-only `node_modules` was symlinked into both, with no dependency installation. The head's `.factory-tmp/home` and `.factory-tmp` existed before Bun execution. `cmp` of extracted `launcher/alerts.ts` against a separate `git show HEAD-SHA:launcher/alerts.ts` export exited **0**; its Git blob hash matches `84e4625dff2300f9872e15ba405245e09c03b442`.

Tool versions: Node **v24.18.0**, Bun **1.3.14** (`0d9b296a`). Commands below ran from `$R/head`. Logs are in that snapshot's `.factory-tmp`; shell wrappers redirected both output streams to the named log, printed it, and propagated the actual command exit.

| Actual command | Exit | Counts / receipt |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | No diagnostics; `typecheck.log` |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/alert-readback.test.ts` | 0 | **19 pass, 0 fail, 106 expect calls**; `alert-readback.log` |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/alerts.test.ts` | 0 | **1 pass, 0 fail, 8 expect calls**; `alerts.log` |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/probes.test.ts` | 0 | **29 pass, 0 fail, 111 expect calls**; `probes.log`; two cases assert the inherited counterexample exists |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/event-acceptance.test.ts` | **1** | **0 pass, 2 fail, 4 expect calls**; `event-acceptance.log`; expected one recovered success event, received zero on head and base |
| Supplied Node report assertions followed by `git diff --check`, from delivery checkout | 0 | Document contract/whitespace only; not behavioral acceptance |

Thus **49 passing functional/observation tests** and **2 intentionally retained failing durability acceptance tests** ran here. The two passing counterexample observations do not turn the failed durability boundary into PASS. Probe source and every probe-created fictional database remain under `$R/head/.factory-tmp`; no additional test matrix is committed. Original suites remove their own disposable fixtures as written. GitHub readbacks are retained privately in `$R/remote-readback.json`.

Git commands emitted xcrun cache-write denials for the system temporary directory but the recorded Git operations returned 0. Bun emitted `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` during discovery, then completed the listed test counts/exits. Neither diagnostic is treated as successful access to private data. One source-inspection command returned exit 2 because an optional `policy/schema.ts` search path did not exist; `launcher/config.ts` was subsequently read directly. These diagnostics did not cause substitution of reviewed source or missing test coverage.

Every `qualificationAlerts` call used an explicit fictional scratch bridge path and a fictional Store (memory-only in the retained suite, scratch SQLite in the new probes). TMPDIR confined `node:os.tmpdir()` fixtures to permitted scratch. The default `mailPath` was never called. No real mail/controller database, private qualification, native/model/provider command, message send, renewal, sign-in or launchd operation occurred. SQLite `RAISE(FAIL)`/`RAISE(IGNORE)` faults are SQL behavior, not process aborts. No deliberate SIGABRT/os.abort was run.

## Retained boundary verdicts

Source references below refer to the immutable reviewed head unless explicitly marked base. PASS means offline source evidence, not hosted acceptance.

| Boundary | Verdict | Actual evidence |
| --- | --- | --- |
| Immutable source, dependency availability, distinct reviewer | PASS | Archive/blob checks and native IDs above; no main/dirty imports |
| Eligibility for each provider at two hours minus/exact/plus one millisecond | PASS | Independent probes poll at `expiresAt-7200000 + [-1,0,1]`: zero rows/markers/events before eligibility, one at/after; persisted reopen/repeat remains deduplicated. Head `launcher/alerts.ts:18` includes equality |
| Fresh alert for each provider immediately before/at/after expiry | PASS | Independent probes at `expiresAt + [-1,0,1]`; expires-at wording before, expired wording at/after, correct hashes and one event after reopen/repeat; head lines 21–23 |
| Malformed qualification never queues | PASS | 20 malformed records per provider: missing/null/nonobject/empty, five false mandatory flags, unwaived phone=false, invalid expiry types/NaN/infinity/zero/negative/fraction, unknown effort and empty model/version/evidence. Zero bridge rows, alert keys and events after reopen. Head lines 15–16 and `launcher/config.ts:114` schema |
| Immutable routing/content/hash conflicts | PASS | Existing 13-field conflict table reused; send_id, sender, sender_app, sender_ref, recipient, recipient_app, kind, reply, body, thread_id, depth, hash and summary all reject without marker/success or row changes; head lines 34–45 |
| Wrong provider/expiry summary with self-consistent hash | PASS | Existing regression reused; both altered contents rejected, original rows unchanged |
| Ignored insert leaves no row | PASS | Existing trigger regression reused: failure retained, marker/event absent; removing fictional ignore trigger recovers while preserving failure history |
| Verified immutable readback precedes marker and success | PASS | Missing/conflicting cases cannot reach success. Independent event callback checks exact bridge row and committed marker before success event. Source lines 34–47 precede 49–50 |
| Retained pre-expiry row, absent controller marker, after simulated interruption | PASS | Both providers: failed marker write leaves one bridge row and retained failure; remove scratch trigger, mark row read/delivered, reopen, recover at expiry, reopen/poll again; row and prior failure unchanged |
| Earlier expires-at wording recovers before/exactly at/after expiry | PASS | Both providers independently recover retained rows at expiry offsets -1/0/+1; earlier summary/hash and created_at retained; one marker/event after repeated polls/reopen |
| Already-expired wording recovery | PASS | Existing explicit regression reused; correct expired summary/hash retained |
| Advanced delivery state is neither reset nor resent | PASS | Both-provider retained rows with state=read/wake_state=delivered remain byte-for-value equal across recovery/reopen/repeat; stable one row and one event. Mutable fields are deliberately outside head immutable comparison |
| Conflicting stable row across restart | PASS | Both providers independently retain wrong-recipient row and first failure event unchanged across reopen and expiry retry; zero success/marker |
| Retry after transient SQLite failure | PASS | Both providers: scratch BEFORE INSERT `RAISE(FAIL)` gives no row/marker/success, one failure. Remove trigger and reopen, retry exactly at expiry: one row/marker/success, original failure retained after another reopen/poll |
| Distinct provider/expiry identities, normal insertion | PASS | Existing alerts test reused, three stable rows; this creates fictional input records only, never renews a real qualification |
| Interruption between controller marker and event | **FAIL, inherited** | Deterministic head/base acceptance failures below: persisted marker suppresses later event repair. Bridge row and prior audit history are preserved |
| Arbitrary power-loss/process-stop recovery; cross-database atomicity; real lock contention/disk failure | NOT RUN | SQL fault injection and orderly reopen establish only the observed cases. No process kill/power-loss trial or arbitrary filesystem failure simulation was performed; no transaction spans both databases |
| Current-main/PR76 combined integration and deployed installation | NOT RUN | Read-only divergence/overlap inspected below; no combined implementation or installation tested |
| Live delivery, native qualification, renewal, endurance, Production | NOT RUN | Fictional outbox persistence cannot prove a sent message, qualification, renewal or release; full suite/CI and Linux abort coverage were not run |

The expected ID is selected by the primary-key lookup. `created_at`, `state` and `wake_state` are intentionally not immutable-content checks. Fictional read/delivered strings are mutable fixtures, not live delivery receipts. Failure events use a stable ID and `Store.event` uses INSERT OR IGNORE, so repeated failures preserve the first diagnostic rather than append a new event on every poll.

## F1: marker survives a missing success event

At head `launcher/alerts.ts:49`, the queued marker is written separately from the event at line 50. `tracking/store.ts:60` and `:67` execute independent writes; its transaction helper at line 80 is not used here. A failure inserting the success event is caught at alert line 52 and records a failure, while leaving the marker committed. Later calls return at line 20. Reopening and repeating after removing the fault never reconstructs the missing success event.

Minimal reproducible sequence, using the fictional bridge schema from `tests/alert-readback.test.ts:25`, a scratch controller Store and explicit scratch `mail` path:

```ts
// Imports from the exact extracted snapshot; now/qualification are fictional fixtures.
const expiresAt = now + 3600000;
const key = `qualification-expiry:codex:${expiresAt}`;
const input = {codex: {...qualification(), expiresAt}};
s.db.exec(`CREATE TRIGGER event_fault BEFORE INSERT ON events
 WHEN NEW.kind='qualification-expiry-alert'
 BEGIN SELECT RAISE(FAIL,'fictional event fault'); END`);
qualificationAlerts(s, input, now, mail);
// One correct bridge row; key marker present; failure event; no success event.
s.db.exec('DROP TRIGGER event_fault');
s.close();
s = new Store(scratchControllerPath);
qualificationAlerts(s, input, expiresAt, mail);
qualificationAlerts(s, input, expiresAt + 1, mail);
// Still no success event: the persisted key bypasses all recovery work.
expect(s.rows('events').filter((e) => e.kind === 'qualification-expiry-alert'))
 .toHaveLength(1); // FAIL: actual length 0.
```

The complete runnable reproducer is `$R/head/.factory-tmp/event-acceptance.test.ts`. Retained failing stores are `event-acceptance-trWYFi` (head) and `event-acceptance-3MdNTB` (base), beneath that snapshot's `.factory-tmp`. Independent observation stores `independent-7zs1aj` and `independent-Z8Auti` additionally assert unchanged bridge rows and failure history after multiple reopen/retries. The failed acceptance command exits **1** on the assertion, not on runner startup.

**Classification:** the same marker/event ordering and early return exist in base `launcher/alerts.ts:20,31–34`. Executing the identical fault against that base also fails. F1 corroborates PR111's retained limitation; it is not newly discovered here and is not introduced by the readback guard. Issue66's explicit requirements—verify before success, retain failures, accept earlier wording, and preserve advanced bridge rows—are supported by the observed tests. A broader promise of complete success-event recovery at every interruption is unsupported. A real crash between the two writes was not induced; the SQL fault deterministically exercises the same persisted-marker/missing-event state.

## Integration, next actor and restart

Read-only local comparison shows this checkout's delivery parent `e12c4bb440c998244dc0dd5e4202b609d7b26500` still has the earlier qualification-alert function, lacking head readback lines 34–47. Authenticated PR76 metadata returned OPEN, head `26254e92f170d81e3d714b874c8212882a95c916`, base `c48c9bb4224e2240cc9f3757e1ac19ee353aabc4`, `mergeable=false`. Its retained exact `launcher/alerts.ts` was inspected with `git show`: it also retains the earlier function and adds `watchdogAlert`. This is concrete overlapping source work, not evidence that a combined head accepts PR69. Remote current-main integration and the installed source were not executed or changed.

1. **Product** reconciles issue109/PR111 and issue110 into one document publication lane, preserving both sets of receipts. Observable restart: a recorded selection/consolidated report disposition; do not treat the stale no-duplicate intake statement as current truth.
2. **Product and Quality** disposition inherited F1 against the required audit guarantee. If repair is authorized, use one separately scoped implementation lane; preserve the two failing scratch fixtures and original audit rows. Observable restart: a new immutable repair head makes the retained event-recovery assertion pass on reopen/retry, with existing readback/delivery-preservation cases still passing. No original source branch was rewritten here.
3. **Product/Release** chooses one integration writer for PR69/PR76 and supplies the immutable combined revision. Observable restart: readback guard survives the combination, then the same offline boundary/recovery commands run against that exact combined head. A source PASS here does not authorize merge, deployment or installed activation.
4. If the head changes, refuse stale acceptance and obtain the new exact objects. Missing objects, dependencies or sandbox capability remain NOT RUN until that same required source/toolchain can be read and the command actually completes. If native identities collide on any later review, dependency is **Quality: assign a reviewer distinct from the original writer**, then rerun rather than reuse this verdict.

Only this document is proposed in Git. Scratch evidence stays private and retained. No implementation, policy, qualification record, schema, capacity, usage, settings, custody or debit was changed. Unsigned local commit/bundle preparation is a handoff to the launcher, not publication or hosted acceptance. Undo this proposal through a reviewed document change while retaining evidence and history.
