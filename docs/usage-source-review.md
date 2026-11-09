# Usage-source review — PR68 / issue64

Issue104 evidence-only proposal, 2026-11-09. **Independent acceptance: NOT RUN.**
The required reviewer identity check collided; the diagnostic results below do
not repair that missing independent acceptance. Product retains outcome custody;
Quality/Release disposition remains separate. No operational or Production
success is claimed.

## Frozen scope and identity

- Reviewed head: `3745aff1b0824dc3bb38ba77fa4073befe14653d`.
- Reviewed base: `2c9e529ff5b40a82c339bb7b0f8c4cf6a2192ad3`.
- Complete diff: `adapters/usage.ts` and
  `tests/usage-source-isolation.test.ts`, 116 additions / 1 deletion.
- Delivery checkout started at `e12c4bb440c998244dc0dd5e4202b609d7b26500`,
  branch `feat/factory-c728cab6dd2ca947`, clean. It was never reset, cleaned,
  substituted for the reviewed head, or combined with PR68.
- `git show -s --format=fuller HEAD_SHA` identifies the PR head's author and
  committer as Vincent Messina
  `<72951696+vincentmessina@users.noreply.github.com>`.
  `git config --local --get user.name` and `user.email` return that same
  name/address for this review workspace. This Codex review turn did not write
  the original diff, but a distinct turn does not prove a distinct writer.
  The observable identity collision triggers the approved NOT RUN rule.
- Named dependency: **Product must assign a separately identified independent
  PR68 reviewer**, with retained provenance distinguishing that reviewer from
  the original implementation writer. Merely changing Git configuration does
  not establish independence. No such assignment is asserted here.

