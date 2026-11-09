# Independent GitHub reconciliation challenge

Review date: 2026-11-09. Scope: fulmar-hq/agent-factory issue #94, independent acceptance evidence for issue #40 / OPEN PR #56. This is the sole docs-only proposal for this round. Product retains custody; Quality and Release determine acceptance and delivery.

**Recommendation: do not accept the head unconditionally.** The reviewed change fixes premature candidate publication during repository transaction failure. Its existing suite passes, and independent probes confirm that fix. Error-diagnostic persistence can still reject the entire reconciliation and stop later repositories. An oversized 1,001-row response also produces misleading source status. These are findings for the responsible owner, not source repairs in this proposal. No hosted or Production proof is claimed.

## Identity, independence and scope

- Immutable reviewed head: `7037d1eba0861354a1b5678b1fef1c07b3b73d19`.
- Supplied PR base: `0da456aaa499568296df780012d97f5d7d4ab6cb`.
- Head parent / merge base with that base: `b157ad17f7cb26960992174a427669df37b95e2b`.
- Local main, origin/main and starting checkout HEAD: `a4c83483606afa82a88351c174e895e904fa322d`. This is a local main compatibility reference, not a fresh remote readback.
- Reviewer declaration: this session is the independent challenger and did not write the implementation or original tests at PR56's head. It generated fresh scratch probes against the immutable source. No writer/reviewer collision is identified in this session or the supplied intake. Git records the original head under Vincent Messina's owner identity; that shared commit attribution does not identify the original native writer session. No private owner/controller/transcript records were read to manufacture identity proof. Launcher/Quality must reconcile retained writer and reviewer custody before accepting independence; any actual collision makes this challenge **NOT RUN**, requiring a different reviewer.
- Intake reports complete issue/PR inventories, no PR56 comments/reviews, and no duplicate independent challenge. Those are supplied intake facts, not newly polled GitHub facts. No live GitHub calls were made by this review or its probes.
- Repository AGENTS.md, README.md and operations were inspected. The recorded shared-standards adoption remains `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`. Shared working-standards local files were denied and connected MEMORY.md returned 404 in intake; upstream policy was **not refreshed**. The explicit unsigned-delivery instruction governs this proposal.

`git diff --stat BASE...HEAD` confirms exactly two files, 182 additions / 7 deletions: `adapters/github.ts` and `tests/github-atomic-readback.test.ts`. A direct `git diff BASE HEAD` is different: 15 files, 185 additions / 972 deletions, because the supplied base contains release work absent from the older head. Those differences are not PR56's two-file patch and must not be mistaken for authorized deletions. No merge, checkout reset, branch switch or head rewrite was performed. The initial checkout was clean.

## Isolation and commands

All paths below are relative to the original workspace unless a command's working directory is specified. Scratch was uniquely allocated as `.factory-tmp/review94-7037d1` (new for this review). The snapshot was extracted with:

```sh
mkdir -p .factory-tmp/review94-7037d1
git archive 7037d1eba0861354a1b5678b1fef1c07b3b73d19 -o .factory-tmp/review94-7037d1/snapshot.tar
tar -xf .factory-tmp/review94-7037d1/snapshot.tar -C .factory-tmp/review94-7037d1
ln -s ../../node_modules .factory-tmp/review94-7037d1/node_modules
mkdir -p .factory-tmp/review94-7037d1/.factory-tmp/home
```

Setup completed with exit 0; installed dependencies were reused read-only, without install or network. Bun reported `1.3.14 (0d9b296a)`. `git ls-tree HEAD` and Node's Git-blob hash computation independently matched extracted source bytes:

| Reviewed file | Git blob |
| --- | --- |
| adapters/github.ts | `73e620e58f8a7c0ab4c4e1ac6b83d930f57aea18` |
| tests/github-atomic-readback.test.ts | `d65402849a7da4eb28a7042bfce52d94e1124dcb` |

The scratch probe imports `./adapters/github`, `./tracking/store` and `./tests/fixtures` inside that extraction, never main. Every execute callback is injected; every Store is fictional `:memory:` SQLite. SQLite `RAISE(ABORT, ...)` aborts a SQL statement/transaction, not the operating-system process. No `os.abort()` or real SIGABRT test was run.

| Actual command and working directory | Exit and result |
| --- | --- |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/github-atomic-readback.test.ts`, extracted head directory | **0**, 9 pass / 0 fail, 473 assertions |
| `node node_modules/typescript/bin/tsc --noEmit`, extracted head directory | **0**, no diagnostics |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test ./adversarial.test.ts`, extracted head directory, first successful probe version | **0**, 26 pass / 0 fail, 522 assertions |
| Same adversarial command after adding two late-success-status-plus-diagnostic-failure characterizations, redirected to `.factory-tmp/adversarial-final.log` with saved exit propagated | **0**, 28 pass / 0 fail, 558 assertions |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/board-model.test.ts --test-name-pattern 'each GitHub reconciliation refreshes closures and includes closedAt'`, separate `.factory-tmp/review94-main` extraction | **0**, 1 pass / 0 fail, 22 filtered, 3 assertions; compatibility only |

Final scratch probe SHA-256: `dac304b2a6a45aca75a4dba6dc82f4b8a9b977f26a9530bf58db6b43a948603d`. Its source and final log remain in `.factory-tmp/review94-7037d1`; neither is a tracked implementation change. The separate main extraction used `git archive a4c83483606afa82a88351c174e895e904fa322d`, the same read-only dependency link and its own scratch HOME.

All successful Bun runs also printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` during directory discovery. That warning is retained: the named tests actually ran with the counts above and exit 0; it does not establish access to private data or qualification of host integrations.

