# Lessons register

One row per failure class: what we learned, why, and the check that holds it. Agents are given the rows that match the paths they are about to change, so every row has to earn its bytes.

## Who writes the row

- **The author of the fix writes or updates the row, in the fix pull request.** One class, one row: when the class already has a row, change that row.
- **The one reviewer accepts the row** inside the one review: it says why, and its check is the real one.
- **Quality owns this file and its pruning.** Only Quality removes, merges or rewrites another class's row, in its own reviewed pull request.
- A fix that lives in the product repository gets its row in the product's lessons table, carrying the same class id, and no row here.

## What a row holds

- `id`: the failure class id (lower-case letters, digits and hyphens). Rows are sorted by id, so two fix pull requests do not collide at the end of the file.
- `lesson`: one sentence of at most 200 characters that contains "because": what to do, and why.
- `paths`: the files, folders or `*` patterns it applies to, separated by commas.
- `home`: where the lesson is enforced, strongest first. `regression` (the recorded failure, replayed in CI), `drill`, `test`, `gate` (code that refuses at run time, proven by a test) or `instruction` (only told to agents; the last resort).
- `check`: what holds the lesson. It must point back at the row; a file that merely exists does not count.
  - `regression`: `regressions/<id>`, a folder that is not empty.
  - `drill`: `drills/<id>`, or a test file with the marker.
  - `test`, `gate`: a test file under `tests/` that contains the marker `lesson: <id>`, beside the test that would fail.
  - `instruction`: `reason: <why nothing that runs can hold it>`.
  - an unproven row: `planned: <the check that will hold it>`.
- `status`: `checked` (the check exists and points back) or `unproven` (no recorded failing input, or no check yet). An instruction row is always unproven. At most 5 rows are unproven, and the weekly review lists them. Add ` always` for a hard rule that is never withheld from an agent.
- `model`: `any`, or the model version an instruction row was written for, so it is tested again when the model changes. An instruction row must name one.

## Limits

`tests/lessons-register.test.ts` enforces everything above, with no network and no clock. This file may not pass 16,000 bytes and a row may not pass 600. Adding past the limit fails until something is pruned, and a fix pull request cannot prune. So Quality prunes at 12,000 bytes, which leaves room for at least six more rows: merge rows that one check now holds, drop a row whose class can no longer happen, turn an instruction into a check.

No names, private data, credentials or ticket text in a row.

## Rows

| id | lesson | paths | home | check | status | model |
| --- | --- | --- | --- | --- | --- | --- |
| alarm-sent-once | An alarm that needs an action repeats or escalates, within a cap, until its condition clears, because one text at 12:22 AM was the only signal in an 18-hour stall. | `launcher/alerts.ts`, `launcher/controller-alerts.ts`, `launcher/factory-health*.ts`, `launcher/idle-queue.ts`, `launcher/watchdog.ts` | drill | planned: the weekly alarm drill, where a synthetic tick error must reach a role and escalate | unproven | any |
| coordinator-holds-heartbeat | The Coordinator must not hold the heartbeat: no scheduled duty runs in or waits on a chat, because one unanswered approval card in that chat stopped every duty for 18 hours. | `launcher`, `scripts`, `launchd` | drill | planned: the held-approval-card drill and a structural test that no launcher path waits on the Coordinator | unproven | any |
| disable-not-start-fence | Fence a loaded job with the admission pause and verified quiescence, because launchctl disable did not stop a loaded job from starting. | `launcher/release-install*.ts`, `scripts/install*`, `launchd` | gate | `tests/release-install-quiescence.test.ts` | checked | any |
| expiry-without-warning | Warn well before a sign-in, qualification or proof expires, because an expiry found at preflight leaves no time for the one person who can renew it. | `launcher/release-auth.ts`, `launcher/release-readiness.ts`, `launcher/qualification-evidence.ts`, `launcher/codex-renewal*.ts` | drill | planned: the lead-time rule and its drill, where a qualification 25 hours from expiry must open a class | unproven | any |
| job-path-missing-tool | Verify in the job's real environment (its own PATH, working folder and checkout), because a tool that resolves in your shell can be missing under launchd. | `launcher/release-*.ts`, `launcher/job-environment.ts`, `scripts`, `launchd` | test | `tests/job-environment.test.ts` | checked | any |
| loaded-job-not-rebound | After changing a scheduled job, reload it and read back the loaded program, arguments, folder and PATH, because replacing plist bytes left the old job running from a checkout that drifted. | `launcher/release-install.ts`, `launcher/job-environment.ts`, `scripts/install*`, `launchd` | gate | `tests/release-install.test.ts` | checked | any |
| publisher-macos-abort | On macOS never crash a process on purpose with os.abort() or SIGABRT, because RLIMIT_CORE=0 does not prevent crash dialogs; use SIGTERM locally and keep real abort coverage on Linux. | `*` | gate | `tests/delivery.test.ts` | checked | any |
| ready-label-not-runnable | Count supply by tickets that can actually run, never by a ready label, because six labelled-ready items had no brief or approval and the queue ran dry for hours. | `launcher/intake-context.ts`, `launcher/intake-policy.ts`, `launcher/autonomy.ts`, `scripts/product-top-up.ts` | test | `tests/intake-context.test.ts` | checked | any |
| sign-in-refresh-not-renewal | Judge a sign-in by the original session's expiry across the whole window, because refreshed credentials do not extend the original sign-in. | `launcher/release-auth.ts`, `launcher/release-readiness.ts` | gate | `tests/release-readiness.test.ts` | checked | any |
