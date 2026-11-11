# Config guard

In plain words: a bad factory config used to stop every tick with an error (21 in a row on 8 Nov). This gives the operator a check to run before a config goes live, one safe way to make it live, and a rule for what a running job does if the live file is invalid anyway: start nothing new, keep looking after what is already running, and say so loudly.

- `scripts/validate-config.ts` checks a file and changes nothing.
- `scripts/set-config.ts` is the supported way to change the live config.
- `launcher/config-guard.ts` is the rule for an invalid live file.
- `launcher/config.ts` gains three operator-only switches, all off by default.

## Changing the config

```
bun scripts/validate-config.ts proposed.yaml
FACTORY_OWNER_TOKEN=... bun scripts/set-config.ts proposed.yaml --actor "<name>" --reason "<why>"
```

`validate-config` exits 0 when the file passes and 1 with one line per failing field, for example `usage_gates.admit_below: Invalid input: expected 0.7 (found 0.97)`. With no file named it checks the live config.

`set-config` runs the same check first. If any field fails it writes nothing. If the file passes it:

1. copies the config being replaced, valid or not, to `archive/set-config-<time>-<id>/config.before.yaml`, with a `receipt.json` naming who changed it and why;
2. replaces `config.yaml` in one rename, so a tick never reads a half-written file;
3. keeps the new file as the last good config.

It needs the owner token, like `scripts/control.ts`, and a named actor. It refuses if the live file changed while it ran. To undo a change, run `set-config` on the archived `config.before.yaml`.

Editing `config.yaml` by hand still works when the result is valid. When it is not, the rule below applies.

`set-config` cannot move a limit. The usage gates (0.70 and 0.90), the capacity controller (6 to 12) and the release schedule (20:00 and 21:30) are fixed in `ConfigSchema`, so a file that changes them is invalid and is refused.

## When the live config is invalid

`guardConfig(dir)` reads the live config for a job that must keep running. It never throws on a bad or missing file.

A valid file is returned as it is, and its exact bytes are kept as `config.last-good.yaml`.

For an invalid file the caller gets:

- `hold: true`. Start nothing new: no claim, no auto-approval, no supply, no owner wake.
- `status: "degraded: config rejected"`, to put in the tick result every tick.
- `config`: what to supervise existing work with. It is the last good config, changed only where the bad file asks for something **tighter** on a safety field. Nothing looser is ever taken from a rejected file.
- `problems`, `honoured` and `ignored`, naming each failing field, each tighter value taken and each looser value seen and not taken.
- `alarm`, one plain sentence in the shape the loop heartbeat uses.

Safety fields and which direction is tighter:

| Field | Tighter |
| --- | --- |
| `capacity.start_parallel`, `capacity.heavy_test_slots`, `capacity.controller.start`, `capacity.controller.max` | lower |
| `usage_gates.admit_below`, `high_benefit_only_below`, `stop_at`, `max_meter_age_minutes` | lower |
| `wallet.aws.ceiling_usd_month`, `hold_at_projected`, `stop_at_actual`, `wallet.other.default_usd` | lower |
| `wallet.aws.reserve_usd` | higher |
| `autonomy.restart.causes_per_hour`, `operator_switches.fix_ups_per_pull_request` | lower |
| `operator_switches.failure_class_admission`, `operator_switches.release_headroom` | off |
| `autonomy.auto_approval.protected_paths` | a path added (a path dropped is ignored) |

A value counts only if it parses on its own: a whole number for a capacity, a number from 0 to 1 for a gate, and so on. Every field not in the table keeps its last good value.

With a capacity controller the slot limit comes from the controller, not from `start_parallel`. So a lowered `start_parallel` in a rejected file also caps the controller, and the lower number really is the limit. The controller's stored slot count drops with it and grows back by its normal rule (one slot per healthy hour) after the config is fixed.

If the file is not YAML at all, nothing in it can be read, so the last good config is used unchanged. If there is no last good config either (a first run on a bad file), `config` is null: there is nothing to supervise with.

`configAt` is unchanged and still throws on an invalid file. A job that should refuse to run on an invalid config, such as the release or a worker, keeps using it.

## Saying so

`reportConfigRejection(dir, guard, {store, mail})` is called once per tick while the guard is rejecting. It never throws.

- It records one `config-rejected` event per distinct bad file, however many ticks see it.
- When the config has been invalid for 15 minutes it writes one hard stop for Vincent in the existing Alido Mail store: "Factory down: config invalid, no new work." The 15 minutes run from the first rejected read and do not restart when one bad file replaces another. With no last good config the stop is due at once.
- While the config stays invalid it writes one more each later day, from 09:00 Toronto time.
- The message id comes from the loop contract (`loop:hard-stop:factory-down:config-invalid:<day>`), so the mail gate knows its tier and any other writer of the same condition lands on the same row.
- If the mail store is away, the failure is returned and recorded once a day, and the next tick retries the same id.

The guard keeps its own small state in `health/config-guard.json` (when the rejection began, which file, the last day a stop was raised).

## Operator-only switches

`operator_switches` in the private factory config holds three switches for later loop work. Each default is the behaviour before the switch existed.

| Switch | Default | Allowed |
| --- | --- | --- |
| `failure_class_admission` | `off` | `off`, `on` |
| `fix_ups_per_pull_request` | `0` | 0, 1 or 2 |
| `release_headroom` | `off` | `off`, `on` |

Only the operator edits that file, on Vincent's recorded decision. They are not loop switches: `scripts/loop-flag.ts` refuses these names, and no agent result or owner wake writes the config. A misspelt switch name is refused, not ignored. Nothing reads them yet.

## Not wired into the tick yet

This change adds the guard and its tests. It does not edit `launcher/tick.ts`, `launcher/controller-alerts.ts` or `board/model.ts`, which belong to other changes. Until the tick calls `guardConfig` in place of `configAt`, an invalid live config still stops the tick with an error as before. What works from the day this installs is the prevention: `validate-config` and `set-config`.

When the tick is wired, three things need care:

- every place that starts something (auto-approval, the claim loop, supply, owner wakes) must check `hold`;
- a held tick must not be stored as the last successful heartbeat;
- the board and the controller alert compare the tick status to exact words (`"degraded"`, `"error"`), so they must learn the new status or a held factory reads as healthy.

## Protected paths

Add `launcher/config-guard.ts`, `scripts/set-config.ts` and `scripts/validate-config.ts` to `autonomy.auto_approval.protected_paths` when this installs (`CONFIG_GUARD_PROTECTED_PATHS`). `launcher/config.ts` is already there. Making that change with `set-config` is also its first real use.
