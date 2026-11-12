# PR71 enrollment concurrency challenge

Issue: fulmar-hq/agent-factory#114; reviewed PR: #71, implementing #70.
Review date: 2026-11-09. This is a docs-only evidence proposal, not QA acceptance or release authorization.

**Independent acceptance: NOT RUN.** The original commit author/committer and PR author are Vincent Messina (`vincentmessina`, `72951696+vincentmessina@users.noreply.github.com`). This worker's local Git identity is the same. This is a fresh Codex review execution, but separate execution alone does not establish independence from the original native writer. No accessible original-writer/native-reviewer identity comparison establishes that separation. Treat the identity collision conservatively. Dependency **Independent enrollment reviewer**: Product must assign a demonstrably different reviewer; Quality must retain both writer and reviewer identity receipts and rerun/adopt the exact-head evidence before acceptance. The technical PASS results below are diagnostic evidence, not an override of this gate.

## Immutable scope and custody

- Head: `2262841e9db1f440241aa315543faf9377fe5ce6`.
- Base: `2c9e529ff5b40a82c339bb7b0f8c4cf6a2192ad3`.
- Read-only GitHub recheck: PR71 OPEN, unmerged, exact head/base above; no conversation comments, submitted reviews or inline threads. Issue114 OPEN, `state:building`, sole allowed path `docs/enrollment-concurrency-review.md`.
- Fresh open enrollment searches found issue70, this issue114 and unrelated issue15; PR71 and unrelated PR73. An open-PR search for the literal report path returned no results. The intake's all-33-PR file-list check and empty occupied array remain intake evidence, not a fresh private lease inventory. No operational custody store was opened. Launcher must recheck active custody, equal/prefix path collisions, duplicates and source state before publication; a GitHub label is not custody proof.
- Starting checkout: `e12c4bb440c998244dc0dd5e4202b609d7b26500`, initially clean. No checkout, reset, merge, source edit or branch switch occurred. Review source came from retained local Git objects, never current-main source.
- Extraction: `git archive 2262841e9db1f440241aa315543faf9377fe5ce6 | tar -x -C .factory-tmp/review-114-2262841/snapshot` (exit 0). Scratch was newly created for this review; installed `node_modules` was linked read-only, and snapshot `.factory-tmp/home` and `.factory-tmp` existed before tests.
- Both objects were readable. `git rev-parse 2262841e9db1f440241aa315543faf9377fe5ce6:scripts/factory.ts 2262841e9db1f440241aa315543faf9377fe5ce6:tests/enrollment-concurrency.test.ts` and `git hash-object` of extracted files matched: `scripts/factory.ts` = `ca81a76f9004e9f09e385092f7304d8dff53ad76`; `tests/enrollment-concurrency.test.ts` = `291fc3c3730c8fa3867e6e9b9423e9932fc37bb1`. Base `git cat-file -t` returned `commit`, exit 0.
- Read AGENTS.md, README.md, operations, enrollment contract, complete changed function and 179-line suite. Shared working-standards MEMORY.md, README.md and projects.md reads returned `Operation not permitted`, exit 1. Retain repository adoption revision `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream policy update was inferred.

All installations were fictional, all enrollment calls supplied `dir`, and all GitHub execution inside tests was injected. No default private root, live enrollment, credentials, native/model/provider operations, operational databases, worker admission or spend were used. Only read-only GitHub connector calls were made. No deliberate process crash, SIGABRT, os.abort, launchd, sign-in, signing or push occurred.

## Commands and observed results

Run directory for the first four commands: extracted snapshot above. Host: macOS, Node `v24.18.0`, Bun `1.3.14 (0d9b296a)`.

| Actual command | Exit | Result |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | PASS; no diagnostics, no tests |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/enrollment-concurrency.test.ts` | 0 | PASS; 6 tests, 0 failures, 44 assertions; 203 ms |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test .factory-tmp/probe.test.ts` | 1 | NOT RUN; filter matched no tests; Bun required explicit `./` path |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/probe.test.ts` | 0 | Initial 5 tests/45 assertions passed; after adding receipt-recovery inspection, final 6 tests/55 assertions passed, 0 failures; 51 ms |
| Required document-content Node check, then `git diff --check` (worker checkout) | 0 | PASS; document format/whitespace only, not behavioral acceptance |

