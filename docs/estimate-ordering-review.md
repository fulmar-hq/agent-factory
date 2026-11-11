# PR50 estimate ordering challenge

Issue: fulmar-hq/agent-factory#87, reviewing #41 / [PR50](https://github.com/fulmar-hq/agent-factory/pull/50). Review date: 2026-11-09.

**Disposition: acceptance NOT RUN pending native reviewer-independence evidence; technical challenge found a FAIL.** Six existing tests pass, but imported records can affect held-out eligibility and promote a forecast. This report is a docs-only proposal, not Quality acceptance or Release delivery authorization. Product retains custody; Quality/Release determine acceptance and delivery. No estimator repair is included.

## Immutable scope and provenance

- Reviewed head: `ae93815f4632554c8eb3ad587af121712a8c37df`.
- Named base: `0da456aaa499568296df780012d97f5d7d4ab6cb`.
- Merge base: `b157ad17f7cb26960992174a427669df37b95e2b`.
- GitHub readback confirmed PR50 OPEN, the named head/base, and zero submitted reviews. Issue41 comments were empty; the supplied intake records no duplicate challenge. No GitHub writes were made.
- `git diff BASE...HEAD --stat` is the advertised two-file proposal: `estimator/predict.ts` and `tests/estimator-ordering.test.ts`, 128 additions / 2 deletions. `git diff BASE HEAD --stat` instead reports 15 files, 131 additions / 967 deletions because the base advanced independently. Do not describe those release-file deletions as PR50's proposed patch or deploy the old head as today's main tree.
- Starting checkout HEAD and API-confirmed current main: `35fe1a42c427a821fbe82284aecef00033802403`. Local `origin/main` was stale (`10709947323c6dfc798e324c5c595ff781744110`); it was not used as current-main evidence or changed.
- Head extracted with `git archive`, without checkout/reset/merge. Unique retained scratch: `.factory-tmp/pr50-review.EFiwBq`. Installed dependencies were reused through a read-only-policy `node_modules` symlink; no install or dependency changes. Bun reported `1.3.14 (0d9b296a)`.
- Extracted source/test blob hashes matched immutable Git objects after probing: `4d28a9d7cc8bc20350bde9c1bd4cf5c881940d05` and `3f16038a1779ff18aa2079b3b254c4da254fc2ae` respectively. All extra probes remain in scratch and import the extracted source, not this checkout's estimator.

Reviewer independence: **NOT RUN / unverified**, rather than inferred from the shared publisher. PR50 metadata identifies the launcher-signed commit and tested tree `e7a394947b4b401d2aeed1bcaf41b51d7aa00009`, but supplies no original native writer identity. The available issue, PR, comments and Git metadata do not bind that writer to a native session that can be compared with this review session. A different issue/workspace or the same GitHub author proves neither independence nor collision. No private owner records/transcripts were copied into Git. Next actor: Product/launcher provides a private attested original-writer/current-reviewer native identity comparison to Quality. Restart independent acceptance only after distinct identities are verified; a collision requires a different reviewer and makes this run NOT RUN for independent acceptance. The executed technical observations below remain observations, not an independence attestation.

README.md, AGENTS.md and docs/operations.md were read. Required shared `MEMORY.md`, `README.md` and `projects.md` under `/Users/vincent/Developer/working-standards` returned `Operation not permitted` (combined `cat` exit 1). Their contents were not invented or replaced with newer policy. Restart that context check with authorized readable sources; this review uses the repository's recorded adoption and explicit issue87 scope.

## Commands and receipts

Commands ran locally in the worker sandbox. `BASE`/`HEAD` below denote the literal immutable hashes above. No command used credentials, launched a model, touched #83/#84, operated a provider, changed custody/policy/settings/schedules, or sent messages. Git commonly emitted an xcrun cache-write denial under `/var/folders/.../T/xcrun_db-*`; the listed Git operations still returned exit 0 and produced their requested objects. No denial is treated as successful execution of the denied write.

