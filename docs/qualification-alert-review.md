# Qualification alert challenge — issue 109

Disposition: **NOT RUN for independent acceptance** because distinct original-worker/reviewer identity cannot be established from permitted evidence. The exact-head functional observations below are reproducible, but do not supply independent sign-off. One inherited marker/event durability counterexample is retained for separate disposition. Product retains custody; Quality and Release acceptance remain separate.

## Reviewed identity and authority

- Target: existing OPEN PR69 for issue66, as recorded by the approved intake.
- Immutable head: `abaf94245cb45b6db1cc1cd2acfbe71aaaabbcc4`.
- Immutable base: `2c9e529ff5b40a82c339bb7b0f8c4cf6a2192ad3`.
- Head tree: `8e40b8be170a9e4219588c916e752a7d6afa9bc4`.
- Reviewer: the Codex worker assigned issue109 in workspace `353e9f870cf6a7bd30fc75f410b04ecc884f6b5368fab696079a9c5dcaed5a92`, task `/root`. No helpers were used. No implementation was authored in this review.
- Independence: **NOT RUN**. The reviewed commit and this worker's configured Git attribution both name Vincent Messina, `72951696+vincentmessina@users.noreply.github.com`. This attribution collision does not establish distinct native worker identity, nor prove they are the same worker. Original native worker identity is unavailable within the permitted sources. Do not count shared authorship metadata, this new workspace, passing tests, or this document as independence confirmation. Named dependency: **Quality independent-review identity verification**. Quality must attest a reviewer distinct from the original worker, or allocate another independent reviewer if identities collide, before independent acceptance.
- Sole repository path lease/scope supplied by issue109: `docs/qualification-alert-review.md`. No controller lease, custody, guard, policy or debit was changed. Probe files and fictional stores remain in ignored scratch only.

Repository AGENTS.md, README.md and docs/operations.md were read. Reads of shared working-standards MEMORY.md, README.md and projects.md each returned `Operation not permitted` (combined command exit 1). Retain adopted revision `c8dd539da85903dd76dd2d6f991d0a5ee5415a89`; no upstream update is adopted. The user-authorized unsigned worker delivery overrides the repository's general signed-commit instruction for this proposal; launcher signing/publication is separate.

The supplied intake records inspection of all 33 returned open issue bodies, 31 open PR changed-file lists, the complete two-file diff, exact local alert source, and no matching challenge issue, posted review, inline thread or PR comment. That is intake evidence, not a fresh GitHub audit by this worker. No external request or GitHub write was made here. Current remote OPEN status was not revalidated.

## Isolation and command receipts

Review performed 2026-11-09, within the 30-active-minute ceiling. Starting worktree was clean at `e12c4bb440c998244dc0dd5e4202b609d7b26500`; it was never reset, checked out over or cleaned. That delivery base is distinct from the PR69 comparison base above.

`git archive --format=tar --output=.factory-tmp/head-abaf942.tar abaf94245cb45b6db1cc1cd2acfbe71aaaabbcc4` exited **0**. It was extracted with `tar -xf` into uniquely created `.factory-tmp/pr69-review-VluRuW` (exit **0**); existing read-only `node_modules` were linked, without installing dependencies. Scratch HOME and TMPDIR were created under the extracted snapshot's `.factory-tmp`. `git show HEAD-SHA:launcher/alerts.ts` exported the reviewed blob; `cmp` against extracted `launcher/alerts.ts` exited **0**. No dirty/installed/main source was imported for this verdict.

An initial Node `spawnSync("git", ["archive", ...])` extraction wrapper exited **1**, reporting no useful child diagnostic; it produced no accepted snapshot. Direct supported Git archive above succeeded. Git repeatedly warned that it could not create xcrun cache files in the system temporary directory; recorded successful commands still returned 0. These warnings were not treated as missing objects or successful tests.

Toolchains: Node **v24.18.0**, Bun **1.3.14 (0d9b296a)**. Commands below ran from the extracted snapshot, before any source modification; the later probe only adds a scratch test file importing that snapshot.

| Actual command | Exit | Observation |
| --- | --- | --- |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" node node_modules/typescript/bin/tsc --noEmit` | 0 | Node typecheck, no diagnostics; run before probe creation |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test tests/alerts.test.ts tests/alert-readback.test.ts` | 0 | **20 pass, 0 fail, 114 expect calls**, 2 files |
| `HOME="$PWD/.factory-tmp/home" TMPDIR="$PWD/.factory-tmp" bun --no-env-file test ./review-probes.test.ts` | 0 | **7 pass, 0 fail, 137 expect calls**, including a test asserting the counterexample exists |
| User-supplied Node document assertion followed by `git diff --check` | 0 | Required head/base, test paths, restart, verdict, independence and exit text present |

