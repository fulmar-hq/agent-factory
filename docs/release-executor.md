# Calendar release executor

The fixed America/Toronto windows are 19:00 preflight, 20:00 frozen QA batch and 21:30 Production admission. A separate 30-second reconciliation job observes already-claimed operations. Missed admission minutes refuse; observations never authorize a new late admission. The system timezone must be Toronto because launchd calendars use the system timezone.

## Frozen source batch

The private current-day `release-batch.json` binds the existing QA base, signed
carrier head/tree/PR, supported OFF hold, ordered exact source heads, overlap
groups and independent composition review. The carrier's PR body binds the
strict manifest's SHA-256. Assemble it in an isolated Alido worktree, preserve
source history there, resolve overlaps in the recorded order, and pass the
normal exact-head Verify, Secret scan and Release hold checks. Failed or pending
heads are explicit exclusions. A green individual source is not proof that the
combined carrier works.

At20:00 the trusted executor rereads the current carrier, base, tree, checks,
holds and promotion inventory, then requests one protected expected-head squash.
The GitHub-signed squash must have the expected base parent and the exact
reviewed carrier tree. Its actual new QA revision becomes the sole Quality and
Production candidate. The original source PRs are not falsely recorded as
individually merged: their histories remain retained and any supersession must
cite the delivered carrier. Unknown merge outcomes retain the original claim;
there is no rebase, changed-head substitution, blind retry or catch-up.

After that admitted merge, freeze, light-push completion, pinned full suite,
candidate and hosted QA deployment may finish before21:20. A failed initial push
is terminal; the scheduled full-batch pass is not a retry of failed tests. Main
scheduled verification is read-only with respect to releases and is not a release
overlap. Queued/active QA or Main push CI, deployments, remote release operations
and open promotions remain overlaps. Inventories are scoped to those workflows
and events so unrelated PR queues cannot crowd out release evidence.

## Readiness and alerting

The19:00 check independently collects a new gross Budgets reading, the original
AWS password/MFA-session provenance valid beyond22:30, configured Release/Quality
qualifications and fresh native usage, Quality process custody, Data-volume
capacity (60GiB free; the existing80% signal remains advisory), supported OFF hold and release-board labels, and the exact
carrier's base/head/tree/current required checks. Billing is read even while
pause or STOP independently prevents dispatch. Access-token refresh expiry never
extends the original authentication session.

If Claude has no fresh structured quota receipt, the explicit preflight reads
the built-in `/usage` screen with tools and customizations disabled. It submits
only that local command, requires a complete native quota panel and zero model
tokens, and stops its own bounded CLI process group. Every exposed quota window
is retained. Unknown UI, trust or authentication prompts supply no evidence;
the reader never answers them. This is not a qualification renewal or a per-tick
model session.

A CLI qualification does not establish hosted acceptance. Private
`release-quality-path.json` must contain genuine evidence of hosted browser
access and trusted receipt ingestion for the configured Quality harness/model/
effort on this exact factory source through22:30. Missing evidence refuses;
fixtures, CI success and deployment health cannot manufacture that receipt.

Every missing input is retained in one readiness report. An admitted19:00 check
queues one plain blocker through the existing Alido Mail outbox only when inputs
are missing. A healthy check is silent. Slow reads may complete that alert
before19:50, but a fresh late invocation cannot claim the preflight. Configuration
errors also enter this path. Rehearsals never invoke the alert. Failed outbox
access remains a recorded delivery failure rather than a claimed notification.

`scripts/install-release.ts` prepares four private plists. `--install` installs and verifies them after review and explicit owner authorization. Existing definitions are archived before replacement. There is no RunAtLoad catch-up. Every external admission checks the current clock after asynchronous reads, the actual QA SHA/tree, overlap inventory, supported hold identity, factory pause and AWS wallet. Each paid operation reserves a conservative dollar atomically with its stable day/step claim. No cap, billing evidence or qualification is manufactured.

Claims are written to SQLite before dispatch. A lost response leaves uncertain custody and is never retried automatically. Successful operations carry their native handle and evidence; failures/deadlines produce durable refusal receipts and one Release diagnosis event. Reconciliation and duplicate calendar invocations retain the original claims. The trusted GitHub adapter never falls back to workstation AWS SSO or changes protection rules.

