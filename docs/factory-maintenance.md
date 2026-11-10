# Launcher merge and installation

Product owns useful scope and installed acceptance. Release owns launcher PR integration; Coordinator owns initial job installation and custody reconciliation. These duties are distinct from the Alido 20:00/21:30 product release train. A read-only owner wake cannot merge or install. Previously publication stopped at PR creation, while CI notifications only woke read-only owners: no executor owned the final transition. Green changes accumulated indefinitely.

The Release maintenance job runs `bun scripts/maintain-factory.ts --once` every five minutes from the installed checkout. It uses the native Codex subscription for required independent review, never a paid model API or AWS. At most one new review runs per maintenance pass, with a normal builder slot, genuine matching qualification, existing usage/pause guards, a standard 15-minute / risk-scaled 30-minute bound, verified native identity and descendant cleanup. No model runs on an idle pass. It first resumes only an explicitly retained verified exact-tree installation, then examines open main PRs oldest first. Every merge requires a successful independent Codex medium challenge for that exact head, independently reread native identity/model/effort, verified cleanup, no findings, green Verify, CLEAN merge state and a GitHub-verified signed head. GitHub's existing protected merge endpoint remains authoritative. Squash merge pins the expected head, preserves the branch, and must return the exact tested tree and a verified signature before installation. No admin bypass, branch deletion, quota/capacity change or product release exists in this lane.

Challenge receipts are trusted controller `codex-challenge` events, with `pr`, `head`, `ok`, `workspace`, `startedAt`, native evidence, cleanup and the structured review. Workers cannot create these events. A changed head requires another review. Findings require a bounded fix-up; conflicts, missing review and failed checks remain durable `factory-maintenance` receipts. Superseded PRs are closed with a source-linked explanation, never deleted. A source delivery alone does not complete live acceptance.

After independent review, Coordinator installs a private launchd plist with label `com.agent-factory.maintenance`, StartInterval 300, RunAtLoad false, absolute Bun/script paths, the installed checkout as WorkingDirectory and existing FACTORY_PRIVATE_DIR. Archive any previous plist, lint, bootstrap, then read back the loaded job. Implementation never loads launchd. The durable launcher-maintenance lease excludes qualification renewal from source integration, with atomic claims and no timeout stealing. The lock under private `maintenance/active` serializes execution; interrupted custody is retained for process-identity reconciliation before archiving the lock. Completed claims, logs and events remain private.

Installation requires clean main, the exact origin, and a fast-forward to the explicitly verified merge revision. A remote main descendant is never substituted. Rejected merge trees remain blocked across restart; a signature alone cannot clear the rejection. It never stashes, resets or cleans local changes. For an existing dirty installation, preserve its patch and untracked files privately, reconcile them through reviewed source, and retain undo before enabling maintenance. Existing ticks adopt source on their next invocation; restart a persistent board only after its own custody check. Undo: boot out the maintenance label, archive its plist, then install a reviewed signed revert. Never reset databases, qualification, claims or debits.

Review independence means a fresh Codex session that did not author the change, with its native ID and exact-head evidence retained. Workers and reviewers normally publish through the same trusted GitHub account; requiring another GitHub account would make this factory's review boundary impossible and does not establish model-session independence.

A durable expected PR/head/tree intent precedes every merge effect. An interrupted or lost response is reconciled by reading that exact PR; it is never re-merged or recovered by installing arbitrary main. Verified merge outcomes create a retained exact installation target. An install failure stops the pass before any later merge and preserves that target for restart.

When a signed green head is behind main, request one normal expected-head GitHub branch update and wait for its new required CI and new exact-head review. Updates retain their claim across unknown responses and never rewrite or delete branches. A fresh source snapshot, credentials-free read-only reviewer and structured launcher-retained receipt replace the old docs-only review dead end. Findings remain a source blocker; they do not become a passing review, fake qualification or automatic scope approval.

Definitive authenticated HTTP 405/409/422 rejection receipts retain the rejected PR/head/status and release only that no-effect merge intent. A later pass rereads every gate. Lost replies, timeouts, malformed responses and failed post-merge readback retain uncertain custody and block read-only reconciliation. Retained non-runnable review attempts do not spend a new pass allowance; only a newly claimed review does.

## One review per change — Vincent, 2026-11-10

