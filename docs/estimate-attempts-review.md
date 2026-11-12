# PR59 independent acceptance evidence

Verdict: **FAIL — changes requested**, limited to the immutable source below. Correctly formed attempt evidence passes the challenged attribution boundaries; newly scanned malformed archive data causes an introduced failure (F1). No implementation was changed. Product retains outcome custody; independent Quality disposition and Release integration remain required.

Reviewed PR59 / issue52, head **cee3288d53bab22104e0d4c1f71d1a22333a0efc**, base **0da456aaa499568296df780012d97f5d7d4ab6cb**. Connected GitHub readback before execution and again afterward reports OPEN, unmerged, and those exact revisions. A changed head invalidates this acceptance evidence. The complete local two-file diff is 168 additions / 8 deletions: `estimator/predict.ts` and the 135-line `tests/estimate-attempts.test.ts`.

Reviewer independence: PASS. This fresh review's `CODEX_SESSION_ID` and `CODEX_THREAD_ID` both report `01a1c2eb-cf16-7442-8ae0-ecf44c105f81`, distinct from supplied source writer `01a1be83-66bb-75c1-8091-055f109dc589`. These identifiers establish separate native sessions; they do not assert launcher qualification or independent verification of native completion/cleanup. A missing/conflicting identity would mean NOT RUN, with Product responsible for assigning a distinct independent reviewer. The authorized per-ticket high-effort exception changes no identity, qualification, expiry or policy here.

Repository AGENTS.md, README.md, operations, exact predictor, complete attempt suite, existing estimator suite, Store, relevant receipt/archive producers and original issue52 were read. Intake supplied the earlier complete 28-issue-body / 28-PR-path inventory. Fresh connected inventory now returned 51 open issue bodies and 39 open PRs; all 39 changed-path lists were retrieved successfully. Searching the returned bodies for this head, PR59 and this report finds this issue103, the existing PR50 challenge issue87 and Product's broader disposition issue128. No separate attempt-matching challenge or report-path collision was found. PR59 comments, submitted reviews and inline review threads are empty. Issue87 / PR88 owns the separate chronological challenge; issue128 is owner disposition, not a second attempt-matching implementation. These observations do not establish current operational claim availability.

Shared authority limitation: local `/Users/vincent/Developer/working-standards/{MEMORY.md,README.md,projects.md}` reads returned `Operation not permitted`. Connected reads of MEMORY.md, README.md and authority.md at pinned `c8dd539da85903dd76dd2d6f991d0a5ee5415a89` returned GitHub 404. Retain the repository's recorded adoption and exceptions; no newer upstream rules or unavailable private-source contents are inferred.

**Execution receipts.** All fixtures are fictional in-memory SQLite. A unique retained snapshot was extracted using local `git archive cee3288d53bab22104e0d4c1f71d1a22333a0efc` and `tar -xf`, each exit 0, into `.factory-tmp/pr59.OCsYbd5K`. Its `.factory-tmp/home` was created first; `node_modules` links to the existing read-only workspace dependencies. No checkout, reset, clean, dependency installation or operational-data read was used. The worker's unchanged source baseline is `e12c4bb440c998244dc0dd5e4202b609d7b26500`; it was never substituted for the reviewed head.

Run from the extracted snapshot:

```sh
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/estimate-attempts.test.ts tests/estimator.test.ts
node node_modules/typescript/bin/tsc --noEmit
HOME="$PWD/.factory-tmp/home" bun --no-env-file test ./.factory-tmp/acceptance.test.ts
```

| Command | Actual exit | Actual result |
| --- | --- | --- |
| Exact requested two-file Bun command | 0 | Bun 1.3.14; 13 pass, 0 fail, 64 assertions, 2 files |
| Exact-head TypeScript check | 0 | No diagnostics |
| Temporary independent archive probes | 1 | 20 pass, 2 fail, 45 assertions, 22 tests / 1 file; both failures retained for F1 |
| Approved Node document assertion followed by `git diff --check` | 0 | Required revisions, suite paths, restart, verdict, exit and independence text present; document-format evidence only |

