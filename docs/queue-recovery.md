# Queue completion and stall recovery

Published finished sessions move from ready/building to review after fresh issue-digest and open-PR readback. Failed label writes retain custody and retry on later ticks. A new content digest or a PR requesting changes is left for the normal owner approval/review flow. Publication never returns work to ready. Retained PRs and claims still prevent automatic replay, including after a failed review; a separately bounded follow-up is required.

Ready counts, admission candidates and A4 supply share the local retained-custody gate. Unknown legacy digests, reused digests, missing archive/approval receipts and retained PRs do not fill the buffer. Final admission still performs its remote PR, usage, qualification, wallet and capacity checks. Moving useful published work to review can close an exhausted intake round once; later empty rounds retain the two-attempt limit.

The stall watchdog tracks actual worker claims separately from successful reconciliation, owner turns and label changes. Two hours with zero claims and free capacity opens one durable incident even when the queue is empty or contains only duplicates. A claim, pause or occupied capacity closes it without a resolution message. The existing Telegram bridge receives one outbox row per incident; a restart cannot duplicate it. Missing bridge access records a failure and retries the same ID.

Ticks run this check. `bun scripts/watchdog.ts` also checks the durable evidence independently and can be invoked by an existing scheduler. This change installs or loads no launchd job; separate hourly scheduling remains Coordinator setup. It implements the A7 zero-claim symptom; release-window receipts remain the release executor's responsibility.

Undo: signed revert after reconciling current custody. Restore only each recorded prior issue state if its digest still matches; preserve all PRs, branches, sessions, debits, incidents and private receipts. Do not reset claims or restore an old database.
