# Morning release-inputs check

In plain words: every refusal of the 19:00 preflight so far was knowable hours earlier. This job looks at tonight's release inputs at 09:00, 12:00, 16:45 and 17:35 and tells the owning role, once a day per input, while there is still time. It changes no gate, pause, wallet, schedule or freeze.

- `launcher/release-morning.ts` holds the checks and the few effects.
- `scripts/release-morning.ts` runs it once (the LaunchAgent calls this; it can also be run by hand).
- `scripts/install-release-morning.ts` prepares and loads the LaunchAgent `com.agent-factory.release-morning`.

## What it checks

It calls the same `collectReleaseReadiness` the preflight uses, with the reads the rehearsal makes but keeping nothing of them (no release effect, no wallet observation, and no `release-billing.json`: the health job uses that file as its billing reading, so this job runs the same trusted Budgets read on a throwaway copy of its two inputs and leaves the file alone), and adds:

| Check | Reported as | When it counts as missing |
| --- | --- | --- |
| Everything the preflight checks (AWS sign-in through 22:30, billing, disk, holds, qualifications, usage against the release gate, Quality runner) | the preflight's own input names | every run |
| Quality proof names the installed revision and outlasts 22:30 | `hosted acceptance path` | once tonight's 17:30–22:35 install freeze is in force; before that it is only noted. An operator's dated hold at another hour is not tonight's freeze |
| `release-batch.json` is dated today | `PR checks` | from 12:00; at 09:00 it is only noted |
| `release-acceptance-ticket.json`, if present, is dated today | `quality qualification` | from 12:00; at 09:00 it is only noted |
| An install freeze covers all of 17:30–22:35 today | `install freeze configuration` | every run |
| No qualification lapses between now and 09:00 tomorrow | `worker environment qualifications` | when a lapsing key has no automatic renewal, or a Codex key's automatic renewal is late (under five hours left); a Codex key still on schedule is only noted |

The proof must outlast 22:30, not 21:30, because that is what the installed preflight requires. The acceptance ticket is an optional override: with no ticket file the configured Quality role applies, so only a ticket for another day is a problem. A qualification that has already lapsed is a limit in force and is not reported as "about to lapse".

"Only noted" means the finding is in the report with level `informational`: no mail, no ledger record.

Three of the preflight's own findings are only noted when they say nothing new:

- **`release holds` while there is no batch for today.** The preflight compares the QA hold's identity with tonight's batch. With no batch it has nothing to compare with and reports "QA hold identity differs" even when the hold is valid and off. That is the missing batch again, so it is one finding and one mail (`PR checks`, to Release, from 12:00). Once the batch exists, a real holds problem (the hold switched on, a changed identity) is mailed as usual. The cost: while there is no batch, a hold that is on or malformed cannot be told apart from this and is not mailed either.
- **`Quality runner` when the reason is "Quality owner is still running".** A session in progress at that minute is not an input anyone can supply hours ahead. The 17:40 rehearsal and the 19:00 preflight judge it when it counts. Every other Quality runner reason is mailed.
- **A Codex qualification that is on schedule.** The tick renews the Codex keys by itself six hours before they lapse, so every one of them always lapses "before 09:00 tomorrow". Mailing that would be a mail a day for a renewal that is working. It is reported at every run and mailed to Platform only once the renewal is an hour late. A key with no automatic renewal is mailed as soon as it is seen.

The qualification input is named `worker environment qualifications` because the contract decides a release input's owner from its name, and renewal is Platform's, not Release's. An explicit row in the contract would be a better home for that than a name.

## What it does about a missing input

