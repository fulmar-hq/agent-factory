# Operations

The controller uses Bun's native SQLite in WAL mode, `BEGIN IMMEDIATE` for reservations, and an append-only debit ledger. Its only runtime dependency is Zod. There is no polling model, queue service, container platform or hosted database.

## Policy and evidence

`config.yaml` is read and validated by the controller. Only the explicit owner-run `factory add-project` setup command appends enrollment entries. Schedule is fixed to 20:00 QA and 21:30 Production, America/Toronto; another schedule is refused. Concurrency starts at the configured limit; heavy tests have their own slot. Prefix-overlapping allowed paths conflict. Unsplit work above four helper-hours or spanning backend and screen is refused. Enrollment and owner assignment come from config. GitHub state labels alone cannot supply a bounded brief: Ready also needs the complete `factory` block. GitHub refresh is bounded to 1,000 issues per enrolled repository; hitting that limit blocks that repository's admissions and marks the source truncated. API errors keep old snapshots with a visible source error.

A private `repositories.json` maps enrolled `owner/repo` names to existing local Git checkouts. Every helper gets a new branch and worktree under the private installation. Existing work is not reset or cleaned. The launcher retains stable issue custody even after completion. A new revision, duplicate event, retry or estimate change never resets that claim. Automatic rework is intentionally absent; reconcile custody and authorize a bounded continuation separately.

Private `readings.json` accepts `codex` and `claude` readings with `observedAt` (epoch milliseconds), `source`, and two `windows` of `{used: 0..1, resetsAt: epochMilliseconds}`. Each provider is validated independently. Ticks also read only rate-limit metadata from bounded tails of the five newest local Codex receipts today. A partial native reading is displayed, but fewer than two windows blocks admission. No reset time manufactures a fresh zero. 70% admits only high-benefit work; 90% in either window refuses all starts. Unknown or older-than-15-minute data refuses starts.

`billing` in readings has `observedAt`, `month` (`YYYY-MM` Toronto), `postedCents`, `unpostedCents`, `fixedCents`, `projectedCents` and a source `receipt`. It must be less than 24 hours old. Available AWS money deducts posted gross, unposted, fixed liabilities, reserve and this month's commitments. Projected and actual gates use config. An actual stop is latched until an owner decision clears it. Other wallets default to the configured authority (normally zero); they cannot borrow. Negative, fractional, infinite and racing requests are refused.

Reservations debit the entire authorized worst-case cost immediately and irreversibly. Finished or stopped work does not refund itself. Posted billing may overlap these commitments: this deliberately underestimates remaining money until month end. There is no agent-facing funding or settlement credit. All inputs, debits, custody changes and decisions carry stable IDs or unique decision IDs, timestamps and undo notes. Corrections append evidence.

## Native workers

Codex runs `codex exec --ignore-user-config --json --sandbox workspace-write -m gpt-6.1-sol -c model_reasoning_effort=medium`. Role settings and explicit ticket overrides take precedence when qualification matches. Claude print runs `claude -p --model opus --effort medium --session-id UUID --output-format stream-json --verbose`; the optional background adapter uses `claude --bg --name`. The installed `opus-5.5` role maps to the native `opus` alias. Native IDs and usage come from actual JSON events. Version receipts are refreshed on each tick. CLI subscription status is verified without a model call; API key and third-party route sign-ins are refused. Worker environment is allowlisted and excludes controller tokens, API keys and GitHub token variables.

Codex app threads need foreground `open codex://threads/ID` to wake; background `open -g` is insufficient. That Mac handler does not prove phone access. CLI links, app visibility, mobile steering, actual model and account qualification must be independently verified. `claude agents --json` can verify background custody. Automatic admission uses supervised print mode only; background support is available for qualification, not silently treated as qualified print mode.

`qualifications.json` is protected controller evidence, keyed by provider. Each record requires `qualified`, `subscription`, `policyIsolation`, `liveAccounting`, `stopVerified`, and `phoneVerified` all true, plus `version`, exact configured `model`, `effort`, future `expiresAt` and an `evidence` receipt. No qualification file or synthetic qualification is installed by prepare. Missing evidence blocks launches.

**This installation's same-user filesystem is not an isolation boundary.** A full-access process sharing the controller's user can edit its files. Do not assert `policyIsolation` based on file modes, prompt instructions or these fixtures. Workers need an independently qualified restricted execution boundary that excludes controller state, policy, account credentials and administrative authority. Neither policy identity provisioning nor account migration is performed by this build.

