# Off-machine heartbeat ("dead man")

In plain words: everything that watches the factory runs on the same Mac as the factory. When the Mac is off, full or cut off, every watcher stops together and nobody is told. This adds one check that runs on GitHub instead. The Mac says "still here, and here is how my watchers are doing" every 15 minutes. GitHub looks every 30 minutes and raises a notice when that stops, or when one of the watchers says it is in trouble. It is the "factory down" hard stop, and the only alarm path that still works when the Mac's own Telegram sender is the broken part.

- `scripts/push-heartbeat.ts push` runs on the Mac (LaunchAgent `com.agent-factory.heartbeat-push`).
- `scripts/push-heartbeat.ts check` runs on a GitHub runner (`.github/workflows/dead-man.yml`).
- `scripts/install-heartbeat.ts` prepares and loads the LaunchAgent.

No AWS resource is used. No agent handles a secret.

## What the Mac sends

Every 15 minutes (minutes 4, 19, 34, 49) the pusher writes one repository Actions variable, `FACTORY_HEARTBEAT`. A variable is not a commit and not a branch, so `main` and the installed version never move. The write goes through the launcher's existing GitHub budget and backoff (`gh api`). When GitHub is in backoff or cannot be reached the pusher skips without an error; the variable then goes stale, which is exactly what the check looks for.

The value holds the pusher's own time and one entry per watched job:

| Watched | Read from | What is sent |
| --- | --- | --- |
| the tick | `last-successful-heartbeat` in `controller.sqlite` (read-only, closed before any GitHub work) | time of the last successful tick |
| the health job | `health/heartbeat.json` | time, how far behind, whether it carries an alarm reason |
| the ledger job | `health/ledger-heartbeat.json` | the same |
| the Telegram sender | `sender-heartbeat.json` beside the mail store | the same; "how far behind" is read as the age of its oldest unsent hard stop |

Each file is optional. One that is not there is sent as `missing`; one that cannot be read is sent as `unreadable`. Neither is ever sent as healthy.

**Only times, counts and fixed words leave the Mac.** This repository is public, and a workflow run prints the values it is given, so the variable has to be treated as public. An alarm's own words stay in the heartbeat file on the Mac; the value says only that there is one.

A limit doing its job (a pause, a usage stop, a refused disk admission) does not make the tick's last success old, so it does not raise this alarm.

## What GitHub checks

Every 30 minutes (minutes 13 and 43) the workflow reads the variable and judges it. A check is **bad** when any of these is true:

- the pusher's own time is more than 45 minutes old, or nothing was ever pushed: "no heartbeat from the Mac (Mac down, or its GitHub access blocked)". An old value is not used to judge the jobs.
- a watched job's time is more than 45 minutes old;
- a watched job carries an alarm reason;
- the Telegram sender has held a hard stop unsent for more than 15 minutes;
- a watched job's heartbeat cannot be read, or is dated in the future;
- a watched job that reported before is now missing.

A job that has never reported (today: the ledger job and the sender, until they are installed) is listed as "not reporting yet". It is not judged and not shown as healthy. From its first report on, it is watched.

A problem **opens** after two bad checks in a row and **recovers** after two clean checks in a row. So one late push or one slow run is ridden out, and a value that flips between good and bad on every check never opens anything. Two checks less than 10 minutes apart count as one look, so a run started by hand right after a scheduled one can neither open nor clear a problem.

**Something else goes wrong while a problem is open.** One open problem covers the Mac and all four jobs, so a small alarm that has been open since the morning must not hide a Mac that dies in the afternoon. The check remembers what its notices have already named in this problem: the Mac's push, the pushed value, or one of the four jobs. Anything not yet named is named in one more notice, after two bad checks in a row for it, the same rule as an opening. Each is named at most once per problem, so a job that keeps flipping inside an open problem adds nothing. A dead Mac behind an open alarm is therefore said in the same 75 to 105 minutes as a dead Mac on a quiet day.