The extraction commands, from the unchanged checkout, were:

```sh
set -o pipefail
review_dir=$(mktemp -d "$PWD/.factory-tmp/pr50-review.XXXXXX")
printf '%s\n' "$review_dir" > .factory-tmp/pr50-review-path
git archive ae93815f4632554c8eb3ad587af121712a8c37df | tar -x -C "$review_dir"
ln -s "$PWD/node_modules" "$review_dir/node_modules"
mkdir -p "$review_dir/.factory-tmp/home"
cd "$review_dir"
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/estimator-ordering.test.ts
```

| Actual command/check | Exit / observed receipt |
| --- | --- |
| `git show --format=fuller --no-patch HEAD`; merge-base, two-dot and three-dot diff reads | 0; objects present, divergence recorded above |
| Extraction and exact-head test command above | 0; **6 pass, 0 fail, 165 expect calls**, one test file, 131 ms |
| From extracted head: `HOME="$PWD/.factory-tmp/home" bun --no-env-file .factory-tmp/probes.ts` | **1; 5 PASS / 1 FAIL** independent checks; assertion failure is imported eligibility, not missing dependencies |
| From extracted head: `HOME="$PWD/.factory-tmp/home" bun --no-env-file .factory-tmp/promotion-contamination.ts` | 0; diagnostic reproduction, two outputs, not a passing acceptance assertion |
| From extracted head: `HOME="$PWD/.factory-tmp/home" bun --no-env-file run typecheck` | **1; NOT RUN**, `error loading current directory`, `CouldntReadCurrentDirectory` |
| From extracted head: `HOME="$PWD/.factory-tmp/home" node node_modules/typescript/bin/tsc --noEmit` | **0**; TypeScript check completed through the installed read-only compiler |
| `git rev-parse HEAD:estimator/predict.ts HEAD:tests/estimator-ordering.test.ts`; `git hash-object` on those extracted files | 0; matching blob pairs above |
| `git diff BASE...HEAD --check` | 0 |
| Issue87's supplied `node -e` report assertion followed by `git diff --check` | 0; required hashes, test path, restart, verdict and exit receipt present; format verification only |
| Three separate `HOME="$review_dir/.factory-tmp/home" bun --no-env-file .factory-tmp/compatibility.ts ABSOLUTE_EXTRACTED_SOURCE` invocations, from checkout | Each 0; diagnostic outputs for PR50, current main and PR59 below |