Accounting is monotonic against the original baseline. The supervisor checks elapsed active-process time every 500 ms, conservatively including waits, checkpoints at 1.8x and terminates at 2x. Final native token receipts trigger the independent token gate. **These print adapters do not provide continuous in-turn token receipts**; therefore live token stopping cannot yet be qualified from final receipts alone. Keep `liveAccounting` unqualified until a streaming counter and its stop rehearsal are provided. Termination escalates from SIGTERM to SIGKILL after three seconds; descendant containment must also pass the execution-boundary qualification. Failed or interrupted work remains retained with paused or unknown custody.

## Owner actions and releases

Board writes require the private bearer token plus an exact loopback Origin. DNS-rebound Host values are refused; no CORS or schedule/funding operation exists. Reads are loopback-only. Text from GitHub is rendered as text, never HTML. English and French control labels are included.

`FACTORY_OWNER_TOKEN` authorizes `bun scripts/control.ts pause|resume`, `qa-accepted REV DAY RECEIPT`, `release qa|production REV RECEIPT`, or `clear-aws-stop OWNER-DECISION-RECEIPT`. Do not pass this environment to workers. Pause persists and blocks admissions/promotions; active supervisors stop and retain work. Resume does not replay claims or clear an overrun stop. The board can answer questions and request a ticket stop. The source token, not a caller-supplied role name, authorizes these operations.

Release authorization refuses any other minute, duplicate daily batch, absent QA acceptance, mismatched revision or paused state. Production requires the same day's independently accepted QA revision. This is a local execution guard and evidence record, **not a deployment receipt**. Integrate it with the private project's protected executor before its effects; separate workflow-side time enforcement and AWS OIDC/brakes belong to the infrastructure setup. No product deployment is performed by this repository. Receipts displayed here are not claimed as independently deployed truth without project readback evidence.

## Restart and undo

A stable claim is committed before spawning. An atomic supervisor claim prevents two supervisors from executing it. A crash between commit and spawn can strand a claim; it cannot cause a duplicate start. Reboot preserves pause, native IDs, original estimates, paths, debits and unknown custody. Reconcile the real native session and preserved worktree before any continuation; do not clear claims or refund a wallet to retry.

`prepare` writes absolute-path plists under the private installation; existing files are preserved. It does not bootstrap jobs. After review, install uses `launchctl bootstrap gui/UID PATH`. Undo loaded jobs with `launchctl bootout gui/UID/com.agent-factory.tick` and the corresponding `.board` label. Archive plists and private state rather than deleting them. To undo source changes, make signed revert commits; retain public history. Stop the manually started board with SIGTERM to its process. Archive worktrees only after custody acceptance. Caps and the schedule are never changed by installation or rollback.

Qualification still needs actual live-meter, stop/descendant, isolated-policy and phone steering rehearsals. Tailscale, phone access, Telegram, production workflow enforcement, AWS billing ingestion and external brakes are not installed or represented as passed.

Primary interface references: [Bun SQLite](https://bun.sh/docs/api/sqlite), [Codex non-interactive execution](https://developers.openai.com/codex/noninteractive/), [Claude CLI](https://code.claude.com/docs/en/cli-reference). Installed local help is checked for supported flags; runtime qualification, not vendor documentation, decides admission.


## Project enrollment

`factory add-project <owner/repo> [--dry-run]` (or `bun run factory -- add-project <owner/repo>`) uses the signed-in `gh` account for read-only issue backfill. It preserves comments and unrelated policy bytes, requires a block-style `projects:` mapping, and validates the proposed config before writing. A source error or the 1,000-issue cap refuses enrollment. Existing enabled projects are refused; existing read-only entries refresh without duplication. Empty owners prevent admission on future ticks; this command never runs a tick or worker.

Run setup with one policy writer at a time. Before replacing config it checks for intervening changes, archives the original under private `archive/add-project-UUID/config.yaml`, then records snapshots and an append-only undo event. Config and SQLite are separate files: interruption between writes can leave an enrolled entry without snapshots; repeat the command to recover. Undo by restoring the archived config after checking for later policy edits; retain the archive, snapshots and events. Dry run uses only an in-memory database and writes nothing, including no receipt; save its output privately when evidence is needed. To rehearse actual writes without live enrollment, copy config into a private staging directory and set `FACTORY_PRIVATE_DIR` to that directory.

CI runs on GitHub-hosted Linux for pull requests and main/QA pushes: Bun 1.3.14, frozen install, strict typecheck and tests. Actions are pinned to commit SHAs; permissions are read-only and no secrets or AWS runners are used. `Verify` is the branch-protection check.
