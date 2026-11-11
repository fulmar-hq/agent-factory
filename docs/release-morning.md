# Morning release-inputs check

In plain words: every refusal of the 19:00 preflight so far was knowable hours earlier. This job looks at tonight's release inputs at 09:00, 12:00, 16:45 and 17:35 and tells the owning role, once a day per input, while there is still time. It changes no gate, pause, wallet, schedule or freeze.

- `launcher/release-morning.ts` holds the checks and the few effects.
- `scripts/release-morning.ts` runs it once (the LaunchAgent calls this; it can also be run by hand).
- `scripts/install-release-morning.ts` prepares and loads the LaunchAgent `com.agent-factory.release-morning`.

## What it checks

It calls the same `collectReleaseReadiness` the preflight uses, with the same reads the rehearsal makes (no release effect, no wallet observation), and adds:

| Check | Reported as | When it counts as missing |
| --- | --- | --- |
| Everything the preflight checks (AWS sign-in through 22:30, billing, disk, holds, qualifications, usage against the release gate, Quality runner) | the preflight's own input names | every run |
| Quality proof names the installed revision and outlasts 22:30 | `hosted acceptance path` | once the install freeze is active; before that it is only noted |
| `release-batch.json` is dated today | `PR checks` | from 12:00; at 09:00 it is only noted |
| `release-acceptance-ticket.json`, if present, is dated today | `quality qualification` | from 12:00; at 09:00 it is only noted |
| An install freeze covers all of 17:30–22:35 today | `install freeze configuration` | every run |
| No qualification lapses between now and 09:00 tomorrow | `qualification expiry` | every run |

The proof must outlast 22:30, not 21:30, because that is what the installed preflight requires. The acceptance ticket is an optional override: with no ticket file the configured Quality role applies, so only a ticket for another day is a problem. A qualification that has already lapsed is a limit in force and is not reported as "about to lapse".

"Only noted" means the finding is in the report with level `informational`: no mail, no ledger record.

## What it does about a missing input

- **Ledger record.** One `release-input` record per input per day in `health/ledger-inbox/`, in the loop contract's format. Harmless before the ledger job exists.
- **Action mail.** One per input per day to the role `actionRole` in `launcher/loop-contract.ts` names. The owner is exactly what the rehearsal's `gapOwner` gives; a Coordinator-owned input (usage, a pause) acts through Platform. The first reason of the day is the one mailed; later runs repeat nothing.
- **Quality proof request.** When the proof is stale and the install freeze is active, one request per installed revision per day: an action mail to Quality and the guarded owner wake `release-path-proof-request`. If the 17:30 freeze-start job has already asked for that exact revision, nothing more is sent. Before the freeze nothing is requested, because an install would undo the proof and each request starts a Quality session.
- **A step only Vincent can do** (a sign-in). No role mail. One ask row for the noon line, written by the 12:00 run (`loop:ask:release-step:aws-sign-in:<day>`). If it is still open, or first seen, at 16:45, one hard-stop row instead (`loop:hard-stop:human-step:aws-sign-in:<day>`). Also one `human-step-request` ledger record.
- **Report.** Every run stores its report as a `release-morning` event and under `release-morning:<day>:<slot>` in the controller store, and prints it as one JSON line to `release-morning.log`.

A usage stop, a pause or a disk refusal is a limit doing its job. It is reported and counted like any other input; nothing here lifts, shortens or works around it.

## The freeze is report-only

The plan asked this job to write today's freeze when the file was missing. It does not. The freeze file holds one interval and the installed reader has no writer, so writing "today's standard interval" would replace whatever an operator had put there. The standing 17:30–22:35 freeze is now part of the source on main (`launcher/integration-freeze.ts`), so the job only verifies: it asks the installed reader about every five minutes of the window and tells Platform if any is uncovered or the file cannot be read. It works the same with the older reader that knows only the dated file. It never writes, moves, shortens or removes a freeze.

## What it cannot do

- **It cannot make a proof.** Nothing in the factory produces `release-quality-path.json`, `release-batch.json` or `release-acceptance-ticket.json` on its own; an operator session has made each one so far. The request above is a request. `dispatchReleaseQuality` cannot carry it: that function only dispatches the release executor's queued acceptance wake.
- **Role mail may not arrive.** A role with no chat thread is not woken by Alido Mail ("no thread in the Codex map"). The contract test in `tests/release-morning.test.ts` shows this with the mail checkout's own code. Only the proof request also queues an owner wake, and that wake is read-only. The ledger record is what lets a later package age an unanswered input.
- **Before the mail budget is installed**, the noon ask and the 16:45 hard stop are sent as they are written (at most one of each per day).

## Install

After the source is installed in the registered checkout, outside 17:30–22:35 America/Toronto:

```
bun scripts/install-release-morning.ts            # writes the definition into the private directory; loads nothing
bun scripts/install-release-morning.ts --install  # loads it and reads it back
launchctl print gui/$(id -u)/com.agent-factory.release-morning
```

The installer copies the program, working directory and PATH from the loaded `com.agent-factory.release.rehearsal-early` job, never from the shell, and fails unless the loaded job reads back the same. It refuses to load during an install freeze. It keeps any earlier definition and an `undo.txt` under `receipts/release-morning-install-<time>/`.

Undo: `launchctl bootout gui/$(id -u)/com.agent-factory.release-morning`, then move `~/Library/LaunchAgents/com.agent-factory.release-morning.plist` into that receipts folder. Keep the events, mail and ledger inbox records.

## Seen only after install

- On the first full day, every input the 19:00 preflight reports missing was already in the 12:00, 16:45 or 17:35 report. Compare `release-preflight-report:<day>` with `release-morning:<day>:<slot>`.
- On a day with an install after noon, a proof naming the installed revision exists by 18:30.
