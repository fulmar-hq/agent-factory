# Process identity challenge — issue 97 / PR60 / issue54

Review date: 2026-11-09. This is a docs-only challenge, not acceptance or Production proof. Product retains custody; Quality/Release decide acceptance and delivery. No implementation or original PR was changed.

Reviewed immutable head: `8759b9b22f63ff78ee34b6584d4eb0234d14a4dd`.
Reviewed base: `0da456aaa499568296df780012d97f5d7d4ab6cb`.
The diff is exactly `launcher/process.ts` (59 changed lines) and the existing 178-line `tests/process-identity.test.ts`: 228 additions / 9 deletions.

## Independence and authority

This reviewer is the issue97 worker on `feat/factory-533f43fb5a356ce6`, assigned checkout initially at `e12c4bb440c998244dc0dd5e4202b609d7b26500`. PR60's writer branch is `feat/factory-82867a392b338c32`; its body identifies launcher-tested tree `2eb27c144b5f474e89c48715ee926a80ba93bee2` and the signed head above. This reviewing turn did not author the implementation. Distinct assigned writer/reviewer attempts are confirmed; neither branch was reset or combined. Git author/committer is the shared launcher identity Vincent Messina, which alone cannot establish native reviewer independence.

Native writer-versus-reviewer identity certification: **NOT RUN**. Reading private/native receipts is explicitly outside this task. No identity collision was observed, but distinct branch names cannot prove distinct native identities. Quality must confirm that provenance before treating these technical observations as independent acceptance. If the identities collide, the independent review is **NOT RUN**, and a different reviewer must restart it. No unconditional independence certification is claimed here.

Read repository AGENTS.md, README.md and docs/operations.md; retained adoption of working-standards `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`. Shared MEMORY.md / README.md / projects.md reads were sandbox-denied during intake; unavailable private authorities were not bypassed or silently updated. Intake reports examination of all 26 open PR path lists and 26 open issue bodies with no duplicate challenge. This turn did not repeat that entire census. Read-only GitHub PR60 metadata confirms OPEN, the exact head/base and 2 files / 228 / 9; review-list response is empty. No review/comment/message was posted.

## Exact-head execution receipts

All commands below ran locally. Scratch root `S=.factory-tmp/pr60-review-8759b9b-issue97` was uniquely created, not reused from another attempt. Installed `node_modules` was linked read-only from the assigned checkout. `$S/.factory-tmp/home` was created. No dependency install occurred. Tests import `$S/launcher/process.ts`, not current main; every process/file/command response in the executed identity suites is fictional and injected. No live process inspection, process signal, deliberate abort or model launch occurred. SIGABRT was represented only as a mocked result/error field.

Actual extraction and execution commands (run from the assigned checkout unless `cd` shown):

```sh
mkdir -p .factory-tmp/home
# Scratch directory was first made by Python with exist_ok=False.
git archive 8759b9b22f63ff78ee34b6584d4eb0234d14a4dd | tar -xf - -C .factory-tmp/pr60-review-8759b9b-issue97
ln -s "$PWD/node_modules" .factory-tmp/pr60-review-8759b9b-issue97/node_modules
mkdir -p .factory-tmp/pr60-review-8759b9b-issue97/.factory-tmp/home
cd .factory-tmp/pr60-review-8759b9b-issue97
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/process-identity.test.ts
HOME="$PWD/.factory-tmp/home" bun --no-env-file test ./.factory-tmp/boundary-probes.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

| Receipt | Actual exit / counts | Interpretation |
| --- | --- | --- |
| Initial Python extraction | Python failed: unsupported `extractall(filter=...)`; its preceding `git archive` exit 0 | No tests extracted at that stage; subsequent focused Bun command exit 1, no matching tests. NOT RUN for that attempt. Restarted extraction with tar above. |
| Archive/tar + dependency link + HOME creation + existing suite | Exit 0; Bun 1.3.14; 10 pass, 0 fail, 168 expectations | PASS for execution of the original suite, not acceptance of its assumptions. |
| First supplemental run | Exit 1; 5 pass, 3 fail, 35 expectations | One reviewer fixture wrongly said Friday for Jan 1, 0099 (actually Thursday); two substantive failures below. Initial file preserved as `.factory-tmp/boundary-probes.initial.ts`. |
| Corrected supplemental run | Exit 1; 6 pass, 2 fail, 46 expectations | Corrected fictional weekday only; failures F1/F2 persisted. |
| Final supplemental run, with independent PID/locale probes added | Exit 1; 8 pass, 2 fail, 84 expectations | F1/F2 reproduced; final output retained at `$S/.factory-tmp/boundary-final.log`. |
| Exact-head TypeScript check | Exit 0, no diagnostics | Static check only. Used direct installed tsc, not `bun run`. |
| Blob verification (`git hash-object`, `git ls-tree HEAD-SHA ...`) | Exit 0; source `47a473993d861861c4ec7b80e5a2bb691c4af0c9`, original suite `71680f00c5a4f5a65b202deadd3d0016eb59e57c` | Extracted files match reviewed immutable tree. |

Git emitted denied xcrun temporary-cache diagnostics but the above Git operations succeeded. Bun emitted `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after executing the reported tests; the original suite nevertheless exited 0, and supplemental failures exited 1. These are not evidence that denied ancestor access succeeded. No permission expansion was attempted. No missing test/object/dependency was counted as success. Full `bun test` and live host integration: **NOT RUN**, outside the approved focused execution and unsafe to assume all host tests meet this task's no-live-process/no-abort constraint.