Logs retained at `.factory-tmp/pr69-review-VluRuW/.factory-tmp/{typecheck.log,alerts-tests.log,review-probes.log}`; probe source is `.factory-tmp/pr69-review-VluRuW/review-probes.test.ts`. Fictional SQLite stores were retained under that snapshot's `.factory-tmp/independent-probe-*`. The upstream tests remove their own fictional fixtures as written; no operational asset was removed. Both Bun runs emitted `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` during discovery, yet completed all listed assertions with exit 0. This is a runner diagnostic, not evidence of reading private mail or native qualifications. Every alert call used an explicit fictional mail path. No real controller/mail store, transcript or qualification was opened.

The two requested files contain no deliberate SIGABRT/os.abort call. Probes use SQLite `RAISE(FAIL)`/`RAISE(IGNORE)`, which are SQL errors/control flow, not process signals. No intentional process crash, signal-exit integration test or abort coverage was run. Full-suite CI, endurance and Linux abort coverage are **NOT RUN** in this bounded review.

## Boundary verdicts

PASS below means an observed exact-head functional result, conditional on the separate independence dependency. It is not release acceptance.

| Boundary | Verdict | Evidence |
| --- | --- | --- |
| Distinct reviewer/original worker | NOT RUN | Attribution collision and missing native identity attestation; Quality dependency above |
| Exact source and dependencies | PASS | Local immutable Git object archived; reviewed alert blob compared equal; read-only dependencies reused |
| Ignored insertion leaves no row | PASS | Existing `ignore_alert` regression reused; independent persistent-store probe repeats after reopening: missing-readback failure retained, no queued marker, no success event, no bridge row |
| Immutable routing/content/hash conflict | PASS | Original 13-field conflict table reused: send_id, sender, sender_app, sender_ref, recipient, recipient_app, kind, reply, body, thread_id, depth, hash, summary. Persistent probes repeat all 13 after reopening both stores; first failure event and original bridge rows remain equal, marker absent, success absent |
| Self-consistent wrong provider/expiry wording | PASS | Original regression tests both altered summaries with matching altered hashes; readback still rejects them |
| Matching crash recovery before expiry | PASS | Retained row, absent controller marker, reopened stores: one marker/event, no bridge rewrite; repeated call remains one row/event |
| At/after expiry with earlier expires-at wording | PASS | Persistent probes at exactly expiry and one millisecond after retain original pre-expiry summary/hash and row; original expiry-boundary regression also passes |
| Already-expired wording recovery | PASS | Correct expired summary/hash accepted after expiry, unchanged across reopen/repeat |
| Advanced delivery fields | PASS | Fictional `state=read`, `wake_state=delivered` retained unchanged; these strings are fixtures, not delivery receipts |
| Normal insertion, repeated calls, provider/expiry identities | PASS | Exact expected row inserted; reopen/repeat deduplicates; different codex expiry and claude identity produce three distinct rows/events |
| Failure history after fictional repair | PASS | Ignore trigger removed only in scratch; missing-readback failure survives successful insertion and later reopen/repeat; failure and success coexist |
| Bridge committed, controller marker write fails | PASS | Fictional kv trigger rejects marker: failure retained, no marker/success, matching bridge row remains; remove trigger and reopen, then recover after expiry without rewrite |
| Success follows verified readback | PASS | Missing/conflicting rows never reach marker/success; independent success callback inspects exact row and committed marker. Source readback lines 34–47 precede marker/event lines 49–50 |
| Marker committed, success-event persistence fails | FAIL | Counterexample below: marker prevents event repair on repeated calls after reopen; queued row remains intact |
| Cross-database atomicity / arbitrary process or power-loss recovery | NOT RUN | No transaction spans both databases; sequential fixture recovery is not atomicity or a power-loss durability proof |
| PR76 and installed dirty-source integration | NOT RUN | Known overlapping delivery implementation; installed source read denied, PR76 exact head unavailable here; no dirty import |
| Delivered notification, renewal, native qualification, endurance, Production | NOT RUN | Only fictional queued-bridge evidence; no live message, admission, deployment or renewal |

The ID lookup itself selects the expected primary key, so a different `id` is not an immutable-field conflict against that same row. `created_at`, `state` and `wake_state` are intentionally outside the immutable comparison. Nothing here invents a requirement to reset delivery state or rewrite earlier legitimate wording. Repeated failure calls retain the first per-ID failure event, rather than generating new events for every retry (`Store.event` uses INSERT OR IGNORE).

## Retained counterexample and scope

