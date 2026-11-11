# PR58 native receipt challenge — issue51 / issue84

Verdict: **NOT RUN — independent acceptance blocked by identity collision.** This document records the blocker and static observations, not acceptance of PR58. Product retains outcome custody; Quality/Release own acceptance and delivery. No live qualification or Production proof is claimed.

## Revision and independence receipts

- Requested head: `8fb71e29a9337d043eacdc3eb86a4f0562d08d89`.
- Requested base: `0da456aaa499568296df780012d97f5d7d4ab6cb`.
- Local delivery base: `35fe1a42c427a821fbe82284aecef00033802403` (local main snapshot; remote current-main freshness was not checked).
- `git show -s --format=fuller 8fb71e29a9337d043eacdc3eb86a4f0562d08d89` exited 0. Author and committer are Vincent Messina, `72951696+vincentmessina@users.noreply.github.com`.
- `git config --local --get user.name` and `git config --local --get user.email` each exited 0 and returned that identical name/email. This is a concrete Git identity collision. Shared launcher attribution may obscure the actual native writer, but no independently attributable original-writer/reviewer evidence is available in the permitted context. A new worker turn alone does not prove independence. Apply the explicit intake rule, “identity collision means NOT RUN.” Do not change Git identity to manufacture independence.
- The intake reports an OPEN PR58, no GitHub reviews/comments and no duplicate open challenge. These are intake facts, not fresh GitHub observations by this worker. No remote messages, sign-ins, PR changes or helper agents were used.
- Shared standards MEMORY.md, README.md and projects.md reads were attempted: combined `cat` exited 1, each path returned `Operation not permitted`. Repository AGENTS.md, README.md and docs/operations.md were readable. No broader permissions were requested.

## Exact source custody and commands

The complete two-file immutable diff was read with `git diff 0da456aaa499568296df780012d97f5d7d4ab6cb 8fb71e29a9337d043eacdc3eb86a4f0562d08d89` (exit 0): `adapters/native.ts` has 16 additions/8 deletions and `tests/native-receipt-errors.test.ts` has 130 additions. Exact head source, both requested test files and `WorkerAccounting` were inspected. No other revision's tests were substituted.

Unique snapshot: `.factory-tmp/pr58-review-6BAJ7yaF`. `mktemp -d "$PWD/.factory-tmp/pr58-review-XXXXXXXX"` exited 0. Extraction ran from the unchanged worker checkout:

```sh
set -o pipefail
git archive 8fb71e29a9337d043eacdc3eb86a4f0562d08d89 | tar -x -C .factory-tmp/pr58-review-6BAJ7yaF
mkdir -p .factory-tmp/pr58-review-6BAJ7yaF/.factory-tmp/home
ln -s "$PWD/node_modules" .factory-tmp/pr58-review-6BAJ7yaF/node_modules
```

Extraction/setup command group exited 0; the snapshot uses existing installed dependencies without installation or modification. Readability checks for `node_modules/zod/package.json` and `node_modules/typescript/bin/tsc` succeeded. Git printed sandbox-denied xcrun cache-file diagnostics under the system temporary directory but returned 0 for the successful object reads/archive/checks; these diagnostics are not runtime test success. No checkout reset or source modification occurred.

Required command, to run **from that extracted snapshot** after the independence blocker is resolved:

```sh
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/native-receipt-errors.test.ts tests/native.test.ts
```

Actual execution: **NOT RUN**; exit status: **not available (not invoked)**; actual executed tests: **0**, passes: **0**, failures: **0**. Static enumeration finds 11 error-suite cases and 6 native-suite cases (17 expected, not a runner result). Additional adversarial probes: **NOT RUN**, 0 executed; no probe script was represented as executed evidence. The collision rule prevents independent test acceptance, so runtime review stopped before invoking Bun. Full `bun test`, typecheck and CI were not run or claimed as acceptance.

For restart, keep all temporary files in scratch: the exact native suite uses `os.tmpdir()` at `tests/native.test.ts:9,27,34,61`; set inherited `TMPDIR` to the extracted snapshot's existing `.factory-tmp` before the exact command. Static inspection of the requested files found no deliberate `os.abort()` or SIGABRT. The native suite includes fictional shell/sleep supervisor fixtures at lines 58–80; these were not executed. Do not run real native models or touch live processes. Any future macOS deliberate-abort coverage must be reported blocked, using SIGTERM fixture coverage and mocked SIGABRT results as authorized; real abort coverage belongs on Linux.

## Boundary verdicts and restart reproductions

All line references below refer to the pinned head, not local main. “Static” statements describe inspected code, not observed runtime behavior. Each runtime verdict is NOT RUN due to the identity blocker above. Restart must use independently attributable reviewer evidence and the same immutable source; probes must import `adapters/native.ts` and `adapters/workers.ts` from the extracted snapshot and use fictional transcript roots only.

