# Agent Factory

A small local desk for approved GitHub work. A deterministic Bun launcher reconciles tickets, usage, capacity and a debit-only wallet; native Codex and Claude sessions do the work. A loopback board shows the evidence and the questions that need a person.

The controller starts no model work on idle ticks. Unknown usage, exhausted budgets, duplicate events and missed release windows fail closed. Private installation settings and operational records stay outside this repository.

Licensed under Apache-2.0. This repository contains original implementation and synthetic examples only.

## Run locally

Requires Bun **1.3.14**, Git, gh, and a signed-in native harness. `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`.

Keep the installation outside this checkout. Set `FACTORY_PRIVATE_DIR` to that folder; its `config.yaml` is the read-only policy. Use [the fictional config](examples/config.yaml) and [intake](examples/intake.md) as references. The default private path supports the existing installation without importing its contents.

`bun run prepare:local` creates private plists, SQLite state and an owner token. `bun run tick` reconciles once. `bun run board` serves **http://127.0.0.1:4318**. New installations start paused. No model is called during an idle tick. No launchd job is loaded by these commands. The Coordinator can run `scripts/install.sh --after-review` after reviewing the installation.

The board shows actual local evidence. Missing readings and unverified native/mobile links remain visibly unverified. Use the private `owner-token` file for board controls; keep it out of workers, screenshots and Git. Cloudflare Tunnel + Access and external AWS/release controls are separate reviewed setup steps. Telegram backup controls reuse the existing verified-sender mail bridge; see operations for preparation and undo.

Read [operations and limitations](docs/operations.md) before enabling workers. The tests use synthetic data only and include independent-process races for the last slot, last dollar and duplicate event, quota boundaries, stale readings, overrun stops, release windows and persistent restart custody.