QA success emits the stable `qa-deployed` event for the frozen revision, tree and immutable artifact. The ordinary launcher dispatches independent Quality. Quality receives the trusted evidence packet in its private scratch and writes a strict structured ACCEPT or REJECT. The launcher records it only after verified native identity/model/effort, successful completion and descendant cleanup. Missing hosted evidence requires REJECT. A receipt must match the current day's exact revision/tree/artifact, arrive after QA verification and before 21:20. A missing, late, rejected or mismatched receipt refuses Production. Protected promotion may create a different main commit; its tree must equal accepted QA. Readback retains source, health, configuration and stopped rollback evidence.

`bun scripts/release.ts dry-run` reads actual remote state and wallet without deployment effects. `bun scripts/rehearse-release.ts` uses an isolated fictional port and separate SQLite files. Each transition runs in a fresh process. It proves duplicate/restart behavior, two synthetic happy paths, failed-check refusal, late-window refusal and uncertain-dispatch retention with zero model calls. It does not prove two consecutive live nights, current IAM permissions or hosted feature acceptance.

Operational receipts and installation/readback logs remain under the private factory root. Undo by booting out the four release jobs and archiving their installed plists, then signing a source revert after reconciling every claimed effect. Retain databases, debits, handles, logs, workspaces and rollback assets; never reset claims or restore an older DB over subsequent work.

## Billing readiness

The trusted release process reads the existing gross AWS Budgets meter with
`DescribeBudget` before each admission. The private `release-billing-source.json`
contains only `{profile, accountId, budgetName}` for the owner's existing read
path. No Cost Explorer query, sign-in, model call or resource start is performed.
The existing reconciler also attempts this read every five minutes from18:00 to
18:59 Toronto, including while paused. A failed read retains the prior receipt
but cannot use it for admission. Missing input files no longer strand preflight;
AWS's actual LastUpdatedTime, gross cost flags, month, currency and configured
ceiling must still validate. Truly stale or unavailable AWS evidence refuses.
A local SSO profile requires an original session valid through the whole window;
this change does not renew it or claim indefinite unattended authentication.

Receipts are atomically written to private `release-billing.json`; existing
provider readings are preserved. Every admission reads the source anew, so a
cached low reading cannot hide newer costs or policy changes. Preview does not
observe billing or clear/latch a stop; scheduled execution retains normal stop
observation. Pre-window refresh is evidence preparation, never catch-up release.

Where private policy explicitly selects the current-month native gross-cost
rule, release admission counts gross actual, the reviewed remaining retained
cost (including the entire current UTC day), lag, private outstanding
reservations, every ledger commitment and the proposed operation. Each component
rounds upward, and equality with the ceiling refuses. The legacy allocation
reserve is not added again to that complete native envelope. Unknown policy uses
the old conservative calculation; expired/mismatched reviewed obligations refuse.
Actual-spend and projection stops, the persistent latch and conservative one-dollar
per-effect atomic debits remain. Expired dated admissions are never reused.

Deliver through a signed PR, independent challenge and green required checks.
Then fast-forward the clean pinned release checkout to the delivered revision;
changing only another checkout does not activate the scheduled jobs. Retain the
before/after revisions and undo via a signed revert. Do not load launchd or run a
release while installing source. Platform owns resuming a disk-paused launcher.

## Plain nightly result

The existing observer calls `releaseWindowResult` after reconciliation, including
its failure path, from22:00 Toronto onward. It queues one result per day in the
existing Alido Mail Telegram outbox whether the release shipped or was refused.
Before22:00 it performs no result observation or messaging. Rehearsals and
`dry-run` do not call it. The19:00 missing-input alert remains separate and quiet
on success.

“Shipped” requires the successful QA operation, matching independent ACCEPT,
protected promotion and successful Production readback for the same accepted
revision/tree/artifact. Unconfirmed effects report not shipped and retain their
custody. QA server status comes from fresh exact-target EC2 and RDS description
reads supplied by the private installation. It says stopped only when both
reads say `stopped`; missing, stale, failed, stopping or running observations
cannot become stopped evidence. The observer never starts/stops resources or
renews credentials. Resource cleanup remains the release owner's responsibility.

The stable daily outbox ID survives a crash between the bridge insert and the
controller receipt. Missing bridge access throws without recording delivery;
the next observer retries. Queued is not delivered: the normal bridge owns
Telegram delivery. Keep the private observations, result and outbox receipts;
undo with a signed revert after reconciling custody, without deleting history.

## Independent acceptance ticket

