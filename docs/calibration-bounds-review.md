# Calibration bounds review — issue #99

Disposition: **NOT RUN for independent acceptance**. Missing independent acceptance
evidence remains missing. This document records the blocking identity check,
immutable-source inspection, and exact restart requirements; it does not approve
PR #61, issue #53, operational use, qualification, or Production delivery.

Reviewed head: `2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8`.
Reviewed base: `0da456aaa499568296df780012d97f5d7d4ab6cb` (head's parent).
Review date: 2026-11-09. Scope: the complete two-file delta, 197 additions and
5 deletions, in `launcher/budgets.ts` and `tests/calibration-bounds.test.ts`.
No implementation, original PR, policy, budget, or qualification changes.

## Independence gate

**NOT RUN.** `git show -s --format=fuller HEAD_OF_REVIEW` shows the same author
and committer identity as this worker's configured local Git identity. Identity
comparison was performed with the literal reviewed SHA, not the checkout HEAD.
The configured identity and reviewed author email match exactly. Git identity
may be shared across workers; that does not prove the same model session wrote
the PR, but it also cannot establish independent authorship. No independent
original-writer session attribution was available in the permitted local Git
metadata. No native transcript or controller records were read to resolve it.

The intake explicitly says “identity collision means NOT RUN.” Accordingly,
no Bun acceptance command or additional runtime probe was executed and no
independence is claimed. A different branch or fresh scratch directory alone
would not resolve this gate. Next actor: Quality assigns a reviewer whose
independence from the original writer is positively established; a shared Git
publisher identity requires separate permitted provenance, not a renamed author.

## Authority and evidence limits

Repository AGENTS.md, README.md and docs/operations.md were read. The recorded
working-standards adoption is `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`;
product-specific Bun/SQLite/plain-board contracts remain authoritative.
Shared working-standards MEMORY.md, README.md and projects.md reads were
sandbox-denied during intake, and connected MEMORY returned 404, as supplied
in the approved brief. This review uses the recorded adoption, without claiming
to have read those unavailable authorities or adopting newer standards.

The supplied intake reports examination of all 27 open factory PR path lists
and all 27 open factory issue bodies, with no existing posted review/comments
or duplicate calibration challenge. That is intake evidence, not a fresh
GitHub read by this reviewer. No GitHub writes or sign-in occurred.

## Immutable extraction and actual commands

The checkout started clean at `e12c4bb440c998244dc0dd5e4202b609d7b26500` on
its original branch. It was never reset, switched, cleaned, or used as a
substitute implementation for the reviewed head. Scratch assets are retained.

Actual command receipts (commands with multiple calls below report the shell
exit; object/hash results were also inspected):

| Command/action | Exit and observed result |
| --- | --- |
| `git cat-file -t 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8` and corresponding base call | 0; both `commit` |
| `git show -s --format=fuller 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8`; `git config --local --get-regexp 'user\.|factory|worker'` | 0; matching identity; independence gate NOT RUN |
| `git diff --stat 0da456aaa499568296df780012d97f5d7d4ab6cb 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8` | 0; two files, 197 additions / 5 deletions |
| Initial Node `spawnSync("git", ["archive", ...])` extraction attempt | 1; child failed without stderr, and diagnostic code raised TypeError reading undefined stderr; no successful extraction claimed from this attempt |
| Direct shell extraction below | 0; both snapshots extracted; scratch HOME directories and read-only installed-dependency links created |
| `git hash-object` on extracted head source, head test, base source; corresponding `git ls-tree` calls | 0; all three blob hashes match (listed below) |
| `nl -ba` on extracted head/base source; `rg -n 'test\(|SIGABRT|os\.abort|process\.abort'` on the two approved head test files | 0; source line references and 10 calibration cases plus 7 budget cases inventoried; no deliberate abort found in these files |
| `git merge-base origin/main 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8` | 0; reviewed base |
| `git merge-tree $(git merge-base origin/main 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8) origin/main 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8` | 0; textual merged source and added test; no conflict markers reported |

Successful extraction used these actual shell commands:

```sh
review_root=$(mktemp -d "$PWD/.factory-tmp/calibration-review-XXXXXX")
printf '%s\n' "$review_root" > .factory-tmp/calibration-review-root
mkdir -p "$review_root/head/.factory-tmp/home" "$review_root/base/.factory-tmp/home"
git archive --format=tar --output="$review_root/head.tar" 2cf02f9d07cbfc4d1eb2f5347c8dd674624521e8
tar -xf "$review_root/head.tar" -C "$review_root/head"
git archive --format=tar --output="$review_root/base.tar" 0da456aaa499568296df780012d97f5d7d4ab6cb
tar -xf "$review_root/base.tar" -C "$review_root/base"
ln -s "$PWD/node_modules" "$review_root/head/node_modules"
ln -s "$PWD/node_modules" "$review_root/base/node_modules"
```

The successful unique scratch leaf was `calibration-review-wn0hMZ`.
No dependency install or dependency write occurred. Dependency execution remains
unverified because of the identity gate. Git emitted sandbox-denied xcrun cache
warnings under the system temporary directory; the inspected Git operations
still returned the objects/results above. No sandbox bypass was attempted.

Verified blob receipts:

- Head `launcher/budgets.ts`: `562f9fa5431ca3e6a41ca7eb607df7b9d2e525b5`.
- Head `tests/calibration-bounds.test.ts`: `17a130e59251e10fa86149f0d73cbe4422aa9c78` (143 lines).
- Base `launcher/budgets.ts`: `0e122c4165a218d7916583dbad20bb5bc1645c21`.

Required focused execution is **NOT RUN**, exit **not available**, 0 tests
executed, 0 runtime PASS and 0 observed runtime FAIL. There are 17 inventoried
cases, not 17 successful cases. The exact command to execute after restart,
from the extracted **head** directory, is:

```sh
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/calibration-bounds.test.ts tests/budgets.test.ts
```

Full `bun test`, typecheck and extra probes are also NOT RUN in this gated
attempt. No macOS process was deliberately aborted or signalled.

## Boundary ledger and restart probes

All runtime verdicts below are **NOT RUN: independence gate**. Source inspection
and existing assertions are pointers for the next reviewer, not acceptance.
Line numbers refer to the immutable head unless explicitly labeled base.

| Boundary | Verdict | Exact source and reusable case / required challenge |
| --- | --- | --- |
| File bytes: exactly 8,388,608 and 8,388,609 | NOT RUN | `launcher/budgets.ts:16`; tests at 82 and 104. Exact size accepts; one over must refuse even with valid turns at beginning/tail. Repeat placements on each UTC date. |
| Aggregate bytes: exactly 33,554,432 and one over | NOT RUN | Source 17, 54, 74–75; test 104 distributes four full-size files across both dates, then adds a byte. Counters must not reset between dates or return a prefix. |
| File count: exactly 128 and 129 | NOT RUN | Source 54, 72; test 95 distributes empty and valid JSONL files across both dates. Overflow must refuse despite five earlier valid samples. |
| Total entries: exactly 1,024 and 1,025 | NOT RUN | Source 54, 70–71; test 114 uses only first date. Add scratch-only cross-date population to prove ignored suffixes count globally. |
| Missing vs denied directory | NOT RUN | Source 59–66; test 123 covers missing. Inject ENOENT versus EACCES at open and first read, including second-date failure after five valid samples; only ENOENT may continue. Base 29 swallowed all directory errors; denial refusal is intentional PR behavior. |
| Symlink and nonregular JSONL | NOT RUN | Source 12, 15; test 134 covers dangling symlink and directory. Add valid-target symlink and mocked nonregular descriptor; require refusal, not partial output. |
| Short reads | NOT RUN | Source 21–26; isolated fs mock should return several positive short reads then EOF with unchanged fstat; require full parse and one close. No existing case establishes this. |
| Growth and shrinkage | NOT RUN | Source 19, 26; mock extra byte, premature EOF, and changed second fstat independently; each must refuse. No real concurrent race was run. |
| Descriptor/directory cleanup | NOT RUN | Source 29, 64, 82; inject read/fstat/parser errors and later enumeration errors; count each acquired descriptor and directory closed once. Open failure must not close an unacquired descriptor. Include first-read deferred error and second-date refusal. |
| Deterministic real filesystem races | NOT RUN | Neither a real race nor deterministic race support established. Injected size/read sequences would prove branch behavior only. Same-size rewriting or path replacement requires separately justified coverage. |
| Toronto day endpoints, both UTC dates | NOT RUN | Source 43, 51; test 36 covers Nov 8 05:00Z inclusive to Nov 9 05:00Z exclusive, a standard-time day. |
| Toronto DST transition days | NOT RUN | Existing Nov 8 case is not the fall transition. Add March 8, 2026 [05:00Z, next-day 04:00Z) and Nov 1 [04:00Z, next-day 05:00Z); probe one millisecond before/at endpoints and both repeated fall 01:30 occurrences (05:30Z, 06:30Z). Two adjacent UTC directories must suffice for each. |
| Out-of-day cumulative baseline | NOT RUN | Source 43–44; tests 36, 57; excluded completion still advances baseline, next included delta must not include earlier consumption. |
| Cached input counted once | NOT RUN | Source 40–41; test 36 and budgets test 31; use cumulative total, never add cached input to it; duplicate readings must not inflate samples. |
| Five completed turns minimum / in-flight exclusion | NOT RUN | Source 42–44, 84; test 76; four completions plus a token-only fifth refuses, exactly five accepts. |
| Nearest-rank p90 | NOT RUN | Source 85–87; test 66; ten increasing deltas select ninth, not maximum or interpolation; expected p90 9,000,009, rounded reservation 10,000,000. |
| Malformed JSON, null and invalid counters | NOT RUN | Source 37–41, base 9–13; static findings and unexecuted reproducers below. |

After independence is established, reuse the existing cases first. Extra tests
must live only in scratch, import the exact head source, and use fictional
files or isolated injected filesystem mocks. Do not alter the reviewed module
to make it injectable or import current main. Prefer separate processes for
module mocks, and restore/contain mocks so they cannot contaminate other cases.
If the installed runtime cannot deterministically inject fs behavior, mark that
case NOT RUN with the unsupported operation and restart environment. Do not
substitute timers, probabilistic races, or mocked success for observed evidence.

## Parser findings: static, not runtime receipts

`turnTokens` is unchanged by this PR (head lines 33–48, base lines 5–20).
The following are source-derived expectations requiring execution on both
snapshots after the identity gate is resolved:

- Malformed JSON such as `turnTokens("{\n")`: JSON.parse throws inside the
  catch and the row is skipped; expected `[]`.
- Literal JSON null: `turnTokens("null\n")` parses successfully, then head
  line 38 / base line 10 dereferences `x.type`. Expected TypeError, not a
  skipped row. This is a pre-existing parser limitation, not a regression
  introduced by PR #61. Inside calibration, head line 82 should still close
  the directory when parsing throws; descriptor closure occurs before parsing.
- To reproduce invalid-counter handling, feed event_msg/token_count rows
  with `total_tokens` values `-1`, `1.5`, `"100"`, `null`, omitted, and
  `9007199254740992`, each followed by task_complete. Expected no samples
  from these values because line 41 requires a safe integer at least the
  previous total (initially zero). Repeat with a prior valid cumulative total
  and a decreasing counter; only an existing positive delta may complete,
  and the invalid reading itself must not advance total.

Runtime verdict for each reproducer: NOT RUN; no crash was actually observed.
Next actor: independent Quality reviewer runs these on head and base using a
scratch-only script importing each snapshot's budgets module. Parser repairs,
if desired, need a separately scoped owner decision; this review makes none.
No newly introduced source failure is established by this gated review.

## Current-main integration is separate

Local `main` and `origin/main` both resolved to
`e12c4bb440c998244dc0dd5e4202b609d7b26500`. Three-tree inspection used the
reviewed base and reported a textual merge without conflicts. This is a
**PASS for local textual compatibility only**, not an integrated runtime test
or authenticated latest-main readback. The supplied intake says GitHub reports
`mergeable=false`; that remains an unresolved integration follow-up, not proof
that the reviewed source fails its acceptance tests. This worker did not fetch,
rewrite the PR, or replace the test target with main.

Next actor: Release reconciles GitHub's exact current base/head and mergeability,
then arranges separately identified integration validation. A new PR head needs
a new immutable review; old-head results must not be transferred silently.

## Delivery and restart receipt

Only this document is proposed. Product retains custody; Quality and Release
decide acceptance and delivery. No operational or Production success is claimed.
The user's explicit unsigned-commit instruction governs this round instead of
the repository's usual signed-commit rule; the launcher signs/publishes later.

Restart condition: establish independently attributed reviewer identity, retain
the same head/base or explicitly approve a new immutable pair, and execute the
focused command plus each missing scratch probe above. Record actual exits,
test/assertion counts, refusal messages and cleanup counts. Dependency or
sandbox execution failure remains NOT RUN with that exact blocker; no broader
permissions, real home reads, model launches or provider operations are implied.
Report-format validation and green CI alone cannot close this acceptance gap.

Documentation checks for this proposal: the intake's exact Node content assertion
followed by `git diff --check` returned exit 0. These are document checks only;
the initial diff check preceded staging the new file. A staged whitespace check
also runs before committing. Delivery bundle is `.factory-delivery.bundle`,
created from the final unsigned HEAD for launcher testing and publication.
