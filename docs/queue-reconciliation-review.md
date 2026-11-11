# Queue reconciliation review — issue 123

Reviewed 2026-11-09. **FAIL: the queue slice is not accepted without follow-up.** Normal publication reconciliation and the local custody filter passed; retained-data containment, post-edit audit recovery and live-intake rearm containment failed. No implementation changes were made. Product retains outcome custody; independent Quality acceptance and sole Release disposition remain separate.

## Identity, scope and authority

- Repository: `fulmar-hq/agent-factory`, issue 75 / OPEN PR76.
- Exact reviewed head: `26254e92f170d81e3d714b874c8212882a95c916`.
- Exact PR base: `c48c9bb4224e2240cc9f3757e1ac19ee353aabc4`.
- Review delivery starts on local `e12c4bb440c998244dc0dd5e4202b609d7b26500`; that newer source was never substituted for the reviewed snapshot.
- **PASS — worker independence:** GitHub PR76 identifies original implementation branch `feat/factory-e56e496be02b73a0`; this issue123 reviewer has separately allocated workspace `11fb7c9978a9ec552f80b6d52f6584ab1ca8fdaa7ea21d65989a033b9c8c0f10`. This reviewer did not implement PR76 or rewrite its head. This establishes separate implementation/review workers, not independent Release approval or a claim about the human identity behind the publisher's signed commit.
- Read local AGENTS.md, README.md, docs/operations.md, the exact snapshot's docs/queue-recovery.md, full retained base-to-head diff, issue75, Engine.retryPrior and supply. The diff is 10 files, 214 additions / 8 deletions. GitHub readback confirmed PR76 head/base above, OPEN, unmerged, `mergeable=false`.
- Shared working-standards MEMORY.md, README.md and projects.md reads returned `Operation not permitted`. Intake also reported connected README/MEMORY 404; those remote authority reads were not repeated. Retain adopted revision `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no unavailable policy was invented or adopted.

Scope is claimableReady, reviewPublished and supply rearming/wiring. Issue119/PR120 owns the PR48 watchdog challenge and its PR76 collision; this report makes no watchdog/notification acceptance claim or duplicate finding. Existing factory and Alido lanes were untouched. Intake's duplicate searches and open counts are historical observations, not full path/custody exclusion. **NOT RUN here:** a fresh all-open-PR changed-path, duplicate-outcome and current-claim inventory; launcher owns that check before admission/publication and must retain its receipt.

## Isolation and command receipts

All probe data were fictional, in-memory Store records. All reconciliation probes injected `execute`; strings containing `gh` were inspected by mocks only. No live gh command, tick, runWorker, default-root CLI, controller/mail/qualification/private-config open, model/provider call, real message, launchd action, signing, push, merge or release was performed. No crash or signal test was needed. The original checkout had no tracked changes on initial inspection and was never checked out/reset/cleaned. Only this report is proposed for Git; scratch and all receipts are retained.

Scratch snapshot: `.factory-tmp/review-123/`, created within this separately allocated workspace with `git archive HEAD_SHA | tar -x -C SCRATCH`. Here HEAD_SHA means the exact reviewed head above. The archive and full diff extraction exited 0; Git emitted denied xcrun cache-write diagnostics under `/var/folders` but returned the requested objects. Installed dependencies are reused through scratch `node_modules -> ../../node_modules`; no install or dependency write occurred. Scratch HOME/TMPDIR were created before successful Bun execution.

`tests/queue-stall.test.ts` retained object and extracted file both hash to `8fe36b57dbdab44bd2b1794adbc198259faab559`. All source locations below refer to the reviewed head, not the delivery checkout.

| Command / check | Exit and evidence |
| --- | --- |
| Initial scratch dependency setup / typecheck attempt | Exit 1: a mistakenly relative symlink destination did not exist; Node reported MODULE_NOT_FOUND. Corrected scratch path only, then used the unchanged approved command below. This was setup failure, not a source type error. |
| `node node_modules/typescript/bin/tsc --noEmit` from extracted snapshot | Exit 0; no diagnostics. |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/queue-stall.test.ts` from snapshot | Exit 0; Bun 1.3.14, **6 pass, 0 fail, 19 assertions**. Two watchdog tests ran because the approved file contains them; their results are excluded from this acceptance. |
| Initial scratch probe invocation using `.factory-tmp/challenge.test.ts` as filter | Exit 1, no tests selected; Bun required an explicit `./` path for the hidden directory. No source/test weakening. |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/challenge.test.ts` from snapshot | Exit 0; **24 pass, 0 fail, 105 assertions**. Scratch probes assert observed behavior, including defects; green probe assertions do not mean acceptance PASS. Output retained at `.factory-tmp/review-123/.factory-tmp/probes.log`. |
| Optional whole-archive manifest comparison through Node child_process | Node exited 1: `spawnSync git EPERM`, before the comparison ran. **NOT RUN** for this additional comparison; no child-process permission workaround. Extraction and the direct retained test-object hash comparison above remain the available provenance evidence. |
| Approved report-content assertion and `git diff --check` | Exit 0 (run after report creation). Format/content presence only, not behavioral acceptance. |

Both successful Bun invocations additionally printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after their test results. The requested tests nevertheless executed and exited 0; no permission broadening or alternate source was used. **NOT RUN:** broad `bun test` / live host integration / scheduled operation. This bounded review uses the explicit approved snapshot commands, not the full host suite or green hosted CI as acceptance.

## Boundary verdicts

| Boundary | Verdict | Evidence and limit |
| --- | --- | --- |
| Finished publication → review; repeated sequential reconciliation; retained claim/digest | PASS | Existing suite returns 1 then 0, one edit, retained approval and no claimable replay. |
| Failed label write then retry | PASS | Existing suite retries an injected edit failure and succeeds; custody persists. This covers failure before successful remote edit, not the post-edit gap below. |
| Changed digest, CHANGES_REQUESTED, unknown PR | PASS | Existing suite declines edits; unknown remote read logs failure, not success. CHANGES_REQUESTED leaves ready for owner follow-up and records review-returned evidence. |
| Closed/merged/wrong-identity PR; missing PR state | PASS | Four scratch probes return 0, with no label edits. Identity here means equality to retained URL; no independent branch/head-to-issue provenance validation is proved. |
| Missing publication event / URL | PASS | No event causes zero remote calls; event without URL causes one github-review-failure and no edit. The existing suite title alone did not actually cover absence of a publication event. |
| Multiple issue state labels | PASS | Scratch ready+building response declines after issue read; no PR/edit request. |
| Stale ready snapshot, fresh remote review | PASS | Fresh issue read prevents an edit. |
| Stale review snapshot, fresh remote ready | PASS for conservative no-edit; recovery limited | Snapshot prefilter causes zero remote calls. Review reconciliation alone cannot recover this state until ordinary reconciliation refreshes the snapshot. It does not compare snapshot observed time/updatedAt (queue.ts:20–21). |
| Malformed remote issue/PR JSON or null shape; bad session then valid session | PASS | Four probes log one per-session failure, continue, and move only the valid session to review. |
| Malformed retained brief/snapshot/publication JSON; bad session then valid session | FAIL | Four probes reject the whole function, make zero execute calls and produce zero github-review-failure events. See finding 1. |
| Concurrent reviewPublished calls: exactly one label request / audit | FAIL | Two competing calls return `[1,1]`, make two issue edits (and two label-create requests), append two github-state events. No serialization/deduplication surrounds queue.ts:23–34. |
| Concurrent calls: no duplicate worker admission | PASS, local synthetic bound | Same probe retains one session; claimableReady is empty and another e.admit for the digest throws duplicate. No live launch or multiprocess worker race was run. |
| Interruption after remote edit, before local audit; subsequent retry | FAIL | Mocked audit-write interruption leaves remote review, zero github-state events after retry, one failure event, and no rearm of an exhausted round whose start is newer than its publication. See finding 2. |
| claimableReady versus retryPrior custody rules | PASS | Scratch matrix below matches retryPrior outcomes; existing retained-digest test also passes. |
| Non-doc launcher-publish or github-state review event rearms exhausted supply | PASS, terminal synthetic wake | Each event kind independently creates one new round. |
| Docs-only publication or review event | PASS | Each leaves the exhausted round unchanged. |
| Later empty rounds stop; old event does not repeatedly rearm | PASS | New round reaches attempt 2; two further supply calls retain its ID/attempt. Event timestamp is older than the new round. No claim of live backoff/endurance. |
| Rearm with prior live intake custody | FAIL | Review event bypasses live-wake check and queues a new intake while prior wake remains running without cleanup. See finding 3. |
| Exact-head tick/worker source wiring | PASS, read-only | queue calls are actually present; propagation limits below. |
| Live scheduled execution, throughput, remote/resource admission | NOT RUN | Not authorized; source wiring and synthetic gates are not live operational evidence. |
| Integration/conflict repair against current main; release readiness | NOT RUN | mergeable=false; separate Product integration and Release disposition required. |

### claimableReady custody matrix

queue.ts:7–8 calls retryPrior directly, treating any exception as excluded. Engine.retryPrior is engine.ts:145–163. The scratch matrix asserted both that function's result and claimableReady's count for every row:

| Local state | Result |
| --- | --- |
| No prior session | Included |
| Current admitted custody, reused digest | Excluded |
| Current admitted custody, new digest | Excluded |
| Unknown custody, new digest | Excluded |
| Archived status without archive receipt, new digest | Excluded |
| Archive receipt but no new approval after archive | Excluded |
| Archived, known distinct digest, archive receipt and matching later approval receipt, no retained publication | Included |
| Same archived original digest, even after fresh approval for another digest | Excluded |
| Missing candidate digest with prior custody | Excluded |
| Missing prior digest | Excluded |
| Retained publication, otherwise eligible archived retry | Excluded |

This is a **local custody filter**. No-prior-session success does not establish an approved/validated brief. Missing/stale GitHub evidence, all-state branch PR readback, live supervisor PID identity, subscriptions, usage, qualifications, slots, path conflicts and wallet gates were not proved by this filter. PID-bearing custody was not exercised. Source inspection shows final launch still repeats retryPrior, remote all-state PR reads, validateIntake and transactional e.admit/claimStart/spawn (tick.ts:23–40); those effects were not invoked.

## Concrete findings and fictional reproducers

### 1. Retained malformed evidence escapes the per-session handler

**FAIL; Product implementation follow-up.** queue.ts:17 performs SQL json_extract outside try; line 19 parses retained brief outside try; line 21 parses/accesses retained snapshot labels outside try. The handler begins only at line 22. Consequently malformed publication data can throw SQLite `malformed JSON`; malformed brief/snapshot text throws during JSON.parse; `{}` snapshot throws on `labels.some`. One bad finished session prevents a valid following session from being processed. These are availability/containment failures, not synthetic launch success.

Minimal reproducer recipe using exact Store/Engine and tests/fixtures, all in memory:

```ts
const e = new Engine(new Store(':memory:'), config());
e.pause(false, 'owner');
// For n=1,2: make ticket(n), build a fictional OPEN ready issue containing
// its factory JSON block, set t.approvalDigest=intakeLabel(t.repo,issue),
// e.admit(t,admission()), e.finish(id,true), then append launcher-publish
// {id,url:`https://github.com/example/demo/pull/${100+n}`}.
e.s.db.query('UPDATE sessions SET brief=? WHERE ticket=?')
  .run('{', 'example/demo#1');