## Boundary verdicts

References below are to reviewed-head `launcher/process.ts`, unless another file is named. PASS denotes the specified synthetic boundary only.

| Boundary | Verdict | Evidence / limit |
| --- | --- | --- |
| Positive safe PID before any I/O | PASS | Line 34; both platforms reject zero (including -0), negative, fractional, NaN, infinities and unsafe integer with zero injected I/O. |
| Inherited locale vs C | PASS | Lines 53–54; original and added probes cover fr_CA, de_DE and C; LC_ALL becomes C while inherited LANG/LC_TIME remain. Exact ps path/arguments checked. |
| macOS dates, weekday, leap/century/year/UID | PASS | Lines 20–30/59; valid 2000/2024 leap days and year 0099; invalid 1900/2026 leap days, wrong weekday, overflow day/time, wrong year width, negative/fractional/unsafe UID rejected. UID validation is safe-integer text validation, not a demonstrated OS UID-width constraint. |
| Whitespace and malformed multiline ps | PASS | Horizontal tabs and outer whitespace accepted; internal newline/extra line/localized output rejected. Interior valid identity whitespace remains byte-for-byte. Outer blank lines are trimmed, not universally rejected. |
| Vanished vs nonzero/signal/stderr/error | PASS | Lines 56–58; only status 1 with no signal and blank stdout/stderr yields null; status 0 malformed output rejects; 2/127/null, signal, stderr warnings and error objects reject. SIGTERM/SIGABRT mocked. Whitespace-only stderr counts as blank. |
| Boot UUID and command failure | PASS | Lines 14–18/60; UUID syntax enforced, surrounding whitespace trimmed, case retained, multi-value/extra suffix rejected; ENOENT/EACCES/EPERM and mocked command error propagate on macOS. No cryptographic UUID semantics claimed. |
| Linux comm parentheses / start ticks | PASS | Lines 37–47; last closing parenthesis handles fictional nested/spaced comm; exact PID header checked. Zero, leading zeros and uint64 maximum preserved; missing, signed, fractional, exponent and overflow ticks rejected. |
| Linux state validation | FAIL | F2: line 44 accepts any ASCII letter, including Q; only malformed multi-character state was covered by original suite. |
| Linux missing process stat | PASS, conditional | Line 49 yields null for ENOENT at `/proc/42/stat`; legitimate disappearance in the assumed available procfs. Missing/unmounted procfs itself is also possible: ENOENT alone cannot prove disappearance on an unqualified host. |
| Linux missing boot_id | FAIL | F1: lines 47–49 conflate missing global boot identity with missing process; successful stat plus boot_id ENOENT returns null. |
| Linux permission / other errors | PASS | EACCES/EPERM/EIO from either file propagate. |
| Reused PID | PASS, bounded | Changed start second on macOS and tick on Linux change identity. Same-second macOS reuse with same UID is not excluded by a seconds-resolution representation. No real reuse was attempted. |
| Existing retained text compatibility | FAIL for universal compatibility | F3 below; standard valid output, UUID case, Linux leading zeros and interior macOS spacing preserved, but a formerly localized retained identity differs after C-locale output. No retained operational data read. |
| Native identity independence / Production qualification | NOT RUN | Requires authorized independent provenance and host qualification outside this worker. |

## Findings and reproductions

**F1 — High: Linux boot-identity unavailability is classified as process absence.** Reviewed source `launcher/process.ts:47` reads boot_id inside the same try as process stat; line 49 converts either ENOENT to null. The original suite `tests/process-identity.test.ts:163` explicitly expects this for both files, so its green result does not prove fail-closed behavior. Missing global `/proc/sys/kernel/random/boot_id` is not evidence that PID42 vanished after a successful stat read. This behavior predates PR60 (base lines 9–11), so it is a retained gap, not a newly introduced regression.

Reproduction: inject Linux, return valid stat below for `/proc/42/stat`, throw `{code:'ENOENT'}` only for boot_id. Actual result null; unavailable identity should remain an error. Exact-head consumers compare identities for custody/lease decisions: `launcher/autonomy.ts:267`, `launcher/wake.ts:27`, `launcher/engine.ts:154` and `launcher/engine.ts:432`; false absence or inequality can bypass the identity portion of a live-process guard. Other custody gates may still block; no live effect is claimed.

