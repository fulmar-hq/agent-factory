# Health alarm delivery

In plain words: the health job finds problems well, but for a day its messages did not arrive. Nothing reached the Coordinator at all, and Vincent's were up to a day late behind a queue of stale ones. These are the rules that make a health alarm arrive, and say out loud when one does not.

The rules live in `launcher/factory-health.ts` (what is due) and `launcher/factory-health-runtime.ts` (writing to Alido Mail and reading back). What counts as an incident is unchanged.

## What went wrong

- **The Coordinator leg waited for a state that never comes.** The job counted an fyi as delivered when Alido Mail marked it `woken`. Alido Mail marks a delivered fyi `digested`. So no Coordinator message was ever confirmed, the first one per condition was retried for ever, and everything behind it waited.
- **Strict order plus a two-hour gap.** A message could not go until every earlier message for the same condition had gone, and two openings had to be two hours apart. With 72 short "work" episodes that made a queue a day long, full of news about faults that had already cleared.
- **Nobody was told.** A message that never arrived was written to a table nobody reads.

## The rules now

**Delivered means proven.**

- Vincent: only when Alido Mail holds the Telegram sent time for the row.
- Coordinator: when Alido Mail has marked the fyi `digested`, or the row has been read. This leg is information only. It is never proof that anyone saw the alarm, and it never stands in for Vincent's leg.

**Current state wins.** There is no ordering queue and no waiting period. A message that was never handed to Alido Mail is archived instead of sent once it no longer describes the condition:

| Situation | What happens |
| --- | --- |
| The condition cleared before the opening reached Alido Mail | Opening and recovery are both archived; nothing is written |
| The condition reopened before a recovery was sent | The recovery is archived; the new opening is sent |
| Alido Mail cancelled a routine row, or folded it into another message | Archived; its recovery goes with it |
| The opening is with Alido Mail but not confirmed yet | Its recovery waits for it, and nothing else waits (one exception below: a routine opening the gate is holding) |

Archived means marked `superseded` with a reason. Nothing is deleted. A recovery is only ever sent to someone who received its opening.

A condition that reopens is said again, even minutes later. Another writer's alarm about the same condition (for example the tick's own stall alarm) still stands in for a health opening, as before, unless Alido Mail folded or cancelled it. An earlier health message never does.

**A fault that comes and goes is not hidden.** If a condition opens three times within 60 minutes, the third opening raises one message, "Keeps recurring: …". The current-state rule never archives it. It closes with one "Stopped recurring: …" message when the condition has been clear for 30 minutes, and then the count starts again. These three numbers are our own choice and live in `HEALTH_TIMING`.

While it is open:

| Raised while "keeps recurring" is open | What happens |
| --- | --- |
| An opening that says what the "keeps recurring" message says | Archived as covered by it |
| An opening that says something else (a different fault of the same condition) | Sent once. The same text again is covered by that one |
| A hard stop | Always sent as a hard stop of its own, the first time. The "keeps recurring" message is routine and never stands for a hard stop. A second hard stop is covered by the first only on the same Toronto day; on a later day it is sent again |
| Any recovery | Archived. The "Stopped recurring" message closes them all |

"Covered by" counts only a message that was not itself archived for that recipient. A hard stop that cleared before it was sent covers nothing, so the next one is sent. The "Stopped recurring" message goes to whoever received anything raised while the span was open: the "keeps recurring" message or a hard stop inside it.

**A fault that becomes a hard stop is said as one.** Whether a message is a hard stop is decided when its episode opens. So when an open episode becomes a hard stop (the sign-in that "expires before tonight" then expires; a disk that could not be read turns out to be full; missing tick evidence becomes a failed tick), that episode is closed and a hard-stop episode is opened in the same evaluation. The stored state marks the new episode `continues`. The closed episode's recovery is archived and never sent, because nothing recovered. The change does not count toward "keeps recurring". If the hard stop later weakens and returns inside its own episode, nothing more is sent: he was told and has not been told it ended.

