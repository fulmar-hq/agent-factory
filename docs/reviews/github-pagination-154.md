# PR155 independent challenge — issue154

**Verdict: REJECT.** One medium-severity identity validation gap was reproduced with local fake responses; a low-severity documentation inconsistency was also found by inspection. Pagination beyond the old limits and the exercised late-failure paths otherwise behaved as intended. This review changes no implementation.

- Review request: `fulmar-hq/agent-factory#156`; PR155/issue154 association supplied by the approved brief.
- Exact reviewed head: `778e3daab205c2b66af38697c792746d04bd94bc`.
- Exact parent/base: `729eeb432a2e37868c00807a68b7eba09419f3e4`.
- Reviewed tree: `8fd12128a19666bfc8a6d3e2bd9aba25ba0a75f4`.
- Reviewed the complete parent-to-head diff: 14 paths, 114 additions, 37 deletions. The head was addressed by its literal object ID, never by a newest branch or remote response. I did not author the implementation.

## Finding: P2 / medium — bind node identity to its URL before publication

Location at the reviewed head: `adapters/github-pages.ts:35`; downstream effects at `board/pulls.ts:24` and `launcher/wake.ts:85` / `launcher/wake.ts:88`.

The new identity check rejects repeated **numbers** and URLs outside the repository/kind prefix, but accepts a node whose number disagrees with its URL. It also accepts different numbers sharing one URL across pages. Matching totals and distinct numbers therefore do not establish distinct, correctly identified evidence.

Executed reproduction, using two raw GraphQL pages with `totalCount: 2`:

1. Page one contains PR number 1, URL `https://github.com/example/demo/pull/1`, head ending `0001`, and a completed failing CI check. Its `hasNextPage` is true, with cursor `a`.
2. Page two contains PR number 2, **the same `/pull/1` URL**, head ending `0002`, a completed successful CI check, and terminal page information. Both pages have complete reviews, closing references and check contexts.
3. `githubWakes` resolves successfully. The inventory contains both rows. The single `board-pr:https://github.com/example/demo/pull/1` entry is overwritten by head `0002` and `failed: false`. Review and CI wakes are queued with `pr: 2`, `/pull/1`, and head `0002`.

The scratch probe asserts those actual results and logs them. Two separate contract assertions expecting rejection for issue number 1 with `/issues/999`, and PR number 1 with `/pull/999`, both fail because `githubPages` resolves. This is a malformed-response integrity failure, not evidence that GitHub actually returned inconsistent identities. The required fail-closed page-identity behavior is nevertheless absent, and the downstream loss of the first PR's failure evidence is demonstrated.

Before acceptance, validate the full repository/kind/number identity and reject aliased identities before returning staged rows. Preserve appropriate repository-name canonicalization. Add regressions for mismatched number/URL and cross-page URL aliases, asserting unchanged prior snapshots and no new wakes. No fix was made during this review.

## Finding: P3 / low — enrollment documentation retains the removed cap

Location at the reviewed head: `docs/operations.md:72`. The enrollment section still says, “A source error or the 1,000-issue cap refuses enrollment.” That conflicts with the new pagination description at line 7 and the changed enrollment/reconciliation code. This is an inspection finding: update the obsolete cap statement to describe incomplete or failed pagination. It is not the reason for the REJECT verdict.

## Executed evidence

The exact head was exported with `git archive 778e3daab205c2b66af38697c792746d04bd94bc` into `.factory-tmp/review-154/head`. All 110 extracted tracked blobs were subsequently hashed against that exact Git tree with no differences (`extracted-integrity.log`). Existing local `node_modules` was symlinked there; no dependency install, network, paid call, real model or GitHub command was executed. Tests inject fake command responses. Bun reported `1.3.14 (0d9b296a)`. Scratch HOME and TMPDIR remained inside the workspace, and fixture directories/logs were retained.

| Execution | Result | Retained receipt under `.factory-tmp/review-154/` |
| --- | --- | --- |
| Exact-head `node node_modules/typescript/bin/tsc --noEmit` | Exit 0 | `typecheck.log` (empty output) |
| Exact-head `bun --no-env-file test tests/github-pages.test.ts tests/add-project.test.ts tests/board-pulls.test.ts tests/board-model.test.ts tests/launcher-regressions.test.ts` | 48 pass, 1 fail; exit 1 | `focused-tests.log` |
| Independent raw-response probes, first run | 34 pass, 2 fail; exit 1 | `adversarial-tests.log` |
| Same probes, expanded with 201-PR wake replay and mocked deadline | 36 pass, 2 fail; exit 1 | `adversarial-tests-expanded.log`, `probes.test.ts` |
| Exact-head `tests/wake.test.ts -t 'ready, returned review'` | 1 pass, 3 filtered; exit 0 | `wake-focused.log` |
| Exact-head `tests/qualification.test.ts -t 'phone deferral\|stream usage is live\|each CLI tick'` | 3 pass, 1 filtered; exit 0 | `qualification-focused.log` |
| Exact-head `tests/engine.test.ts -t 'either provider window\|missing meter\|stable duplicate\|spawn is claimed\|missing qualification\|ticket override\|scope split\|heavy tests\|1.8 checkpoint\|tokens checkpoint'` | 9 pass, 1 fail, 19 filtered; exit 1 | `admission-focused.log` |
| Exact-head `tests/budgets.test.ts` | 7 pass; exit 0 | `budget-focused.log` |

