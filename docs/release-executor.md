# Calendar release executor

The fixed America/Toronto windows are 19:00 preflight, 20:00 frozen QA batch and 21:30 Production admission. A separate 30-second reconciliation job observes already-claimed operations. Missed admission minutes refuse; observations never authorize a new late admission. The system timezone must be Toronto because launchd calendars use the system timezone.

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