| Boundary | Codex | Claude | Inspection, reproduction and restart assertion |
| --- | --- | --- | --- |
| Valid baseline | NOT RUN | NOT RUN | Error-suite fixture lines 13–32 constructs custody/model/effort plus 42 total/7 cached tokens. Poll and assert verified before each mutation. |
| Valid to malformed JSON | NOT RUN | NOT RUN | `native.ts:26–33,57` latches parser failures. Append `{broken}\n`, assert throw and both flags false; retry, restore valid content and call beginTurn: terminal failure must persist. Existing cases: error suite lines 35–62. |
| Truncation and restoration | NOT RUN | NOT RUN | `native.ts:50`: shrink below consumed offset, poll, restore original bytes, retry and beginTurn. Neither restoration nor another turn may clear the terminal latch. Existing cases: error suite lines 64–79. Same-size rewrite/regrowth between polls is not established by this size check. |
| Conflicting native ID/workspace | NOT RUN | NOT RUN | `native.ts:61–69`: append wrong ID and wrong cwd separately after valid verification; assert throw, flags false, unchanged counters and permanent invalidity on retries/beginTurn. Error suite lines 35–62 covers both providers. |
| Transient open failure/recovery | NOT RUN | NOT RUN | `native.ts:32,48`: rename the fictional file aside after success, poll, restore it. Flags must become false immediately and recover only after successful full reread. Existing error-suite lines 82–97 cover Codex only; extend to Claude in scratch. |
| Transient read failure/recovery | NOT RUN | NOT RUN | `native.ts:51–53`: append usage, inject one readSync exception, restore the mock, retry. Counter/offset must not advance on failed read; flags stay false until complete success. Existing error-suite lines 99–117 cover Codex only; extend to Claude. |
| beginTurn and fresh model/effort | NOT RUN | NOT RUN | `native.ts:25,80–85` clears model/effort only, retaining custody, offsets and terminal error. Assert immediate verified=false, no historical usage replay, then recovery with new provider-correct model/effort only when nonterminal and fully read. Existing error-suite lines 119–130 exercise Codex. |
| Partial line and completed newline | NOT RUN | NOT RUN | `native.ts:53–57,77`: append an incomplete valid row; flags false and no new usage until completing it. Complete it, poll, assert one accounting increment. Use Claude assistant rows with stable message IDs for duplicate checks. |
| Late appends and bounded catch-up | NOT RUN | NOT RUN | `native.ts:51,77` reads at most 1 MiB and compares offset with final size. Inject an append between read and final stat, and separately use a >1 MiB backlog; flags must remain false until another complete poll drains it. No independent probe ran. |
| Monotonic/cached accounting | NOT RUN | NOT RUN | `workers.ts:232–283` uses cumulative maxima and per-message maxima/maps. Append increasing, decreasing and duplicate counts; assert totals never decrease or double count, cached tokens included once. Cover Claude streamed/transcript dedup and beginTurn without clearing accounting. Native suite lines 33–56 supplies some original Claude cases, not independent evidence. |
| Any thrown poll invalidates verification | NOT RUN | NOT RUN | Entry reset (`native.ts:32`) precedes open/read; terminal errors guard evidence at line 85. **Unresolved static concern:** line 77 can set caughtUp=true before line 78 calls closeSync. After a verified baseline, inject a closeSync wrapper that closes the fictional descriptor with the original function and then throws once. A no-new-data poll appears able to throw while caughtUp and verified remain true. Probe both providers on restart; record as FAIL if reproduced. No runtime reproduction is claimed here. |
| Oversized pending line/unbound receipt | NOT RUN | NOT RUN | `native.ts:65,76`: independently probe Codex rows before custody binding and both providers' >16 MiB unterminated lines with repeated bounded polls. Verify terminality after error, including valid late append and beginTurn. |

The closeSync observation prevents a blanket static assurance that *every* thrown poll invalidates verification. Likewise, code inspection alone cannot establish transient I/O recovery or terminal irrecoverability. No PASS has been assigned to those behaviors.

## Current-main compatibility, kept separate

Static patch applicability: **PASS** against local delivery base `35fe1a42c427a821fbe82284aecef00033802403` only. Commands:

```sh
git diff --binary 0da456aaa499568296df780012d97f5d7d4ab6cb 8fb71e29a9337d043eacdc3eb86a4f0562d08d89 -- adapters/native.ts tests/native-receipt-errors.test.ts > .factory-tmp/pr58-review-6BAJ7yaF/pr58.patch
git apply --check .factory-tmp/pr58-review-6BAJ7yaF/pr58.patch
```

Both exited 0; nothing was applied. `git diff --quiet 0da456aaa499568296df780012d97f5d7d4ab6cb HEAD -- adapters/native.ts tests/native.test.ts` exited 0. Local main still has the prepatch native reader and lacks the new error test. Its `adapters/workers.ts` differs from pinned head in browser-handoff prompt text. Runtime integration with local main: **NOT RUN**. Fresh remote-main compatibility: **NOT RUN**, no fetch/readback performed. None of these results substitute for pinned-head tests.

## Disposition and restart conditions

Independent acceptance remains missing. Quality/Release must obtain auditable reviewer-versus-original-native-writer identity evidence that resolves the collision (or assign a demonstrably different reviewer), then rerun the exact command and both-provider scratch probes. If provenance remains ambiguous, retain NOT RUN. A new source revision needs its own review; do not silently retarget this one. Missing objects/dependencies, sandbox refusals or deliberate macOS aborts must produce concrete NOT RUN receipts, never synthetic success.

The restart receipt must capture actual command exit status and runner counts, every boundary's result, and the closeSync reproduction. Transient I/O can recover only after a successful complete read; terminal corruption must not recover on the same reader through valid appends, restoration or beginTurn. Reconstructing a reader is a separate lifecycle decision, not proof that terminal state recovered safely.

Only this document is proposed. Preserve scratch and history. Running #83, custody, debits, guards, settings, schedules, provider activation, original PRs and operational records were untouched. No source repair, signing, pushing, merging, model run, funding or live qualification occurred. The document-format/whitespace checks below are delivery checks only and cannot close the acceptance gap.

Delivery validation: **PASS**. The issue's exact approved `node -e` assertion command (both immutable SHAs, both requested test paths, `restart`, boundary verdict and exit text), followed by `&& git diff --check`, exited **0**. This ran 0 application tests and establishes document structure/whitespace only. The worker will leave an unsigned docs-only commit and `.factory-delivery.bundle` for launcher handling; that does not approve PR58.