**F2 — Low: state validation is only a one-letter shape check.** `launcher/process.ts:44` accepts Q (also arbitrary alphabetic states) despite the requested malformed-state challenge. Supplemental test expects rejection and receives the normal boot:tick string. This is input-validation incompleteness, not proof a kernel emits Q or a demonstrated production exploit. Product/Quality must decide whether a documented Linux-state allowlist is part of acceptance or future compatibility intentionally permits unknown letters.

Minimal scratch-only reproduction for F1/F2, importing the exact extracted source:

```ts
import { processIdentity } from '../launcher/process'; // file in $S/.factory-tmp
const boot = '12345678-abcd-1234-abcd-123456789abc';
const stat = (state: string) =>
  `42 (fictional ) worker) ${state} ${Array(18).fill('0').join(' ')} 12345 0 0\n`;
const os = {
  platform: 'linux' as const,
  spawn() { throw Error('unexpected command'); },
  exec() { throw Error('unexpected command'); },
  readFile(path: string) {
    if (path === '/proc/42/stat') return stat('S');
    throw Object.assign(Error('fictional missing boot_id'), {code: 'ENOENT'});
  },
};
console.log(processIdentity(42, os)); // F1 actual: null
os.readFile = path => path === '/proc/42/stat' ? stat('Q') : boot;
console.log(processIdentity(42, os)); // F2 actual: boot + ':12345'
```

Run a reproduction saved as `$S/.factory-tmp/repro.ts` with `HOME="$PWD/.factory-tmp/home" bun --no-env-file .factory-tmp/repro.ts` from `$S`. This snippet is a reproduction recipe, not an additional claimed execution; actual failing tests are lines 45–50 of the retained supplemental file.

**F3 — Medium: locale stabilization does not migrate retained identities.** Base `launcher/process.ts:15` inherits locale; reviewed lines 53–54 pin C, and line 61 returns trimmed stdout without interior normalization. A fictional retained `${boot}:dim. nov. 8 12:34:56 2026 501` differs from the new `${boot}:Sun Nov  8 12:34:56 2026   501` for an otherwise identical injected process. The supplemental retained-text test demonstrates inequality, not a live localized ps observation. Equality-based guards at the consumers above cannot distinguish a representation change from PID reuse. Standard C text is preserved; UUID case is not lowercased, ticks are not numerically normalized, and interior date/UID whitespace is not collapsed. Thus there is no general canonicalization guarantee across locale/format changes. Whether this installation has affected retained strings is **NOT RUN**; private records were prohibited. Next actor must arrange safe custody reconciliation before rollout rather than assume compatibility or reset records.

## Current-main integration, separately

Assigned HEAD, local main and origin/main all resolved to `e12c4bb440c998244dc0dd5e4202b609d7b26500`. `git merge-base <reviewed-head> HEAD` exited 0 and returned the approved base. `git diff <base> HEAD -- launcher/process.ts` exited 0 with no changes; current-main process.ts remains the 21-line base implementation, and the reviewed test file is absent there. Other launcher/test paths evolved on main. This comparison did not create a merge tree, modify heads or run the reviewed suite against main. Combined-main behavioral acceptance is **NOT RUN**.

Intake's recorded GitHub `mergeable=false` is an integration follow-up, not evidence of a code defect. This turn's read-only `get_pr_info` returned `mergeable=true` with merge commit SHA `302862fc153fba0ecb748bad621fa71d9aacbeac`. Record both observations; mergeability is mutable and neither value resolves F1–F3. Release must refresh integration evidence for the exact candidate/base it proposes to deliver.

## Disposition, next actors and restart

Acceptance is withheld: the original suite passes but enshrines F1, supplemental safety assertions fail, retained-text compatibility is conditional, and native independence certification is unavailable. No source repair was authorized or made.

Product retains this proposal and triages F1–F3 with Quality. Quality must confirm distinct native writer/reviewer identities using its authorized provenance; a collision requires a different reviewer. Product must separately authorize any implementation repair or retained-custody reconciliation. Release owns current-main integration and delivery acceptance; no sign/push/merge/release or policy/custody changes occurred here.

Concrete restart condition: provide independently verified non-colliding reviewer provenance, an immutable separately approved repair/candidate head and base, and an executable bounded injected test command. Rerun the unchanged original suite plus missing-boot_id rejection, agreed Linux-state behavior and retained-localized-identity reconciliation evidence at that exact tree. If an object/dependency is missing or execution is denied, mark that boundary NOT RUN and restart only when the launcher supplies the missing object/read-only dependency or authorized execution environment. Do not manufacture success or broaden permissions. Live host/Production proof requires separate authorization and custody, never a real macOS abort.

The required report-format assertion and `git diff --check` validate this documentation only. They cannot change these acceptance verdicts. Undo this docs-only proposal by reverting its single report commit; preserve scratch, branches and evidence. Publication is left to the launcher from an unsigned local commit and `.factory-delivery.bundle`.

Documentation receipt: the exact issue97 `node -e` assertion followed by `git diff --check` ran after report creation and exited 0. This is a format/whitespace PASS only.