**A message nobody confirmed is a fault of its own.** Ten minutes after a message was first handed to Alido Mail, if it is neither delivered nor archived, the job asks Alido Mail why.

- A routine row for Vincent that the mail gate reports as `held`, `folded` or `cancelled` is the gate doing its job. It is not a failure.
- Anything else is. The reason goes into `health/heartbeat.json` as `alarm` (the shared heartbeat shape, which the off-Mac check carries) and into the job's result line in `health.log` as `deliveryAlarm` and `unconfirmed`.
- A hard stop has no "held" exception, whichever id its row carries. Only a Telegram sent time settles it: its own, or that of the message the gate folded it into. The gate folds a hard stop into one he was already sent that day for the same condition and records which (`owner_gate.into_mail`). When that message has a sent time the hard stop counts as delivered, with a receipt that names it, and its recovery follows as usual. A hard stop that is held, cancelled, or folded into something with no sent time is reported, and is not archived on the gate's say-so while its condition is still open.

The gate's three states are read from the row's `wake_state`. A sender that predates the gate never selects those values, so it cannot send a held row by mistake.

**A held routine opening is cancelled with its recovery.** A recovery normally waits until its opening has been delivered. One exception: when the gate is holding a routine opening and the condition clears, the job writes the recovery row at once, under its own ids. The gate then cancels the pair, so a fault that cleared hours ago is not named in the next fixed-slot line. The job reads the gate's answer back on later runs and archives both. This is never done for a hard stop, or for an opening that borrowed another writer's row.

**Without the mail gate the job spaces its own routine mail.** All limiting of routine mail to Vincent lives in the gate. Each run the job checks that the gate is running: the mail store has the gate's table (`owner_gate`) and the sender's heartbeat beside the store (`sender-heartbeat.json`) is less than 15 minutes old. The answer is `mailGate` in the job's result line and in `health/heartbeat.json`. While it is false, a routine opening for Vincent waits until two hours after the last opening handed over for the same condition (`HEALTH_TIMING.ungatedSpacing`). No queue forms: one that clears while it waits is archived like any other. Hard stops, recoveries, the two "recurring" messages and the Coordinator's leg are never spaced.

**Hard stops carry the contract's id.** Vincent's row for these openings is built by `ownerMessageId` in the loop contract, so the mail gate tiers it from its own table and no field or writer can lower it.

| Health incident | Id |
| --- | --- |
| Disk above its limit | `loop:hard-stop:disk:data-volume:<day>` |
| AWS access has expired | `loop:hard-stop:human-step:aws-sign-in:<day>` |
| Tick failed, or no tick for ten minutes | `loop:hard-stop:factory-down:tick-dead:<day>` |

Unknown evidence, and "AWS access expires before tonight", are not hard stops and keep their ordinary ids. The contract allows one hard-stop id per condition and Toronto day. If the same hard stop opens again later that day, the second opening is written under its own id, `factory-health:<disk, aws or tick>:<n>:<opened>:opening:Vincent`, so that it is not passed over in silence. The mail table lists that id shape as a hard stop too, and the health job treats the row as a hard stop whichever id it carries. `healthHardStopRowIds` returns both ids for an opening, and the cross-repository test sends both through the mail table.

A hard stop never borrows another alarm's row, because that row could be held.