**A problem that comes back.** A problem that opens within 24 hours of a recovery gets its notice, which says it is back. From then on it counts as recovered only after 12 clean checks in a row (six hours on the 30-minute schedule), not two. So a fault that comes and goes every hour or two gives two openings and one recovery, and after that only the daily reminder, not an opening and a recovery every two hours. The most any fault can produce is five openings in 24 hours, and that needs a fault that stays clean for six hours each time before it comes back. While such a problem is held open the owner has been told it is open and has not been told it recovered; the issue text shows how many clean checks it has.

**How long it takes.** With checks on time, a Mac that stops is noticed 75 to 105 minutes after its last push. GitHub often starts scheduled runs late, which adds to that. This is a coarse backstop, not a pager. A stop that ends just under the 105 minutes can go unnoticed.

## The notice

The check keeps one standing issue. It rewrites the issue's text on every run (status, last check, one row per watched job), and its own memory lives in a hidden line at the bottom of that text. Editing an issue's text notifies nobody.

It adds exactly one comment naming the owner when a problem opens, and one when it recovers. In between it comments only for the two cases above: once for each further thing that goes wrong, and once a day while the problem stays open, at the first check from 09:00 Toronto time. The daily repeat is the rule planned for the Mac's own hard stops too.

- Without the Telegram secret, each of those comments mentions the owner's GitHub login, so GitHub notifies him. Whether that reaches him depends on his own GitHub notification settings.
- With the Telegram secret, the workflow sends one plain line from GitHub for each of those comments except the recovery. The comment is still written, without the mention. If Telegram cannot send, the mention is used instead. The recovery is a comment only.

A notice is saved before it is sent. If a run dies in between, the next run sends it first. The cost is that a notice can, rarely, be repeated; it is never lost.

The issue and its comments are public, like the rest of this repository. They say which job, how old, and that an alarm exists. They never carry an alarm's own words.

## Install

Operator steps, outside 17:30 to 22:35 Toronto time. Nothing here is done by merging.

1. Install the merged source the usual reviewed way.
2. Create the standing issue and the drill issue. The body must contain the marker line, or the check refuses to write to the issue.

   ```
   gh issue create --repo fulmar-hq/agent-factory --title "Factory heartbeat (off-machine check)" --body "<!-- factory-heartbeat-state -->"
   gh issue create --repo fulmar-hq/agent-factory --title "Factory heartbeat drill" --body "<!-- factory-heartbeat-state -->"
   ```

3. Store the owner's GitHub login: `gh variable set FACTORY_HEARTBEAT_OWNER --repo fulmar-hq/agent-factory --body "<login>"`.
4. Prepare the job and read the plist it wrote: `bun scripts/install-heartbeat.ts`. This loads nothing.
5. Load it: `bun scripts/install-heartbeat.ts --install`. It refuses inside 17:30 to 22:35, during an install freeze, without `gh` on the scheduled PATH, or when the registered checkout has no pusher. It archives any earlier plist, loads the job, reads back what launchd actually holds, and writes two "proof owed" records for the ledger (the drills, due in 3 days; the Actions minutes, due in 7).
6. Read back the first push (the job runs once when loaded): `gh variable get FACTORY_HEARTBEAT --repo fulmar-hq/agent-factory`, and the last line of `heartbeat-push.log` in the private factory folder. The pusher creates the variable on its first run. The Mac's `gh` sign-in needs the classic `repo` scope for that; it had it when this was written (11 November).
7. Only now turn the check on: `gh variable set FACTORY_HEARTBEAT_ISSUE --repo fulmar-hq/agent-factory --body "<standing issue number>"`. Until this variable exists the scheduled job is skipped and costs nothing. Setting it before the first push would start the count towards a false "no heartbeat" notice.
8. Add `scripts/push-heartbeat.ts` and `scripts/install-heartbeat.ts` to `autonomy.auto_approval.protected_paths` in the private factory config, recording the value before and after. `.github/` is already protected. These files judge the factory, so no automatic-lane change may edit them.
9. Optional, and Vincent's own step: in the repository's Settings, under Secrets and variables, Actions, add the secret `FACTORY_HEARTBEAT_TELEGRAM` with the value `<chat id> <bot token>` (one space between them). No agent reads, writes or is shown this value.
10. Run the drills below.