Finding F1 — **controller marker can outlive missing success history**. At reviewed `launcher/alerts.ts:49`, `s.set` commits the queued marker. Line 50 then writes the event separately. At line 20, all later calls skip this identity once the marker exists. `tracking/store.ts:72` and `:79` implement independent writes; no surrounding controller transaction joins them. A success-event insertion error is caught at alert lines 51–52, leaving a failure event alongside the marker. After the fault is removed and the controller reopened, repeating the call does not reconstruct the success event. A process stopping in the same interval is consistent with that ordering, but no real crash was induced.

The persistent probe observed one correct bridge row, a non-null queued marker and only `qualification-alert-failure`, both before and after reopen/retry. The retained counterexample store is under `.factory-tmp/pr69-review-VluRuW/.factory-tmp/independent-probe-tgsWZ2/`. Its passing test asserts that failure exists; it must not be counted as PASS for event durability.

Minimal fictional reproducer, run with Bun from an extracted exact-head snapshot and scratch HOME/TMPDIR; all paths are fictional and explicit:

```ts
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { qualificationAlerts } from "./launcher/alerts";
import { Store } from "./tracking/store";
import { now, qualification } from "./tests/fixtures";
const dir = mkdtempSync(`${process.env.TMPDIR}/event-gap-`);
const mail = `${dir}/fictional-mail.sqlite`;
const controller = `${dir}/fictional-controller.sqlite`;
const bridge = new Database(mail);
bridge.exec(`CREATE TABLE messages(
 id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,
 sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,
 kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,
 hash TEXT,state TEXT,wake_state TEXT)`);
bridge.close();
const expiresAt = now + 3600000;
const id = `qualification-expiry:codex:${expiresAt}`;
const q = {codex:{...qualification(),expiresAt}};
let s = new Store(controller);
s.db.exec(`CREATE TRIGGER fail_success BEFORE INSERT ON events
 WHEN NEW.kind='qualification-expiry-alert'
 BEGIN SELECT RAISE(FAIL,'fictional success-event fault'); END`);
qualificationAlerts(s, q, now, mail);
console.log(s.get(id), s.rows("events")); // marker + failure, no success
s.close();
s = new Store(controller);
s.db.exec("DROP TRIGGER fail_success");
qualificationAlerts(s, q, now + 1, mail);
console.log(s.get(id), s.rows("events")); // unchanged; event not repaired
s.close();
```

This ordering already exists in the base at `launcher/alerts.ts:20,31–34`. F1 is an inherited diagnostic durability limitation, not a regression introduced by the readback patch. Supported recovery is specifically bridge insertion before controller marking: an already matching row can be verified and marked without another bridge row. This evidence does not justify claiming cross-database atomicity or guaranteed durable success history at every interruption boundary. Product/Quality must disposition F1 against existing requirements; any implementation repair needs a separately scoped lane. No original PR or reserved test was edited.

## Integration disposition and restart

PR76 and the installed dirty `launcher/alerts.ts` are overlapping implementation lanes identified by intake. Reading `/Users/vincent/Developer/agent-factory/launcher/alerts.ts` returned `Operation not permitted` (cat exit 1). This is a concrete integration blocker. No attempt was made to read private sibling assets or bypass it. PR76's precise code and behavior were not reconstructed from unrelated branches.

Separately, read-only comparison with this worker's clean delivery-base `launcher/alerts.ts` showed the pre-readback implementation (diff exit 1 means differences). It lacks head lines 34–47. That comparison establishes divergence only in this workspace; it is not a claim about the denied installed dirty source or PR76. The integration conflict is ownership of the same alert insertion/readback path: Product/Release must select **one delivery writer/lane**, preserve the existing work and carry forward verified readback behavior rather than let a competing lane overwrite it. No competing writer was created.

Next actor and observable restart:

1. **Quality** supplies a permitted original-worker/reviewer identity attestation. If the worker identity collides, assign a named distinct reviewer and rerun exact-head acceptance. Until that receipt exists, independent acceptance stays NOT RUN.
2. **Product/Release** provides permitted, immutable PR76 and installed dirty-source snapshots, names the single integration lane, and records disposition of F1. Restart integration review only when those snapshots and lane receipt are readable; compare read-only and rerun the same fictional readback/reopen probes against the chosen combined head under a separately approved scope.
3. For missing Git objects, dependencies, toolchain or native sandbox capability on restart, stop the affected boundary as NOT RUN and retain the actual command/error. Restore access to the same immutable object and supported read-only dependencies/capability, then rerun these commands. Never substitute main, dirty source or fabricated success.

No format assertion or green CI alone resolves these dependencies. Only the document is proposed. Unsigned local delivery and bundle preparation do not transfer Product custody or supply Quality/Release approval. No signing, push, merge, release, launchd, sign-in, provider/AWS/spend action, real message, policy change or custody/debit reset was performed. Undo this proposal by a later reviewed document change while retaining the evidence and history.