The explicit private `release-acceptance-ticket.json` can select the qualified
Codex provider/model/effort for one day's Quality acceptance under the existing
`model_override: per_ticket_wins_then_per_role` policy. It never changes permanent
owners. The strict ticket names repository1192, Quality, day, expiry, source
authority and excluded writer/helper native IDs. Readiness and the actual owner
run resolve the same ticket. Native qualification must cover the deadline;
subscription route, usage, pause and unchanged ticket are rechecked just before
the new independent session starts. The accepting native may not reuse Release
or helper custody. Normal native identity/model/effort and descendant-cleanup
verification precede receipt ingestion.

The trusted launcher fetches a bounded synthetic HTTP packet through the existing
QA SSM route before starting Quality. It verifies exact deployed source/digest,
web health, worker running, stopped rollback, dedicated synthetic fixture
membership, authenticated workspace/preferences and screen responses, unsigned
and cross-tenant denial, then expires the retained short session and closes the
database. Tokens and response bodies remain on the host. Public HTTPS redirects
prove reachability only. This path does not claim browser, keyboard or feature
interaction coverage. Quality must state missing required checks honestly. A
failed or absent affirmative hosted packet cannot become ACCEPT, even if the
model writes it. No dry-run invokes the collector or starts an AWS resource.

`release-quality-path.json` records actual hosted HTTP and native receipt-ingestion
proof (`hostedHttp:true`, `receiptIngestion:true`) for the installed factory
revision and effective profile through the full release margin. CLI qualification
alone cannot create that proof. Rehearsal records remain isolated from the live
night's acceptance and immutable claims.

## Cold Production readiness

The21:30 promotion admission remains fixed. After its PR checks pass, the trusted
local executor waits within the existing22:00 deadline for exact Production
metadata: the existing read-only `fulmar-production` profile must identify the
Production account, its named EC2 instance must be running, its named RDS
instance available, and that EC2 instance's SSM agent Online. Only then may the
protected main merge trigger normal CI/deployment. Pending recovery keeps the
same admitted effect; it never starts a late second promotion or extends the
deadline. Read errors or mismatched identities refuse.

These checks start no resources, issue no SSM command, renew no sign-in and
supply no alternative deployment credentials. Native metadata observations are
retained in the private effect journal and promotion receipt. They prove
readiness only; the normal OIDC deployment, source/health/configuration/rollback
verification and independent Production readback remain required.

The native receipt's evidence may be one nonempty string or an explicit array of
nonempty finding strings. The trusted schema preserves every array entry as
newline-separated wire text, retains the input digest and leaves the native raw
file untouched. It never changes the tuple or verdict; empty, mixed or object
findings and extra keys refuse. This representation repair does not rerun a
model or replace a rejected decision.


## Dedicated acceptance custody

The single hosted acceptance task uses `owner-runtime:quality-acceptance`,
separate from ordinary permanent Quality mail/review turns. Dispatch, native
identity/PID updates and cleanup use that same key. A live or unresolved
acceptance runtime retains the pinned wake until its deadline; ordinary Quality
custody cannot consume it. Per-ticket override readiness checks this dedicated
workspace; legacy readiness without an override retains the permanent-role
check. No permanent owner configuration, model qualification, budget, worker
capacity or independence rule changes. Register the existing read-only acceptance
workspace through the trusted setup before the release; this source change
starts no native/model work and does not replay any existing acceptance.

Release job installation uses the canonical factory checkout registered in private
`repositories.json`, rather than the worktree running the installer. It requires
clean factory main and the expected origin. Scheduled PATH includes the operator's
`bin`, the actual Bun directory and standard Homebrew/system directories; required
local executables are resolved before replacement. Replacing an idle loaded job
explicitly boots it out and bootstraps the archived/reviewed definition, then reads
back its actual source and PATH. An active job refuses replacement. This changes
no release admission minute and performs no catch-up release.

Billing and final QA-server reads check the existing original-password/MFA sign-in
receipt before invoking AWS. An expired/missing receipt causes a local refusal;
subsequent observers reread local provenance while waiting for the owner and never
try SSO or loop on the AWS CLI. A real owner renewal can restore that read path.

Installation retains one exclusive private `release-install-active` claim for the
whole operation (including preparation); completed claims are archived and a
crashed claim requires identity reconciliation, never timeout stealing. Before
its final idle read it disables future scheduled starts and verifies the launchd
disabled-state interlock. Already-running jobs retain custody and the original
enabled state is restored. Only an interlocked idle job is booted out; the new
reviewed definition is copied before enabling/bootstrap restores its fixed
schedule. A preexisting disabled hold is preserved and refuses replacement.
