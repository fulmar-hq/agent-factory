# Capacity display acceptance evidence

Issue: fulmar-hq/agent-factory#112; reviewed proposal: [PR43](https://github.com/fulmar-hq/agent-factory/pull/43), implementing [issue38](https://github.com/fulmar-hq/agent-factory/issues/38). Review date: 2026-11-09. This is a docs-only evidence proposal, not acceptance or merge authority.

Exact head: `030b029a7a67486a0bda6de6d46419c4772dc0e9`.
Exact base: `b157ad17f7cb26960992174a427669df37b95e2b`.
Head tree: `3f7dd01c4d8f05b3b11802e24eff3025782f8b6a`.
GitHub readback confirmed OPEN, not draft, unmerged, `mergeable=false`, and these exact refs. The complete base-to-head diff contains only board/app.js, board/index.html, board/style.css and tests/board-capacity.test.ts: 240 additions, no deletions.

## Independence and authority

**NOT RUN — independent acceptance.** PR43's author is `vincentmessina` (GitHub ID 72951696); its commit author/committer is Vincent Messina, `72951696+vincentmessina@users.noreply.github.com`. The read-only authenticated GitHub profile is the same account and local Git identity has the same name/email. This is an identity collision, not proof of a different reviewer. A fresh leaf/workspace does not establish worker independence. No original native worker identity was read or inferred from private transcripts; original-versus-review worker identity remains unverified. All PASS/FAIL entries below describe reproducible technical observations only, not an independent Quality verdict.

Dependency **Quality / independent-review**: Product must retain custody and arrange a separately identified reviewer with evidence distinguishing that reviewer from PR43's original worker. Observable restart: that reviewer records identity separation and repeats the exact-head/base checks, then supplies its own verdict. If either ref changes, review the new immutable pair afresh. Release alone makes the release disposition after independent Quality evidence and integration checks; this document grants no policy or merge authority.

Repository AGENTS.md, README.md and docs/operations.md were read, including the exact-head AGENTS. Attempts to read shared working-standards MEMORY.md, README.md and projects.md returned `Operation not permitted` (combined cat exit 1). Retain recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream adoption is implied. Restart: an authorized reader supplies those governing sources, then checks whether they alter this review. Intake's prior inventory (35 open issue bodies, 32 open PR file lists, no prior capacity challenge/comment/review/thread) is supplied context, not a new exhaustive inventory claim here.

## Isolation and command receipts

The starting checkout was clean (`git status --porcelain=v1`, exit 0, empty); its HEAD was `e12c4bb440c998244dc0dd5e4202b609d7b26500`. No reset, clean, checkout, rebase or implementation edit was performed. A newly created scratch directory `.factory-tmp/capacity-review-112-20261109` holds an archive extracted from the retained head object, not a copy of working files. Existing node_modules was linked read-only by use; nothing was installed or modified there. Scratch `.factory-tmp/home` and `.factory-tmp` provide HOME/TMPDIR for Bun. Probes and outputs remain ignored scratch, not a committed duplicate test matrix.

Commands below ran from that extracted snapshot unless stated otherwise. Node v24.18.0; Bun 1.3.14 (0d9b296a), macOS.

