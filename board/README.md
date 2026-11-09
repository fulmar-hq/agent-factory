# Factory Desk

The board follows Vincent's revised November 9, 2026 Factory Desk mockup. The approved private reference is `~/.alido-private/factory/design/factory-desk-mockup.html`, SHA-256 `6b232265749aaaae476bb53db9412d852a83fe7b0b1e091fe3294eefe41612b5`. Its tokens, type, section templates, bilingual wording and sheet behavior are ported to static external assets; the mockup state picker is omitted. Requested differences are five queued rows, collapsed waiting groups, and desktop DOM order matching visual order. Phones retain Running first.

The approved colour follow-up is `~/.alido-private/factory/design/factory-desk-mockup-v3-colours.html`, SHA-256 `cf0c0bbfe6529995a77f44325003a49b78ba441901edb8746bc0f74526ade377`. It supplies the exact light/dark status tokens, dots on the flow and column headings, amber trouble counts, tinted worded pills and the initially collapsed “What the colours mean” legend. No coloured left borders. Green means moving/shipped; blue means waiting on something else; amber needs attention; red means stopped/failed; grey means inactive/closed/skipped/paused. Every colour is paired with words or numeric evidence.

Usage tones use the unrounded weekly fraction and `usage_gates.admit_below` / `stop_at`: below 70% green, 70–90% amber with “High”, at least 90% red with “At limit”. Missing/stale readings remain neutral. AWS spend is green below `wallet.aws.planned_usd` (fallback `hold_at_projected`, normally $60), amber through `board.aws_red_above_usd` (default $65), then red. The separate red “AWS stopped” pill follows the admission latch; its temporary actual-stop threshold never colours the spend bar.

Running bars are green within estimate, amber past estimate or after `board.quiet_after_minutes` (default 15) without a worker-log write. Quiet text says “No activity for N min”; over/quiet/fix counts appear under their flow stage. Comparisons use exact seconds, before display rounding; over-estimate durations round up so their text cannot appear equal to the estimate. Completed bars compare recorded duration with estimate. Unknown duration/estimate stays neutral. Missing log evidence never manufactures activity or a quiet event. These are display policies only; admission, wallet and custody rules are unchanged.

`model.ts` is a read-only projection. Running elapsed time uses session start; activity uses the newest worker-log write. Completion duration uses recorded start and exit times, never issue-update time or a made-up duration. Missing timing is shown as a dash and excluded from duration statistics. Estimates come from ticket intake. Weekly meters require a fresh seven-day reading, and AWS spend requires actual fresh month-to-date billing. No balance becomes spend or missing reading becomes zero.

`runtime.ts` identifies owner runs only through live native process descriptors attached to a direct `work/*/run-*` folder, with no result file. It reads that run's brief and log metadata, never native transcript contents. Missing process proof omits the run. Owner estimates remain unknown unless the brief records one.

Question presentations always contain a short title, one-sentence context, choices, default and nullable deadline. `questions.ts` validates the structured JSON contract in the existing question text field. The view-model adapts legacy launcher, browser and overrun rows without changing their custody, authorization or default behavior. Long legacy wording goes under sanitized Technical details. The board change deliberately leaves launcher producers and their shared working-tree edits untouched. A positive overrun answer requests a bounded extension; it does not grant or execute one.

Run `bun run typecheck` and `bun test` in the repository. Browser acceptance is opt-in:

```sh
bun install --cwd board --frozen-lockfile
BOARD_URL=http://127.0.0.1:4318 \
BOARD_SCREENSHOTS=/path/to/private/run/screenshots \
bun test board/browser.test.js
```

Install Chromium with `bun board/node_modules/playwright/cli.js install chromium --only-shell` if needed; `BOARD_CHROMIUM` can select an existing headless executable. Set `BOARD_MOCKUP` to the approved private HTML for matching reference captures. Acceptance covers 375×812, 820×1000 and 1440×900, both color schemes, French, DOM column order, five queued rows, collapsed waiting, focus capture/return, no horizontal overflow, raw JSON/ISO text, or inline CSP violations. Screenshots and operational evidence stay in the private run folder.

Publish a signed scoped commit through the normal GitHub PR checks. After merge, restart the already installed board with `launchctl kickstart -k gui/$(id -u)/com.agent-factory.board`; do not bootstrap a job. Verify with curl using `Host: 127.0.0.1:4318`. Undo with a signed revert and the same restart, retaining private runs and evidence.
