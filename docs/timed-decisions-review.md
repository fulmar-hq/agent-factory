# Timed decision review — independent supplement

Current review: issue #117, 2026-11-09 evening ET (execution began 2026-11-10 00:45 UTC). This supplements the existing [PR118 report](https://github.com/fulmar-hq/agent-factory/pull/118) at `6840b025c8c109b3d5cadce94d7af3c7601cc10a`, report blob `669ad8a0f8700120b48a0c3b4b563c52bc832c77`. Its historical content and receipts are retained below. This section governs the current verdict and supersedes its native-independence NOT RUN, cold-start NOT RUN where specifically reproduced here, and unrestricted SQL-immutability PASS. Publication must reconcile this supplement into that existing report lane; it is not authorization for another parallel challenge PR.

**Verdict: PASS for exercised DecisionService API behavior at the exact head; FAIL for an unrestricted Store.db immutability claim and for the separately reproduced current-main fixture compatibility. Application integration/endurance remain NOT RUN.** The SQL finding does not demonstrate a normal service-method overwrite or an authentication exploit. Quality must disposition its supported-boundary implications; this is not unconditional acceptance, a hosted review, or release permission.

Reviewed OPEN PR46 / issue34:

- Head: `ce3ec491eb0a82e7b6b1297c2052e287495056da`.
- Base: `b157ad17f7cb26960992174a427669df37b95e2b`.
- Full diff inspected: only `tracking/decisions.ts` (118 additions) and `tests/decisions.test.ts` (188 additions), 306 additions total.
- Comparison main: local immutable `e12c4bb440c998244dc0dd5e4202b609d7b26500`. Connected read-only `main:tracking/store.ts` also returned blob `bbd4004c427cc0079ca36fc380e61a01b767fdfd`, identical to that local file. This does not pin all of remote main.

## Fresh independence and duplicate check

PASS — current reviewer native identity differs from the Product-named source writer. Before executing acceptance, this worker read its actual `CODEX_THREAD_ID` and `CODEX_SESSION_ID`; they are present, equal to each other, and unequal to the original writer ID explicitly supplied in this approved brief. A direct Node comparison exited 0 and retained `{reviewerNativePresent:true,sessionMatchesThread:true,reviewerDiffersFromProductNamedWriter:true}` in scratch. Raw private native identifiers/transcripts are excluded from Git. This resolves the earlier report's named `independent-review-native-identity` dependency using the newly supplied source-writer identity, rather than inferring independence from branches or GitHub authors. It does not qualify a harness or change permanent Quality identity/model/effort evidence. Native receipt custody verification at publication remains the launcher's responsibility.

