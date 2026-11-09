# Factory at a glance

Vincent opens this on his phone for ten seconds. The page answers, in order:
is it working, does it need me, what is happening, and what finished?
Independent styling: quiet system type, generous space, whole-row tints and no
accent borders. Existing static assets only; no framework, external assets or
inline scripts/styles. Light and dark follow the device.

## Layout

One reading column, 960px maximum, with 20px gutters at 375px. At 1440px the
same hierarchy stays intact; rows have room for secondary information.

```
Factory                                      English / Français
Working — 4 tasks running, 9 in the queue
Codex weekly 18% · Claude unavailable · AWS $12 / $75 · Next QA 8 PM

Needs you
  Question in words
  If you don't answer by 11:15 AM: not approved
  [None: Nothing needs you.]
Running now                                           4
  Task title                               ›
  Product · started 23 min ago
  ━━━━━━━──────── 23 of 30 min
Up next                                               9
  Task title                               ›
  [At most ten rows, then +N more]
Waiting
  Task title · waiting for review           ›
Done · last 48 h
  Task title · closed · 10 min ago          ›
Releases · tonight, Toronto time
  QA              8:00 PM        Scheduled
  Production      9:30 PM        Skipped: AWS stopped
```

Paused says “Paused by you”. Idle includes elapsed time since the last active
work; prolonged idle with queued work says “needs attention”. Unknown/stale
controller or usage evidence is stated plainly, never portrayed as success.
Empty sections have one quiet sentence. Fetch failures retain the last view
with a visible stale-data notice and retry automatically.
Waiting and Done initially show six rows each, with an explicit “Show all”
button and total count; this keeps Releases reachable on a busy phone view.

## Meaning and retention

One task appears once, with the latest attempt's evidence. Running is actual
starting/running work, never retained failed or archived custody. Up next uses
the launcher's approved-intake and retained-claim gates in reconciliation order;
it is a queue, not a promise that resource gates have passed. Waiting names
checks, review, release, a stopped task or investigation. Archived attempts and
closed tasks older than 48 hours are hidden. Closed time comes from GitHub,
not the last edit time. Every existing launcher tick rereads all-state GitHub
issues, including closures. No operational record is deleted.

Only unanswered, unresolved Vincent questions appear. Each shows its recorded
deadline/default; where no deadline exists, say so. A budget extension defaults
to keeping the task stopped, not automatic approval. Owner/resolved questions
stay out of the main view. Deployment wording requires explicit per-task
deployment evidence; a finished worker or release authorization is not proof
that a feature shipped. Without that evidence use “closed” or “waiting”.

## Details and access

Tap any task/question/release to open a labelled modal sheet. Show its purpose,
owner, time and tokens in human units, validated GitHub issue/PR links and the
saved native session ID as a selectable/copyable “Open session” value. Missing
evidence says unavailable. Raw evidence lives only under “Technical details”.
Escape, a visible close button, focus containment and return focus support
keyboard and screen readers. Minimum targets are 44px; text contrast meets AA,
focus is visible, progress has a text equivalent, zoom/reflow and reduced motion
work, and EN/FR translate all interface and generated state copy. Task titles
and recorded user-authored purposes retain their source language.

The loopback Host guard, Access front door and token plus exact-Origin POST
checks remain unchanged. Owner token, Pause and action forms are available only
at the exact local address; the remote page is read-only. No token is embedded
in source or URLs. Undo with a signed revert and board restart; retain SQLite,
question resolutions, claims, debits, release receipts and private assets.