For the exact-head Bun commands, the working directory was the extracted `head`; environment was `HOME="$PWD/../../home" TMPDIR="$PWD/../../"`. Independent probes ran from the original workspace with `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/review-154/probes.test.ts`. Runs overlap; their counts are not a combined unique-test total. The first probe log remains intact after the expansion.

Successful executed challenges cover:

- Complete issue counts of 0, 100, 1000, 1001 and 1205; complete open-PR counts of 0, 100, 101 and 205. Command arguments, owner/name, first-page cursor omission, subsequent cursor forwarding and positive timeout bounds were asserted. The authored test also admits approved ready work after more than 1000 historical issues.
- A 201-PR, three-page `githubWakes` read repeated twice: 201 board rows, exactly 201 review wakes and 201 completed-CI wakes, including the final PR, with no replay duplication. CheckRun and StatusContext fields survive normalization.
- Invalid JSON, null repository/node, missing pageInfo, late GraphQL errors, wrong repository/kind URLs, duplicate numbers within/across pages, missing/empty continuation cursors, empty intermediate pages, an A/B/A cursor cycle, increasing/decreasing totals, terminal undercount and count overflow all reject.
- Late issue transport errors, malformed responses and truncated labels retain prior ticket rows and observation events, return no ready work, and record the source error. An earlier page contains valid approved ready work, so this exercises withholding useful partial results.
- Late truncated PR reviews, closing references and check contexts retain the previous inventory and create no new per-PR evidence or owner wakes; board refresh marks the retained inventory erroneous. The authored late-transport test also withholds a new empty-baseline snapshot and wakes.
- A mocked clock crossing the two-minute deadline after page one refuses before request two. This proves the loop guard, not a real process timeout or live API latency.

## Inspection versus limitations

The focused suite's failure is `#4 archive refuses helpers, missing receipt and live supervisors`; the admission subset's failure is `spawn is claimed exactly once, never replayed after uncertain custody`. Both fail at unchanged `launcher/process.ts:15` / `:16`: `EPERM: operation not permitted, posix_spawn '/bin/ps'`. These are retained sandbox limitations, not counted as pagination defects or successful custody verification. Several Bun runs also print `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied`, including runs that exit 0; the diagnostics remain in the logs.

The full host suite was not run. Filters above are explicit; tests that delete fixture trees, including the modified idle test, were inspected rather than executed under this task's preservation constraint. No deliberate abort or signal-exit test was run on macOS. No installed harness, real GitHub schema/server response, rate limit, live deadline, native subscription, external custody or operational endurance was verified. Cursor traversal is not a point-in-time GitHub transaction; matching totals alone cannot prove that content stayed unchanged during a concurrent repository edit.

README.md, AGENTS.md and docs/operations.md were read. Required private shared standards files (`/Users/vincent/Developer/working-standards/MEMORY.md`, README.md and projects.md) returned `Operation not permitted`; the unavailable source was not substituted with newer upstream policy. The repository's recorded adoption revision remains `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`. Failed read receipts are retained in `standards-read.stderr`.

## Unchanged controls

Inspection of the complete base diff shows only the GitHub reader, its issue/board/wake/enrollment integrations, pagination documentation and fictional test adjustments. Usage/accounting (`adapters/usage.ts`, `adapters/workers.ts`, `launcher/budgets.ts`), capacity (`launcher/capacity.ts`), admission/qualification schemas and gates (`launcher/config.ts`, `launcher/engine.ts`), native worker/custody and delivery (`adapters/native.ts`, `adapters/delivery.ts`, `launcher/process.ts`, `launcher/worker.ts`, `tracking/store.ts`) are unchanged. Launcher tick and owner dispatch are unchanged. More complete ready supply does not raise slot limits or waive those gates.

The selected accounting, admission, budget and qualification fixture tests support that inspection within the disclosed limits; they do not supply native qualification evidence. The existing explicitly authorized **native subscription review HIGH override remains in effect until factory132 qualification selection is installed**. This review neither removes that override nor installs selection, qualification, policy or capacity changes.

## Artifact receipts

All paths below are local retained scratch, excluded from the documentation-only delivery:

| Artifact | SHA-256 |
| --- | --- |
| `head.tar` | `195a74cf30fda61a234e4e6425245ec996fd83e4e7d4a334e4668f3a38ecb0cb` |
| `probes.test.ts` (expanded) | `bc650c0ebdf58840dd44c7296306202667038dea23417d5a27482b516bfa661a` |
| `adversarial-tests.log` (first failed run) | `59d42b76bf9b870f28e23ccf172bfa48fb1ec7de7bc0826e58d208c4974f981b` |
| `adversarial-tests-expanded.log` | `3ebc6072092e7588b9b174934ab0650014508e153863999c76eae1b3221e90de` |
| `focused-tests.log` | `3bfc6235b702aee975acf4094fe9f448915c813b4d6ec6b0a39d71da1fe69be5` |
| `admission-focused.log` | `de85ccd2fafb115818920aa5cd7b9c155dec346557ffd47cc4c042967e7ae55a` |

`objects.txt`, `changed-paths.txt`, empty `invariants.diff`, archive stderr and the other test logs are also retained. The required `test -s docs/reviews/github-pagination-154.md && git diff --check` passed; the staged documentation also passed `git diff --cached --check`. Only `docs/reviews/github-pagination-154.md` is to enter the unsigned local review commit; the launcher owns signing and publication. No implementation, private operational asset, policy, release or remote state was changed.