Unsuccessful auxiliary attempts are not acceptance evidence:

- First probe setup used an erroneously doubled relative destination from inside scratch; shell reported `no such file or directory`, then Bun reported no matching test. The compound command's final `cat` returned 0, masking that setup failure. Verdict **NOT RUN** for that attempt; corrected setup and successful runs are recorded above.
- `shasum -a 256 .../adversarial.test.ts` exited **134** because sandbox-denied Perl library loading caused a dyld failure. This was an unexpected tool startup failure, not a deliberate abort probe; it was not retried. Node crypto produced the recorded hash instead.
- A Node `execFileSync('git', ...)` byte-comparison helper exited **1**, `spawnSync git EPERM`. It provided **NOT RUN** comparison evidence. Direct Git tree inspection plus pure Node blob hashing succeeded with exit 0 instead.
- Direct Git commands printed xcrun temporary-cache permission warnings, while returning the requested local object/ref/diff information with exit 0. No permission escalation was attempted.

## Boundary verdicts at the immutable head

Here PASS means the named safety property was observed, not overall acceptance. Passing characterization tests deliberately assert actual defective behavior; their green result does not convert a FAIL boundary into success.

| Boundary | Verdict | Observed evidence |
| --- | --- | --- |
| Early approved row followed by malformed row | **PASS** | No failed-repository candidates escape; prior snapshots and events compare equal after rollback. Existing suite and new probes test healthy repository both before and after it. |
| Duplicate / unsafe identities | **PASS** | Duplicate, string and unsafe-integer identities independently refuse the entire repository. Existing tests also cover absent/null/zero/negative/fractional identities and malformed fields/top-level values. |
| Late snapshot write failure | **PASS** | Trigger fails the second ticket update after the first row; old snapshots and events survive exactly, no repository candidates escape. Both repository orders tested. |
| Late event write failure | **PASS** | Trigger fails second issue's event insert after ticket writes; transaction restores all prior failing-repository snapshots/events. Healthy repository still admits in either order if error diagnostic persists. |
| Late success source-status write failure | **PASS** | Trigger rejects only the success `kv` update after all rows/events. Entire repository rolls back, candidates withheld, catch writes a fresh error diagnostic. Both orders tested. |
| Error diagnostic write failure | **FAIL** for repository isolation / fresh diagnosis | Trigger rejects every update of failing repository's source key. Tested after late malformed row and after all rows reach success-status write. Transaction rollback preserves old snapshots/events/status, but catch's own `s.set` rejects the entire `reconcile` promise. Later repositories are never read. |
| Healthy repository before/after ordinary repository failure | **PASS** | Healthy candidate returns and its status commits in both orders, covering malformed rows, invalid JSON, execute rejection and all three late write failures when diagnostic write succeeds. |
| Healthy repository before/after diagnostic failure | **FAIL** for continuation | Failing-first calls only `example/demo`, leaving healthy observation at `1794092399999`. Healthy-first calls healthy then failing and commits healthy observation `1794092400000`, but whole call still rejects and returns no candidate array. No failed-repository candidate was returned. |
| Exact digest / per-issue refusal isolation | **PASS** | Edited approved block and another issue's digest refuse only those issues; missing kind refuses that issue, closed issue is not admitted. Approved sibling returns; every valid source row and its event persist; source error stays null. Existing suite checks exact refusal strings. |
| Invalid JSON / execute rejection | **PASS** | Old snapshots/events retained, fresh nonempty source error at supplied now; healthy repository continues in both orders when diagnostic persistence works. |
| Valid empty snapshot | **PASS**, with retention semantics | Count 0, truncated false, error null; no candidates. Prior two snapshots/events remain unchanged. This is additive snapshot retention, not deletion of absent issues. |
| 999 rows | **PASS** | 999 failing-repository candidates, count 999, truncated false, error null; healthy sibling also admits. |
| 1,000 rows | **PASS** | All 1,000 snapshots commit; zero candidates for that repository; count 1000, truncated true, error null; healthy sibling admits. |
| 1,001 injected rows | **PASS** admission refusal; **FAIL** diagnostic semantics | All 1,001 snapshots commit and zero candidates escape, but status is `{count:1001,truncated:false,error:null}`. No oversize rejection exists. This exceeds requested limit and is synthetic robustness evidence, not a claim that live gh returned it. |
| Full host suite / hosted / Production acceptance | **NOT RUN** | Approved focused tests were used. Host integration/provider/qualification operations were outside this challenge. CI green or report-format checks cannot supply these receipts. |

