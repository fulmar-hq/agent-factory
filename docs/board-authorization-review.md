# Board authorization review — issue 101

Independent acceptance verdict: **NOT RUN**. Reviewer identity collides with the original writer's published identity. This document records the blocker and bounded static observations; it does not approve PR47, establish runtime safety, or claim operational/Production success. Product retains custody; Quality/Release decide acceptance and delivery.

Reviewed proposal: [PR47](https://github.com/fulmar-hq/agent-factory/pull/47), issue44, immutable head `0d0180573ee8e2e7a952ac1c8a888d4110295856`, base `b157ad17f7cb26960992174a427669df37b95e2b`. Readback on 2026-11-09: OPEN, not draft, unmerged, 2 files, 109 additions / 22 deletions. Local diff confirms `board/server.ts` +27/-22 and `tests/board-authorization.test.ts` +82/-0. Checkout at intake was `e12c4bb440c998244dc0dd5e4202b609d7b26500`; its tests were not substituted.

## Independence gate and restart

GitHub `github_get_user_login({})` returned reviewer login `vincentmessina`, ID `72951696`. `github_get_pr_info` for PR47 returned the same author login/ID. `git show -s --format=fuller HEAD_SHA` identified the original head author and committer as Vincent Messina, `72951696+vincentmessina@users.noreply.github.com`; local Git identity matches. A separate conversation is not proof of a separate writer/reviewer. Shared launcher publication could explain account reuse, but there is no verified distinct original-worker/reviewer provenance here. No private transcripts were read to infer it.

Reproducer: compare those two read-only GitHub identity responses and the immutable commit metadata. Result: published-identity collision. Per the approved instruction “identity collision means NOT RUN,” the independent execution gate stays closed. This is an acceptance-evidence blocker, not a demonstrated authorization source defect.

Next actor: Product/Quality must assign a demonstrably independent reviewer and retain evidence distinguishing that reviewer from the original writer. **restart condition:** verified non-colliding reviewer provenance, unchanged reviewed head/base (or a freshly scoped review for a replacement head), available exact Git objects/dependencies, and permitted execution. Do not treat this document, CI green, or its format check as acceptance. No implementation repair or branch combination is authorized by this report.

## Source custody and command receipts

All listed source operations were read-only; extraction never reset or switched the checkout. Scratch is `.factory-tmp/board-review-gV7J4R/`, with `snapshot/`, `head.tar`, `base-server.ts`, and `source.diff`. `.factory-tmp/board-review-location.txt` records its absolute location. A failed earlier scratch directory is retained too. Nothing in scratch is part of the proposal.

Commands executed in this worktree (exit means process exit, not an acceptance verdict):

| Command / read | Actual result |
| --- | --- |
| `git status --short`; `git rev-parse HEAD`; `git config user.name`; `git config user.email`; `git show -s --format=fuller 0d0180573ee8e2e7a952ac1c8a888d4110295856` | Initial grouped shell exit 0; clean status, checkout/identity as above. Git emitted sandbox-denied xcrun cache warnings but returned source. |
| `git show HEAD_SHA:board/server.ts`; `git show HEAD_SHA:tests/board-authorization.test.ts` | Grouped shell exit 0; both source files read. `HEAD_SHA` throughout this table denotes the immutable reviewed head, not checkout HEAD. |
| Initial Node `spawnSync('git', ['archive', HEAD_SHA])` extraction attempt | FAILED: no stdout buffer; subsequent `writeFileSync` raised `ERR_INVALID_ARG_TYPE`; Node exit 1. The surrounding shell then read the board contract and exited 0, which does not erase the Node failure. No extraction success was inferred from that shell exit. |
| `review_scratch=$(mktemp -d "$PWD/.factory-tmp/board-review-XXXXXX")`; `mkdir -p "$review_scratch/snapshot/.factory-tmp/home"`; `git archive -o "$review_scratch/head.tar" HEAD_SHA`; `tar -xf "$review_scratch/head.tar" -C "$review_scratch/snapshot"`; `ln -s "$PWD/node_modules" "$review_scratch/snapshot/node_modules"` | Replacement shell used `set -e`, exit 0; successful unique extraction, scratch HOME, existing dependency symlink, no install or dependency writes. |
| `git show b157ad17f7cb26960992174a427669df37b95e2b:board/server.ts > "$review_scratch/base-server.ts"`; `git diff BASE_SHA HEAD_SHA -- board/server.ts tests/board-authorization.test.ts > "$review_scratch/source.diff"` | Same fail-fast shell exit 0; actual base/head diff inspected. `BASE_SHA` denotes the full base above. |
| `git rev-parse HEAD_SHA:board/server.ts HEAD_SHA:tests/board-authorization.test.ts`; `git hash-object "$review_scratch/snapshot/board/server.ts" "$review_scratch/snapshot/tests/board-authorization.test.ts"` | Fail-fast shell exit 0; corresponding blobs match exactly: `8548043a9e5381f801d9f7f04e3edc448835b720`, `864268e318bc9018a866952bc52d1c5c35d91585`. |
| `wc -l "$review_scratch/snapshot/tests/board-authorization.test.ts"`; `nl -ba` on extracted head and saved base | Exit 0; 82 lines; concrete source ordering inspected. |
| `git diff --numstat BASE_SHA HEAD_SHA`; `git diff --stat HEAD_SHA HEAD -- board/server.ts`; `bun --version` | Fail-fast shell exit 0; counts above; checkout server differs by +54/-30; Bun `1.3.14`. |
| From extracted `snapshot/`: `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/board-authorization.test.ts` | **NOT RUN**, no exit code: identity gate. Zero executed suite tests/assertions; no runtime PASS/FAIL count. Source defines 13 test instances (including loops), not 13 executed tests. |
| Additional scratch probes importing extracted `board/server.ts` | **NOT RUN**, no exit code: identity gate. Zero executed guard probes and zero header-constructor probes. |
| `bun run typecheck`; full `bun test` | **NOT RUN**, no exit code. This blocked docs-only review did not broaden into the full host suite or risk macOS abort integration tests. |

GitHub reads are connector responses, not shell exits: identity and PR47/PR73 metadata succeeded; corrected `github_list_pull_request_reviews({repo_full_name:"fulmar-hq/agent-factory",pr_number:47})` returned `reviews: []`; corrected PR73 filename read succeeded. Initial reviews/filenames calls used `repository_full_name` where `repo_full_name` was required and returned `INVALID_ARGUMENT`; retries above supplied the required field. Intake's no-comment result and complete newest/oldest inventories (28 open issues, 28 open PRs, all changed paths, no competing authorization challenge/output) are supplied intake context, not newly rerun inventory claims.

Repo AGENTS.md, README.md, operations, board-design and board README contract were read. Shared standards MEMORY/README/projects were sandbox-denied and connected MEMORY returned 404 per intake. This review uses recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; upstream was not refreshed.

## Boundary ledger

Every runtime row is blocked by the same independence gate. The following are concrete restart cases, not claimed executions. Use only fictional token `"a".repeat(64)`, port 4318, POST URL `http://127.0.0.1:4318/api/pause`, exact Host/Origin and invalid-JSON body. Import `same` and `authorizationResponse` from the extracted reviewed source; never call `board()` or a control. Reuse the existing suite before adding scratch-only cases.

| Boundary / source at reviewed head | Verdict | Existing evidence and exact restart probe |
| --- | --- | --- |
| `same()` ASCII exact/wrong/empty, `board/server.ts:17–20` | NOT RUN | Reuse test lines 10–15: identical `Bearer a…` true; `Bearer b…`, short, empty versus credential false. Add `same('', '')` true to distinguish equality semantics from valid authorization. |
| Equal JS-length / unequal UTF-8 byte-length Latin1 and supplementary Unicode | NOT RUN | Reuse lines 17–24: `Bearer ${'é'.repeat(64)}` and `Bearer ${'😀'.repeat(32)}` each have credential's JS length but different bytes; both comparison directions must return false without throwing. |
| Unequal JS-length / equal byte-length and exact Unicode equality | NOT RUN | Scratch: `same('é', 'aa')` and reverse false despite two UTF-8 bytes each; `same('😀','aaaa')` and reverse false despite four bytes each; exact `é`/`é` and `😀`/`😀` true. This directly tests the exported comparator without header encoding assumptions. |
| Exact bearer spelling, `board/server.ts:36–40` | NOT RUN | Reuse exact positive, wrong token, lowercase scheme, no scheme, double separator, empty. Add uppercase `BEARER`, tab separator and suffix alteration; inspect normalized header value before checking refusal. |
| Missing and duplicate headers | NOT RUN | Reuse delete-authorization/origin/host cases. Add duplicate values via header tuples/append, recording `.get()` normalization independently for each header, including identical duplicates. Compare the normalized string with the exact allowed value; no raw-header assumption. |
| Accepted versus rejected Request encodings | NOT RUN | Reuse Latin1 `é` header if constructor accepts it. Try supplementary `😀`, embedded NUL, CR and LF separately with construction in its own try/catch. A constructor rejection is only an encoding observation; guard was not executed. Unsupported encodings remain NOT RUN at guard level. Test leading/trailing header whitespace and record normalization before interpreting exact matching. No constructor behavior was observed this round. |
| Wrong/missing Host, `board/server.ts:34–35` | NOT RUN | Reuse missing, localhost, foreign host and port 4319. Add omitted port, IPv6 and scheme-prefixed Host; expect 403 loopback-host error when constructed value differs. |
| Wrong/missing Origin, port/scheme, `board/server.ts:36–40` | NOT RUN | Reuse missing, foreign origin, localhost and port 4319. Add `https://127.0.0.1:4318`, trailing slash, `null`, absent port and duplicate Origin; exact HTTP origin is the sole allowed POST value after header normalization. |
| Refusal headers and untouched body, `board/server.ts:21–40` | NOT RUN | For each constructed refusal assert 403, correct JSON error, cache-control no-store, nosniff, exact CSP, no-referrer and application/json; assert bodyUsed false before/after guard and after reading response JSON, then read original invalid body to prove preservation. Existing cases check only subsets. |
| GET / unsupported-method runtime behavior | NOT RUN | Static comparison below only; no board started, no handler/control invoked. |

## Static findings (separate from independent acceptance)

**PASS — exact-source custody, static only.** Archive extraction and matching blobs establish which files were inspected. Both required objects were available; cache warnings were not mistaken for missing source. Dependency execution remains unverified.

**PASS — guard placement, static only.** In extracted `board/server.ts`, fetch begins line 52, constructs URL at 53, calls `authorizationResponse` at 54 and returns refusal at 55. Only afterward does POST enter at 56 and `req.json()` run at 58. All POST controls are downstream: pause at 60/63, answer at 67/72–84, archive at 88/92 and stop at 95/97–110. Unsupported POST is downstream too at 113. The guard itself lines 33–41 accesses headers/method only; there is no body read or control invocation. Reproducer: inspect `nl -ba snapshot/board/server.ts` and search all pathname/POST branches. This proves source ordering, not runtime acceptance.

**PASS — base behavior comparison, static only.** Saved base `board/server.ts:43–51` checks Host for every method and Origin/bearer only for POST. Reviewed head lines 33–40 and 54–55 preserve those checks while moving them into a function. Base line 113 and head line 118 refuse non-GET methods after the POST branch with 405. With exact Host, GET ignores missing/wrong Origin/authorization and proceeds to existing routes; other non-POST/non-GET methods reach 405. With wrong Host, all methods first reach 403. `security`/`json` moved from base lines 26–37 to head 21–32 without value changes. Diff shows downstream GET/unsupported-method code unchanged. Reproducer: `git diff BASE_SHA HEAD_SHA -- board/server.ts` plus numbered base/head above. No live server or controls were needed.

**Source intent, not runtime PASS:** base comparator lines 17–18 gates `timingSafeEqual` with JS string length, while reviewed lines 17–20 compare encoded Buffer lengths. This removes the apparent unequal-buffer-length call path for the specified malformed examples. Exact runtime outcomes, Request encoding support and security-header/body assertions remain NOT RUN. No independently reproduced source FAIL is asserted.

## Integration and disposition

Fresh GitHub metadata reports PR47 `mergeable=false`; this is integration evidence, not proof of source failure. Retained [draft PR73](https://github.com/fulmar-hq/agent-factory/pull/73), head `c484d402d15384d843f890f0867cb87b80e757d2`, is OPEN/draft/unmerged and also `mergeable=false`. Its changed-path list includes `board/server.ts` among 14 files. Its base SHA is `b5b88756109f1e368cd47a8b034696f94b516269`. Current checkout server also differs from PR47 (+54/-30); it was never used for the frozen tests. No merge simulation, branch combination or main test run occurred. Release must reconcile current-main integration separately, retain PR73 and obtain a new immutable-head review if source changes.

The sole tracked proposal is this document. No original-head edits, implementation changes, GitHub writes, live data/tokens, sign-ins, models, controls, messages, jobs, policy/settings changes, signing, push, merge or release occurred. No deliberate SIGABRT/os.abort was run. Preserve scratch, branches, claims and evidence; undo the document through the normal reviewed revert path without deleting operational assets. The requested unsigned local commit/bundle is for launcher testing/signing/publication, not acceptance or Product custody transfer.

Delivery validation receipt: the exact approved `node -e` document-content assertion followed by `git diff --check` ran and exited 0. It checked both immutable SHAs, the focused test path, restart text, boundary verdicts and command-exit reporting. This is a report-format/whitespace PASS only; independent acceptance remains NOT RUN. The same check is repeated after this receipt is added.