Both successful Bun runs also printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after test results. Exit remained 0, all named assertions completed, and the original separate subprocesses exited 0. The denial was retained as a limitation; no permissions were widened. Git emitted denied xcrun cache-write warnings under the host temp directory but returned 0 for archive/object inspection. No substitute source or dependencies were installed.

Temporary probes are retained only in scratch at `snapshot/.factory-tmp/probe.test.ts`. They dynamically import the extracted `scripts/factory.ts`, inject filesystem failures with Bun mocks and use the real extracted SQLite Store. The implementation and existing regression file remain byte-identical to the reviewed blobs. No second regression matrix is committed.

## Boundary verdicts

Line references below are to the immutable head, not current main. PASS means the specified diagnostic boundary was observed; the independence gate above still applies.

| Boundary | Verdict | Evidence and limit |
| --- | --- | --- |
| One cooperating writer from a shared original snapshot | PASS | Existing suite lines 71–85: two separate Bun processes finish source reads before release; writer one holds the archive barrier, writer two gets `Enrollment custody exists`; both child exits 0. No sleep-based race or crashes. |
| Deliberate retry, preservation and no work/debits | PASS | Suite lines 86–104: retry preserves both entries, unrelated bytes and empty owners; repeat enrollment does not duplicate config; exact backups equal original/first/both; 2 ticket snapshots, 3 events, 0 sessions/debits, no remaining claim. |
| Append-only receipts and snapshot contents | PASS | Additional recovery probe checks exact fictional snapshot/source count, prior event equality after another enrollment, 2 events and 0 sessions/debits. Store lines 15–17 reject event update/delete; lines 67–81 insert events within immediate transactions. The preview's GitHub-observed events are not copied into the installation: enrollment records its own event. |
| Config reread under claim | PASS | Function lines 47, 55–56; suite lines 137–146 changes config during injected source execution. Under-claim comparison refuses, preserves edited bytes, removes only owned claim, allows deliberate retry. |
| Dry run with unknown custody | PASS | Suite lines 107–119: no archive, database, claim or receipt is created; config/unknown claim retained. Non-dry-run refuses unknown custody. |
| Existing enabled project and source error | PASS | Function lines 22, 38–42; suite lines 171–179: both refuse before installation effects. |
| 1,000-issue truncation | PASS | Scratch probe returns 1,000 fictional issue rows; rejection contains `1000 issues`; directory remains only byte-identical config. Function line 41 precedes claim acquisition; adapter lines 119–123 mark truncation. |
| Archive-directory failure | PASS | Existing child failure case plus scratch mock of awaited archive mkdir; original config and no database, owned claim released. |
| Backup-copy, staged-write and config-rename failures | PASS | Scratch mocks separately throw on archive copy, `Bun.write(config.next.yaml)` and rename. Config remains exact, no database is opened, owned claim released; write/rename failures retain exact original backup. This does not simulate disk-full partial writes or durability after power loss. |
| Database-open failure after config replacement | PASS | Suite lines 122–134 and additional recovery probe use a directory at `controller.sqlite`. Config enrollment survives, exact original backup survives, owned claim releases. Archive the fictional blocker by rename, retry same read-only enrollment: config stays exact and snapshots/receipt are recovered. |
| Preexisting dangling claim symlink | PASS | Scratch fixture symlinks claim to `missing-target`. Exclusive `wx` rejects, symlink and config remain unchanged, no archive/database appears. |
| Missing/replaced/symlink claim during failure cleanup | PASS | At archive step, scratch renames owned claim to `retained-claim`, then leaves pathname missing, creates unknown regular file, or points symlink at retained inode. Cleanup refuses with `cannot be verified`/`custody changed`, preserves original config and retained descriptor's file, leaves unknown file/symlink intact. |
| Descriptor/inode-bound normal cleanup | PASS | Function lines 78–90: held descriptor stays open across fstat/lstat/dev+inode+regular-file verification and unlink; inner finally closes it. Existing normal/failure/replacement tests and probes exercise owned release and unknown retention. Synchronous verification/unlink excludes JavaScript await interleaving, not an arbitrary external process's filesystem mutation. |
| Continuous ownership validation before effects after an awaited custody change | FAIL (broader guarantee only) | Minimal reproduction below shows config and SQLite effects precede final custody error. This is outside issue70's cooperating-writer contract, not evidence of failure between ordinary cooperating writers. |
| Actual crash/power interruption or SQLite commit/I/O failure | NOT RUN | Database-open interruption proxy was exercised; no process crash, power-loss simulation, SQLite transaction failure injection or fsync/durability claim. |
| Independent reviewer identity | NOT RUN | Identity collision/unresolved native provenance; named dependency above. |
| Current-main integration, full host suite, live enrollment, autonomous endurance, Production | NOT RUN | Outside approved outcome. Focused tests and source inspection cannot establish these claims. |