Fresh connected readbacks before testing found PR46 OPEN/unmerged at the exact head/base above, with no comments, submitted reviews or inline threads. Inventory has changed since intake: **51 open issues and 39 open PRs** (rather than intake's 37/34). All 39 paginated changed-file lists were read; only PR118 owns this report path. Issues116/117 concern the same challenge. PR118's report already contains behavioral receipts but explicitly lacks native identity proof. Its own comments/reviews/threads are empty. Therefore the work reuses that report and repairs its missing independent evidence; other challenge reports are separate lanes. No claim of live controller/path custody is inferred from GitHub inventories.

Final connected PR46 readback at 2026-11-10 00:50:48 UTC remained OPEN/unmerged with the same exact head/base and306 additions. Acceptance execution and report validation completed within six elapsed minutes of intake, inside the30 active-minute bound. Any later changed head requires a new immutable review; none of these results transfers automatically.

Repository and exact-head AGENTS/README/operations, issue34, full two-file diff, exact Store and test suite were read. Shared `/Users/vincent/Developer/working-standards/{MEMORY.md,README.md,projects.md}` reads each failed with sandbox `Operation not permitted` (combined command exit 1); connected pinned README returned HTTP404. Retain recorded adoption `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no inaccessible policy was invented. The user's explicit unsigned local delivery overrides the normal signed-commit rule for this worker.

## Fresh offline command receipts

The assigned checkout started clean at `e12c4bb440c998244dc0dd5e4202b609d7b26500`. No checkout/reset/clean/rebase, branch deletion, operational database access or source implementation edit occurred. All database fixtures are fictional in-memory or newly created scratch SQLite. Scratch, logs and probes are retained, excluded from the commit.

Unique snapshot directory `S=.factory-tmp/review-117-ce3ec491-01` was created in the workspace. Both pinned Git objects returned `commit` (exit 0). Workspace-root commands `git archive --output=.factory-tmp/review-117-ce3ec491-01.tar ce3ec491eb0a82e7b6b1297c2052e287495056da` and `tar -xf .factory-tmp/review-117-ce3ec491-01.tar -C "$S"` exited 0. Installed workspace `node_modules` is reused via a read-only-target symlink; no install ran. Snapshot `.factory-tmp/home` and `.factory-tmp` were created before testing.

`git rev-parse SHA:path` and `git hash-object` both exited 0 and matched the three blob IDs listed in the historical report: decisions `161951914625ac15d3b94abc7954eeb770782877`, tests `547187853333ff5d52bc3f84e9c4affc05e73799`, Store `0b6e56269189cb7498e28a1a96a0543bc58f249f`. No main or dirty implementation was substituted.

Commands below ran from S unless indicated. Node v24.18.0; Bun1.3.14.

| Actual command | Exit / observed result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | **0**, no diagnostics, before adding scratch probes |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/decisions.test.ts` | **0; 9 pass, 0 fail, 97 expect calls, 145 ms**; all three competing-process tests passed their child-exit/output assertions |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file review-probes.ts` | **0; six assertion groups passed**, including independent three-decision rollback/retry and controlled cold-lock reproduction |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file replacement-probe.ts` | **0; three deliberate assertions confirmed replacement is accepted** for definition, outcome and event, exposing the limitation below; this exit is successful reproduction, not immutable-boundary PASS |
| Workspace-root current-main in-memory positional INSERT command retained in historical repro below, with HOME changed to `$PWD/.factory-tmp/review-intake/home` | **1**, seven-column PRAGMA readback followed by `SQLiteError: table questions has 7 columns but 4 values were supplied` |
| Direct Node identity comparison | **0**, all three boolean readbacks true |
| Supplied Node document-content check and `git diff --check` | **0** after this supplement; report-format validation only |

The focused test log retained the extra `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` diagnostic despite exit0 and all nine tests passing. Git commands emitted denied xcrun temp-cache diagnostics but returned their objects/results with exit0. An incidental `shasum -a 256 ...` invocation failed with **exit134** because sandboxed dyld could not load Perl's `libperl.dylib`. This was an unexpected tool startup failure, not a deliberate abort test; it was not retried. Equivalent hash receipts were obtained using Node crypto (exit0). No os.abort, SIGABRT or deliberately crashing process was requested or used. SQLite `RAISE(ABORT)` here is a statement/transaction failure, not a process signal.

The first staged whitespace check exited2 for an extra blank line at EOF inherited during report restoration. It was corrected before commit; the final staged check exited0. The earlier unstaged check did not inspect the new untracked report, so only the final staged check validates its whitespace.

## Current boundary verdicts

| Boundary | Verdict | Actual evidence / limit |
| --- | --- | --- |
| Idempotent create/resolve, different definition, malformed input | PASS | Existing tests24–62 plus fresh canonicalization probe: reversed object keys and padded text/options normalize identically and append no event. Changed question/scope/options order/deadline/resolver refuse without snapshot changes. |
| Deadline minus1 / equal / plus1; invalid/late/repeated conflicting replies | PASS | Existing tests and fresh probes. Before deadline wrong resolver/option throw; at/after deadline both invalid inputs default to hold. First committed answer remains unchanged on later conflicting or invalid replies. `decisions.ts:71–81` checks completed outcome, then deadline, then resolver/option. |
| Resolver/time trust | PASS for stated service contract | `decisions.ts:30–33,71–80`: resolver identity and now are caller inputs, not authentication or a trusted independent clock. A caller able to supply matching identity/backdated time can obtain an answer; future adapters must authenticate identity and choose time. No adapter authenticity was tested. |
| Restart, missed ticks, one outcome/audit across competing defaults/answers/late answers | PASS, warm Store only | Fresh nine-test run, especially tests65–83 and147–188. Process capability was supported here; no CI result was substituted. |
| Multiple due decisions, second audit failure | PASS | Fresh three-decision probe: equal deadlines sort batch-a,b,c. Trigger rejects only batch-b's resolution audit, after batch-a writes. Entire before/after snapshot deep-equal: three definitions, zero outcomes, only three creation events. Retry after dropping fictional trigger yields exactly three outcomes and three resolution audits; another expire and reopen append nothing. `decisions.ts:85–96,106–116`; `Store.atomic:80–81`. |
| Creation audit collision / atomic single resolution failure | PASS | Fresh existing test122–141, including reserved event-ID collision and injected event-insert failure. |
| Exact pending keys, sorting and unrelated synthetic work | PASS | Fresh probe rejects prefix/case/trailing-space queries and returns exact key members sorted by deadline/id. Existing test86–100 admits and finishes unrelated ticket without global pause. This does not enforce a same-scope hold. |
| Original questions/A4/events through initialization and reopen | PASS at exact head | Fresh test103–119 with original four-column Store. Separate integration failure below. |
| UPDATE/DELETE of definition/outcome/event | PASS for those SQL forms | Fresh suite and probe directly use Store.db; triggers reject all six operations. |
| Unrestricted raw Store.db replacement immutability | FAIL for that broader claim | Fresh REPLACE probe changes all three types without altering schema/triggers; see minimal repro below. Service API retains its first outcome; no normal method uses REPLACE. |
| Cold initialization under lock | FAIL as a guaranteed-availability claim; reproduced pre-existing limitation | Child importing only exact Store sees SQLITE_BUSY after1 ms at constructor; after lock release a new Store/DecisionService creates/defaults once. No DecisionService method ran in failed child. |
| Two simultaneous completely cold Store constructors | NOT RUN as a separate race | Controlled lock reproduction covers the mechanism, not every cold-start schedule. Existing race suite intentionally keeps connection open at tests153–154. Next actor Store owner/CI; restart with approved fictional cold rendezvous, retained normal child exits and durable readbacks, no macOS aborts. |
| Current-main four-value question fixture | FAIL, integration only | Fresh positional INSERT fails against seven columns at main Store25; remote Store blob matches local. Exact-head preservation PASS is unchanged. No combined-tree full suite was run. |
| Atomic pending snapshot under competing resolution | NOT RUN anew; retain prior observed limitation | Historical separate-process schedule below shows pending may include a subsequently resolved row. `decisions.ts:99–103` uses ID SELECT then per-row get; no snapshot/admission-lock contract was found. |
| Wired holds, scheduler expire wiring, real unanswered-owner routing, board/Telegram, release/admission integration, full A3/endurance | NOT RUN | Explicitly deferred by issue34 / decisions30–33. Product must scope adapters/callers; Quality needs approved integration/endurance receipts. Report/green CI cannot supply them. |
| Repository-wide host suite | NOT RUN | User approved exact-head focused test and probes; no full host qualification claim. CI is next actor for separately required host coverage. |

## Minimal fictional mutation repro and classification

Exact-head `tracking/decisions.ts:38–44` adds UPDATE/DELETE triggers; `tracking/store.ts:5,11–17` exposes the database and initializes WAL/busy timeout/event triggers without enabling recursive triggers. Probe readback was `{"recursive_triggers":0}`. SQLite REPLACE's implicit delete does not invoke those delete triggers with this setting. No DDL, trigger disabling, arbitrary file editing or foreign-key disabling is needed:

```ts
const s = new Store(":memory:"), d = new DecisionService(s);
const x = {id:"fictional-replace", scope:"fictional/demo#1", question:"Proceed?",
  tier:"Vincent", options:["go","hold"], default:"hold",
  deadline:1800000001000, resolver:"fictional-owner"};
d.create(x,1800000000000); d.expire(1800000001000);
s.db.query("INSERT OR REPLACE INTO a3_outcomes VALUES(?,?)").run(x.id,
  JSON.stringify({option:"go",source:"answer",at:1800000000000,resolvedBy:"fictional-replacement"}));
// d.get(x.id).outcome now says go/answer; retained resolved audit still says hold/deadline.
```

Additional fresh in-memory probes replaced the definition with question `Changed after resolution?` / scope `fictional/demo#2` while creation/resolution audits retained original scope/question; and replaced the reserved resolution event with fictional data while outcome stayed unchanged. All three probes exited normally0. This narrows the historical report's “all decision evidence rejects mutation” assertion: UPDATE/DELETE are protected, unrestricted SQL replacement is not. Tests137–140 themselves use raw Store.db for their immutability assertion, which motivates reporting this same database boundary. There is no service-method overwrite, external untrusted SQL entrypoint or authentication bypass demonstrated. If supported use is explicitly limited to DecisionService methods and Store.event, those exercised APIs PASS; arbitrary privileged SQL needs a separately defined guarantee. Event REPLACE weakness predates this PR because Store is byte-identical to base; analogous decision-table trigger coverage is new in the PR.

Next actor: Product and independent Quality define/disposition the supported mutation boundary; if database-level append-only protection is required, assign one separately scoped implementation/test repair to the implementation owner. Observable restart: immutable repair head/base with normally exiting fictional replacement attempts rejected and original definitions/outcomes/audits unchanged, plus the focused suite passing. Do not rewrite the reviewed head as part of this report.

## Cold WAL initialization reproduction

Parent opens a new fictional database using Bun SQLite, executes `PRAGMA journal_mode=DELETE; CREATE TABLE fictional_lock(id INTEGER); BEGIN EXCLUSIVE;`, and retains that lock while a normal Bun child imports only the exact Store and calls `new Store(path)`. Child catches/logs its error and exits0. Actual readback:

```json
{"exit":0,"stdout":"{\"name\":\"SQLiteError\",\"message\":\"database is locked\",\"code\":\"SQLITE_BUSY\",\"elapsed\":1}\n","stderr":""}
```

Parent rolls back/closes the fictional lock. A subsequent Store then creates/defaults `after-lock` with exactly one outcome and one resolution event. Constructor `tracking/store.ts:12` runs journal_mode=WAL before busy_timeout=10000; no busy wait protects that first PRAGMA. The Store file has no diff between approved base/head (git diff exit0, empty). This is pre-existing Store availability behavior, not a decision-service regression. It does not undermine tested warm races or prove successful simultaneous cold startup. Next actor: Product assigns Store startup repair only if required; Quality/CI should exercise lock contention and cold rendezvous. Observable restart: a reviewed Store proposal handles that lock per an explicit retry/fail-closed contract with retained errors, normal exits and consistent post-retry state.

## Retained artifact receipts and handoff

All paths in this table are relative to S. SHA-256 was calculated with Node crypto, exit0.

| Scratch artifact | SHA-256 |
| --- | --- |
| `review-probes.ts` | `5f5038aecf01abab89681ee625c3f8a6e38bb3ee0ec47b5cb611d22b192c0cc3` |
| `.factory-tmp/review-probes.log` | `47171022eb2c2d3efbfc9b31eee8269c35dbcdf4cb464da965472b78bae5a227` |
| `replacement-probe.ts` | `943161c659afcf92caf3663b4094db65a8c6731a76e9e0c26749fd53266cf397` |
| `.factory-tmp/replacement-probe.log` | `a1c71399453399fb96c1dc9f301118baa9355e6a9ab7638eea6941a5385f2982` |
| `.factory-tmp/decisions-test.log` | `dc7e8003ff6130bb0854218214debd9ff7c433db478c09c9386c39b30b332683` |

Scratch `.factory-tmp/typecheck.log` is empty (successful no-diagnostics exit). Workspace `.factory-tmp/review-intake/` retains independent identity booleans, fresh readback inventory and current-main failure log. Historical logs below remain attributed to their prior run, never relabeled as this run's receipts.

Product owns the current-main fixture repair: use an independently reviewed, named-column preservation fixture on the declared integration base, then rerun focused preservation; no source edit here. Quality/Release disposition and native custody remain separate. Launcher should reconcile the existing PR118 report lane before publication, retest the delivered snapshot and sign only after worker cleanup; this worker leaves only an unsigned local report commit and delivery bundle. No GitHub write, source repair, activation, provider call, credential/sign-in, real message, launchd or custody/debit reset occurred. Undo is a subsequent report-only revert; retain all original source, historical report, scratch and operational assets.

---

# Retained PR118 report (historical)

The following is the prior report content. Its earlier independence and broad immutability conclusions must be read with the supplement above.

# Timed decision independent acceptance review

Review date: 2026-11-09. Proposal: issue #116, reviewing OPEN [PR46](https://github.com/fulmar-hq/agent-factory/pull/46), implementation issue #34.

Exact reviewed head: `ce3ec491eb0a82e7b6b1297c2052e287495056da`.
Exact reviewed base: `b157ad17f7cb26960992174a427669df37b95e2b`.
Read-only integration comparison: local main snapshot `e12c4bb440c998244dc0dd5e4202b609d7b26500`; this is not an assertion about a later remote main.

**Result: PASS for the tested exact-head durable-service boundaries; FAIL for the reproduced current-main legacy-test integration dependency.** No implementation repair was attempted. `pending()` can return a decision resolved between its queries; that observation is a read-consistency limitation, not a demonstrated violation of this leaf's documented service contract. Full A3 acceptance and release remain unproved.

## Independence, authority and custody

PASS — assigned implementation/reviewer worker separation. PR46's branch is `feat/factory-d45567f0c3eda61c`; this review's branch is `feat/factory-6c53e84e086a0c09`. The retained `eventId` rule (`launcher/engine.ts:43–47`, SHA-256 of `helper:v1:repo#number`) independently reproduced:

```text
#34  d45567f0c3eda61ccec71c4c0c5d72f6fadefd02791472b563724b091d4c00b0
#116 6c53e84e086a0c090f4b57e94de56772f0a63a8c0c466dc5f4d53869e8ce255f
```

`launcher/worker.ts:67` derives the branch from that worker ID. This is a separately assigned review context, which did not implement PR46; private native receipt identifiers are not copied into Git history. There is no assigned-worker collision. GitHub author identity and the launcher's signed commit do not establish native-worker identity. NOT RUN — dependency `independent-review-native-identity`: authoritative mapping to the original native implementation receipt, which is outside this worker's readable custody. Independent Quality must compare retained implementation/reviewer native receipts before treating native identity separation as proved; if they collide, this challenge must be marked NOT RUN and assigned to a distinct reviewer. Observable restart: record distinct receipt IDs and rerun the immutable-head commands under that independent assignment.

Repository AGENTS.md, README.md, operations and issue #34's bounded contract were inspected. Reads of shared working-standards `MEMORY.md`, `README.md` and `projects.md` returned `Operation not permitted` (exit 1). That authority is unavailable here. The recorded adoption revision remains `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream policy update is inferred. The explicit unsigned-delivery instruction governs this local proposal despite the repository's normal signed-commit rule.

The intake's searches, reviews/comments/threads and 34 open-PR file lists found no duplicate challenge and a disjoint report path. This is inherited intake evidence, not a new operational custody guarantee. Fresh PR readback during this review still reported OPEN, unmerged, the exact requested head/base and two changed files. The empty occupied array is not a live custody check. Launcher must repeat current source-state, duplicate, custody and path gates before admission/publication. Product retains outcome custody; independent Quality and sole Release dispositions remain separate.

## Execution receipts

Started approximately 19:03 UTC. Review used less than the authorized 30 active minutes. The initial source status was clean; no branch/workspace, claim, event, debit or operational evidence was reset or removed. All databases below are fictional in-memory or newly created scratch SQLite.

Scratch HOME and TMPDIR were created first. `git cat-file -t` returned `commit`, exit 0, for both immutable objects. An initial Python extraction attempt exited 1 because the installed Python lacks `extractall(filter=...)`; it extracted no files. Its unique `review-ce3ec491-01` directory was retained. Supported `git archive` and `tar` extraction then succeeded in distinct `.factory-tmp/review-ce3ec491-02`. No checkout, clean, reset or rebase was used. Its `node_modules` symlink reuses the installed read-only dependencies. No package install or permission expansion occurred.

Commands ran from that extracted snapshot unless stated otherwise:

| Actual command | Exit and result |
| --- | --- |
| `git archive --output=.factory-tmp/review-ce3ec491-02.tar ce3ec491eb0a82e7b6b1297c2052e287495056da` then `tar -xf .factory-tmp/review-ce3ec491-02.tar -C .factory-tmp/review-ce3ec491-02` (workspace root) | 0, retained immutable archive and extracted snapshot |
| `node node_modules/typescript/bin/tsc --noEmit` | 0, no diagnostics; before adding temporary probes |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/decisions.test.ts` | 0; Bun 1.3.14, **9 pass, 0 fail, 97 expect calls**, 139 ms; all three two-process races ran |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file probes.ts` | 0; **7 independent probe groups passed**, separate pending-resolution child exit 0; raw readbacks retained below |
| Current-main in-memory positional-insert repro shown below | 1; `SQLiteError: table questions has 7 columns but 4 values were supplied` |
| `git rev-parse HEAD:path` with the explicit reviewed SHA, compared to `git hash-object` on extracted files | 0; all three hashes matched, listed below |

The test runner also printed `error: Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after the nine passes. Exit was still 0; no individual test failed. This is retained as a sandbox diagnostic, not silently treated as permission to read that directory. A supplemental Node script attempting to spawn Git was denied with `spawnSync git EPERM` (Node exit 1); the surrounding diagnostic shell continued and exited 0. Direct already-supported Git invocations obtained the hash readbacks without broadening permissions. Bun's actual test/probe children succeeded; the Node diagnostic is not substituted for acceptance.

Matching immutable Git blob IDs:

```text
tracking/decisions.ts     161951914625ac15d3b94abc7954eeb770782877
tests/decisions.test.ts   547187853333ff5d52bc3f84e9c4affc05e73799
tracking/store.ts         0b6e56269189cb7498e28a1a96a0543bc58f249f
```

Temporary `probes.ts` imports `./tracking/decisions` and `./tracking/store` from this extracted immutable tree; it does not reimplement the service. It and its log remain scratch-only, outside the commit. SHA-256 receipts:

```text
probes.ts                  37f694370f2e579ef9e4a1639228ccbe065958bf24406eae5d448e13d0c54be4
.factory-tmp/probes.log     48ae76383bacb0b58fa0ba50ceb22ad2e0955bd29212e9768fc9811608f32365
```

The repository-wide suite is NOT RUN: the approved execution is the exact-head focused suite and probes, not an unrelated full-controller qualification. Reviewed tests use SQLite `RAISE(ABORT)` to roll back statements, which does not abort a process. No `os.abort`, SIGABRT, real controller/mail database, adapter, native/model/provider operation or external message was invoked.

## Boundary verdicts

Source references below are to the immutable head unless explicitly labeled current main. They are review references, not claims that the files exist in this proposal's main tree.

| Boundary | Verdict | Evidence and limit |
| --- | --- | --- |
| Malformed definitions/timestamps cause no state/audit writes | PASS | Existing test at `tests/decisions.test.ts:47–62`; schema at `tracking/decisions.ts:4–18` rejects blanks, malformed options/defaults, unsafe/negative/noninteger times. |
| Idempotent create/resolve; changed duplicate ID | PASS | Existing test `:24–45`; probe also changes scope, question, tier, option ordering, default, deadline and resolver. Each changed definition throws; exact state/event snapshot remains unchanged. |
| Canonicalized duplicate definition | PASS | Probe reverses input property order and pads every text field/option with whitespace: same parsed definition returns original, no extra audit. Schema canonicalization precedes comparison (`decisions.ts:55–61`). Resolution input itself is not trimmed. |
| Before/equal/after absolute deadline | PASS | Probe `deadline-1` selects answer; `deadline` and `deadline+1` select default. Default timestamp is supplied resolution time, not rewritten to deadline (`:71–81`, `:106–110`). |
| Late wrong resolver / unknown option | PASS | At equal and after deadline, wrong resolver, unknown option and both together produce `hold`, source `deadline`, resolver `deadline-default`. This matches default-before-answer-validation (`:78–80`); it is not caller authentication. Before deadline existing tests reject wrong resolver/unknown option. Resolver identity is trusted adapter input (`:30–33`). |
| Restart and repeat/reopen append nothing | PASS | Existing restart test `tests/decisions.test.ts:65–83` and three races `:177–186`; probe retries resolve/create/expire after completion and compares full snapshots. Existing outcomes return unchanged even when later inputs differ. |
| Stable expiration ordering | PASS | Probe creates z(deadline+1000), b/a/c(deadline+500): expire returns `[a,b,c,z]`; matching scope pending returns `[b,c,z]`. Query explicitly orders deadline then ID (`decisions.ts:89–94`, `:100–103`). |
| Exact cross-scope queries and unrelated progress | PASS | Probe returns only exact scope keys; unmatched prefix returns `[]`. Existing test `tests/decisions.test.ts:86–100` admits/finishes unrelated work without global pause. This proves no wired same-scope enforcement. |
| Legacy questions, A4 records, preexisting events | PASS at exact head | Existing preservation test `:103–119` passes through reopen with the original four-column Store. Current-main compatibility separately FAILS below. |
| Creation/resolution audit collision rollback | PASS | Existing creation test plus independent created/resolved reserved-ID collisions. Both throw `Decision audit ID conflict`; complete definitions/outcomes/events before and after are equal. |
| Later batch expiration audit failure rolls back whole batch | PASS | Trigger fails only batch-b's resolved audit after batch-a's writes; both outcomes and all new audits roll back. Removing fictional trigger permits exactly two outcomes/two resolved audits; repeats append nothing. `Store.atomic` is immediate transaction (`tracking/store.ts:80–81`). Exact readbacks below. |
| Immutable definitions/outcomes/audit rows | PASS | Existing update/delete rejection tests `tests/decisions.test.ts:137–140`; service triggers `decisions.ts:41–44`, Store append-only event triggers. |
| Simultaneous competing answers/defaults | PASS, warm Store only | Existing `defaults`, `answers`, `late-answer` two-process races: child exits 0, same result from both, one creation and one resolution audit after reopen. `tests/decisions.test.ts:147–188`. |
| Simultaneous cold Store initialization | NOT RUN | Tests deliberately hold a connection open (`:153–154`); WAL is initialized before busy_timeout. No claim that startup races are proved. Next actor: separately scoped Store owner/Quality; restart with fictional cold-open process rendezvous and retained child exits/state, without deliberate macOS aborts. |
| Single get and multi-query pending under resolution | PASS for single-query get; observed non-atomic pending | `get` uses one joined SELECT (`decisions.ts:48–51`). Deterministic separate-process interleaving below demonstrates pending membership and outcome can reflect different times. No snapshot/linearizability promise was found in issue #34 or service contract; no durable corruption observed. |
| Current-main test/Store compatibility | FAIL | Exact preservation test's positional insert `tests/decisions.test.ts:108` fails against current-main `tracking/store.ts:25` (seven lifecycle columns), as reproduced below. |
| Wired same-scope admission holds, scheduler expire invocation, board/Telegram signals, complete A3/endurance | NOT RUN | Outside durable-state leaf (`decisions.ts:30–33`, issue #34). Next actor: Product scopes caller/adapter integration; independent Quality runs approved fictional integration and then separately authorized A3/endurance drills. Restart needs actual same-scope admission refusal, unrelated progress, scheduler defaults and signal receipts, not just this suite or CI. |

## Concrete integration finding and minimal repro

FAIL — legacy preservation fixture depends on Store column count. At the reviewed head, `tests/decisions.test.ts:108` uses `INSERT INTO questions VALUES(?,?,?,?)`. At comparison main `e12c4bb440c998244dc0dd5e4202b609d7b26500`, `tracking/store.ts:25` defines seven columns: `id,text,answer,at,resolved_at,resolved_by,addressed_to`. This blocks the legacy fixture before its preservation assertions when combined with that Store. It does not negate the exact-head PASS or establish a service migration defect.

Executed from current workspace, exit **1** (fictional in-memory only):

```sh
HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file -e 'import {Store} from "./tracking/store.ts"; const s=new Store(":memory:"); try {console.log(JSON.stringify(s.db.query("PRAGMA table_info(questions)").all())); s.db.query("INSERT INTO questions VALUES(?,?,?,?)").run("fictional-legacy","Existing fictional question",null,1800000000000);} finally {s.close();}'
```

Readback: PRAGMA reported seven columns, including nullable `resolved_at`/`resolved_by` and `addressed_to TEXT NOT NULL DEFAULT 'vincent'`; then `SQLiteError: table questions has 7 columns but 4 values were supplied`. No test or Store rewrite is part of this review. Next actor: Product assigns a separate compatibility repair to the implementation owner; independent Quality reruns preservation on the declared integration base. Observable restart: explicit-column fixture proposal, immutable updated head/base, focused test passing on that integrated tree. A full PR merge simulation was NOT RUN; this is the concrete failing insert, not a claim about every integration behavior.

## Read boundary observation and classification

Minimal fictional schedule: create pending `read-a` and `read-b` in one scope. `pending(scope)` first selects both IDs. At its first call to `get`, a scratch hook pauses that method and synchronously starts a separate Bun process importing the exact extracted implementation. That process resolves `read-a` at `1800000000999`, closes, and exits 0. The hook then calls the original unmodified `get`; remaining reads are unmodified. The resulting pending array includes `read-a` with an answer and `read-b` with null outcome. A subsequent pending query returns only `read-b`.

The hook controls timing, not service logic or SQL. `get()` itself is a single-query view; it is the pending ID SELECT plus per-ID gets that lack a shared read transaction (`decisions.ts:99–103`). At no point is an outcome lost or duplicated. The actual contract promises durable first-committed outcomes, idempotency and exact scope keys, not an atomic pending snapshot. Therefore this observation is a limitation for future callers, not asserted here as a release-blocking defect. A caller must not infer an authoritative admission lock from this read. Next actor: Product defines caller consistency needs in the integration leaf; Quality should preserve this interleaving if atomic membership becomes a requirement. Observable restart: a declared contract and controlled same-scope caller read/write race with exact state readback.

## Retained all-or-nothing readbacks

The following is the actual scratch probe stdout, not reconstructed expected values. Each collision/batch probe selected all definitions, outcomes and events ordered by ID before and after and asserted deep equality; the log includes exact serialized definition/audit payloads. SQLite trigger failure at batch-b occurs after batch-a is processed due to `(deadline,id)` ordering. The successful retry snapshot includes both immutable outcomes and both resolution audits; repeated calls were then asserted equal to that snapshot. All identities and questions are fictional.

```text
deadline-readback {"id":"late-1001-unknown-wrong","scope":"fictional/demo#1","question":"Proceed?","tier":"owner","options":["go","hold"],"default":"hold","deadline":1800000001000,"resolver":"fictional-owner","outcome":{"option":"hold","source":"deadline","at":1800000001001,"resolvedBy":"deadline-default"}}
PASS before/equal/after and late invalid caller input
PASS canonical duplicate and changed definitions
expire-order ["a","b","c","z"]
PASS stable expiration ordering and exact cross-scope queries
created-collision-readback {"before":{"definitions":[],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"collision\",\"created\"]","kind":"fixture","at":1800000000000,"data":"{}","undo":"retain"}]},"after":{"definitions":[],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"collision\",\"created\"]","kind":"fixture","at":1800000000000,"data":"{}","undo":"retain"}]}}
PASS audit collision created
resolved-collision-readback {"before":{"definitions":[{"id":"collision","definition":"{\"id\":\"collision\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"}],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"collision\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"collision\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"collision\",\"resolved\"]","kind":"fixture","at":1800000000000,"data":"{}","undo":"retain"}]},"after":{"definitions":[{"id":"collision","definition":"{\"id\":\"collision\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"}],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"collision\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"collision\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"collision\",\"resolved\"]","kind":"fixture","at":1800000000000,"data":"{}","undo":"retain"}]}}
PASS audit collision resolved
batch-rollback-readback {"before":{"definitions":[{"id":"batch-a","definition":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"},{"id":"batch-b","definition":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"}],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"batch-a\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"batch-b\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"}]},"after":{"definitions":[{"id":"batch-a","definition":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"},{"id":"batch-b","definition":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"}],"outcomes":[],"events":[{"id":"[\"a3-decision\",\"batch-a\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"batch-b\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"}]}}
batch-retry-readback {"definitions":[{"id":"batch-a","definition":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"},{"id":"batch-b","definition":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","deadline":1800000001000,"scope":"fictional/demo#1"}],"outcomes":[{"id":"batch-a","outcome":"{\"option\":\"hold\",\"source\":\"deadline\",\"at\":1800000001000,\"resolvedBy\":\"deadline-default\"}"},{"id":"batch-b","outcome":"{\"option\":\"hold\",\"source\":\"deadline\",\"at\":1800000001000,\"resolvedBy\":\"deadline-default\"}"}],"events":[{"id":"[\"a3-decision\",\"batch-a\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"batch-a\",\"resolved\"]","kind":"a3-decision-resolved","at":1800000001000,"data":"{\"id\":\"batch-a\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\",\"outcome\":{\"option\":\"hold\",\"source\":\"deadline\",\"at\":1800000001000,\"resolvedBy\":\"deadline-default\"}}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"batch-b\",\"created\"]","kind":"a3-decision-created","at":1800000000000,"data":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\"}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"},{"id":"[\"a3-decision\",\"batch-b\",\"resolved\"]","kind":"a3-decision-resolved","at":1800000001000,"data":"{\"id\":\"batch-b\",\"scope\":\"fictional/demo#1\",\"question\":\"Proceed?\",\"tier\":\"owner\",\"options\":[\"go\",\"hold\"],\"default\":\"hold\",\"deadline\":1800000001000,\"resolver\":\"fictional-owner\",\"outcome\":{\"option\":\"hold\",\"source\":\"deadline\",\"at\":1800000001000,\"resolvedBy\":\"deadline-default\"}}","undo":"Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID"}]}
PASS later batch audit failure rolls back earlier outcome and event
pending-child-exit 0
pending-interleave-readback [{"id":"read-a","scope":"fictional/demo#1","question":"Proceed?","tier":"owner","options":["go","hold"],"default":"hold","deadline":1800000001000,"resolver":"fictional-owner","outcome":{"option":"go","source":"answer","at":1800000000999,"resolvedBy":"fictional-owner"}},{"id":"read-b","scope":"fictional/demo#1","question":"Proceed?","tier":"owner","options":["go","hold"],"default":"hold","deadline":1800000001000,"resolver":"fictional-owner","outcome":null}]
PASS pending interleaving with separate process resolution
Independent probe groups passed: 7
```

## Proposal validation and handoff

The supplied Node document-content check and `git diff --check` both passed (exit 0). These validate the report only; service acceptance comes from the exact-head commands and readbacks above. Only this report is proposed for Git history. Scratch probes, fictional databases and retained archive stay outside the commit. Undo is a later documentation revert; original source and operational assets require no undo. Launcher owns fresh admission/publication gates, snapshot retesting and signing; this worker leaves an unsigned local commit and `.factory-delivery.bundle`. No GitHub writes, push, merge or release occurred. Product must separately assign the current-main fixture repair and integration scope; independent Quality must resolve `independent-review-native-identity` and retain remaining NOT RUN boundaries. Sole Release decides release disposition.