The "Keeps recurring" and "Stopped recurring" rows keep the ids `factory-health:<condition>:recurring:<started>:opening:Vincent` and `…:recovery:Vincent`. They are routine. The mail table does not list them yet, so the gate counts them as an unknown id (`unknownPrefix` in the sender's heartbeat) and treats them as routine "anything else" mail. Adding them to the table is a change in the mail repository.

## Tests

- `tests/factory-health-delivery.contract.test.ts` holds these rules. Its replay block uses the outbox as stored on 11 November 2026 (`tests/data/health-outbox-stored-20261111.json`): 138 messages would have gone at once under the new "due" rule alone; with the archive pass none goes to Vincent. Replaying that day's 72 "work" episodes with delivery working gives Vincent 14 messages (5 openings, 5 recoveries, 2 "keeps recurring", 2 "stopped recurring"), each in the run that raised it. Its last two blocks run Alido Mail's own code on a temporary store: the first needs only the mail checkout, the second needs the gate's code.
- `tests/owner-tier.contract.test.ts` builds every id a hard stop for Vincent can be written under (each contract id, and the opening's own id for each of the health job's three hard stops) and checks that the real mail code gets each one to him with the day's count already spent. Removing a hard-stop kind from the mail table makes it fail.

The mail checkout is a separate repository and is absent in this repository's CI, so the parts that need it are skipped there. A skipped test is not proof. Run both files on the Mac with `FACTORY_REQUIRE_MAIL_SOURCE=1` before install, and again after any change to the mail table. Until the gate is in the installed mail checkout, point `FACTORY_MAIL_SOURCE` at a checkout of the gate's branch. No CI job runs them against the mail repository yet; until one does, the running job's own check above is what catches a hard stop the gate holds.

## Install

Install **after** the mail gate (the daily budget inside Alido Mail's send function) is installed and running, and after every chat's mail server has been restarted onto it with a readback. This is the ordinary reviewed source install. No job is loaded or unloaded.

1. Run `FACTORY_REQUIRE_MAIL_SOURCE=1 bun test tests/factory-health-delivery.contract.test.ts tests/owner-tier.contract.test.ts tests/loop-contract.test.ts` and record the mail revision.
2. Read `autonomy.auto_approval.protected_paths` in the private factory config and record it. Add `launcher/factory-health.ts` and `launcher/factory-health-runtime.ts` (`HEALTH_PROTECTED_PATHS`). Read it back and record it beside the first value.
3. After the next five-minute run, read the last line of `health.log`. It must say `"mailGate":true`; `false` means the job did not find the gate running and is spacing routine mail itself. On the first run `archived` is the size of the backlog (265 on the 11 November outbox) and `health/state.sqlite` has one row in `state_archive`: the state exactly as the old rules left it.
4. Read back Alido Mail: no new row for Vincent about a condition that had already cleared. The Coordinator gets at most one recovery per condition.
5. Run `bun scripts/factory-health-watch.ts --rehearse YYYY-MM-DD` and read both legs back: Vincent's Telegram sent time and the Coordinator's `digested` row.

## Reading the first 24 hours

- Hard stops: every message in the stored outbox with `hardStop: true` is one. For each, Vincent's delivery is either `delivered` (the receipt holds the Telegram sent time; compare it with `createdAt`) or archived with a reason (cleared before it was sent, or covered by a hard stop already raised that day while the condition kept recurring). Any other state after ten minutes is in `unconfirmed` in `health.log`. Count from the outbox, not from `loop:hard-stop:%` rows in Alido Mail: a second hard stop the same day has its opening's own id.
- Routine messages: count the gate's outcome per row in Alido Mail's `owner_gate` (sent, folded, cancelled) for ids starting `factory-health:`.

## Known gaps outside these two files

- `relatedFactoryAlarm` in `launcher/alerts.ts` looks for health rows by the older id only. When the health job's heartbeat is more than ten minutes old and the disk is critical, the tick's own disk blocker no longer sees a health disk hard stop written under the contract id, and writes its own. It also still reads a health opening with no Telegram sent time as "on its way", so another writer can stay quiet behind a row the gate held. Both need a change to that file.

## Undo

Revert the source change. State written under the new rules does not load under the old ones, so also put the archived state back before the next run:

```
sqlite3 health/state.sqlite "UPDATE state SET json=(SELECT json FROM state_archive WHERE id=1) WHERE id=1"
```

That returns the outbox to the moment before the first pass, backlog included; episodes opened since then are lost from the health state, though their mail rows remain. Keep `state_archive`, `delivery_links` and `delivery_failures`. Remove the two paths from `protected_paths` with the same before-and-after record.
