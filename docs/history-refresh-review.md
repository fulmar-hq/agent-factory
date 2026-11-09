# History refresh challenge — issue 90

Reviewed 2026-11-09 for [issue 42](https://github.com/fulmar-hq/agent-factory/issues/42) and existing OPEN [PR49](https://github.com/fulmar-hq/agent-factory/pull/49). This is the sole docs-only proposal. Product retains custody; Quality/Release decide acceptance and delivery.

**Result: PASS for the exercised refresh boundaries; independence provenance NOT RUN, so this is not unconditional independent acceptance.** No defect was reproduced in the pinned refresh implementation. CI green or this report's format check is not acceptance evidence.

## Identity, scope and limitations

- Reviewed head: `b740b3452b536cdccfdf352a90982b11f66cce7d`.
- Reviewed base and head's actual parent: `b157ad17f7cb26960992174a427669df37b95e2b`.
- Exact local objects exist; diff is exactly two files, 162 additions/12 deletions: `estimator/refresh.ts` (29/12) and `tests/history-refresh-validation.test.ts` (133/0). Both were inspected.
- Separate current-main comparison: `98eb82c9d103f005f18eabc1600045cacc24282d` (local `main`, `origin/main` and initial checkout HEAD agree). This is a local immutable comparison, not a fresh remote-main attestation.
- This reviewer executed new adversarial checks in this review turn and did not author or modify the reviewed implementation in this turn. **Independence from the original native writer: NOT RUN.** Commit/PR authorship is the launcher account and does not identify the original native writer; this workspace contains no approved native-writer identity attestation. Private controller records/transcripts were not accessed. Next actor: Product supplies a non-sensitive writer/reviewer provenance receipt to Quality. Restart condition: Quality establishes distinct native writer and reviewer identities, or assigns a demonstrably separate reviewer to repeat these exact-head checks. Do not infer independence from Git author name or a new branch.
- Shared working-standards `MEMORY.md`, `README.md`, `projects.md` reads returned `Operation not permitted` (combined command exit 1). Intake also records connected upstream reads returning 404; those failures were not reclassified as successful reads. Upstream refresh: **NOT RUN**. Used repository AGENTS.md's recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`, preserving local contracts. Next actor: standards custodian; restart when the required private sources are accessible through an authorized read path. No claim of refreshed upstream policy.
- README.md, AGENTS.md and docs/operations.md were read. The frozen head's operations contract at lines 84–88 requires retention on errors/truncation, imported exclusions, elapsed-only GitHub timings, and null/unknown missing native actuals.
- Intake's fresh inventories/no duplicate challenge are supplied context. Read-only connector rechecks in this turn confirmed issue42 open, PR49 open at the exact head/base above, 162/12 over two files, and an empty posted-review list. No review/comment/message was posted. GitHub reads were review metadata reads only, outside all injected probes.

## Exact extraction and receipts

Checkout started clean. Nothing was reset, cleaned, checked out over, signed, pushed or merged. Existing dependencies were reused through a scratch symlink, without installation or dependency writes. Bun reports `1.3.14 (0d9b296a)`.

Scratch root retained locally: `.factory-tmp/history-review-sQQWQb`; locator: `.factory-tmp/history-review-path`. Additional adversarial code exists only at `head/tests/independent-history.test.ts` under that root and imports `../estimator/refresh`, `../estimator/predict`, and `../tracking/store` from the exact extracted head. Every refresh uses injected execute, fictional rows and `new Store(":memory:")`; the CLI main entry point is never invoked.

Actual extraction commands (all exit 0):

```sh
mkdir -p .factory-tmp/home
review_dir=$(mktemp -d "$PWD/.factory-tmp/history-review-XXXXXX")
printf '%s\n' "$review_dir" > .factory-tmp/history-review-path
git archive b740b3452b536cdccfdf352a90982b11f66cce7d > "$review_dir/head.tar"
mkdir "$review_dir/head"
tar -xf "$review_dir/head.tar" -C "$review_dir/head"
ln -s "$PWD/node_modules" "$review_dir/head/node_modules"
cd "$review_dir/head"
mkdir -p .factory-tmp/home
```

The following commands were run from that extracted `head` directory. Outputs are retained one level above it; exits are actual observed process exits.

| Command | Exit | Receipt |
| --- | --- | --- |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/history-refresh-validation.test.ts` | 0 | `head-suite.log`: 48 pass, 0 fail, 129 expect calls |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/independent-history.test.ts` | 0 | `independent.log`: 10 pass, 0 fail, 78 expect calls |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/estimator.test.ts` | 0 | `head-estimator.log`: 4 pass, 0 fail, 23 expect calls |
| `HOME="$PWD/.factory-tmp/home" node node_modules/typescript/bin/tsc --noEmit` | 0 | `head-typecheck.log`: no diagnostics; includes scratch probes |

Thus head testing comprises 62 passing tests / 230 expect calls over three separately invoked suites. The 48-test suite remains the frozen acceptance command; the other runs supplement it.

After testing, `git hash-object` on extracted files and `git rev-parse HEAD-OF-REVIEW:path` (using the full reviewed SHA, not checkout HEAD) returned matching Git blobs, exit 0:

| Head path | Git blob |
| --- | --- |
| `estimator/refresh.ts` | `77ab4a54a149bc140ddccbd0142f3fee3aafdb50` |
| `estimator/predict.ts` | `aef6cb6795b3b8ec1dd4ec336a7cd4d615b599f3` |
| `tracking/store.ts` | `0b6e56269189cb7498e28a1a96a0543bc58f249f` |
| `tests/history-refresh-validation.test.ts` | `8b94b37ca398f32946be9e82ba72749dfdfa67b7` |

Scratch probe SHA-256, computed with Node `createHash("sha256")`: `2dafef362d986133dfebed58f4d4854caefc8816fdab30a2c670fa09262ae193` (exit 0). An earlier `shasum -a 256` attempt failed because sandbox policy blocked Perl's libperl loading; no hash from that attempt is relied on. No deliberate abort or signal-exit test was run.

Git emitted denied xcrun cache-write warnings, but the object commands and extraction completed successfully. Each Bun test run also emitted a denied ancestor-directory read warning after its test results; each returned exit 0 with the counts above. These warnings are retained, not permission/qualification success. No controller content was read.

## Boundary verdicts and reproduction

All line references below are against the pinned head, unless explicitly labeled otherwise. `H` means the unchanged 48-test head suite; `A` means the 10 scratch adversarial tests. Every failure case compares all three of `estimate-history`, `estimate-history-source`, and complete event rows against a seeded prior snapshot. Reproduction: use the extraction above, retain the scratch probe file, and execute the corresponding command in the receipt table. No live GitHub is needed.

| Boundary | Verdict | Concrete evidence / source |
| --- | --- | --- |
| Malformed JSON and response shapes | PASS | H rejects `{`, null, object, array-like object, string, number, boolean; prior state unchanged. `refresh.ts:39` parses unknown; `:17` validates the whole array. |
| Bad rows/labels/body | PASS | H rejects null/array/missing-field rows; missing/null/object labels; null labels, absent/numeric names; object/null bodies. Bad row after a good row and malformed imported row also preserve prior evidence. Schema at `refresh.ts:8`. |
| Invalid timestamps and derived values | PASS | H covers missing/null/numeric/empty/unparseable/date-only/impossible-calendar timestamps and epoch-zero derived timestamp; no invalid derived row commits. `refresh.ts:10`, `:22`, `:26`; positive HistorySchema at `predict.ts:3`. |
| Valid offsets; equal/reversed intervals | PASS | A normalizes `2026-01-01T03:00:00+03:00` to UTC and a next-day `+05:30` close to 86400 seconds; equal UTC instants with different offsets and a reversed offset interval refuse. `+25:00` and timezone-less input refuse. H also tests equal/reversed Z timestamps. `refresh.ts:23`. |
| Duplicate/unsafe identities | PASS | H rejects duplicate numbers, absent/null/string/zero/negative/fractional/unsafe numbers. A accepts `9007199254740991`; identity 7 in issue and PR namespaces remains distinct. `refresh.ts:9`, `:18`, `:27`. |
| Late repository/kind failure | PASS | H's fourth fetch fails by execute/shape/interval/truncation after three valid staged responses. A additionally injects execute rejection, bad JSON, null closedAt and boolean label name at calls 2, 3 and 4. No partial repo/kind snapshot, source change or event survives. `refresh.ts:36`–`:43`. |
| Execute rejection | PASS | A rejects at each later boundary; head estimator suite rejects first-call offline execute. Both retain prior snapshot. All execute functions are injected. |
| 10000 refusal / bounded success | PASS | H and A reject exactly 10000 rows before persistence. A accepts 9999 unique rows per issue and PR source, stores 19998 total, with only two calls despite duplicate repo configuration. The cap is per response, not aggregate. `refresh.ts:16`. |
| Duplicate repo configuration | PASS | H and A pass `[repo, repo]`; exactly two execute calls (one issue, one PR), without duplicate repo ingestion. `refresh.ts:37`. |
| Imported exclusions | PASS | H tests imported/migrated labels, Linear URL, imported-from and migrated-from bodies: 10 imported of 12 stored rows, only two eligible `history()` rows. A rechecks filtering after replacement. `refresh.ts:30`, `predict.ts:31`. |
| Elapsed-only unknown measurements | PASS | H checks all stored rows keep seconds/tokens/provider null/null/unknown. A also checks forecast helperHours/tokens null while elapsedHours is 24. No provider or native usage is inferred. `refresh.ts:28`, `:31`, `predict.ts:55`. |
| Valid empty replacement | PASS | H and A replace prior rows with `[]`, count 0 and new observedAt; A confirms exactly one appended empty-snapshot receipt and retention of all previous events. `refresh.ts:43`. |
| Atomic successful replacement | PASS | A replaces old identities with new issue/PR rows, checks both key writes occur while `s.db.inTransaction` is true, source count/time matches rows, exactly one matching event is appended, and all prior events remain. `refresh.ts:43`–`:48`. |
| Storage failure rollback | PASS | A installs fictional SQLite triggers raising `FAIL` before the refresh event insert, before history update, and before source update. Every rejected refresh restores both keys and complete event list. Reproduce with `BEFORE UPDATE ON kv WHEN NEW.key='estimate-history-source' ... RAISE(FAIL,'fictional storage failure')` to fail after event/history writes. Uses real in-memory SQLite transactions, not a mocked Store. `refresh.ts:43`, `tracking/store.ts:81` atomic wrapper. |

No source repair is proposed. On any future failed boundary, Product is the next actor: retain failing fixture/receipts, authorize a separate source fix, then restart on the new immutable head with this suite and the failed boundary. Never rewrite this original head or infer success from missing execution.

## Separate main and retained predictor compatibility

Main was independently extracted using `git archive 98eb82c9d103f005f18eabc1600045cacc24282d > "$review_dir/main.tar"`, `mkdir "$review_dir/main"`, `tar -xf ... -C ...`, and a separate symlink to the same read-only installed dependencies (all exit 0). Main has its own `.factory-tmp/home`. No branches were combined and no main tests were substituted for head acceptance.

| Main-only command / check | Verdict | Actual result |
| --- | --- | --- |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/estimator.test.ts` | PASS | Exit 0; 4 pass / 0 fail / 23 expect calls in `main-estimator.log` |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file run typecheck` | FAIL | Exit 1, `CouldntReadCurrentDirectory` in `main-typecheck.log`; no compiler acceptance claimed from this invocation |
| `HOME="$PWD/.factory-tmp/home" node node_modules/typescript/bin/tsc --noEmit` | PASS | Exit 0; no diagnostics in `main-direct-typecheck.log`; supported direct compiler path resolves the check |
| Head vs main predictor/test comparison | PASS | `git ls-tree` returns identical predictor and estimator-test blobs on both; `git diff b740b345 main -- estimator/predict.ts tests/estimator.test.ts` empty, exit 0 |
| Head vs main Store comparison | PASS (inspection only) | Main adds question-resolution migration/columns (13 additions/1 deletion); event/get/set/atomic behavior used here retained. No combined-tree execution claim |

Main's refresh still matches the unvalidated base implementation; its four passing estimator tests do not exercise PR49's malformed-history acceptance. Static interface compatibility of PR49 with current main is supported, but **combined-tree acceptance: NOT RUN**. Next actor Quality/Release; restart on their selected exact integration tree with the head validation command and storage probes before delivery.

Read-only GitHub PR fetches and exact local objects separately confirmed these retained OPEN predictor proposals:

- [PR50](https://github.com/fulmar-hq/agent-factory/pull/50), head `ae93815f4632554c8eb3ad587af121712a8c37df`, base `0da456aaa499568296df780012d97f5d7d4ab6cb`: orders forecast pools and held-out evaluation. `estimator/predict.ts:13` sorts completion then ID then remaining fields.
- [PR59](https://github.com/fulmar-hq/agent-factory/pull/59), head `cee3288d53bab22104e0d4c1f71d1a22333a0efc`, same base: binds native receipts to one eligible attempt and sorts history/prediction/evaluation. `estimator/predict.ts:15` sorts completion then start then ID; `:35`–`:41` validates/matches native receipts.

Both retain HistorySchema's exported shape (lines 3–8), imported filtering and nullable measurements, so PR49's `HistorySchema` import and emitted elapsed-only records remain compatible by inspection. Neither proposal is present in current main's predictor blob. They both edit `predict`/`score` and choose different tie-breaking rules; they must not be mechanically stacked or counted as duplicate refresh work. Their tests, merged behavior and relative ordering are **NOT RUN** here. Next actor Product chooses intended predictor precedence; Quality tests each retained proposal and any authorized resolution on its own immutable tree. Restart condition: an explicit integration tree and ordering decision. PR49 refresh evidence does not accept either predictor PR.

## Remaining gates and handoff

Full `bun test`, host integration, real signal exits, Linux abort coverage, live API failure behavior, controller persistence, qualification and delivery: **NOT RUN** in this bounded docs-only challenge. Some repository tests exercise subprocesses, worker custody and host capabilities beyond this approved probe scope. No macOS abort was deliberately invoked; no signal coverage is silently credited. Next actor Quality/Release runs applicable broader checks on an authorized host, with SIGTERM/mock SIGABRT on macOS and real abort coverage only on Linux. Restart only within a separately approved test boundary.

Missing objects/dependencies, permission denial or nonzero execution must remain NOT RUN/FAIL with the concrete failure and restart prerequisite; none may become synthetic success. The successful focused runs above do not establish private policy isolation or live endurance.

The supplied document-content assertion and `git diff --check` are local proposal checks, not product acceptance. Only this Markdown path enters the unsigned local proposal; scratch probes/logs remain outside Git. Undo the documentation proposal by reverting its docs-only commit after custody review; retain scratch evidence. Launcher alone may test, sign and publish the retained bundle after cleanup. Product custody and Quality/Release acceptance remain unchanged.

Local document receipt: the supplied Node assertion (both immutable SHAs, focused test path, `restart`, verdict and exit text required) returned exit 0. `git diff --check` returned exit 0; the staged version is checked again before commit. `git diff --exit-code -- estimator tests` returned exit 0. Initial status had no dirty files; final proposed change is only `docs/history-refresh-review.md`.