await reviewPublished(e, async args => { throw Error('should not be reached'); });
// Rejects before any execute call; valid example/demo#2 remains ready.
```

The retained scratch reproducer implements that setup fully. Alternate mutations `snapshot='{'`, snapshot `{}` or a raw fictional launcher-publish event with `data='{'` each reproduce rejection, zero remote calls and zero per-session failure receipts. Raw invalid event insertion represents corrupt/legacy retained input: normal Store.event serializes JSON (store.ts:74–77). This does not assert normal writers emit invalid JSON. A valid JSON receipt without URL is contained, as recorded above.

**Read-only integration implication:** tick.ts:103 awaits this function without a local catch, so rejection exits tick through its outer finally before candidate/supply processing. runWorker calls the same global scan after persisting its publication (worker.ts:96–100); rejection reaches its outer catch, which calls e.finish(id,false), even when another session's retained evidence caused the error. Source finish changes a finished session to unknown (engine.ts:378–393). Actual tick/worker invocation and resulting live status changes are **NOT RUN**.

Observable restart after separately authorized repair: replay the same fictional bad-first/good-second inputs; require a retained per-session failure, successful processing of the valid session and no unrelated worker status degradation. Preserve damaged evidence and custody; do not reset claims or edit operational receipts to manufacture a pass.

### 2. Remote label success can lose local audit and supply rearm evidence

**FAIL; Product implementation follow-up.** queue.ts:33 awaits the remote issue edit before line 34 appends github-state. There is no durable pending/acknowledged reconciliation record. The probe injects an exception only for that github-state event after the mock has moved the issue to review. The catch records a failure and returns 0; on the next call the fresh review state fails line 26, so no audit is repaired. A refreshed local review snapshot would skip even earlier at line 21.

Minimal fictional interruption hook, installed only on the in-memory Store:

```ts
const original = e.s.event.bind(e.s);
e.s.event = (...args) => {
  if (args[1] === 'github-state') throw Error('fictional post-edit interruption');
  return original(...args);
};
// execute mutates only the fictional issue labels when it sees issue edit.
// First reviewPublished returns 0 after successful mock edit.
// Restore event, then repeat: remote review is skipped; no audit appears.
```

No process was crashed. The actual probe throws once and leaves other event writes working. Its exhausted supply round starts after the older launcher-publish event; no github-state review receipt exists after restart, so supply leaves that round exhausted. This proves loss of the new rearm signal in this ordering, not universal loss of all rearm opportunities. An in-round publication event could still rearm. Retained session/approval continues to block duplicate admission.

Competing calls independently expose the distinction: sequential retries are quiet, but concurrent fresh ready reads can both edit and record distinct random-UUID audits (queue.ts:32–34). The probe observed two edits/two audits with one retained worker session. Neither worker-path invocation nor tick's call shares a queue reconciliation lease. `autonomyEffects` surrounds later autonomy effects (tick.ts:105), not reviewPublished at line 103. No claim of cross-process exactly-once label requests is justified.

Observable restart after separately authorized repair: interrupt at this same mocked boundary; require recovered local review audit/rearm evidence and retained no-replay custody. If exactly-once external edits are required, independently challenge competing callers; an unchanged worker count alone is insufficient.

### 3. Supply rearm skips unresolved prior intake custody

**FAIL; Product integration follow-up.** autonomy.ts:74–76 sets an exhausted round's local `closed=true` on a useful event before the wake's state is examined at lines 79–84. That makes the live-wake guard unreachable and line 98 opens a replacement round. The original launcher-publication rearm already existed in the base; PR76 adds review events to the same ordering. This review demonstrates the new review-event path, not a claim that PR76 introduced every instance of the underlying issue.

Minimal fictional state:

```ts
e.s.set('intake-round', {id:'live-round', at:now, attempt:2, wake:'live-wake'});
e.s.set('owner-wake:live-wake', {state:'running', cleanupVerified:false});
// x is a finished synthetic session whose brief includes src/fixture.ts.
e.s.event('review', 'github-state', {session:x.id, state:'review'}, 'retain', now+1);
supply(e, [], now+2);
// intake-round now has a different ID, its wake is queued;
// owner-wake:live-wake is still running with cleanupVerified=false.
```

This proves duplicate queued intake custody, not that a second native process was launched: dispatch may independently refuse it. No dispatch/native process was invoked. Observable restart after separately authorized integration repair: hold the old wake in running/starting or unresolved cleanup, publish the same fictional review event and require unchanged round/no replacement wake; only terminal independently verified cleanup may allow replacement. Retain all old owner and worker receipts.

## Source wiring and integration limits

At the exact head, tick.ts:102–110 reconciles snapshots, runs reviewPublished, rereconciles after a positive changed count, applies claimableReady, and applies the same filter after owner results/approval before supply. Worker.ts:95–97 records launcher-publish then calls reviewPublished. Supply's useful-event lookup matches publication `id` or review `session`, and ignores docs-only paths (autonomy.ts:75–76). Scratch probes proved one event rearms once, docs-only events do not, and the unchanged old event does not perpetually rearm later empty rounds. They do not establish event authentication, throughput, production scheduling or correct behavior after a real host restart.

Read-only comparison with delivery checkout `e12c4bb440c998244dc0dd5e4202b609d7b26500` shows queue.ts absent there, evolved supply/backoff/cleanup logic, supply moved after admission outcomes, and browser/question handling added in tick/worker. PR76's hooks therefore cannot simply replace those later paths without an integration review. GitHub still reports mergeable=false. No merge, merge-tree write, conflict repair or watchdog-collision analysis was performed. A future integrated revision requires its own immutable head/base and focused replay; exact-head evidence cannot certify a conflict-resolved tree.

## Next actor and restart receipt

Product should retain these three concrete findings and the concurrency limitation, arrange separately bounded repairs/integration, and keep existing lanes intact. Launcher must perform fresh duplicate/path/current-custody checks and retain the tested-tree receipt before publishing this docs-only proposal. Independent Quality should replay the retained exact suite and fictional boundary recipes against the resulting immutable integrated head, carrying forward NOT RUN cases. Release alone decides disposition; this report authorizes no merge, activation or capacity/policy change.

An observable restart receipt must name the new head/base, independent reviewer, command exits/counts, bad-session containment, post-edit audit recovery, no new intake before prior cleanup, retained no-duplicate admission and one-time useful-event rearm. Missing live evidence remains NOT RUN. Undo this report through a reviewed documentation revert; preserve scratch probes, bundles, branches, sessions, debits and receipts. No operational reset is part of this review.