- **Ledger record.** One `release-input` record per input per day in `health/ledger-inbox/`, in the loop contract's format. Harmless before the ledger job exists.
- **Action mail.** One per input per day to the role `actionRole` in `launcher/loop-contract.ts` names. The owner is exactly what the rehearsal's `gapOwner` gives; a Coordinator-owned input (usage, a pause) acts through Platform. The first reason of the day is the one mailed; later runs repeat nothing.
- **Quality proof request.** When the proof is stale and tonight's install freeze is in force, one request per installed revision per day: an action mail to Quality and the guarded owner wake `release-path-proof-request`. If the 17:30 freeze-start job has already asked for that exact revision, nothing more is sent. Before the freeze nothing is requested, because an install would undo the proof and each request starts a Quality session.
- **A step only Vincent can do** (the AWS sign-in). No role mail. One ask row for the noon line, written by the 12:00 run (`loop:ask:release-step:aws-sign-in:<day>`). If it is still open, or first seen, at 16:45, one hard-stop row instead (`loop:hard-stop:human-step:aws-sign-in:<day>`). Also one `human-step-request` ledger record. He is asked only while a release can still follow tonight: never while the factory is paused or the AWS stop is latched, and the hard stop needs today's batch to exist (the noon ask does not, because the batch is normally made in the afternoon). Only an input that names the AWS sign-in counts; another input whose error text mentions a password goes to its role.
- **After 18:30 nothing is sent.** Every message names 18:30. A run after that (by hand, or launchd catching up after sleep) still stores its report and ledger records, and sends no mail, proof request, ask or hard stop. The 19:00 preflight has its own message.
- **An input the contract cannot name** is listed under `failures` in the report (the run exits non-zero) and the other inputs are handled as usual.
- **Report.** Every run stores its report as a `release-morning` event and under `release-morning:<day>:<slot>` in the controller store, and prints it as one JSON line to `release-morning.log`.

A usage stop, a pause or a disk refusal is a limit doing its job. It is reported and counted like any other input; nothing here lifts, shortens or works around it.

## The freeze is report-only

The plan asked this job to write today's freeze when the file was missing. It does not. The freeze file holds one interval and the installed reader has no writer, so writing "today's standard interval" would replace whatever an operator had put there. The standing 17:30–22:35 freeze is now part of the source on main (`launcher/integration-freeze.ts`), so the job only verifies: it asks the installed reader about every five minutes of the window and tells Platform if any is uncovered or the file cannot be read. It works the same with the older reader that knows only the dated file. It never writes, moves, shortens or removes a freeze.

## What it cannot do

- **It cannot make a proof.** Nothing in the factory produces `release-quality-path.json`, `release-batch.json` or `release-acceptance-ticket.json` on its own; an operator session has made each one so far. The request above is a request. `dispatchReleaseQuality` cannot carry it: that function only dispatches the release executor's queued acceptance wake.
- **Role mail may not arrive.** A role with no chat thread is not woken by Alido Mail ("no thread in the Codex map"). The contract test in `tests/release-morning.test.ts` shows this with the mail checkout's own code. Only the proof request also queues an owner wake, and that wake is read-only. The ledger record is what lets a later package age an unanswered input.
- **Before the mail budget is installed**, the noon ask and the 16:45 hard stop are sent as they are written (at most one of each per day).
- **It is not in the job-environment audit.** `scripts/check-job-environment.ts` checks the jobs listed in `launcher/job-environment.ts`, and this job is not listed there. Until it is, only the installer's own readback checks its PATH.
- **It keeps the first reason of the day.** One mail and one ledger record per input per day: if an input's reason changes later that day, nothing new is sent.

## Install

After the source is installed in the registered checkout, outside 17:30–22:35 America/Toronto:

```
bun scripts/install-release-morning.ts            # writes the definition into the private directory; loads nothing
bun scripts/install-release-morning.ts --install  # loads it and reads it back
launchctl print gui/$(id -u)/com.agent-factory.release-morning
```

The installer copies the program, working directory and PATH from the loaded `com.agent-factory.release.rehearsal-early` job, never from the shell, and fails unless the loaded job reads back the same. A job that reads back differently is unloaded again and its definition moved into the receipts folder, so nothing is left scheduled. It refuses to load during an install freeze. It keeps any earlier definition and an `undo.txt` under `receipts/release-morning-install-<time>/`.

Undo: `launchctl bootout gui/$(id -u)/com.agent-factory.release-morning`, then move `~/Library/LaunchAgents/com.agent-factory.release-morning.plist` into that receipts folder. Keep the events, mail and ledger inbox records.

## Seen only after install

- On the first full day, every input the 19:00 preflight reports missing was already in the 12:00, 16:45 or 17:35 report. Compare `release-preflight-report:<day>` with `release-morning:<day>:<slot>`.
- On a day with an install after noon, a proof naming the installed revision exists by 18:30.
