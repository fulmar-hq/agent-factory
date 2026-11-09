# PR45 metrics evidence review

Reviewed 2026-11-09 for issue [107](https://github.com/fulmar-hq/agent-factory/issues/107), concerning [PR45](https://github.com/fulmar-hq/agent-factory/pull/45) / [issue37](https://github.com/fulmar-hq/agent-factory/issues/37). This is a docs-only evidence proposal. Product retains outcome custody; Quality/Release disposition is separate.

## Verdict and independence

**Independent acceptance: NOT RUN.** The connected account is `vincentmessina` (ID 72951696). PR45's author is that account; the reviewed commit's author/committer and this workspace's configured author are Vincent Messina, `72951696+vincentmessina@users.noreply.github.com`. This Codex execution cannot establish an independent writer/reviewer identity from those records. A separate execution alone does not resolve the collision. Dependency **IR-45: Product assigns an identified reviewer independent of the original writer, with provenance confirming that separation**. No identity was changed to manufacture independence.

The technical results below are reproducible **non-independent diagnostics**, not a substitute for IR-45. Source acceptance is held: the original suite passes, but the owner-answer discrimination probe fails. No implementation was repaired. Classification ordering has additional limits requiring contract clarification, not an asserted production defect.

Current-main integration, board wiring, concurrent-reader behavior under operational load, live endurance, and Production delivery are all **NOT RUN**. Green CI, a document-format assertion, native completion, a PR, or release permission proves none of them.

## Immutable scope and intake

| Receipt | Value |
| --- | --- |
| Reviewed head | `d8dbb0bf8272705d60750262d11083cf3d099e82` |
| Reviewed base / head parent | `b157ad17f7cb26960992174a427669df37b95e2b` |
| Reviewed tree | `22b37e499052c7b2d71c98bd8d0bdb7f22c6fc06` |
| Complete delta | `tracking/autonomy-metrics.ts`: 170 additions; `tests/autonomy-metrics.test.ts`: 154 additions; no deletions |
| Source blob, extracted and Git object | `c04fea0f01b1b3e9fde7dd097b95c13f1b6f423b` |
| Suite blob, extracted and Git object | `d61990e688bc9e54deefbf0e5217211c76099323` |
| Unmodified delivery baseline | `e12c4bb440c998244dc0dd5e4202b609d7b26500` |
| Retained scratch relative to checkout | `.factory-tmp/review-107-d8dbb0bf-01/` |

Both immutable commits were present locally (`git cat-file -t`: commit, exit 0). `git archive HEAD_SHA | tar -x -C SCRATCH` extracted the reviewed head into the newly created scratch directory. The current checkout was never reset, replaced, checked out over, or cleaned. Blob hashes above match `git ls-tree` at the reviewed head. The full two-file diff and exact suite/source were read, together with the reviewed snapshot's AGENTS.md, README.md, operations, and producer code. The existing dependency directory is reused read-only via scratch `node_modules -> ../../node_modules`; no install occurred.

The approved intake records inspection of all 32 then-returned open issue bodies and all 30 then-open PR changed-file lists, with no existing metrics challenge, review, inline thread, or PR comment. Those counts are **intake evidence**, not a fresh complete inventory certified here. This execution reread issue37 and PR45; PR45 was returned open with 324 additions / two files. Fresh review submissions, inline threads, and merged comment timeline each returned an empty list. Issue107 is the now-existing challenge lane; no new ticket or GitHub write was made.

Local working-standards MEMORY.md, README.md and projects.md each returned `Operation not permitted` (combined read exit 1). Connected MEMORY.md and README.md at the recorded pin each returned HTTP 404 / `NOT_FOUND`. This limitation remains unresolved. Retain repository adoption at `c8dd539da85903dd76dd2d6f991d0a5ee5415a89` and its product-specific exceptions; no newer standards adoption is inferred. These read-only metadata checks used the existing connector session, without sign-in. All executable probes used fictional local data and no external I/O.

## Actual execution receipts

Commands below ran from the extracted snapshot unless stated otherwise. Bun was **1.3.14 (0d9b296a)**. Scratch HOME was created before the retained runs.

| Command | Actual exit / result |
| --- | --- |
| `mkdir -p .factory-tmp/home` | 0 |
| `ln -s ../../node_modules node_modules` | 0; existing dependencies only |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/autonomy-metrics.test.ts` | **0; 9 pass, 0 fail, 45 expect calls** |
| `node node_modules/typescript/bin/tsc --noEmit` | **0** |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test ./.factory-tmp/challenge.test.ts` | **1; 5 pass, 1 fail, 32 expect calls** |
| `git hash-object` on each reviewed file; `git ls-tree HEAD_SHA ...` | 0; matching blobs above |
| Approved Node document-content assertion followed by `git diff --check` (delivery checkout) | **0**; format/presence check only, not source acceptance |

Retained raw test logs: `SCRATCH/.factory-tmp/suite.log` and `SCRATCH/.factory-tmp/challenge.log`. Probe source and fictional SQLite files remain there; no second test matrix is committed. The probe imports `../tracking/autonomy-metrics` and `../tracking/store` from inside that snapshot.

An initial setup command mistakenly prefixed scratch-relative setup paths a second time: its `ln` reported `No such file or directory` (failure); its `mkdir` created an unused nested scratch directory. That first focused run still returned exit 0 / 9 pass / 45 assertions. Correct relative setup and the retained run above followed; no failed setup is represented as successful. Both focused Bun runs printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after the tests; the suite process nevertheless exited 0. The adversarial run printed the same denial and exited 1 for its assertion failure. Git printed denied xcrun temporary-cache creation diagnostics while the object/status/hash commands returned successfully. No sandbox permission was broadened.

Full `bun test` and `bun run typecheck` are **NOT RUN**: this lane used the explicitly bounded focused suite and direct Node typecheck, not the full host integration suite or Bun script runner. No process signal, deliberate abort, native model, private operational DB, transcript, service, or real message was used. Diagnostics ended within the 30-minute bound; uncovered boundaries remain NOT RUN.

## Boundary results

PASS/FAIL here describe the indicated diagnostic only. The independent-acceptance column is NOT RUN for every row because IR-45 is unresolved.

| Boundary | Diagnostic result and evidence | Independent acceptance |
| --- | --- | --- |
| Half-open windows / UTC hour clipping | PASS: existing suite includes start, end exclusion, partial final UTC hour | NOT RUN |
| Input order / identical duplicate invariance | PASS: existing suite reverses input with repeated identical ID; scratch tie probe reverses inputs | NOT RUN |
| Conflicting IDs / malformed JSON, shape, timestamps, windows | PASS: existing suite rejects conflicting ID and invalid evidence rather than success | NOT RUN |
| Missing observations / unknown intervals | PASS: empty history yields null counts and explicit unknown intervals | NOT RUN |
| First actual failure followed by classification | PASS: suite and scratch retain actual failure time and measured latency | NOT RUN |
| Classification-only failure | PASS: suite keeps failedAt/latency null despite a later response | NOT RUN |
| Response before / equal / after boundaries | PASS: scratch window [10,20), failure at 1; response at 9 excludes cohort, 10/11/19 includes measured response, 20/21 remains unresolved | NOT RUN |
| Unrelated-session retry / diagnosis / planned retry | PASS: wrong-session approval does not resolve s; suite ignores plan and queued diagnosis | NOT RUN |
| Same-time failure and response | PASS: response at failure timestamp produces zero latency even if response ID sorts earlier | NOT RUN |
| First-response cohort | PASS: response at 9 followed by escalation at 15 does not re-enter [10,20); earlier unresolved failure remains visible | NOT RUN |
| Circuit membership / another session's response | PASS: recent=[s,t] resolves s/t, not u; session-specific retry never resolves another session | NOT RUN |
| Two response IDs at same timestamp | PASS for deterministic behavior only: lexical `a-response` escalation wins over `z-response` retry in either input order; chronology between them is unproved | NOT RUN |
| Classification before actual failure / tied failure IDs | PASS for reproducing conservative null behavior; semantic adequacy NOT RUN pending ordering clarification below | NOT RUN |
| Owner decisions versus generic answers / requests | FAIL discrimination probe: generic overrun answer counts as owner=1; request alone does not count (F1) | NOT RUN |
| Publication session/repo/head/tree/URL shape | PASS: empty session, mismatched repo, uppercase/short SHA, query/trailing slash, PR zero and HTTP URL rejected | NOT RUN |
| Publication authenticity beyond event shape | NOT RUN: no GitHub identity/tree verification is performed by this reader; trusted producer boundary only | NOT RUN |
| Native success / PR / release permission versus Production | PASS: all remain insufficient for verifiedProductionDeliveries; result null | NOT RUN |
| Reopen / reader leaves events and KV unchanged | PASS: full ordered rows of both tables equal before/after read and reopen; replay equal | NOT RUN |
| Current heartbeat/capacity projected backward | PASS: fictional future KV does not change past unknown eligibility/starvation | NOT RUN |

## Findings and producer comparison

**F1 — owner counter includes generic answers.** At reviewed `tracking/autonomy-metrics.ts:97`, owner counting accepts every `owner-answer` having nonempty id/answer. Minimal fictional reproducer (the exact-head scratch probe asserts null and receives 1):

```ts
autonomyMetrics([{
  id: 'generic', kind: 'owner-answer', at: 3,
  data: JSON.stringify({
    id: 'overrun:fictional-session',
    answer: 'Please retain work for inspection'
  })
}], { from: 0, to: 10 }).decisions.owner
// actual: { observed: 1, eventIds: ['generic'] }
```

This is a real producer-compatible distinction, not a proposed future event schema: `launcher/engine.ts:360` creates `overrun:` questions; `board/server.ts:62-79` accepts any unanswered question ID and emits the request body as `owner-answer`. It does not attach an autonomy-decision link, tier or validated outcome. By contrast, `launcher/autonomy.ts:28-32` emits an `autonomy-owner-decision` **request/escalation** and creates `autonomy:<id>` question/KV state; expiration emits `autonomy-decision-default` at line 37. Rule approvals emit repo/number/digest at line 253. Generic `intake-approval` and an unanswered request do not establish an actual owner answer.

Issue37's counter name alone does not settle whether overrun answers should be included in a broader owner-action total. The approved challenge explicitly requires distinguishing genuine decisions from generic answers; the reader cannot currently provide that distinction. Product must settle the intended counter taxonomy, and a separately scoped repair must bind evidence accordingly if autonomy decisions are intended. An `autonomy:` prefix alone would not establish an outcome or prevent all malformed associations. No live miscount magnitude is claimed.

**Ordering limitation, not a confirmed source defect.** Reviewed `tracking/autonomy-metrics.ts:83` sorts by timestamp then ID; lines 103-109 retain the first failure-like record even if it is classification, and line 123 deliberately makes classification time unknown. Fictional sequences:

```text
classified:s failure-classified at=2 {session:s}
exit:s       worker-exit        at=5 {id:s,ok:false}
retry        automatic-retry-approved at=8 {session:s}
=> failureEventId=classified:s, failedAt=null, respondedAt=8, latencyMs=null

a-classification failure-classified at=10 {session:s}
z-failure       worker-exit        at=10 {id:s,ok:false}
retry at=12 {session:s}
=> classification wins lexically; latencyMs=null
```

These expose the limit of the comment at line 100 (“Prefer the first actual failure receipt”). They do not by themselves prove the later receipt timestamps the original failure. `launcher/autonomy.ts:112-118` can classify an unknown/paused session without a `failure:` event. `launcher/engine.ts:353-358` persists paused state before a later halt/finish receipt; `launcher/worker.ts:167` emits halt, engine finish emits `exit:<session>` at engine line 388, and worker catch calls finish(false) before emitting `failure:<session>` at worker lines 98-99. Thus classification may observe an already-failed/paused state before the later receipt. Timestamp ties carry no insertion sequence. Actual generated `classified:` and `exit:` IDs also sort classification first when tied. Retaining unknown can be more honest than declaring the later receipt the original failure. Product/IR-45 must clarify precedence when actual evidence exists and what tied timestamps prove; no latency repair is authorized here.

Failure escalation matching aligns with the exact producer: `launcher/autonomy.ts:122` supplies `{circuit,recent}` with session members; line 124 supplies session directly in payload; line 221 emits `automatic-retry-approved` with the original failure's session. The reader treats an escalation request as a failure response, not an answered owner decision. This distinction is appropriate for retry-or-escalation latency.

Publication shapes also align: `launcher/worker.ts:95` emits `{id,...result}`; `adapters/delivery.ts:163` returns signed head, tree, URL, branch and repo. Reader lines 91-95 enforce nonempty session/repo, lowercase 40-hex head/tree and matching canonical GitHub PR URL syntax. They do not independently verify that a session exists, the remote identity is authentic, or the tree belongs to that commit. That trust belongs to launcher publication evidence; shape acceptance is not a network attestation or delivery.

## Persistence and missing evidence

Reader lines 163-169 issue one bounded `SELECT ... WHERE at < to ORDER BY at,id`, replaying all earlier history needed for cross-window responses. `Store.atomic` (`tracking/store.ts:80-81`) uses an **immediate transaction**. The reader performs no event/KV mutation, but it is not an OS read-only connection or a deferred read transaction: BEGIN IMMEDIATE can acquire the writer reservation and contend. Store construction enables WAL, creates schema/default KV and may migrate old schemas (lines 6-52). Reopening the already-current fictional database preserved exact events/KV; this does not prove opening a legacy database is mutation-free, nor byte-identical DB/WAL files. No lock-contention or operational latency acceptance was run.

The null outputs deliberately preserve missing evidence. Original issue37 metrics still unavailable are:

| Metric | Missing future evidence needed before a non-null result |
| --- | --- |
| Eligible hours with ticket progress / per-hour eligibility | Timestamped retained admission eligibility transitions or bounded samples, observation coverage/gaps and the applicable gate evidence; sparse progress events cannot supply an eligibility denominator |
| Ready starvation intervals | Retained ready/unclaimed queue state transitions or time-bounded observations plus coverage, correlated with eligibility and free capacity over the same interval |
| Capacity starvation intervals | Retained effective slots and occupied/admission-blocking custody over time, queue demand and coverage; a current KV snapshot or capacity-increased event cannot reconstruct past occupancy |
| Complete rule/owner/default decision totals | Explicit decision identity, type, resolver/outcome and coverage of the decision lifecycle; existing observed counts are lower bounds, absent families stay null, and F1 prevents a clean autonomy-owner total |
| Latency for classification-only/unobserved failures or unresolved responses | An actual first-failure receipt linked to session and an approved retry/escalation receipt with timestamps and ordering sufficient to attribute the first response; absent response is null, not elapsed waiting |
| Verified Production deliveries | A verified execution receipt tied to the delivered revision/tree, target environment and successful post-delivery verification; native completion, launcher PR and release authorization are insufficient |

Launcher-publication observed counts and sparse progress UTC buckets are available for valid retained events, without completeness, eligible-hours or Production claims. Specifying these future evidence requirements adds no collection, integration, dashboard or operational scope to this proposal.

## Next actor, restart and undo

Product should retain this evidence and assign **IR-45**. Observable restart: a named independent reviewer records separation from the original writer, verifies the same immutable head/base/tree and blobs in a new retained scratch, reruns the exact focused command and probes, and supplies their own boundary disposition. Missing immutable objects, installed dependencies or executable sandbox capability must remain NOT RUN until the launcher restores that exact prerequisite; never substitute current main. If Bun ceases to execute the suite, require a fresh receipt with actual test counts and exit before resuming acceptance.

Product separately scopes any F1 correction after settling taxonomy; IR-45 determines acceptance and the ordering limitation. No existing branch is rewritten. Current-main integration and dashboard wiring require their own bounded work; Quality/Release separately owns live endurance and Production disposition. No merge/release authority follows from this document.

Undo this docs proposal through a later reviewed revert if needed. Preserve scratch, fictional databases, failed assertion, original commits, branches and all operational custody/debit history. The unsigned docs commit and delivery bundle are for launcher retesting/signing/publication after cleanup; they are not a posted GitHub review or acceptance receipt.