Both Bun runs emitted `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after executing tests. Actual exits and completed test counts above are retained; no denied directory was opened or permission widened. This diagnostic did not prevent the scoped tests from running. Full host/CI tests and current-main integration are NOT RUN. The approved focused suites contain no deliberate process-abort test; no SIGABRT/os.abort or native/model launch was performed.

Earlier Python and Node extraction wrappers each exited 1 before any test execution (unsupported Python tar extraction argument; unsuccessful Node child invocation). Their scratch directories were preserved. The subsequent shell extraction above succeeded and its reviewed file blobs matched Git; no failed setup attempt supplied acceptance evidence.

Scratch retains `focused-tests.log`, `focused-tests.exit`, `typecheck.log`, `typecheck.exit`, `acceptance.log`, `acceptance.exit`, and the temporary probe source under that snapshot's `.factory-tmp/`. The base predictor was read with `git show 0da456aaa499568296df780012d97f5d7d4ab6cb:estimator/predict.ts` into scratch only, allowing the same synthetic Store to be compared against both versions. No second suite is committed.

Extracted bytes were independently hashed with Git's blob format and matched `git ls-tree` at the reviewed head:

| Source | Verified Git blob |
| --- | --- |
| `estimator/predict.ts` | `8cf1116903febf9012c8bc004d8178995c6b9234` |
| `tests/estimate-attempts.test.ts` | `e218804c4ed96933e4e534ce099bafa0d078adb3` |
| `tests/estimator.test.ts` | `a9d4cab3a0e6afbde419d188bdeb1d1d5b98044a` |

**Boundary disposition.** Source line references below refer to the reviewed immutable head.

| Boundary | Verdict | Executed evidence |
| --- | --- | --- |
| Retry cannot borrow earlier failed/archived start, elapsed, area, kind or provider | PASS | Existing retry test gives the archived failure identical 4-second / 40-token counters, unknown prior status, different start/features/provider and both session orders. Exact expected row remains the successful retry: start 10000, completion 20000, elapsed 10, screen/fix/codex. |
| Unique counter match, incompatible/ambiguous receipt, zero usage | PASS | Existing counter distinction, ambiguous finished/archived sessions in both orders, 13 incompatible cases and zero-usage cases all pass. Matching uses unique candidate count, not newest/last row (`predict.ts:35–41`). |
| Archived success finished before archive | PASS | Existing archived-success tests retain original features/start while a later attempt starts after receipt completion. Temporary single-attempt probes independently check the archive cutoff. |
| Completion before / equal to / after archive | PASS | Completion fixed at 20000: archives at 20001 and 20000 include the row; archive at 19999 excludes it. Equality is allowed by `>=` (`predict.ts:39`), consistent with finish and archive sharing a millisecond. Existing test also excludes a receipt at 40000 after archive at 30000. |
| Absent / non-finished archive evidence | PASS | Temporary absent, unknown, paused, running and starting evidence each excludes archived attempts. The existing suite separately rejects unsupported live statuses. |
| Duplicate / reordered archive events | PASS | Three permutations of valid archive times 25000/30000/30000 give the same row; duplicate event IDs insert nothing. Both orders of 19999/30000 exclude the attempt, demonstrating the earliest finished-archive cutoff (`predict.ts:29`). Unrelated IDs and non-finished events cannot supply support. |
| Several equally supported completed attempts | PASS | Three permutations of three matching attempts, mixing finished and archived-with-finished-evidence, return no row. No start or feature is guessed. |
| Preservation and imported-history exclusions | PASS | Existing retry test compares sessions/events/actuals. Temporary probes compare every session, event and KV row before/after history, including imported and invalid history rows; imported rows stay excluded and a separate valid historical row survives. Baseline-comparison probes also preserve all inputs after exceptions. |
| Newly scanned malformed archive data | FAIL | F1 below: null and invalid JSON each throw before processing unrelated supported sessions. Both explicit acceptance assertions fail with the actual source stack. |
| Malformed selected session brief | PASS: classification only | A matched finished session with brief `{` throws in both base and head. This is inherited behavior at head `predict.ts:43`, not an introduced archive regression and not a claim of malformed-brief tolerance. |
| Existing PR59 chronological behavior | PASS, bounded | Its existing shuffled/frozen chronological and recent-five completion-tie/future/imported cases pass, along with the four existing estimator tests. No additional PR50 chronological matrix was written or executed. |
| Current-main/combined-branch, hosted, operational and Production acceptance | NOT RUN | Outside this exact-head offline challenge; no delivery or compatibility permission follows from any passing row. |

**F1 — malformed archive events now break unrelated valid history.** `estimator/predict.ts:25–28` scans every archive event before considering candidates. `JSON.parse` is unguarded at line 27; the TypeScript assertion does not validate its result, so valid JSON `null` causes `TypeError: null is not an object (evaluating 'data.id')` at line 28. Invalid JSON `{` causes `SyntaxError: JSON Parse error: Expected '}'` at line 27. Neither event needs to reference a retained attempt. The base does not scan archives and returns the valid row for the identical Store.

Minimal fictional reproducer, using the reviewed Store and history exports (run only in scratch):

```ts
const s = new Store(":memory:");
s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief,started,actual_seconds,actual_tokens,attempt) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("a", "fictional/challenge#52", "fictional", "codex", "finished",
    '{"area":"screen","kind":"fix","provider":"codex"}', 10000, 4, 40, 1);
s.set("actual:fictional/challenge#52", {completed:20000, seconds:4, tokens:40});
s.event("bad", "session-archive", null, "fictional only", 30000);
try { history(s); } finally { s.close(); } // throws at predict.ts:28
```

For the second failure, replace the event call with `s.db.query('INSERT INTO events VALUES(?,?,?,?,?)').run('bad','session-archive',30000,'{','fictional only')`. Both retained probes first assert that the base returns the complete expected row, then confirm head throws and inputs remain unchanged. Two further assertions require head to preserve that supported row and fail, retaining negative acceptance evidence instead of turning an expected exception into source PASS. Scratch probe SHA-256: `3656b3acc6e640b744176f41fb68150c01a7cc15e3885247b51af90f1057b4ae`; failing log SHA-256: `87e973525b55da84373980f0f1fee5242a70955f1d58178f831000c6d1926c26`.

This finding concerns malformed or legacy input, not evidence that normal Engine archive writes produce it. Normal producer `launcher/engine.ts:442` writes an object with id, receipt and previousStatus. The introduced scan nevertheless enlarges the failure surface to every retained archive event. `Engine.admit` invokes history at `launcher/engine.ts:251`, and the board history reader at `board/server.ts:127` also invokes it; this review proves the reader exception, not an operational outage. Missing/invalid archive evidence should remain unsupported without poisoning unrelated supported history or altering evidence.

Next actor for F1: **Product assigns one separately scoped source repair** for defensive archive parsing/shape validation, with independent Quality challenge of the resulting immutable head. Do not repair or rewrite PR59 in this docs-only leaf. Observable restart: a new explicitly approved immutable repair head is available with local objects/dependencies, distinct reviewer identity and fresh OPEN/head/duplicate readback; rerun the two original files and retained minimal failures against that head. Require the failing archive cases to preserve the valid row, maintain all exclusions and input preservation, and retain these original failing receipts. There is no authority here to create that ticket or post a PR verdict.

**Release integration dependency.** PR50 head `ae93815f4632554c8eb3ad587af121712a8c37df` and PR59 head `cee3288d53bab22104e0d4c1f71d1a22333a0efc` share base `0da456aaa499568296df780012d97f5d7d4ab6cb` and both change `estimator/predict.ts`. Read-only comparison confirms overlapping chronological helper, prediction and scoring edits. PR50 sorts by completion, then ID, then remaining fields for duplicate-ID stability; PR59 sorts by completion, start, then ID. Their chronological helper signatures also differ. These require an explicit accepted ordering decision and **one Release-owned integration lane** retaining both original heads, the issue87 / PR88 challenge and this failing evidence. No branch was combined, rebased or repaired. PR50's dedicated chronological challenge was not duplicated.

Intake reported GitHub `mergeable=false`. Fresh connected PR59 metadata before execution and at final recheck reports `mergeable=true`, with the same immutable head/base. Record this changed observation rather than treating either mergeability flag as behavioral acceptance. **Integration readiness remains NOT RUN / held for Release**, additionally blocked by F1 and unresolved PR50 overlap. Observable integration restart: Product/Quality dispose F1 and the two source proposals; Release supplies one reviewed integration candidate with fresh target-base, required-check/signature/custody evidence and combined regression receipts. No current-main compatibility, hosted acceptance, publication, installation or Production success is claimed.

The report-format assertion is only a document check. Real execution and the retained failing evidence determine this FAIL. Only this document belongs in the unsigned local proposal and launcher bundle; scratch evidence is retained locally. Undo the proposal by reverting its document commit; preserve the reviewed source, original branches and failure receipts.
