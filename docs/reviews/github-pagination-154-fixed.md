# Issue 157: corrected PR155 independent review

**Verdict: ACCEPT** for the pagination repair at **24eefb2e6578213b4b1f9fd8806e265c566bd895** only. No additional blocking finding was reproduced in the focused synthetic challenges below. This is an independent review; no implementation was written or modified during this task.

Reviewed on 2026-11-10 for fulmar-hq/agent-factory#157, restoring GitHub pagination for issue154. The review checkout started at `729eeb432a2e37868c00807a68b7eba09419f3e4`. That is also the merge base of the corrected head. Inspected both the complete base-to-head diff and the correction from rejected `778e3da` to the exact corrected head. No tests were executed against the rejected implementation or a newer source revision.

## Findings and locations

| Severity / disposition | Location at reviewed head | Evidence |
| --- | --- | --- |
| HIGH original defect, repaired | `adapters/github-pages.ts:35`; regression `tests/github-pages.test.ts:29` | Every issue/PR node must now have exactly `https://github.com/<repo>/issues/<number>` or `/pull/<number>`, as appropriate. Distinct numbers sharing a URL reject before publication. Both supplied regressions and independent first/late-page probes passed. |
| No additional blocking finding | `adapters/github-pages.ts:22-53` | Complete cursor traversal, unique numbers, stable totals, exact final count, cursor progress and nested completeness were challenged with injected responses. Failures prevented partial snapshots and wakes. |
| Existing HIGH native subscription review, authorized override retained | Existing subscription/qualification path (`launcher/tick.ts:130`, `launcher/engine.ts:210`) | Outside this pagination change. The explicitly authorized override remains in force until factory132 qualification selection is installed. This review neither clears that HIGH nor claims qualification selection is installed. |

`recordPulls` at `board/pulls.ts:21` retains its older prefix-only guard. Inspection found both production callers (`refreshPulls` and `githubWakes`) obtain their inputs from the strengthened `githubPages` reader before calling it. Direct trusted helper calls are not evidence that malformed GitHub pages can bypass the repair.

## Executed evidence

Materialized the immutable object with `git archive 24eefb2e6578213b4b1f9fd8806e265c566bd895` into `.factory-tmp/head-24eefb2`, with a symlink to the existing local `node_modules`. No install, network or paid calls. Verified all **110 tracked blobs** in that materialization against their Git blob IDs after execution. Bun was **1.3.14**. Scratch HOME and TMPDIR stayed under `.factory-tmp`.

| Execution | Result | Retained output |
| --- | --- | --- |
| Exact-head `tests/github-pages.test.ts` and `tests/board-pulls.test.ts` | 6 pass, 0 fail, 57 assertions | `.factory-tmp/focused-existing.log` |
| Exact-head `tests/wake.test.ts`, filter `ready, returned review` | 1 pass, 0 fail, 5 assertions; 3 unrelated tests filtered | `.factory-tmp/focused-wake.log` |
| Independent `.factory-tmp/rechallenge.test.ts`, importing exact-head modules | 72 pass, 0 fail, 1,637 assertions | `.factory-tmp/rechallenge.log` |
| Exact-head strict TypeScript check via installed Node and `typescript/bin/tsc --noEmit` | Exit 0, no diagnostics | `.factory-tmp/typecheck.log` |

Total: **79 focused tests passed, 0 failed, 1,699 assertions**. The independent harness injects command responses and uses in-memory SQLite; it starts no GitHub CLI, worker, model, HTTP server or signal-exit fixture.

Executed cases establish:

- The supplied 1,002-issue traversal includes approved ready work beyond the former 1,000 limit. The 128-PR traversal includes the second page and deduplicates its returned review. Cursor arguments are asserted. Empty complete connections succeed.
- Both resource kinds reject different numbers sharing one canonical URL, wrong URL numbers, foreign repositories, wrong issue/PR path kinds, trailing path text, query strings, fragments, leading zeroes and percent-encoded number spellings. Independent late-page tests start with a valid page containing approved ready work or review/check evidence.
- Failures reject duplicated numbers across pages; increasing/decreasing totals; final undercounts/overcounts; absent or fractional totals; missing page information; null nodes; missing required fields; invalid number types; wrong connection keys; null repositories; GraphQL partial errors; malformed JSON; and thrown late-page errors.
- Missing, empty and repeated cursors, empty continuing pages and a three-page cursor cycle refuse. A fake clock confirms the shared two-minute deadline stops another page request without waiting in real time; supplied per-call timeouts are positive and bounded by that deadline.
- Incomplete nested issue labels, PR reviews, closing-issue references and check contexts refuse. Missing nested completeness metadata refuses. Successful three-page PR normalization retains closing references, returned reviews, CheckRun and StatusContext evidence, including a failing check. Null review fields normalize as implemented. Repeated reconciliation yields nine unique review/CI wakes, each with matching PR number, URL and head.
- For the late-page rejection matrix, existing ticket rows, board-PR state, events and a queued wake are seeded first. Rejected issue reads return no ready work and preserve ticket rows/events. Rejected owner reads preserve the prior board snapshot and priming flag without new wakes. Rejected board refreshes retain the previous snapshot with only `error: true`. Neither first-page nor failed-page PR state is inserted, and no sessions or debits appear. An unprimed first-page collision also leaves priming and baseline events absent.