## Source findings and reproduction

Line numbers here refer to the exact extracted PR56 source, not main.

1. `adapters/github.ts:14–22,106–115`: runtime row validation and duplicate identity detection occur outside the per-issue intake catch. Validation therefore rolls back the repository rather than disguising corrupt source as an intake refusal. Schema parse's returned object is discarded: serialization uses the original row at line 128, preserving unknown fields.
2. `adapters/github.ts:107–145`: candidates are repository-local until `Store.atomic` commits. `tracking/store.ts:80–81` uses Bun SQLite's immediate transaction. Snapshot writes, append-only event inserts and success source status share the transaction. Failures tested at each position preserved old evidence; only successful sub-limit repositories publish candidates.
3. **Diagnostic isolation gap:** `adapters/github.ts:146–147` writes the error diagnostic outside a protective catch/continuation boundary. Reproduce after a successful seed by installing `CREATE TRIGGER diagnostic_failure BEFORE UPDATE ON kv WHEN NEW.key='github:example/demo' BEGIN SELECT RAISE(ABORT,'fictional diagnostic unavailable'); END`, then call injected reconcile with `[approvedIssue, null]` or two valid changed issues. Promise rejects; the old successful source status survives even though fresh reconciliation failed. This conservatively returns no candidates, but neither persists the fresh diagnosis nor continues later projects. The original suite's source-status trigger at `tests/github-atomic-readback.test.ts:95–101` rejects only success status, allowing its error diagnostic write; it does not cover this failure.
4. **Oversize status gap:** `adapters/github.ts:140,145` uses equality for `truncated` and less-than for admissions. Those conditions disagree at 1001. Source status reports apparent untruncated success while admissions are withheld. Product/Quality must decide whether oversize input should be rejected or marked truncated; this review changes neither behavior.
5. `adapters/github.ts:45–79,118–123`: byte-bound intake digest refusal is deliberately per-issue. Source failures and admission refusal have different meanings. Failure status at line 147 replaces the old status with only error and observedAt when persistence succeeds; prior count/truncated are absent. If persistence fails, the entire prior successful status remains. Consumers must not treat that old status as a fresh successful read.

## Current-main compatibility and overlapping work

This section is separate from head acceptance. `git diff 7037d1 main -- adapters/github.ts` shows local main includes `Issue.closedAt?: string | null` at line 10 and requests `closedAt` in reconcile's JSON fields at line 94. `board/model.ts:246` uses it for completion timing. The separate focused main test at `tests/board-model.test.ts:254` passed and explicitly requires that requested field. PR56's line 103 does not request it. An independent injection confirms PR56 preserves supplied `closedAt` and extra fields in snapshots because it serializes the original object; that does not compensate for omitting the field from real readback requests. A later integration must preserve main's field request and optional field type and rerun both atomicity and board closure checks on the new exact revision.

Intake identifies draft PR73 as overlapping work. It is not a duplicate independent challenge merely because it overlaps implementation. **NOT RUN**: revision-specific PR73 compatibility/acceptance, since no immutable PR73 head or bound patch was supplied in this review and no local ref was established as that PR's head. Do not borrow PR73's tests, CI or review as PR56 acceptance, merge it experimentally, or infer its exact implementation from its draft status. Product should bind PR73's current immutable head and complete diff, compare its overlapping reconciliation path with these findings and main's closedAt contract, and decide which proposal owns any follow-up. No PR73 source acceptance is asserted.

## Next actor and restart

Product retains existing PR56/issue40 custody and should triage diagnostic-write isolation and oversize source-status semantics, and bind PR73's exact revision before selecting follow-up ownership. Quality evaluates the recorded boundaries and independent custody evidence; Release alone determines delivery eligibility. This report grants no approval to merge, deploy, rewrite the original head or repair source.

**Restart condition:** if native writer/reviewer custody collides or cannot establish independence, classify independent acceptance **NOT RUN** and assign a distinct reviewer. If objects/dependencies are absent or named test execution is denied, restart only when the exact head/base objects, read-only dependencies and supported scratch execution are available; extract anew without resetting existing work. For PR73 compatibility, supply its immutable head/diff first. For any source repair, Product must approve a separately bounded implementation task, retain this head and evidence, and Quality must rerun the focused suite plus diagnostic/oversize probes and main's closure check against the new immutable revision. A different revision's success cannot retroactively accept this head.

All scratch, original branches and evidence are retained. Undo this docs-only proposal by reverting its document commit; archive review scratch under normal custody rather than deleting operational evidence. Publication remains a launcher step after worker cleanup and exact-snapshot verification. No sign, push, merge, provider operation, live message, sign-in, job, policy, settings, guard, schedule, spend or custody/debit reset was performed.

Document verification: the approved Node content assertion and `git diff --check` completed with exit 0. These are document checks only; they do not alter the boundary verdicts above.