The new job is not in `scripts/check-job-environment.ts`'s list of scheduled jobs; the installer does its own PATH check and loaded-job readback instead.

**Undo.** `launchctl bootout gui/$(id -u)/com.agent-factory.heartbeat-push`, then move its plist from `~/Library/LaunchAgents` into the install's archive folder (the path is in `undo.txt` there). To stop the check as well, delete the `FACTORY_HEARTBEAT_ISSUE` variable, or run `gh workflow disable dead-man.yml`. Keep the issues; close them if the check is retired.

## Drills

A drill uses its own variable, `FACTORY_HEARTBEAT_DRILL`, and the drill issue. Those are the only two variable names the pusher, the check and the workflow accept: the check's own settings (`FACTORY_HEARTBEAT_ISSUE`, `FACTORY_HEARTBEAT_OWNER`) start with the same words, and a heartbeat written over one of them would switch the watch off. A drill never touches the real tick, the real variable or the standing issue, and it can notify nobody: the check only mentions the owner or uses Telegram when it writes to the standing issue, the standing issue only accepts the real variable, and the pusher refuses to write the real variable from a drill folder. Run drills outside 17:30 to 22:35.

Set these up once, in a shell in the installed checkout:

```
R=fulmar-hq/agent-factory; DRILL_ISSUE=<drill issue number>
tick()   { sqlite3 "$D/factory/controller.sqlite" "update kv set value=json_object('at',(strftime('%s','now')-$1*60)*1000,'status','ok') where key='last-successful-heartbeat';"; }
sender() { echo "{\"at\": $(($(date +%s)*1000))$1}" > "$D/mail/sender-heartbeat.json"; }
ledger() { echo "{\"at\": $(($(date +%s)*1000))$1}" > "$D/factory/health/ledger-heartbeat.json"; }
push()   { bun scripts/push-heartbeat.ts push --repo "$R" --variable FACTORY_HEARTBEAT_DRILL --dir "$D/factory" --mail-dir "$D/mail"; }
check()  { gh workflow run dead-man.yml --repo "$R" -f variable=FACTORY_HEARTBEAT_DRILL -f issue="$DRILL_ISSUE"; }
reset()  {
  D=$(mktemp -d); mkdir -p "$D/factory/health" "$D/mail"
  sqlite3 "$D/factory/controller.sqlite" "create table kv(key text primary key,value text not null); insert into kv values('last-successful-heartbeat','{}');"
  tick 0
  gh issue edit "$DRILL_ISSUE" --repo "$R" --body "<!-- factory-heartbeat-state -->"
}
```

- `tick 0` makes the drill's tick current; `tick 60` makes it an hour old.
- `sender` and `ledger` write that job's heartbeat file with the current time. Their one argument adds a field, for example `sender ', "behindMs": 1500000'`.
- `reset` gives a new, empty drill folder with a current tick and no sender or ledger file, and wipes the drill issue's memory. **Every drill starts with it.** The check remembers an open problem, which jobs have reported, and when it last recovered. Without a reset a drill inherits all three from the one before: a problem that is already open gets no opening comment, a file left in the folder goes stale, a file deleted reads as "stopped writing", and anything within 24 hours of the last recovery is treated as a problem that came back. Let the last check finish before a reset.
- A **round** is: write the files the drill names (so their times are current), then `push; check`, then wait 15 minutes. Two checks less than 10 minutes apart count as one. Each `push` goes through the real GitHub budget.

