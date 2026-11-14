# Factory changes

Factory changes are reviewed and merged by a person or the Coordinator after
green `Verify`, then installed by the Coordinator with the steps written in the
PR. The factory never merges or installs its own source: the five-minute
maintenance job that challenged, squash-merged and fast-forward installed factory
PRs (and reviewed product PRs) was removed on 2026-11-14. Its history remains in
Git and in private `controller.sqlite` events.

## One review per change — Vincent, 2026-11-10

Every change gets exactly one independent review of its current immutable head,
by a fresh session that did not write it, after its checks are green. Review is a
step of the same issue and pull request. Never create Challenge/Accept issues,
use review as refill work, or add a repository report document. The reviewer
posts a short PASS, specific DEFECT, or BLOCKED verdict on that PR; defects return
to the original issue. Missing evidence is a blocker, not a proven defect. Reuse
an existing valid exact-head verdict. A changed head needs fresh exact-head
review evidence as a continuation of that PR review; never reuse stale approval.

Standard review checks the outcome, changed code and cheapest meaningful focused
regression, normally within 15 minutes. Changes touching tenant separation,
consent, sends, bookings, permissions, money or migrations receive deeper review:
trace the affected lifecycle and deterministic safeguards and check the relevant
cross-feature or migration regression, within an explicit 30-minute bound. The
reviewer escalates when source reveals one of these risks. It reports BLOCKED if the
bound or available tools cannot establish the required evidence.

