# Independent factory alarm

`bun scripts/factory-health-watch.ts` runs every five minutes from launchd,
independently of the tick and all chats. It has no model or AWS call, opens the
controller read-only, keeps its own state in `health/state.sqlite` and
`health/controller-alerts.sqlite`, and delivers through the existing Alido Mail
bridge (Vincent by Telegram, Coordinator by wake). Missing evidence is
actionable unknown, never proof of health.

## What it watches and why

| Condition | Prevents | Pages when |
| --- | --- | --- |
| disk | a full disk corrupting SQLite and stopping every job | Data volume above 85% used |
| tick | the controller silently stopping | no successful tick for over ten minutes |
| controller / pause | an unreadable controller, or a pause nobody owns | controller evidence unavailable; paused by anyone but a verified Vincent pause |
| qualification | builders admitted with an unverified harness | a required qualification is missing, expired, or expires within three hours without live renewal |
| tick failures (controller-alerts) | a tick that keeps failing | the second consecutive failed tick; one failure that the next tick repairs never pages |
| paused with ready work (controller-alerts) | approved work stuck behind a forgotten pause | paused five minutes with ready tasks and no running builder |

Retired on 2026-11-14 with the machinery they guarded: work-supply and idle-queue
alarms (the queue is filled only by people now), nightly release, release AWS
expiry, billing and hold checks.

## Delivery

State is persisted before insertion. Bridge IDs are stable per condition,
incident and destination; retries reuse the same ID. Only the latest transition
of a condition is delivered: a superseded opening or recovery stays as history
and is never drip-fed later. A recovery goes only to a destination that was sent
its opening. Repeated openings, and repeated recoveries, wait two hours after the
previous same-kind delivery. A queued insert is not delivery: Vincent needs a
`telegram_messages` receipt; Coordinator needs a recorded wake.

`bun scripts/factory-health-watch.ts --rehearse YYYY-MM-DD` inserts exactly one
labelled test message to Vincent through the real bridge, with an idempotent ID.

Undo: boot out `com.agent-factory.health`, archive its plist, and install a
reviewed signed revert. Retain health state, controller data and bridge receipts.