1. **Stale tick.** `reset`. Two rounds of `tick 60; push; check`. Expected: one comment on the drill issue after the second check, naming the tick. Then two rounds of `tick 0; push; check`: one recovery comment.
2. **Held hard stop.** `reset`. Two rounds of `tick 0; sender ', "behindMs": 1500000'; push; check`. Expected: one comment naming the Telegram sender and 25 minutes. Then two rounds of `tick 0; sender; push; check` (the file stays, with a current time and no `behindMs`): one recovery comment.
3. **Ledger alarm.** `reset`. Two rounds of `tick 0; ledger ', "alarm": "canary words"'; push; check`. Expected: one comment naming the ledger job. The words "canary words" must not appear in the variable, the issue or the run log. Then two rounds of `tick 0; ledger; push; check` (the file stays, current and without the alarm): one recovery comment.
4. **Pusher stopped for 100 minutes.** `reset`. `push` once at a time T and then do not push. `check` at T+50 and T+80. Expected: one comment at T+80, "no heartbeat from the Mac for 80 minutes". At T+100 `tick 0; push`, then `check` at T+105 and T+120. Expected: one recovery comment.
5. **Flapping.** `reset`. Six rounds, alternating `tick 60; push; check` and `tick 0; push; check`. Expected: no comment at all, and the issue text reads "watching" after each bad round.
6. **A worse problem behind an open one.** `reset`. Two rounds of `tick 0; ledger ', "alarm": "canary words"'; push; check`: one comment naming the ledger job, as in drill 3. Then do not push. `check` 50 and 80 minutes after the last push. Expected: a second comment after the second of those checks, "Another problem", naming "no heartbeat from the Mac for 80 minutes". Then two rounds of `tick 0; ledger; push; check`: one recovery comment.
7. **A problem that comes back.** `reset`. Drill 1 in full, without another reset: one comment and one recovery. Then two rounds of `tick 60; push; check`. Expected: one comment, "Problem, back within 24 hours of a recovery". Then two rounds of `tick 0; push; check`. Expected: no recovery comment, and the issue text reads "12 clean checks in a row; 2 so far". Finish with `reset`.

Drills 1 to 4 are the ones the plan asks for. Attach each result (the comment links and the run links) to the "off-machine-heartbeat-drills" proof.

## Cost

- **GitHub calls from the Mac:** one variable write every 15 minutes, 96 a day, counted by the existing budget under `control`.
- **Actions minutes:** 48 short runs a day. On a public repository standard runners are not billed. The usage is still measured after 7 days (the "off-machine-check-actions-minutes" proof). If the repository were private, each run would bill one whole minute: about 1,440 minutes a month at 30 minutes, about 720 hourly. The rule: if the monthly projection passes a quarter of the allowance, change the cron to once an hour. Detection then becomes 105 to 165 minutes after the last push, and this page must say so.

## What it does not cover

- If GitHub is down, or its scheduler is late or switched off, nothing fires. GitHub switches scheduled workflows off in a public repository after 60 days without activity in the repository.
- Deleting the `FACTORY_HEARTBEAT_ISSUE` variable turns the check off silently. Only someone with write access to the repository can do that.
- Inside one open problem each thing is named once. If the Mac's heartbeat was already named and the Mac then stops for good, or a problem that came back is being held open while it flips, nothing more is said until the daily reminder at 09:00. The owner has been told the problem is open and has not been told it recovered.
- The notice says that a job reports an alarm, not why. The reason is in that job's heartbeat file on the Mac.
- The loop contract does not name the field in which the sender reports the age of its oldest unsent hard stop. This check reads the shared "how far behind" field (`behindMs`). If the sender uses another field, the held-hard-stop rule needs a one-line contract amendment and a matching change here. A gate error still arrives as the sender's alarm reason.
- The Mac does not check that the GitHub side is alive. The standing issue's "Last check" line shows it to a person who looks.
