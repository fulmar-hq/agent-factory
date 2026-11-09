# PR62 cleanup challenge — issue55 / issue83

Review date: 2026-11-09 (UTC). **Overall: FAIL for the requested cleanup boundaries; independent acceptance NOT RUN.** The exact-head focused suite passes, but injected adversarial probes expose signals to reused PIDs/groups. No reviewed code was changed. This is local evidence for Quality/Release, not hosted acceptance, full qualification or delivery approval. Product retains custody.

## Revision and independence receipts

- Reviewed source: `5b8db766d394c7cdf705d32b667396a803d3b89a` (PR62 head supplied by intake).
- Reviewed base and head's immediate parent: `0da456aaa499568296df780012d97f5d7d4ab6cb`.
- Worker starting HEAD: `35fe1a42c427a821fbe82284aecef00033802403`; never reset or used as the head under test.
- Locally available `origin/main`: `10709947323c6dfc798e324c5c595ff781744110`. Fresh hosted main, PR OPEN status and hosted head equality: **NOT RUN**. These identifiers describe immutable local evidence and the approved intake, not authenticated remote readback.
- Native-writer independence: **NOT RUN / unverified**. The permitted Git objects expose Vincent Messina as author/committer, not the originating native session ID. No original/current native identity comparison was available in the authorized evidence; private controller records and native transcripts were not read. Shared Git author identity neither proves nor disproves native identity collision. No independence PASS is claimed. **restart:** Quality/Release must supply an authorized non-secret receipt comparing the original writer's native ID with this reviewer's ID. A collision disqualifies this review as independent and requires a different native reviewer; an unknown identity remains NOT RUN.
- Required shared standards files (`MEMORY.md`, `README.md`, `projects.md` under `/Users/vincent/Developer/working-standards`) were attempted with `cat`, exit 1, each `Operation not permitted`. Local AGENTS.md, README.md and docs/operations.md were read. No broader permission or private data access was attempted. **restart:** provide those governing documents through permitted read access if their full review is required.

`git cat-file -t` returned `commit` for both target objects (exit 0 each). `git rev-parse HEAD` and `git rev-parse HEAD_SHA^ refs/remotes/origin/main` returned the revisions above (exit 0). Git emitted sandbox-denied xcrun cache-write diagnostics under `/var/folders/.../T`; object reads and archive creation still succeeded. No Git reset, fetch, sign-in or publisher action was performed.

| Path | Head Git blob | Base Git blob |
| --- | --- | --- |
| launcher/child.ts | `6149156f950af52df7c6a8278e95cad09022bea1` | `678c3aff5b3cecedebf9b4eca8eaf254bbfe648d` |
| tests/process-table-errors.test.ts | `0c44beb64591be3ae8630c8ab3f7dbcd6c5fac61` | absent |

`git diff --stat BASE HEAD`: exactly these two paths, 179 insertions and 12 deletions (exit 0). The test was absent from the worker checkout; it was run only from the extracted head.

## Snapshot and execution receipts

Host: Darwin; Bun `1.3.14` (`0d9b296a`); Node `v24.18.0` (version commands exit 0). Scratch snapshot: `.factory-tmp/pr62-review-CtKn9d`. No existing directory was reused. Installed `node_modules` was linked read-only from the worker checkout; no installation or dependency writes occurred. Snapshot scratch HOME was created before Bun execution.

An initial Node extraction helper failed before archiving: `spawnSync('git', ...)` supplied no stdout, and `writeFileSync` raised `ERR_INVALID_ARG_TYPE` (helper exit 1). Its uniquely created scratch directory was preserved. The supported shell commands below then successfully created a fresh snapshot. This failed helper supplied no test evidence.

Actual successful extraction commands (run from worker root):

```sh
review_root=$(mktemp -d "$PWD/.factory-tmp/pr62-review-XXXXXX")
print -r -- "$review_root" > .factory-tmp/cleanup-review-root
git archive --format=tar -o "$review_root/head.tar" 5b8db766d394c7cdf705d32b667396a803d3b89a
tar -xf "$review_root/head.tar" -C "$review_root"
mkdir -p "$review_root/.factory-tmp/home"
ln -s "$PWD/node_modules" "$review_root/node_modules"
cd "$review_root"
HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/process-table-errors.test.ts > .factory-tmp/focused.log 2>&1
```

`mktemp`, archive, extraction, mkdir and dependency link succeeded; focused test exit **0**, **53 pass, 0 fail, 772 assertions**, one file, reported 4.18 seconds. Bun also printed `Cannot read directory "/Users/vincent/.alido-private/": PermissionDenied` after executing the tests; this diagnostic is retained, not silently omitted. Counts and process exit were observed separately.