Reproduction commands (from the materialized head for the first three):

```sh
HOME="$PWD/../home" TMPDIR="$PWD/../tmp" /Users/vincent/.bun/bin/bun --no-env-file test tests/github-pages.test.ts tests/board-pulls.test.ts
HOME="$PWD/../home" TMPDIR="$PWD/../tmp" /Users/vincent/.bun/bin/bun --no-env-file test tests/wake.test.ts --test-name-pattern 'ready, returned review'
/Users/vincent/.local/node-v24.18.0-darwin-arm64/bin/node node_modules/typescript/bin/tsc --noEmit
```

From the review workspace root:

```sh
HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp/tmp" /Users/vincent/.bun/bin/bun --no-env-file test ./.factory-tmp/rechallenge.test.ts
/Users/vincent/.local/node-v24.18.0-darwin-arm64/bin/node .factory-tmp/verify-tree.mjs
test -s docs/reviews/github-pagination-154-fixed.md && git diff --check
```

## Inspection evidence and boundaries

The complete base diff contains 14 files: the new pagination reader, its issue/board/wake callers, an enrollment error message, operations copy and synthetic test adaptations. The one-line repair adds exact URL equality and the correction adds its no-effects regression. All changed tests were inspected; only the focused selections above were run.

Issue publication follows the completed read inside `reconcile` (`adapters/github.ts:83`). Board publication follows the completed read (`board/pulls.ts:33`), and owner wakes follow it (`launcher/wake.ts:78`). Reads stage one repository's entire connection before effects. Error metadata is an intentional failure effect; no partial data publication was observed. This is a per-repository guarantee, not a transaction covering all configured repositories or both issue and PR reads together.

Blob-ID comparisons against the merge base confirmed unchanged `adapters/usage.ts`, `adapters/workers.ts`, `launcher/config.ts`, `launcher/engine.ts`, `launcher/capacity.ts`, `launcher/process.ts`, `launcher/worker.ts`, `launcher/tick.ts` and `tracking/store.ts`. Inspection of tick/admission and enrollment call sites found no changed usage, wallet, capacity, qualification, reservation or custody gates. Removing the arbitrary result ceilings restores complete GitHub evidence; it does not grant admission authority. No policy or operational state was edited.

Pagination trusts GitHub's returned connection metadata. Stable totals plus unique identities cannot prove an atomic snapshot if upstream membership or contents change without changing the count. Nested collections over 100 are rejected rather than paginated. Actual API schema/permissions, network timing and GitHub behavior were not exercised by these fakes. The timeout check used a fake clock, not real subprocess termination.

No full host/process/HTTP integration suite ran here, and no such success is inferred from the focused results. The user reports separate host/CI success; that report was not independently verified or counted. No macOS deliberate abort or SIGABRT was run; the selected tests contain no required abort probe. The unrelated real-worker recovery test was explicitly filtered out.

## Preserved limitations and receipts

- Shared private standards `MEMORY.md`, `README.md` and `projects.md` could not be read: `Operation not permitted`. Used the repository's recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no newer policy was adopted.
- Initial `/usr/bin/git` commands emitted sandbox-denied `xcrun_db` temporary-cache warnings, including after setting workspace TMPDIR. Object reads worked. Later commands used `/Library/Developer/CommandLineTools/usr/bin/git` successfully without those warnings.
- No local `fix/github-pagination` branch was present. `origin/fix/github-pagination` resolved to the requested exact hash; all materialization and execution used the immutable hash.
- Every Bun invocation emitted `error: Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` while still exiting 0 with all selected tests passing. Raw logs retain this diagnostic. No permissions were widened.
- Scratch materialization, independent harness, logs, tree verifier, `.factory-tmp/probe-limitations.md` and `.factory-tmp/evidence-receipts.json` are retained locally, outside the review-only commit. The latter records SHA-256 hashes for the archive, harness and all execution logs.

Independent harness SHA-256: `6138868adafee2a567c02bc04759034c6e9b823b3dfd157fa873b8dfbe11935e`.

Independent execution log SHA-256: `601e3a0b1fa9a45f33044c140dbfc85008963cc9cd34f561e10940713a568ba5`.

Only this review document is authorized for the tracked delivery. Leave its commit unsigned and create `.factory-delivery.bundle` from review HEAD for ordinary launcher validation/signing/publication. No sign, push, release, merge, sign-in, credential access, real-person message, AWS action, deletion or helper delegation was performed. Undo the review by a later reviewed revert; retain the scratch evidence and existing history.