Every change gets exactly one independent review of its current immutable head,
by a fresh session that did not write it, after its checks are green. Review is a
step of the same issue and pull request. Never create Challenge/Accept issues,
use review as refill work, or add a repository report document. The reviewer
posts a short PASS, specific DEFECT, or BLOCKED verdict on that PR; defects return
to the original issue. Missing evidence is a blocker, not a proven defect. Reuse
an existing valid exact-head verdict. A changed head needs fresh exact-head
review evidence as a continuation of that PR review; never reuse stale approval.

Standard review checks the outcome, changed code and cheapest meaningful focused
regression, normally within 15 minutes. Changes touching tenant separation,
consent, sends, bookings, permissions, money or migrations receive deeper review:
trace the affected lifecycle and deterministic safeguards and check the relevant
cross-feature or migration regression, within an explicit 30-minute bound. The
launcher selects deep review from changed path/diff risk terms; the reviewer
must escalate when source reveals one of these risks. It reports BLOCKED if the
bound or available tools cannot establish the required evidence.

The existing five-minute maintenance job reviews enrolled product PRs as well
as its protected factory lane, admitting at most one new review per pass. It
requires green Verify and (for Alido) Secret scan; Release hold remains a separate
merge/release gate. It never merges product PRs. Normal qualification, capacity,
usage, pause and native cleanup gates remain unchanged: unavailable capacity
defers the required review and never waives it. Native subscription calls only;
no AWS or paid model APIs. Private exact-head custody and receipts are retained.
The frozen `release-batch.json` carrier and all its sources are excluded from this
new sweep, preserving the already frozen release. Existing report-only PRs are
reconciled with their source PR and archived by closing, never deleting branches.

`review_process` in private config enables the consistent review executor.
`refill` enables product-only intake at both creation and automatic approval,
including results from stale queued wakes. Refill must cite an existing open
product backlog issue, label each proposal `category: product`, and return
`mix: {product: N, other: 0}` matching its ticket count, including an empty refill.
The launcher records the mix in a `refill-mix` receipt. Prioritize multi-staff and
mixed-calendar booking, Outlook, Leads, onboarding, Settings and reply quality.
No review, challenge, acceptance or factory-maintenance tickets come from refill.
Keep existing work custody and avoid duplicates. Spare usage goes to product
work only; it never adds or removes a review requirement. GitHub API reserve is
checked before maintenance; below 500 remaining core or GraphQL points, defer to
a scheduled pass after reset rather than retrying and starving launcher ticks.

Install config only after source review: archive the previous private config,
add the fixed `review_process` and `refill` blocks from the fictional example,
validate it, retain an undo receipt, and let the maintenance job install the
reviewed signed source. This changes no schedule, wallet, usage or capacity limit.

For an existing review backlog, set `review_process.historical_receipts: pending` while migrating verdicts. Product supplies private `historical-review-receipts.json` as `{complete:true,reviews:[{repo,pr,head,session,native,verdict,verdictUrl,evidence}]}`. Each evidence string must contain the exact reviewed head; the PR verdict retains source provenance. The importer validates enrolled repo, source-PR verdict URL, a retained successful review worker with matching native ID and verified cleanup, and refuses a known target author. It also requires a trusted launcher-retained `code-review-verdict` result binding that native session to the exact repository, PR, head and actual verdict, with verified execution and cleanup. PASS additionally requires no findings or missing evidence. Migration prose, successful worker exit or a review title cannot supply this binding. Each unavailable or mismatched row stays in append-only `historical-review-pending` evidence and grants no approval. Unbound imports from older source are preserved in an invalidation event before clearing their approval key. Missing or invalid migration input never blocks an actual independent review of a current green product change. No new native result or qualification is manufactured. Preserve the packet, pending receipts and all original reports. Product inventory carries the actual PR base; only supported `main` and `QA` bases reach the reviewer, with a fresh PR identity/base check before native review custody is claimed.

A maintenance pass shares one new-review claim counter between factory and product review. The reservation callback consumes the allowance before snapshot fetch or dependency preparation; failed preparation keeps its custody receipt and cannot admit a second review in that pass. Reusing an existing result does not consume a new allowance.

Product refill requires at least one product source path in addition to any tests. Scratch-only, report-only and tests-only proposals cannot become product work. Explicit review/acceptance execution or result tasks are rejected wherever the workflow phrase appears, and source issues labelled `kind:accept` are excluded. Product changes to consent controls, Accept button copy or website-review progress remain eligible.