| Command | Actual exit and evidence |
| --- | --- |
| `git archive --format=tar -o .factory-tmp/capacity-review-112-20261109/head.tar 030b029a7a67486a0bda6de6d46419c4772dc0e9`, then `tar -xf … -C .factory-tmp/capacity-review-112-20261109` from checkout | 0; extracted retained immutable source |
| `node node_modules/typescript/bin/tsc --noEmit` | 0; no diagnostics; source/type check, not rendering acceptance |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/board-capacity.test.ts` | 0; 6 pass, 0 fail, 70 expect calls, 1 file. Bun also printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied`; this did not change the returned exit or test counts. No broader directory access was attempted to remove it. |
| `node probe.cjs > .factory-tmp/probe-results.jsonl` | 0 on final run; 41 adversarial cases, 48 explicit assertions. Null-session exception captured as an observation, not counted as a passing robustness case. Most row outputs are observations, not independent assertions. |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file producer-probe.ts` | 0; 6 assertions of exact-source `slotLimit` with fictional in-memory store/config; no DB, memory command or controller invocation |
| `git hash-object` on extracted app.js/server.ts/capacity.ts, compared with `git ls-tree` at head | 0; matching blobs respectively `d9beb5d8dee08a66fc86a1a51a18617266012f38`, `5dc1d22244404d5b99374b9a871d03ce7a323a4a`, `cfc0f08e117ca923ffd91cafc611c5160bbbe098` |
| Required issue112 `node -e` document-content check followed by `git diff --check`, from delivery checkout | 0; required refs, suite name, restart, verdict, exits and independence text present; format-only validation |

Git commands printed sandbox-denied xcrun cache-write diagnostics but returned the recorded objects/status successfully. No capability was widened. Full `bun test` was NOT RUN: this leaf authorizes the focused synthetic suite, not host/native integration. No process abort/SIGABRT test was run. Final document-format validation and `git diff --check` are delivery checks only, not acceptance evidence.

## Boundary results

Source line numbers below refer exclusively to the exact reviewed head, not the delivery checkout.

| Boundary | Verdict | Evidence / limit |
| --- | --- | --- |
| Missing controller | PASS | Existing test: unavailable status, unknown sampled values; current slots.max still shown. Scratch missing/null slots also yield unknown limits and unavailable evidence. |
| Real zero versus missing/invalid counts and rates | PASS | Existing zero busy/failure tests; scratch undefined/null/negative/fractional/string/NaN/Infinity counts become Unknown, zero remains 0. app.js:159–162,171–178. |
| Retained paused/unknown occupancy | PASS | Existing 8 occupied / 6 limit with paused 1 / unknown 2; no clamp to limit or subtraction of custody. server.ts:181,184; engine.ts:90–97 counts all statuses except finished/archived. |
| Sample age 119999 ms | PASS | Empty status, sample accepted. app.js:163–164. |
| Sample age exactly 120000 ms | PASS | Empty status, inclusive boundary; matches producer dwell continuity threshold capacity.ts:25. |
| Sample age 120001 ms | PASS for warning and sampled dwell | Warning appears; dwell remains sample.at minus healthySince, never wall-clock extension. Historical row interpretation discussed below. |
| Sample 1 ms in future | PASS for rejection; FAIL for row provenance | Warning plus Unknown sample/dwell, but Normal / 0% / growth reason still render. Finding F1. |
| Invalid sample.at | PASS for rejection | Missing, null, NaN, Infinity, numeric string, zero and negative all warn and show Unknown sample/dwell. Other rows remain visible as in F1. |
| Invalid now | FAIL for strict malformed-input handling | Undefined/null/NaN/zero/negative warn; Infinity warns but keeps sample/dwell; numeric-string now is silently accepted as fresh. Finding F2; producer normally supplies a number. |
| Missing/non-array sessions | PASS at capacity renderer boundary | Undefined/null/object yields Unknown / Unknown. This does not prove full render() tolerates absent sessions: existing downstream loops assume API arrays. |
| Malformed session entries | FAIL for robustness | `[null]` throws reading status; `[{}]` and `["paused"]` produce 0 / 0, conflating malformed entries with measured absence. Finding F3; not demonstrated from valid producer output. |
| Current admission limit versus policy ceiling | PASS | Always Unknown ceiling, never controller.slots or API max relabeled maximum. Fictional current 6 / policy ceiling 12 returns 6; sampled 9 returns 9; 99 clamps 12; 1 clamps 6; missing defaults 6; controller absent returns start_parallel 4. |
| Actual dwell, pressure enum, out-of-range fractions | PASS | Existing tests; valid dwell uses c.at, null means Not accumulating, bad fractions/pressure map to Unknown. No claim that a sample proves continuous live health. |
| Six exact-head growth reasons, EN/FR | PASS | Existing suite checks all six French mappings and switching back to English. app.js:46–53,114–121 matches capacity.ts:26–28. |
| Repeated language changes | PASS synthetically | Scratch EN→FR→EN→FR→EN retains ten rows; existing suite exercises full render and no duplicate rows. No browser layout claim. |
| Unknown reason inert text | PASS at source/synthetic boundary | Existing suite and scratch malicious-looking fictional img string remain text; app.js:143–146 uses textContent, not HTML parsing. |
| No new controls | PASS | Diff and existing suite: capacity section has heading/status/dl only; no button/input/select or scheduling action added. |
| Accessible semantic structure | PASS source only | index.html:23–26 named section, h2, role=status, dl; app.js:185–189 creates dt/dd pairs in div groups. Keyboard, accessibility tree and live announcements are NOT RUN. |
| Responsive source rules | PASS source only | style.css:63–79 auto-fit minmax(min(100%,240px),1fr), min-width:0 and wrapping; existing 500px media rule/focus-visible styles retained. Not proof of layout. |
| EN 375px browser | NOT RUN | No authorized actual browser evidence; restart dependency below. |
| FR 375px browser | NOT RUN | Same. |
| EN 1440px browser | NOT RUN | Same. |
| FR 1440px browser | NOT RUN | Same. |
| Integrated candidate / release | NOT RUN | PR43 mergeable=false; PR73 changes producer semantics; no combined candidate was built or conflict resolved. |

## Findings and minimal fictional reproductions

F1 — **FAIL: future/invalid evidence rows lack usable sample provenance; stale historical values require explicit interpretation.** app.js:163–183 gates only warning, dwell and timestamp on validity/freshness. With `now=1800000000000`, `controller={at:1800000000001, slots:6, busy:5/6, pressure:"normal", failureRate:0, healthySince:1799998200001, reason:"collecting healthy hour"}`, the result has the stale/invalid warning and Unknown timestamp/dwell, yet “Memory pressure: Normal”, “Failure rate · trailing hour: 0%”, and “Growth status / hold reason: Collecting a healthy hour”. This is a plausible stored sample after a clock rollback, without corrupting the Capacity shape. The evidence is not current authority; even its displayed timestamp is unavailable. The warning correctly refuses current growth, but those unqualified rows can still be read as current facts. The existing test title about future samples not implying current health overstates what its assertions establish.

For a stale but otherwise valid sample, use at=1799999879999 and healthySince=1799998079999: dwell stays 30 min at sample, not 32 min at request. This is correct historical evidence; retaining it is not inherently a bug. Busy explicitly says sampled and dwell explicitly says at sample. Pressure, trailing-hour failures and growth have no equivalent local qualification. With reason="maximum capacity", the row says “Maximum capacity reached” even while current growth is unknown. capacity.ts:28 really emits that reason; it is historical controller state, not a supplied numeric policy ceiling or a grant to grow. Product must decide the explicit historical labeling/unknown contract in a separately scoped repair; Quality must verify that future/invalid rows cannot be mistaken for current authority. No claim is made that this read-only display changes admission or that stale historical rows must be deleted. Browser comprehension/announcement acceptance remains NOT RUN.

F2 — **FAIL: invalid-now numeric coercion.** app.js:163–164 never requires finite numeric data.now. With otherwise valid sample at 1800000000000 and `now="1800000000000"`, status is empty and dwell 30 min. `now=Infinity` warns but still treats sample time as valid. server.ts:116,130 supplies Date.now(), so ordinary exact-head API output does not generate these malformed inputs. This is an adversarial robustness gap, not evidence of a live clock bug. Product owns separate repair scope; restart with finite/type checks demonstrated against these cases and unchanged 119999/120000/120001 boundaries.

F3 — **FAIL: malformed session members crash or manufacture zero custody.** For a valid sample and `sessions=[null]`, renderCapacity throws `Cannot read properties of null (reading 'status')` at app.js:166 before replacing evidence rows. `[{}]` and `["paused"]` instead show 0 / 0. Full refresh catches rendering errors at app.js:388–395 and changes connection text, but this is not proof that previous capacity rows are cleared. server.ts:181 normally maps typed engine session rows to objects; no valid-producer route to null was established. This is a robustness finding under malformed input, not an asserted production incident. Product owns triage/repair; observable restart uses these exact arrays, demands unknown/unavailable rather than a throw or false zero, and retests valid retained custody.

The scratch renderer probe executes the extracted complete board/app.js in node:vm and calls its actual renderCapacity; it does not reproduce the rendering implementation. It intentionally isolates this boundary from unrelated full-render assumptions. The existing six-test suite separately executes full render. producer-probe imports the extracted launcher/capacity.ts and supplies only fictional in-memory getters. All retained examples are fictional, including epoch values and counts. Infinity/NaN/undefined cases test JavaScript robustness; they are not claimed to survive JSON transport as those values.

## Exact producer contract and integration dependency

board/server.ts:184 exposes `{used:e.active().length, max:slotLimit(s,c), controller:s.get("capacity-controller")}`. Current `max` can differ from the stored sample's slots after config changes; capacity.ts:5–9 bounds it using policy start/max. No API field exposes policy max. Capacity type at capacity.ts:4 and persisted state at :29 contain slots, at, healthySince, pressure, busy, failureRate and reason. Unknown policy ceiling must remain unknown; this review does not authorize adding API fields, increasing limits or deriving a maximum from reason text.

launcher/tick.ts:97 samples only starting/running workers; capacity.ts:24 divides that count by the pre-growth admission limit, while :27 can add one slot before persisting the sample. Thus sampled busy is not recomputable as current occupied / current admission limit, and paused/unknown retained custody belongs only in occupancy. Failure rate at :21–23 aggregates unique worker outcomes over the trailing hour ending at sample time; zero means no failed outcomes in that calculation (also zero when there are none), not proof of universal health. Dwell, pressure and reason are sampled facts, not live authorization.

Read-only PR73 comparison: OPEN draft, mergeable=false, head `c484d402d15384d843f890f0867cb87b80e757d2`, base `b5b88756109f1e368cd47a8b034696f94b516269`. Its body explicitly retains a policy-clarification hold. Both GitHub patch and retained local objects show its board/app.js Codex pace insertion overlaps file ownership with PR43; textual overlap alone does not establish the cause of PR43's conflict. No merge simulation or branch mutation was performed.

PR73 also changes server occupancy to include challengerCount, allows admission limits below configured start, adds memoryFree/policy fields and new reason strings: “collecting healthy interval”, “added one slot after healthy interval”, “memory free below floor”, “failure rate above ceiling”. PR43's six-key mapping would display these as raw English in French. This is an integration requirement, not a defect attributed to PR43's exact producer. Retained challenger occupancy would also lack a breakdown in sessions-only paused/unknown rows. Neither proposal exposes the numeric policy ceiling. Existing exact-head evidence cannot establish acceptance for their combination.

**Next actors and observable restart:** Product retains custody, triages F1–F3 and scopes any repair separately; Product reconciles intended producer/display contracts and the PR73 policy hold without using this leaf as authorization. Release owns the integration path and conflict disposition, then identifies an immutable candidate head/base. Independent Quality reruns focused source and adversarial checks against that pair, including new bilingual reason mappings and challenger occupancy if actually adopted. Release alone assesses final merge/release readiness. No rebasing, conflict repair, policy expansion or acceptance of PR73 occurred here.

Browser/keyboard restart dependency: Product must separately authorize actual read-only EN/FR runs at 375px and 1440px on that candidate, with retained viewport/language/head receipts, overflow and wrapping readback, keyboard focus order/visibility, semantic accessibility tree and status announcement evidence. This leaf explicitly forbids starting a browser/signing in; no browser child was requested and no synthetic DOM result substitutes for those checks. Missing capabilities remain NOT RUN, not waived by green CI, this document's format check, or elapsed review time.

Only this document is proposed for Git history. Scratch and original assets are retained. No GitHub writes, native/provider operations, live controller/mail DB, credentials, messages, settings, activation, policy edits, signing, push, merge, release, launchd or custody/debit reset occurred. The explicitly requested unsigned local delivery commit/bundle are for launcher validation and later signing/publication, overriding the repository's usual signed-commit rule for this leaf. Any check not evidenced above remains NOT RUN within the 30-active-minute ceiling.