The exact-head Bun test also printed `error: Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after the six passing cases. The tests executed; the ancestor directory read was denied. This is not permission/isolation qualification. Any required coverage dependent on that denied read is NOT RUN; restart in an authorized sandbox that permits the required read, without widening policy here. Likewise the denied Bun script-runner typecheck is NOT RUN even though the direct Node compiler completed. Full-suite `bun test` without a file filter was NOT RUN in this focused review; only the six authorized existing tests were reused. No deliberate abort or signal-exit integration test ran on macOS.

## Boundary verdicts at PR50 head

These PASS results describe executable synthetic checks or explicitly identified source inspection; they do not waive the independence gate.

| Boundary | Verdict | Evidence |
| --- | --- | --- |
| Actual promotion without injecting a success status | PASS | Independent 50-row history: first 20 values 100, next 30 values 10; score has 45 held-out observations per dimension, status `better`; estimate chooses recent-five, tokens 100. Seconds error ratio 0.16103652880592662, tokens 0.1610365288059266. |
| Shuffled/frozen inputs, both exports, no mutation | PASS | Independent probe rotates all 50 positions and reverses each, freezes rows and array, deep-compares score/estimate, and compares serialized before/after. Existing six tests add seeded permutations. Source `estimator/predict.ts:13` copies before sort. |
| Completion ties and duplicate IDs | PASS | Existing tests exercise distinct IDs and duplicate IDs. Independent seven-record duplicate tie (same start/completion/ID, values 1..7) yields tokens 50 in both directions; frozen input unchanged and scores equal. Comparator at `estimator/predict.ts:16` continues through remaining fields. |
| Equal-start completions, overlapping/future rows and provider exclusion | PASS | Independent and existing tests add huge-value rows completed at target start, just after, or wholly in the future; forecasts unchanged. Held-out test adds completion times 10000/10001/30000 against target start 10000; score unchanged. Strict `<` at `estimator/predict.ts:43` and `:54`. |
| Imported measurements excluded from prediction | PASS | Huge imported value cannot change selected measurement mean/recent-five value when evaluation eligibility is otherwise unchanged; `estimator/predict.ts:43`. |
| Imported rows excluded from evaluation eligibility/promotion | **FAIL** | Imported predecessor counts toward the five-record eligibility filter at `estimator/predict.ts:54`. Reproduction below changes count and can switch the default estimate method. |
| Dimension-specific comparable/provider fallback | PASS | Independent three comparable seconds values 1/2/3 exclude other-area value 100 (helper mean 2 seconds); one null comparable token leaves only two known comparable tokens, so provider fallback produces `(10+20+1000)/3`. Elapsed remains comparable mean 4 seconds. Existing test also exercises promoted provider recent-five fallback. `estimator/predict.ts:43`–`:48`. |
| Null measurements / absent history/provider | PASS | Independent all-null data, empty array and absent provider return null; no zero or inferred tokens. Existing tests retain null tokens with a promoted evaluation. `estimator/predict.ts:48`, `:74`. |
| Minimum 20 held-out measurements per dimension | PASS with FAIL caveat above | 24-row declining-value history gives 19 observations and `not-better`; 25 rows gives 20 and `better`. Null token dimension blocks promotion. Imported eligibility can falsely supply the twentieth observation. |
| At least 10% improvement for helper time/tokens; elapsed no worse | PASS (source inspection plus non-edge dynamic fixtures) | `estimator/predict.ts:62`–`:64` requires both non-null ratios `<= .9` and elapsed candidate error `<=` mean. Constant history has zero mean error, null ratios and `not-better`; declining histories promote. Exact 0.9 floating-point threshold and an isolated elapsed-regression fixture were **NOT RUN** dynamically; restart with constructed boundary datasets if Quality requires that additional coverage. |
| Forecast advisory; approved reservations not reduced/reset | PASS (source inspection only) | Head/current docs/operations.md:88 matches the algorithm's contract. Head `launcher/engine.ts:178` applies maxima against approved bounds independently; `:251` stores forecast separately; `:369` reads frozen brief bounds/explicit extension for overrun calculation. PR50's diff does not change that integration. No live reservation/accounting test was performed. |
| Native independence, quota/accounting, Production acceptance | **NOT RUN** | Native identity attestation absent; synthetic estimator tests establish no native accounting, subscription percentage, provider qualification or deployed Production evidence. |

## Finding: imported row can select recent-five

Source: immutable PR50 `estimator/predict.ts:54` counts imported prior rows for eligibility while `:43` excludes them from training. This line is unchanged from the merge base, named base and current main: it is a pre-existing adjacent contract defect, not introduced by the new sort. `history()` filters imported rows (`:38`), but exported direct callers of `score()`/`estimate()` can pass valid `History` records with `imported: true`.

Minimal observed case: four clean predecessors of value 100 and a later target of value 10 produce zero held-out measurements. Add one earlier imported row: each dimension now counts one held-out measurement (seconds candidate/mean error 90; tokens 900; elapsed 180). The imported value is not averaged into prediction; it changes the eligibility gate.

Stronger reproduction, saved as scratch `promotion-contamination.ts`, importing exact head:

```ts
import {score, estimate} from '../estimator/predict.ts';
const target = {area:'screen', kind:'feature', provider:'codex'};
const rows = Array.from({length:24}, (_, i) => ({
  ...target, id:String(i), started:1000+i*1000, completed:1500+i*1000,
  seconds:i<10?100:1, tokens:i<10?1000:10, elapsed:i<10?200:2,
  imported:false,
}));
const imported = {...rows[0], id:'imported', started:1, completed:2, imported:true};
for (const input of [rows, [...rows, imported]]) {
  console.log(score(input), estimate(input, target, 100000));
}
```

Actual clean result: 19 held-outs per dimension, `not-better`, method `mean`, tokens **422.5**. With imported row: 20 held-outs, `better`, method `recent-five`, tokens **10**. Errors themselves are unchanged: seconds candidate 297 / mean 896.2700245474005, tokens 2970 / 8962.700245474003, elapsed 594 / 1792.540049094801. This is an advisory forecast correctness issue, not evidence of changed reservations or quota use.

Next actor: Product retains this finding; Quality determines whether it blocks PR50 or needs separately approved repair. No fix or new ticket was created. Restart: independently qualified reviewer reruns this exact reproduction and the six head tests; if a later approved repair changes the head, bind all new evidence to that new immutable head and retain these results. Required expected behavior: imported row does not change eligibility, evaluation or default forecast.

## Separate current-main / PR59 compatibility

Current main was verified via read-only GitHub branch API as `35fe1a42c427a821fbe82284aecef00033802403`, and extracted separately into `.factory-tmp/main-compare.k5gKPV`. Retained [PR59](https://github.com/fulmar-hq/agent-factory/pull/59) remained OPEN at `cee3288d53bab22104e0d4c1f71d1a22333a0efc`, base `0da456aaa499568296df780012d97f5d7d4ab6cb`, and was separately extracted into `.factory-tmp/pr59-compare.2uEAP4`. No branches were combined, refs updated, heads altered or changes applied to main/PR59.

`git diff PR50 CURRENT_MAIN -- estimator/predict.ts` shows that main lacks PR50's copy-sort helper and its use in prediction/evaluation. PR59 overlaps prediction, evaluation and history construction (41 changed source lines plus its separate attempt tests). PR59 `estimator/predict.ts:15` sorts completion, then start, then ID; PR50 sorts completion, then ID, then remaining fields. With equal completion but different starts/IDs these are different policies. With identical completion/start/ID, PR59 has no remaining-field tie break, losing PR50's duplicate-ID guarantee. PR59's substantial attempt-receipt checks must also be preserved by any later integration decision.

Compatibility probe: seven otherwise identical records with ID `duplicate`, start 1000, completion 2000, seconds 1..7, tokens 10..70 and elapsed 2..14. Call estimate at 3000 with explicit `{...score([]), status:'better'}` to isolate recent selection, then reverse input. This injection is diagnostic only; natural promotion was established separately on PR50 above.

| Separate source | Forward/reverse tokens | Compatibility verdict |
| --- | --- | --- |
| PR50 immutable head | 50 / 50 | PASS duplicate-ID stability |
| Current main | 50 / 30 | FAIL same ordering contract; main tests are not head acceptance |
| Retained PR59 immutable head | 50 / 30 | FAIL duplicate-ID stability; cannot substitute PR59's ordering for PR50 without review |

All three probe processes exited 0 because they print observations; unequal outputs are FAIL, not success inferred from process exit. Combined-branch build/tests and textual merge resolution: **NOT RUN**, expressly outside this round. Next actor: Product coordinates retained PR50/PR59 scope; Quality approves an explicit tie contract and tests the eventual separately authorized integrated immutable tree. Restart compatibility review when main or either retained head changes, or when integration is authorized. Preserve both original heads and acceptance records.

## Handoff and limits

Report-format checks and green CI cannot turn the FAIL or identity NOT RUN into acceptance. No model/provider/Production operation, launchd/job change, sign-in, spending, funding, policy edit, custody reset or history deletion occurred. Existing #83/#84 work was untouched. Scratch snapshots/probes are retained privately under `.factory-tmp`; only this report belongs in the proposal commit. Launcher alone tests, signs and publishes the delivered unsigned snapshot after worker cleanup. Undo this documentation proposal through the normal reviewed revert; preserve original evidence and operational assets.
