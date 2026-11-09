# PR78 wake ordering and deadline challenge

Review for [issue125](https://github.com/fulmar-hq/agent-factory/issues/125), 2026-11-09. **PASS for the supported ordering/deadline boundaries on the immutable head below. Integrated source delivery: NOT RUN / not accepted by this report.** Malformed-record containment is separately unsuccessful and outside this correction's supported input contract.

## Identity, authority and scope

- Reviewed head: `73a42b8e3151885ecd087735a8822c7779baf1ec`.
- Reviewed base: `c48c9bb4224e2240cc9f3757e1ac19ee353aabc4`.
- Full retained diff inspected: `launcher/wake.ts`, `tests/wake-ordering.test.ts`, `tests/release-executor.test.ts`; 129 additions / 10 deletions. The production change is ordering; the existing dispatch deadline guard is unchanged from base.
- Independence: I confirm that this review session is the issue125 challenger, did not implement issue77/PR78 or PR67, and made no source changes. I independently inspected the retained implementation and wrote the scratch probes. This is reviewer attestation, not an inference from the shared Git author/account. Private native-session/custody comparison was NOT RUN: the launcher must verify distinct implementation/reviewer custody before counting this as independent acceptance. If that distinction cannot be confirmed, mark independent acceptance NOT RUN and assign a different reviewer to repeat the immutable-head review.
- Read the checkout's AGENTS.md, README.md and docs/operations.md. Shared working-standards MEMORY.md, README.md and projects.md reads returned `Operation not permitted` (combined read exit 1). Retain the recorded adoption at `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; upstream authority was unavailable and was not refreshed.
- Only this report is proposed. No implementation, real executor CLI, native owner spawn, provider/model activity, process signals/crashes, sign-in, messages, GitHub writes, policy changes, jobs, spending or operational custody/debit changes occurred. All databases and identities used below are fictional scratch fixtures. No helpers were used. PR68/76 challenges were not duplicated.

## Isolation and execution receipts

Unique scratch: `.factory-tmp/wake-review-dFFibR/tree`. Extraction used retained `git archive --format=tar 73a42b8e3151885ecd087735a8822c7779baf1ec` and `tar -xf` into that empty directory, both exit **0**. No reset, clean, checkout switch, branch combination or source transplant was performed. Installed checkout `node_modules` was symlinked for read-only reuse; nothing was installed or edited there. Scratch HOME and TMPDIR were created inside the extracted tree.

An initial Node child-process archive helper exited **1** before extraction (no child status/stderr; the helper then threw while accessing stderr). Its extraction attempt was NOT RUN. The subsequent direct shell archive/extraction above succeeded against the same immutable object; no current-main source was substituted. The `/usr/bin/git` shim printed denied xcrun cache-write diagnostics despite successful reads; later Git checks used the existing `/Library/Developer/CommandLineTools/usr/bin/git` directly, without changing permissions.

The three extracted file hashes matched retained blobs (`git ls-tree` and `git hash-object`, exit **0**):

| Path | Blob |
| --- | --- |
| `launcher/wake.ts` | `baa2bf9a2c4632c1917387912167ac9425a5dc68` |
| `tests/wake-ordering.test.ts` | `482680bd28916604588b06d353240464e06a5a06` |
| `tests/release-executor.test.ts` | `82cda0d825953ab2e27bfb9761d8148b4a6c2dd9` |

Commands below ran from the extracted tree on macOS, Node **v24.18.0**, Bun **1.3.14** (`0d9b296a`).

| Actual command | Exit | Result |
| --- | --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | **0** | No diagnostics |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/wake-ordering.test.ts tests/release-executor.test.ts` | **0** | **20 pass, 0 fail, 64 expect calls**, 2 files: 6 ordering tests and 14 release tests, including both deadline regressions |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test .factory-tmp/adversarial.test.ts` | **1** | Initial filter spelling matched no files; zero probes ran |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./.factory-tmp/adversarial.test.ts` | **0** | **12 pass, 0 fail, 157 expect calls**, 1 scratch file importing the extracted `launcher/wake.ts` and `tracking/store.ts` |

Both successful Bun runs printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied`. This is retained as a host warning, not hidden or counted as successful private access. Every listed test completed; no unexpected host capability was needed, no permission was broadened, and probes injected identity rather than calling the host process-identity implementation. Tests use fictional ReleasePort callbacks; reading the test/imported source confirmed no abort or actual executor invocation. Native spawning, real process identity, full host suite and hosted release acceptance are **NOT RUN**; these receipts cannot qualify them.

Raw receipts remain in `.factory-tmp/wake-review-dFFibR/`: `typecheck.log`, `retained-tests.log`, `adversarial.log`; the only additional probe source is `tree/.factory-tmp/adversarial.test.ts`. SHA-256 receipts:

```text
archive .factory-tmp/wake-review-head.tar
6bb17d18b7c44e4bbc09eea4e6fb4f1beffdc2c7e520a79014f8144ebf82f178
retained-tests.log
8a6514855426ffb592254e2c4490a1295892df4914ac943260f01644e95ce075
adversarial.log
94af240182d34e2758fa667813d6c4116d7a9041364c741e723e7238875721b2
scratch adversarial.test.ts
06aa19c4caf36bffa6c7285336be7692b6b5a9ae357c9d3994f53ed6f0ca7924
```

No probe matrix is added to committed tests. The scratch diagnostics' passing assertions mean the documented limitations were reproduced, not that malformed-record containment passed.

## Supported boundaries and source findings

All line numbers here refer to `launcher/wake.ts` at the immutable reviewed head.

| Boundary | Verdict | Independently checked evidence |
| --- | --- | --- |
| Priority before age | **PASS** | Lines 17, 24 preserve QA, production verification, release diagnosis, Product intake, failure diagnosis, owner decision, then routine. Scratch reverses age across all seven classes; even undated QA remains first. Retained tests cover routine kinds sharing one class. |
| Age and stable ID ties | **PASS** | Lines 25–27 compare numeric ages, then IDs with literal string comparison. Retained shuffled/reversed rows and scratch equal maximum timestamps return `a-max` before `z-max`; routine kinds do not get separate priority. |
| Epoch / maximum supported Date | **PASS** | Line 21 includes `0` and `8640000000000000`. Scratch returns epoch, both maximum-date peers, then unknown ages; `8640000000000001` follows dated peers. JavaScript Date accepts the maximum and rejects maximum+1. |
| Supported legacy ages | **PASS** | Line 21 maps missing, null, string, negative, fractional, object, array, boolean and out-of-range ages to Infinity without writing. Retained tests cover these values; scratch compares raw kv plus events before/after repeated reads. Known ages precede unknown ages within their class, unknown ages tie by ID. No urgency or refreshed timestamp is invented. |
| Queued records only | **PASS** | Line 23 filters `state==='queued'`; retained tests exclude starting/running/done/expired/failed/archived/missing state and unrelated keys. This assumes parseable non-null records; see malformed inputs below. |
| Reversed insertion / restart | **PASS** | Retained test reconstructs raw kv in reverse row order with original events and compares complete pending arrays. Scratch additionally closes and reopens a real SQLite file wholly inside scratch; order is unchanged. This is storage restart evidence, not native worker restart qualification. |
| Duplicate queue event | **PASS** | Lines 12–14 return false before overwriting if the event exists. Both retained reconstruction and scratch close/reopen tests reject duplicate ID with a later time; original queue timestamp, payload/class and event receipt remain identical. |
| Deadline minus one | **PASS** | At `Date.now() = D-1`, deadline D is valid under lines 34–39. Injected stale PID identity permits exactly one spawn callback, sets starting/runtime wake and one dispatch event. A second dispatch returns false; old CI stays queued. |
| Deadline equality | **PASS** | At `Date.now() = D`, dispatch returns false, no spawn or identity callback occurs, wake becomes expired with cleanupVerified true, and `owner-deadline:accept` / `owner-wake-expired` plus undo text is retained. Runtime snapshot is unchanged. |
| Deadline plus one | **PASS** | At `Date.now() = D+1`, same no-spawn, receipt-retention and unchanged-runtime assertions pass. Repeated dispatch does not replay. |
| Missing / invalid deadline | **PASS** | Lines 35–38 reject missing, null, string, boolean, object, array, fractional and unsafe integers; negative/zero deadlines are already past at the fixture clock. Scratch also supplies NaN/Infinity, which JSON storage serializes to null: these are not evidence of non-finite numbers surviving JSON. All expire without consuming runtime or inspecting PID. |
| Clock advances after ordering | **PASS** | Retained second deadline regression orders before deadline, advances to equality and refuses dispatch. Scratch also passes a stale caller payload claiming a later deadline: line 35 reads the retained payload and still expires at equality, preserving runtime. |
| Expired then valid versus old CI | **PASS** | Retained first deadline regression orders expired QA, valid QA, old CI. Expired QA cannot claim runtime; valid QA then dispatches once. Scratch boundary tests inject both spawn and identity and independently assert retained receipt and old-CI queue state. |
| Existing running / unverified custody | **PASS** | Lines 43–47 refuse a live mocked PID, PID without identity, prior starting/running wake even with cleanupVerified true, and prior done/failed wake without verified cleanup. Scratch repeats attempts and verifies unchanged kv/events and zero spawns. A mocked stopped PID can dispatch once. No real process was queried or stopped. |

The deadline decision occurs inside the atomic claim at lines 31–39 before runtime checks; the spawn callback follows the committed claim at line 54. This establishes the requested ordering-to-dispatch boundary. It is not a measurement of wall-clock latency up to an actual native process start. No real-time scheduling or broader Release fault-containment claim follows from these fixtures.

## Malformed retained records: separate limits

**FAIL for an assertion of malformed-record containment; outside supported legacy timestamp behavior.** No such repair was attempted or acceptance requirement silently added.

At line 23, JSON parsing and property access have no per-row validation/catch. A raw kv value `{` throws SyntaxError; JSON `null` throws on `r.state`. In either case pendingWakes does not return a healthy queued peer. Raw kv/events remain unchanged. This is function-level failure, not a deliberately crashed process, and does not prove controller-level recovery or containment.

At line 27, missing IDs are not validated. Two otherwise queued same-age routine objects without IDs compare equal; forward insertion returns markers `[a,b]`, reverse insertion `[b,a]`. Such malformed records are different from valid records with only a missing/invalid `at`. Minimal diagnostic: insert `('owner-wake:bad','null')` directly into a fictional Store's kv, then call pendingWakes; or insert two queued same-age objects omitting id and reverse their insertion order. Do not apply these fixtures to operational storage. Product/Quality must decide separately whether unsupported record shapes need a new bounded correction; this report grants no repair authority.

## Minimal fictional supported reproducer

Place this only in the extracted tree's scratch directory and run with the same scratch HOME/TMPDIR. It imports exact reviewed source; callbacks only collect strings and return a fictional identity.

```ts
import {Store} from '../tracking/store';
import {queueWake,pendingWakes,dispatchWake} from '../launcher/wake';
const s=new Store(':memory:'), D=1794270000000;
const original=Date.now, starts:string[]=[];
Date.now=()=>D;
try {
 s.set('owner-runtime:quality',{workspace:process.cwd()});
 queueWake(s,{id:'ci',owner:'quality',kind:'ci-finished',payload:{}},0);
 queueWake(s,{id:'valid',owner:'quality',kind:'qa-deployed',payload:{deadline:D+1}},2);
 queueWake(s,{id:'expired',owner:'quality',kind:'qa-deployed',payload:{deadline:D}},1);
 const ordered=pendingWakes(s); // expired, valid, ci
 const dispatch=(w:typeof ordered[number])=>dispatchWake(s,w,id=>{starts.push(id);},()=>null);
 console.log(dispatch(ordered[0]),dispatch(ordered[1]),dispatch(ordered[1]));
 // false, true, false; starts=['valid']; expired receipt retained; ci still queued
 console.log(starts,s.get('owner-wake:expired'),s.rows('events'));
} finally {Date.now=original;s.close();}
```

The executed scratch tests assert these state/receipt/custody outcomes; this shortened explanatory reproducer is not presented as an additional executed test.

## Current-main compatibility and delivery boundary

Read-only GitHub observations during this review (approximately 20:30–20:32 UTC): PR78 is OPEN, non-draft, unchanged head/base above, 3 files / 129 additions / 10 deletions, and its fetched comments list is empty. Intake recorded `mergeable=false`; fresh `get_pr_info` returned **`mergeable=true`**, while still reporting the original base SHA. Preserve both observations. GitHub's computed flag is mutable metadata, not independent integrated acceptance.

GitHub `fetch_commit(main)` and local HEAD/origin-main agreed on `e12c4bb440c998244dc0dd5e4202b609d7b26500`. Retained `git merge-base` with reviewed head returned `c48c9bb4224e2240cc9f3757e1ac19ee353aabc4` (exit 0). Comparing that base to current main shows only `launcher/wake.ts` among the three reviewed paths: current main adds board pull recording (`recordPulls`, `pullFields`, `BoardPull`) outside the ordering function. Its release test is still the original insertion-order expectation, and it lacks the new ordering suite. Current-main source inspection suggests a reconciliation is possible, but **integrated execution/acceptance is NOT RUN**. No merged tree was created, tested or claimed by this report.

Preserve **PR67 -> issue77 / PR78** as one corrective outcome: PR67 remains OPEN, head `2fc8892d0e352d8278b058619a64d378be337678`, mergeable false. PR78 is the sole corrective delivery candidate; this document is review evidence, not another source lane. Draft PR73 remains OPEN at `c484d402d15384d843f890f0867cb87b80e757d2`, mergeable false. Its changed-path readback includes `launcher/wake.ts` among 14 paths. Its policy/capacity/challenger proposal is not authorized by this review. Release must explicitly reconcile that overlap and retain one accepted delivery lane, without combining or merging branches here.

Only the selected PRs/issues and PR73 path list were read back. This is not a complete remote path, duplicate-outcome or live custody inventory. The launcher must recheck current OPEN evidence, issue125/report duplication, all open PR paths, and retained/current claims before creation/admission/publication. Existing intake search results are historical context, not current exhaustive proof.

## Next actor, observable restart and undo

Product retains outcome custody. Quality determines whether these exact-head supported-boundary receipts are accepted, including reviewer independence and the explicitly separate malformed-record limitation. Release owns source acceptance/delivery and must retain one accepted lane and an independently reviewed **integrated revision** before any source delivery. Passing focused tests, this report's format check, CI green or mergeability metadata alone is insufficient.

Observable restart conditions:

1. If independent reviewer custody cannot be confirmed, independent acceptance is **NOT RUN**. Launcher supplies a distinct reviewer assignment/custody receipt; that reviewer re-extracts this same head and repeats the review. No original-worker self-approval.
2. If objects/dependencies disappear or execution is denied, the affected checks are **NOT RUN**. Restore authorized read access to the specified retained objects, installed dependencies and in-workspace scratch, then rerun the exact commands without substituting main or broadening permissions. The earlier failed helper/filter attempts above are not passing evidence.
3. For integration, Product/Release records a single chosen corrective lane and PR73 overlap disposition, then supplies the immutable integrated revision with current main preserved. A distinct challenger repeats ordering, deadline and custody boundaries on that exact revision; Quality/Release retain its command exits, findings and acceptance before source delivery. Any head/base movement invalidates transfer of this report's execution verdict.
4. Launcher rechecks mutable remote evidence and claims and retains snapshot-test/signing/publication receipts after worker cleanup. This worker leaves only an unsigned local docs commit and `.factory-delivery.bundle`; no publication or merge is authorized here.

Initial and subsequent local status reads were clean, despite intake's warning of concurrent dirty source/Release work elsewhere or earlier. No such work was reset, cleaned, staged or committed; only the report path is selected. Any newly appearing concurrent edits must remain untouched. Undo only through a reviewed revert of this report, retaining original PRs/work and all receipts. Keep scratch evidence; do not reset custody/debits or remove operational assets.

Report-format validation and `git diff --check` receipts are recorded below after execution. Review remained within the approved 30 active minutes.

Final local validation: the issue125 report-format Node assertion exited **0**; `git diff --check` exited **0**. These check report delivery format/whitespace only, not source acceptance. The same checks are repeated on the final report, with a staged whitespace check before the unsigned commit.
