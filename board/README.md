# Factory Desk

The board follows Vincent's November 9, 2026 popup reference verbatim: `~/.alido-private/factory/design/factory-desk-mockup-v4-popup.html`. SHA-256 `6f6768ddd905f49acae3e9d1a3b890d49b3955c6c38f975791cc68f156a9c767`. Its complete CSS is the prefix of `style.css`; only CSP progress adapters, local controls and intrinsic Safari sizing are appended. The `.half` wrappers and row/flow/column markup match the reference. The reference's review-only state picker and sample-data footer are omitted. Tablet and desktop details use its 520px centred window from 720px; phones keep its bottom sheet. Escape, scrim and close dismiss, with a focus trap and return.

Earlier references: The approved private reference is `~/.alido-private/factory/design/factory-desk-mockup.html`, SHA-256 `6b232265749aaaae476bb53db9412d852a83fe7b0b1e091fe3294eefe41612b5`. Its tokens, type, section templates, bilingual wording and sheet behavior are ported to static external assets; the mockup state picker is omitted. Queue data initially includes five items; phones show three before expanding. Waiting previews and DOM structure now follow the popup reference, superseding the earlier collapsed-groups and reordered-DOM exceptions. Local authorization controls remain available at `/?controls=1`.

The approved colour follow-up is `~/.alido-private/factory/design/factory-desk-mockup-v3-colours.html`, SHA-256 `cf0c0bbfe6529995a77f44325003a49b78ba441901edb8746bc0f74526ade377`. It supplies the exact light/dark status tokens, dots on the flow and column headings, amber trouble counts, tinted worded pills and the initially collapsed “What the colours mean” legend. No coloured left borders. Green means moving/shipped; blue means waiting on something else; amber needs attention; red means stopped/failed; grey means inactive/closed/skipped/paused. Every colour is paired with words or numeric evidence.

Usage tones use the unrounded weekly fraction and `usage_gates.admit_below` / `stop_at`: below 70% green, 70–90% amber with “High”, at least 90% red with “At limit”. Missing/stale readings remain neutral. AWS spend is green below `wallet.aws.planned_usd` (fallback `hold_at_projected`, normally $60), amber through `board.aws_red_above_usd` (default $65), then red. The separate red “AWS stopped” pill follows the admission latch; its temporary actual-stop threshold never colours the spend bar.

Running bars are green within estimate, amber past estimate or after `board.quiet_after_minutes` (default 15) without a worker-log write. Quiet text says “No activity for N min”; over/quiet/fix counts appear under their flow stage. Comparisons use exact seconds, before display rounding; over-estimate durations round up so their text cannot appear equal to the estimate. Completed bars compare recorded duration with estimate. Unknown duration/estimate stays neutral. Missing log evidence never manufactures activity or a quiet event. These are display policies only; admission, wallet and custody rules are unchanged.

`model.ts` is a read-only projection. Running elapsed time uses session start; activity uses the newest worker-log write. Completion duration uses recorded start and exit times, never issue-update time or a made-up duration. Missing actual timing is shown as a dash and excluded from duration statistics; missing estimates say “no estimate”. Estimates come from ticket intake. Claude reads the same structured native quota receipts as the launcher, preferring newer evidence over cached readings. Missing or stale quota stays a dash. Weekly meters require a fresh seven-day reading, and AWS spend requires actual fresh month-to-date billing. No balance becomes spend or missing reading becomes zero.

`runtime.ts` identifies owner runs only through live native process descriptors attached to a direct `work/*/run-*` folder, with no result file. It reads that run's brief and log metadata, never native transcript contents. Missing process proof omits the run. The role in the brief identifies the owner even under a launcher directory. Titles and one or two description sentences come from concrete actions in the brief. Estimates prefer explicit brief seconds, then the configured `ticket_budget_default.estimate_minutes` also used by owner turns, then the median of the owner’s ten most recent completed run durations. Unknown estimates say “no estimate” and omit their progress target. “View the work” uses an explicit GitHub work link or the retained live brief on the same loopback board.

Question presentations always contain a short title, one-sentence context, choices, default and nullable deadline. `questions.ts` validates the structured JSON contract in the existing question text field. The view-model adapts legacy launcher, browser and overrun rows without changing their custody, authorization or default behavior. Long legacy wording goes under sanitized Technical details. The board change deliberately leaves launcher producers and their shared working-tree edits untouched. A positive overrun answer requests a bounded extension; it does not grant or execute one.

`pulls.ts` shares the launcher’s complete open-PR readback, including closing issue links. The board refreshes it read-only at most once per minute. Issue and PR rows count once; no-longer-open published PRs disappear. Real failures/changes requested need a fix; pending non-release checks are running; approval or a currently pending Release hold waits for tonight; the remainder needs a reviewer. An incomplete/error read retains evidence and never invents passing checks. Counts cover all enrolled projects, not Alido alone.

Run `bun run typecheck` and `bun test` in the repository. Browser acceptance is opt-in:

```sh
bun install --cwd board --frozen-lockfile
BOARD_URL=http://127.0.0.1:4318 \
BOARD_SCREENSHOTS=/path/to/private/run/screenshots \
bun test board/browser.test.js
```

Install Chromium with `bun board/node_modules/playwright/cli.js install chromium --only-shell` if needed; `BOARD_CHROMIUM` can select an existing headless executable. Set `BOARD_MOCKUP` to the approved private HTML for matching reference captures. Acceptance covers 375×812, 768×1024, 1280×800 and 1440×900, both color schemes, French, reference DOM structure, queued rows, responsive waiting previews, focus capture/return, no horizontal overflow, raw JSON/ISO text, or inline CSP violations. Screenshots and operational evidence stay in the private run folder.

Publish a signed scoped commit through the normal GitHub PR checks. After merge, restart the already installed board with `launchctl kickstart -k gui/$(id -u)/com.agent-factory.board`; do not bootstrap a job. Verify with curl using `Host: 127.0.0.1:4318`. Undo with a signed revert and the same restart, retaining private runs and evidence.

Fidelity proof (Chromium and WebKit, light/dark, each requested size):

```sh
BOARD_URL=http://127.0.0.1:4318 \
BOARD_SCREENSHOTS=/path/to/private/run/screenshots \
BOARD_MOCKUP="$HOME/.alido-private/factory/design/factory-desk-mockup-v4-popup.html" \
node board/fidelity.mjs
```

The reference is served as UTF-8 (it has no encoding declaration). Captures include actual-data mockup/live pairs and open details, plus a clearly labelled equal-data fixture to separate layout from changing content. Computed style differences are recorded. Operational captures, paired PNGs, pixel differences and the visible-difference report remain private. Undo: signed revert, merge through checks, restart the existing board job; retain the PR snapshot and run evidence.