## Custody-change observation and contract reasoning

Minimal fictional reproduction against `scripts/factory.ts` lines 58–89:

1. Create a scratch installation with fictional config and injected one-issue source; invoke `addProject("fictional/probe", { dir, execute })`.
2. In a mock of the awaited archive `mkdir`, await rename of `.add-project.claim` to `retained-claim`, await creation of a new claim containing `unknown`, then allow mkdir to succeed. Do not throw or alter implementation.
3. Observe rejection `Enrollment custody changed`. Nevertheless config contains `"fictional--probe"`, the archive contains the exact original config, and SQLite contains one ticket/one enrollment event, zero sessions and zero debits. Both retained original claim and unknown replacement remain.

The original suite's replacement case throws immediately after replacement (lines 45–48), so it proves safe cleanup retention but does not establish pre-effect refusal after replacement. The additional probe fills that evidence gap. The descriptor check in finally detects custody loss only after awaited archive/copy/write/rename and database work; it is not rollback. A caller must reconcile actual effects after this error, rather than infer that rejection means no enrollment occurred.

Issue70 explicitly excludes unrelated editors; function line 43 states the same prerequisite. Cooperating invocations never replace another invocation's claim, and the controlled two-process regression passes. Consequently this observation does not justify rewriting PR71 in this lane. If Product wants fail-closed effects after external custody mutation, it requires a separately scoped repair/design and independent tests. Rechecking a pathname alone must not be presented as a cross-file transaction or complete protection against unrelated editors.

Likewise, missing custody at final cleanup produces an explicit reconcile error, but cannot recreate an unknown claim. Removing custody externally can permit a later invocation to acquire the now-empty pathname. Unknown replacement is retained and blocks the next ordinary enrollment; unknown absent custody requires operator reconciliation. Same-user arbitrary mutation and the small external lstat/unlink race are outside the supported cooperating-writer guarantee.

## Interrupted config/database recovery and restart

Function line 63 renames config before line 65 opens SQLite and lines 67–74 commit snapshots/event. There is no cross-file transaction. A database-open failure leaves an enrolled, empty-owner entry without its receipt; the exact pre-enrollment backup remains. The tested recovery archived the fictional failed-database directory, reran the same enrollment with explicit `dir`, and obtained snapshots/receipt without another config entry or config-byte change. Prior receipts remain unchanged on another refresh.

An actual interrupted writer can leave a claim. Function line 50 deliberately refuses automatic stale/PID reclaim. Next actor: Coordinator reconciles the writer, config, archive and database, archives unknown claim only after custody is known, and repeats read-only enrollment or restores the correct archived config after checking later edits. Preserve all archives, snapshots, events and debits. This review performed that recovery only on its fictional database-open fixture, never on an installation.

Observable restart for independent acceptance: Product assigns **Independent enrollment reviewer** with identity distinct from the issue70 writer; Quality records that comparison, extracts the same immutable head/base, creates scratch HOME/TMPDIR, runs the exact typecheck and focused suite commands above, and retains exits, per-test counts and the custody observation. The launcher rechecks source state and lease collisions first. If subprocess permission or retained objects/dependencies become unavailable, record NOT RUN with the exact error; next actor is the CI maintainer running the same immutable snapshot in supported CI, without widening worker permissions. Do not replace it with main or a green unrelated CI run.

No live retry, independent acceptance, Quality disposition, Release approval or merge is granted here. Product retains outcome custody. Launcher may test this docs-only snapshot and sign/publish after cleanup; this worker leaves only an unsigned local commit and `.factory-delivery.bundle`. Review remained within the 30-active-minute bound. Uncovered boundaries remain NOT RUN rather than synthetic success.
