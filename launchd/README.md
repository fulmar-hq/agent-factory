Run `bun run prepare:local` to write absolute-path, private plists. The tick plist has StartInterval=60; board has KeepAlive. Neither is loaded by preparation. After Coordinator review, scripts/install.sh --after-review bootstraps them. A one-shot tick can launch no helper twice; workers have independent supervisors. Jobs and private state remain outside the checkout.

All schedules use the explicit `jobEnvironment` PATH, never the launching
shell's PATH. `tests/job-environment.test.ts` is part of CI's normal `bun test`:
it resolves every trusted scheduled executable against the generated plist PATH
using the reviewed Mac installation inventory, reproduces a missing `~/bin`
for every job, and catches new literal executable calls. Dynamic argv boundaries
are pinned in `executable-audit.json`; a changed boundary requires rereading its
full tool chain and updating the inventory and hash deliberately. Worker-authored
arbitrary test commands remain governed by their qualified toolchain/sandbox.

After installation, run `bun scripts/check-job-environment.ts` on the Mac. It
reads the **actual installed plists** for release, rehearsal, tick, top-up,
health and maintenance and resolves every executable under each plist's PATH.
Missing plists, tools, absolute PATH, private-directory or timezone evidence
fails closed. It neither loads jobs nor calls AWS, GitHub or models. CI's
fictional Mac layout tests PATH parity; this live check establishes actual
installed availability and must precede installation acceptance.