| Command from extracted head | Exit | Receipt |
| --- | --- | --- |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test tests/process-table-errors.test.ts` | 0 | PASS: 53/53, 772 assertions |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file test ./.factory-tmp/adversarial.test.ts` | 1 | 3 pass, 4 fail, 15 assertions, one file, 4.57 seconds |
| `HOME="$PWD/.factory-tmp/home" bun --no-env-file run typecheck` | 1 | NOT RUN: startup `CouldntReadCurrentDirectory`, no typechecking result |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | PASS: exact-head typecheck through installed compiler; zero tests |

Full `bun test`: **NOT RUN**, outside the bounded focused challenge and not audited here for macOS abort/real-signal integrations. No real process signal or deliberate abort was used. The reviewed file's SIGABRT case is an injected exception (`tests/process-table-errors.test.ts:72–87`); every fixture supplies fake spawn, process table and kill (`:13–35`). Linux real-abort integration and native host process cleanup: **NOT RUN**. **restart:** separately approve and inspect such integration coverage; never deliberately run SIGABRT/os.abort on macOS, use SIGTERM for local signal-exit tests and mocked SIGABRT there, with real abort coverage confined to Linux.

SHA-256 of extracted files, recorded after extraction:

```text
launcher/child.ts              e14937d63712e97da8292d017128aa8ce55a034b6726e11a5f995d3d1acc3225
tests/process-table-errors.test.ts 2f266ebcb803b14e5a756aa8ad4f26f6be50a34408d811781e1ac06da8e18341
bun.lock                       576ddbb9266e88672e839cd9743c19fcccb62efd8755af41c16e8b0c99345ae6
package.json                   89595af97c2cf59400bcd82871143a4d1c91fd22908c80e6d30e7aba7803eabf
head.tar                       dc2da27769301d15db19938ab1db787d2ef5c5ce248d847ac444cb798ec3587e
```

## Boundary findings at the exact head

Line references below are to the immutable reviewed head, not the worker checkout.

| Boundary | Verdict | Evidence and limit |
| --- | --- | --- |
| Malformed, empty, whitespace and visibly partial/truncated rows | PASS | `launcher/child.ts:12–23` throws rather than dropping bad rows. Tests `:38–70` cover garbage, valid row plus truncated suffix, missing fields, invalid state/start/time, unsafe numbers, and bad reads 1–6, including the final observation. Verification remains false. |
| Arbitrary truncation at a complete-row boundary | FAIL for the literal “never” claim | Additional prefix probe returns only the valid PID1 row while conceptually omitting a surviving worker. `processRows` accepts any nonempty valid prefix and cleanup becomes verified. No completeness marker/count exists (`child.ts:12–23`). This is an information-limit probe, not evidence that the real ps command actually truncates successful output. Visible partial-row rejection must not be described as proof against all missing rows. |
| Observation failures remain sticky | PASS | `child.ts:37,47,111` retains tracking errors across later valid reads. Existing test `:90–97` covers malformed tracker output. Additional tracker probe retains mocked SIGABRT failure and original cause after later good reads. The variable retains a failure, though another failure can replace its diagnostic. |
| Valid macOS/Linux-style rows and zombies | PASS for fixtures | Existing test `:99–109` accepts kernel zero IDs, `R`, `I<`, `Ssl+`, `Z`, `Z+`, whitespace and ordinary lstart spacing. `child.ts:75,109` excludes zombies as survivors. This proves those representative formats, not every possible platform stat extension or live-host behavior. |
| PID reuse of retained descendant group | FAIL | Additional group43 probe replaces PID43 with a later start identity after PID42 exits. Subsequent observations identify the replacement, yet `[-43,"SIGTERM"]` and `[-43,"SIGKILL"]` are still requested. `child.ts:72–84` retains groups forever; signaling does not revalidate retained leaders. Final survivor rejection does not undo the unrelated signal requests. |
| PID reuse of original worker group | FAIL | Additional group42 probe replaces exited PID42 with a new start identity. Later requests still include `[-42,"SIGTERM"]` and `[-42,"SIGKILL"]`. `child.ts:72` seeds the group unconditionally; `:84` signals it on each pass. |
| PID reuse between observation and individual signal | FAIL | Injected kill callback for PID42 replaces PID43 before the same terminate pass reaches it; `[43,"SIGTERM"]` is requested for the replacement. `child.ts:83–88` uses a previously collected live array. Existing test `tests/process-table-errors.test.ts:134–144` actually allows one such PID43 TERM and checks only that group99 is not targeted; it cannot establish the stronger no-unrelated-signals boundary. This is a controlled race, distinct from the retained-group failure observable in later snapshots. |
| TERM denial preserves diagnostics and fallback | PASS | Existing tests `:111–132` retain negative group and individual EPERM keys and permit success only after disappearance. `child.ts:51–62,87–90` records denials. Additional persistent-denial probe rejects survivors and retains all four TERM/KILL group/individual diagnostics. |
| Independent final observation rejects survivors | PASS | `child.ts:108–112` checks owned survivors and a separate group read before verification. Additional probe shows only read6 revealing an unrelated-parent PID88 in group42; stop rejects with `owned worker descendants survived cleanup` and verified stays false. This checks detection, not safe signaling. |
| Native identity independence / live qualification | NOT RUN | No native identity comparison or live cleanup test; restart conditions above. |