Repository AGENTS.md, README.md and docs/operations.md were read. Retain the
recorded working-standards adoption at
`c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream update was adopted.
Reading shared MEMORY.md, README.md and projects.md returned `Operation not
permitted` (exit 1). Intake reports connected pinned MEMORY/README/authority
returned 404; those connected failures were not independently repeated here.
Intake also reports complete inspection of 30 open issue bodies and 29 open PR
path lists, with no duplicate challenge/review/thread/comment found. That is
intake provenance, not fresh GitHub readback by this worker. No GitHub writes.

## Execution receipts

All paths below are workspace-relative. Scratch and failed extraction attempts
are retained, excluded from Git. Existing installed `node_modules` was linked
read-only into the successful snapshot; dependencies were not installed or
modified. Scratch HOME existed before the successful Bun invocation.

| Command / action | Actual exit and evidence |
| --- | --- |
| Initial `git status --short`, head metadata and diff reads | exit 0; clean start, frozen metadata and two-file diff above. Git repeatedly printed denied xcrun cache-write diagnostics; object reads still succeeded. |
| Python `git archive` / `tarfile.extractall(..., filter='data')` helper | exit 1: installed Python rejects the `filter` keyword. Its archive remains in scratch. |
| Premature snapshot-path read and Bun command after that helper | exit 1: path file absent; Bun searched the delivery checkout and found no matching tests (zero executed). This is an invalid attempt, not exact-head evidence. |
| Companion premature `rg`/package read | shell exit 0 from final `cat`; `rg` reported a nonexistent `launcher/gates.ts`. Checkout output was discarded as reviewed-head evidence. |
| Node extraction helper using `execFileSync('git', ...)` | exit 1: `spawnSync git EPERM`. No permissions were broadened. |
| Shell `git archive --format=tar --output="$REVIEW_SNAPSHOT/head.tar" 3745aff1b0824dc3bb38ba77fa4073befe14653d`, then `tar -xf ... -C "$REVIEW_SNAPSHOT"` | exit 0 under `set -e`; unique snapshot `.factory-tmp/usage-review-02EDC332-54FE-4A30-B618-29F69C12C127`. Created with `uuidgen`, with `.factory-tmp/home` and a dependency symlink. Successful path retained in `.factory-tmp/usage-review-path`. |
| From that extracted snapshot: `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/usage-source-isolation.test.ts` | exit 0; Bun 1.3.14, **27 pass, 0 fail, 70 expect calls**, one file, 28 ms. Also emitted `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied`. This diagnostic does not prove access; no default reader was invoked. |
| Exact-snapshot numbered source/test reads, base `git show` | exit 0; references below are at the frozen head unless explicitly labeled base. |

The successful command ran the retained original 112-line suite without edits.
Every call injects all three fictional source functions. No app-server, home
receipts, controller database, credentials or native models were used. No
additional test matrix was committed. No deliberate process abort, live tick,
job, sign-in, provider operation or operational mutation was attempted.

## Boundary verdicts

“Diagnostic PASS” means only the original synthetic suite observed the stated
behavior in this workspace. Every independent acceptance boundary remains
**NOT RUN** because of the identity dependency above; green tests alone are not
acceptance.

| Boundary | Diagnostic evidence | Independent verdict |
| --- | --- | --- |
| Synchronous throw and asynchronous rejection at receipt, Claude and status | PASS: six cases, test lines 22–38; all other sources survive. | NOT RUN |
| All eight surviving-source subsets, including none | PASS: lines 40–53, masks 0–7; mixed throws/rejections. | NOT RUN |
| Exactly once per configured source | PASS for six single-failure cases: call list equals the three unique keys, lines 25–35. Other subset and delayed schedules lack call-count assertions. | NOT RUN for complete requested matrix |
| Undefined results and no previous-call leakage | PASS for sequential success, failure and all-undefined calls, lines 55–64. Overlapping calls are not exercised. | NOT RUN |
| Differently ordered delayed fulfillment/rejection settlements | NOT RUN: original suite uses immediately settled promises; no additional adversarial probe after identity collision. | NOT RUN |
| Newest Codex observation in both directions | PASS: lines 84–103 select each newer source, retaining the precise returned object. | NOT RUN |
| Original provider, source, timestamp and windows; no window merging or refreshed timestamps | PASS: object identity and serialization unchanged for newer status and Claude over two polling times, lines 66–82; newer receipt identity checked at line 99. Full delayed/repeated-call matrix absent. | NOT RUN |
| Equal timestamp with higher-usage status | PASS: lines 105–112 retain low receipt despite tied status at .95. Deliberately unchanged base behavior. | NOT RUN |
| Newer high usage, future time, expired reset, empty windows, wrong provider | PASS for **selection only**, both receipt/status directions, ten cases at lines 84–103. | NOT RUN for independent selection acceptance and downstream admission |
| Downstream gate and tick merge | Static inspection completed below; no end-to-end synthetic admission check. | NOT RUN for executable admission proof |
| Never-settling source | Static wait boundary below; no runtime hang probe. | NOT RUN for runtime observation; outside throw/rejection repair |
| Current-main integration, full suite/typecheck, CI and release | Not executed. Focused exact-head suite does not establish integration readiness; broad host suites are outside this bounded collision-blocked review. | NOT RUN |

## Findings and limits

1. **No new implementation defect established.** At `adapters/usage.ts:146`,
   `Promise.resolve().then(source).catch(() => undefined)` defers each call and
   contains throws/rejections. Line 147 constructs all three independent reads.
   Reproduce the observed isolation result with the exact snapshot command above;
   tests at lines 22–53 are the retained fictional reproducers. No failing
   implementation evidence was produced and no implementation was changed.

2. **Selection is not admission proof.** `adapters/usage.ts:148` selects by
   observation time without validating or falling back from the selected object.
   `launcher/tick.ts:88` reads private inputs; lines 89–95 merge a local meter only
   when strictly newer than that provider's input, store the result and call
   `refreshUsage`. Thus a newer invalid local object is not discarded in favor
   of an older low input at that merge. Equal timestamps retain the input there.
   `launcher/config.ts:69` defines MeterSchema; lines 146–158 parse each private
   provider independently. `launcher/engine.ts:50` validates the selected meter:
   empty windows fail schema; future/old observations and expired resets fail
   freshness; configured exposed-window policy checks provider; legacy policy
   requires two windows; maximum usage is compared with configured thresholds.
   Wrong-provider refusal depends on `usage_windows` being enabled; this review
   does not assert unconditional refusal under the legacy policy.

   `launcher/engine.ts:202` passes admission's meter to `usageGate`. Lines
   204–208 permit an explicit bounded recovery route for certain unknown/stale
   results, subject to `recoveryEligible` at lines 110–120 and retained allowance
   checks. Expired-reset evidence can therefore require recovery-path analysis;
   it is not proof that every admission is refused. No assertion of ordinary or
   recovery admission is made from selection tests. Observable restart: the
   independent reviewer runs fictional source selection through the exact merge
   and an in-memory Store/Engine, exercises normal and explicit recovery paths,
   and records the chosen meter plus refusal/admission and retained allowance.
   The ten existing invalid/high-use fixtures should be reused. Do not call tick
   or its default readers merely to obtain this evidence.

3. **Tie precedence is retained, not a new defect.** Reproducer: receipt at
   timestamp T with used .1 and status at T with used .95; suite lines 105–112
   selects receipt. Both head `adapters/usage.ts:148` and base
   `adapters/usage.ts:145` use strict `>` for status selection. A changed tie
   policy would require separate scope; this document does not request it.

4. **Wait boundary remains.** At `adapters/usage.ts:147`, Promise.all still waits
   for every source. Injecting `status: () => new Promise(() => {})` while the
   other two resolve leaves `localReadings` pending. This is a source-derived
   reproducer, **not executed** here. The default status reader has its own
   timeout (`adapters/usage.ts:22–33`), but that is not a general aggregation
   deadline for arbitrary sources. A never-settling source is outside this PR's
   throw/rejection repair; no timeout was added.

## Next actor and restart

**Product** assigns the named independent-review dependency above. The reviewer
must record verifiable distinct writer/reviewer provenance, re-extract this exact
head into a new unique `.factory-tmp` directory, create scratch HOME first, link
only existing read-only dependencies, and rerun the exact focused command. If
objects/dependencies are absent or the sandbox refuses execution, retain the
failure and mark that boundary NOT RUN; restart only when the named missing
prerequisite is available through the authorized path. Do not substitute main.

The independent reviewer then adds scratch-only probes importing exact-head
source: all settlement orders with both delayed successes and rejections,
exactly-once counters for every subset, overlapping calls with distinct fictional
objects, both newest directions and tied higher status, identity preservation,
and in-memory downstream admission/recovery checks. Record actual exits and
assertions; preserve a failing probe for any separately scoped repair. Stop at
30 active minutes and leave unresolved boundaries NOT RUN. Do not combine
branches, change tie behavior, add timeouts or expand this into operational work.

**Quality/Release** separately assesses current-main integration and disposition
after independent acceptance. This docs-only delivery neither grants that
acceptance nor changes custody, policy, usage, qualification or release state.
Undo this proposal by reverting only the document; retain scratch evidence.

## Delivery checks

The approved Node document assertion and `git diff --check` both returned
**exit 0** before the unsigned local commit. They validate document
content/whitespace only. The requested unsigned commit
and local bundle are launcher inputs, not signed or published acceptance.