The three PID-reuse failures are safety findings even though two probes ultimately reject cleanup and the third verifies absence. The original 53-test PASS does not satisfy the requested stronger boundary. Group retention and the individual observation/signal race already exist in the base implementation; PR62 does not introduce those mechanisms, but its passing regression test is insufficient acceptance evidence for the approved outcome. No fix was made or proposed as an accepted policy change.

## Current-main compatibility, separately

Local `origin/main` is `10709947323c6dfc798e324c5c595ff781744110`; `git merge-base HEAD_SHA refs/remotes/origin/main` returned that same SHA (exit 0), so this local main is an ancestor, not evidence of today's hosted main. `git diff --quiet 0da456aaa499568296df780012d97f5d7d4ab6cb refs/remotes/origin/main -- launcher/child.ts` exited 0: base and local-main child source match. `git ls-tree` showed blob `678c3aff...` and no focused test on local main.

Compatibility-only commands:

```sh
git diff --binary 0da456aaa499568296df780012d97f5d7d4ab6cb 5b8db766d394c7cdf705d32b667396a803d3b89a -- launcher/child.ts tests/process-table-errors.test.ts > "$review_root/.factory-tmp/pr62.patch"
main_root=$(mktemp -d "$PWD/.factory-tmp/pr62-main-XXXXXX")
git archive --format=tar -o "$main_root/main.tar" 10709947323c6dfc798e324c5c595ff781744110
tar -xf "$main_root/main.tar" -C "$main_root"
patch --dry-run -p1 -d "$main_root" < "$review_root/.factory-tmp/pr62.patch"
```

Diff, archive, extraction and patch dry run each exited 0: **PASS for textual applicability to this local main only**. The dry run did not modify source. Runtime compatibility on current hosted main, hosted CI and merge acceptance: **NOT RUN**. **restart:** obtain authenticated read-only current-main/PR head/status receipts through an authorized intake path, pin the new immutable main, then separately assess integration. Never substitute that integration test for acceptance of `5b8db766d394c7cdf705d32b667396a803d3b89a`. CI green alone is insufficient.

## Preserved adversarial reproduction

Only scratch holds this extra probe file, its logs, archive and extraction. It imports `../launcher/child` from the exact head snapshot, never the worker/current-main source. All spawn/read/kill operations are injected. The assertions below express required safety properties, so the four reported failures are intentional observations of unmet boundaries, not repaired or hidden failures. Run with the adversarial command in the execution table after creating scratch HOME. The complete probe source follows:

```ts
import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnWorker} from '../launcher/child';
const old='Sun Nov  8 12:34:56 2026', fresh='Sun Nov  8 12:35:00 2026';
const row=(pid=42,parent=1,group=42,start=old)=>`${pid} ${parent} ${group} Ss ${start}\n`;
const absent=row(1,0,1);
function fixture(read:(n:number)=>string,signal?:(p:number,s:any)=>void){
  const child=Object.assign(new EventEmitter(),{pid:42,stdout:new PassThrough(),exitCode:null as number|null,signalCode:null});
  let reads=0; const signals:any[]=[];
  const runtime={spawn:(()=>child) as any,execFileSync:(()=>read(++reads)) as any,
    kill:(p:number,s:any)=>{signals.push([p,s]);signal?.(p,s);return true as const;}};
  const worker=spawnWorker({argv:['fictional'],env:{}},'/fictional',2,runtime);
  return {worker,child,signals,reads:()=>reads};
}
test('independent final group observation rejects a newly visible survivor',async()=>{
  const f=fixture(n=>n===6?absent+row(88,1,42):absent);
  await expect(f.worker.stop()).rejects.toThrow('survived cleanup');
  expect(f.reads()).toBe(6);expect(f.worker.cleanup.verified).toBe(false);
});
test('persistent TERM denial plus survivor cannot verify cleanup',async()=>{
  const f=fixture(()=>absent+row(),()=>{throw Object.assign(Error('denied'),{code:'EPERM'});});
  await expect(f.worker.stop()).rejects.toThrow('survived cleanup');
  expect(f.worker.cleanup.verified).toBe(false);
  expect(f.worker.cleanup.deniedSignals).toEqual(['-42:SIGTERM','42:SIGTERM','-42:SIGKILL','42:SIGKILL']);
},6000);
test('tracker execution failure is sticky across later good reads',async()=>{
  let broken=true;
  const cause=Object.assign(Error('mock only'),{status:null,signal:'SIGABRT'});
  const f=fixture(()=>{if(broken)throw cause;return absent;});
  await new Promise(r=>setTimeout(r,150));broken=false;
  try{await f.worker.stop();throw Error('unexpected success');}
  catch(e){expect((e as Error).cause).toBe(cause);expect((e as Error).message).toContain('signal=SIGABRT');}
  expect(f.worker.cleanup.verified).toBe(false);
});
test('PID reuse of retained descendant group must not authorize later group signals',async()=>{
  let reused=false;const after:any[]=[];
  const f=fixture(()=>reused?absent+row(43,1,43,fresh):absent+row()+row(43,42,43),(p,s)=>{
    if(reused)after.push([p,s]);
    if(p===42){reused=true;f.child.exitCode=0;}
  });
  await expect(f.worker.stop()).rejects.toThrow('survived cleanup');
  console.log('retained descendant group after reuse',JSON.stringify(after));
  expect(after.filter(([p])=>p===-43)).toEqual([]);
});
test('PID reuse of original worker group must not authorize later group signals',async()=>{
  let reused=false;const after:any[]=[];
  const f=fixture(()=>reused?absent+row(42,1,42,fresh):absent+row(),(p,s)=>{
    if(reused)after.push([p,s]);
    if(p===42){reused=true;f.child.exitCode=0;}
  });
  await expect(f.worker.stop()).rejects.toThrow('survived cleanup');
  console.log('original group after reuse',JSON.stringify(after));
  expect(after.filter(([p])=>p===-42)).toEqual([]);
});
test('PID reuse between collection and individual signal must not target replacement',async()=>{
  let reused=false;const after:any[]=[];
  const f=fixture(()=>reused?absent+row(43,1,99,fresh):absent+row()+row(43,42,43),(p,s)=>{
    if(reused)after.push([p,s]);
    if(p===42){reused=true;f.child.exitCode=0;}
  });
  await f.worker.stop();
  console.log('individual after reuse',JSON.stringify(after));
  expect(after.filter(([p])=>p===43)).toEqual([]);
});
test('successful prefix truncated at row boundary cannot establish complete absence',async()=>{
  // Upstream returns only a valid prefix; an omitted live worker is unobservable.
  const f=fixture(()=>absent);
  await f.worker.stop();
  expect(f.worker.cleanup.verified).toBe(false);
});
```

## Document validation and handoff

The supplied check was run from the worker root and exited 0:

```sh
node -e 'const s=require("node:fs").readFileSync("docs/cleanup-review.md","utf8"); for(const x of ["5b8db766d394c7cdf705d32b667396a803d3b89a","0da456aaa499568296df780012d97f5d7d4ab6cb","tests/process-table-errors.test.ts","PID reuse","restart"]) if(!s.includes(x)) throw Error(x); if(!/PASS|FAIL|NOT RUN/.test(s)) throw Error("verdict required")' && git diff --check
```

After the probes, `git hash-object "$review_root/launcher/child.ts" "$review_root/tests/process-table-errors.test.ts"` exited 0 and returned exactly the two head blobs recorded above. Reviewed source remained unchanged. `git status --short --untracked-files=all` showed only `?? docs/cleanup-review.md`; scratch and the requested delivery bundle are ignored by the existing local excludes. Only this document is staged for delivery.

For the denied Bun script-start boundary, **restart:** run the same script command only in an authorized environment where current-directory discovery is permitted; the direct Node compiler result already provides a separately recorded exact-head typecheck, not a claim that the Bun script command worked.

The requested unsigned docs-only commit and `git bundle create .factory-delivery.bundle HEAD` are launcher handoff artifacts. Their resulting commit/bundle receipts are reported outside this document to avoid self-referential commit identifiers. No signing, push, merge, PR edit, hosted acceptance, browser work, messages, jobs, guard/policy/schedule changes, credentials or custody/debit resets are part of this review. Scratch evidence is preserved. Undo is a later reviewed revert of this document; no operational assets need deletion or reset.
