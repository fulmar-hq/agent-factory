import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, linkSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { collectCodexRenewalEvidence, readCodexRenewalReceipt, securityChecks, type CodexRenewalManifest, type ReceiptRef } from "../launcher/codex-renewal-evidence";

// Entirely fictional retained owner captures. No model, target, process, socket,
// subscription command or qualification replacement is executed by this suite.
const startedAt = Date.parse("2026-11-09T12:00:00Z"), now = startedAt + 700000;
const digest = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (x: unknown) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x));
const jsonl = (rows: unknown[]) => rows.map(x => JSON.stringify(x)).join("\n") + "\n";
function fixture(root = "/fictional") {
  const files = new Map<string, Uint8Array>();
  const put = (name: string, value: unknown): ReceiptRef => {
    const data = bytes(value), path = `${root}/${name}`;
    files.set(path, data); return { path, sha256: digest(data) };
  };
  const probe = put("probe.py", "# fictional 12-check probe, never executed\n");
  const q = { codex: { phoneVerified: false, waiver: { phone: "deferred" }, expiresAt: startedAt - 1, evidence: "retained old receipt" },
    "codex:medium": { phoneVerified: false, waiver: { phone: "deferred" } }, "codex:high": { phoneVerified: false, waiver: { phone: "deferred" } },
    claude: { expiresAt: 123, evidence: "opaque original", phoneVerified: false, waiver: { phone: "deferred" } }, unknown: ["preserved"] };
  const m: CodexRenewalManifest = { version: 1, runId: id(99), startedAt, expiresAt: startedAt + 86400000, model: "gpt-6.1-sol", probe,
    qualifications: put("qualifications.json", JSON.stringify(q, null, 4) + "\n"), sources: [put("workers.ts", "fictional adapter fingerprint")],
    subscription: put("subscription.json", { argv: ["codex", "login", "status"], code: 0, signal: null, stdout: "", stderr: "Logged in using ChatGPT\n", observedAt: startedAt }), runs: [] };
  const output = JSON.stringify(Object.fromEntries(securityChecks.map(k => [k, true]))) + "\n";
  for (const effort of ["medium", "high"] as const) for (const kind of ["security", "time", "tokens"] as const) {
    const n = m.runs.length + 1, start = startedAt + n * 100000, end = start + (kind === "time" ? 55000 : 2000), nativeId = id(n), workspace = root;
    const u = { input_tokens: kind === "tokens" ? 200 : 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: kind === "tokens" ? 210 : 110 };
    const row = (offset: number, type: string, payload: unknown) => ({ timestamp: new Date(start + offset).toISOString(), type, payload });
    const command = `/usr/bin/python3 ${probe.path}`;
    const rollout: unknown[] = [row(0, "session_meta", { id: nativeId, cwd: workspace }), row(1, "turn_context", { model: m.model, effort, cwd: workspace })];
    if (kind === "security") rollout.push(row(20, "response_item", { type: "function_call", name: "exec_command", call_id: "tool-1", arguments: JSON.stringify({ cmd: command }) }),
      row(50, "response_item", { type: "function_call_output", call_id: "tool-1", output: "Wall time: 0.1 seconds\nOutput:\n" + output }));
    rollout.push(row(100, "event_msg", { type: "token_count", info: { total_token_usage: { ...u, reasoning_output_tokens: 2 } } }));
    if (kind === "security") rollout.push(row(900, "event_msg", { type: "task_complete" }));
    const stream: unknown[] = [{ type: "thread.started", thread_id: nativeId }];
    if (kind === "security") stream.push({ type: "item.completed", item: { id: "tool-1", type: "command_execution", command, exit_code: 0, aggregated_output: output } }, { type: "turn.completed", usage: u });
    const parent = { pid: n * 100, parent: 1, group: n * 100, identity: `parent-start-${n}`, state: "S" };
    const child = { pid: n * 100 + 1, parent: parent.pid, group: n * 100 + 1, identity: `child-start-${n}`, state: "S" };
    const stopAt = kind === "time" ? start + 50000 : kind === "tokens" ? start + 1000 : null;
    const snapshot = (at: number, rows: unknown[]) => ({ at, error: null, rows });
    const supervisor = { runId: m.runId, nativeId, workspace, startedAt: start, endedAt: end, pid: parent.pid, identity: parent.identity,
      probeBeforeSha256: probe.sha256, probeAfterSha256: probe.sha256,
      reason: kind === "security" ? "complete" : kind, timeBudget: kind === "time" ? { estimateSeconds: 25, pauseSeconds: 50 } : null, tokenBudget: kind === "tokens" ? { estimateTokens: 100, pauseTokens: 200 } : null, exitCode: kind === "security" ? 0 : null, signal: kind === "security" ? null : "SIGTERM", stopAt,
      samples: [{ at: start + 500, alive: true, usage: u }], before: snapshot(start + 500, kind === "time" ? [parent, child] : [parent]),
      afterTerm: kind === "time" ? snapshot(start + 52000, [child]) : null, final: snapshot(end, []),
      descendant: kind === "time" ? { pid: child.pid, identity: child.identity } : null,
      signals: kind === "security" ? [] : [{ pid: parent.pid, identity: parent.identity, at: stopAt, signal: "SIGTERM" },
        ...(kind === "time" ? [{ pid: child.pid, identity: child.identity, at: stopAt, signal: "SIGTERM" }, { pid: child.pid, identity: child.identity, at: start + 53000, signal: "SIGKILL" }] : [])] };
    m.runs.push({ nativeId, effort, kind, workspace, startedAt: start, endedAt: end,
      stream: put(`stream-${n}`, "OpenAI Codex v0.0 fictional CLI banner\n" + jsonl(stream)), rollout: put(`rollout-${n}`, jsonl(rollout)), supervisor: put(`supervisor-${n}`, supervisor),
      ...(kind === "security" ? { command, commandProbe: put(`command-${n}`, { runId: m.runId, nativeId, workspace, command, probeSha256: probe.sha256, probeAfterSha256: probe.sha256,
        startedAt: start - 500, endedAt: start - 100, code: 0, signal: null, stdout: output,
        targets: securityChecks.slice(0, 6).map(check => ({ check, target: `/fictional/known-${check}`, existedAt: start - 1000, kind: check === "known_agent_socket" ? "socket" : "file" })) }) } : {}) });
  }
  const read = (path: string) => { const data = files.get(path); if (!data) throw Error(`missing ${path}`); return data; };
  const mutate = (ref: ReceiptRef, change: (x: any) => void, native = false) => {
    const old = Buffer.from(read(ref.path)).toString();
    const value = native ? old.trimEnd().split("\n").map(x => JSON.parse(x)) : JSON.parse(old);
    change(value); const data = bytes(native ? jsonl(value) : value); files.set(ref.path, data); ref.sha256 = digest(data);
  };
  const collect = (opts: Parameters<typeof collectCodexRenewalEvidence>[1] = {}) => collectCodexRenewalEvidence(m, { read, clock: () => now, ...opts });
  return { m, files, read, mutate, collect };
}

test("six independently joined receipts verify without changing any qualification/source bytes", () => {
  const f = fixture(), before = [...f.files].map(([p, b]) => [p, Buffer.from(b).toString("hex")]);
  const r = f.collect(); expect(r.reason).toBeUndefined(); expect(r.status).toBe("verified"); expect(r.verifiedRuns).toHaveLength(6);
  expect(r).toMatchObject({ sourceAcceptance: "verified", installedAcceptance: "not-run", qualificationReplacement: "not-performed", cleanup: "verified", independentExactHeadChallenge: "required-before-release" });
  expect([...f.files].map(([p, b]) => [p, Buffer.from(b).toString("hex")])).toEqual(before);
  expect(r.verifiedRuns.map(x => x.usage.total_tokens)).toEqual([110, 110, 210, 110, 110, 210]); // overshoot retained
});

const rejectionCases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["missing raw receipt", f => f.files.delete(f.m.runs[0].rollout.path)],
  ["tampered bytes", f => f.files.set(f.m.probe.path, bytes("changed"))],
  ["different provider", f => { (f.m as any).provider = "claude"; }],
  ["wrong model request", f => { (f.m as any).model = "other"; }],
  ["missing high effort", f => { for (const r of f.m.runs) r.effort = "medium"; }],
  ["reused native ID", f => { f.m.runs[5].nativeId = f.m.runs[0].nativeId; }],
  ["missing independent token run", f => { f.m.runs[5].kind = "time"; }],
  ["wrong rollout identity", f => f.mutate(f.m.runs[0].rollout, x => { x[0].payload.id = id(98); }, true)],
  ["wrong workspace", f => f.mutate(f.m.runs[0].rollout, x => { x[0].payload.cwd = "/unrelated"; }, true)],
  ["wrong effort", f => f.mutate(f.m.runs[3].rollout, x => { x[1].payload.effort = "medium"; }, true)],
  ["conflicting model", f => f.mutate(f.m.runs[0].rollout, x => { x.splice(2, 0, { ...x[1], payload: { model: "other", effort: "medium" } }); }, true)],
  ["stale rollout", f => f.mutate(f.m.runs[0].rollout, x => { x[0].timestamp = new Date(startedAt - 1).toISOString(); }, true)],
  ["native clock regression", f => f.mutate(f.m.runs[0].rollout, x => { x[3].timestamp = x[0].timestamp; }, true)],
  ["missing context", f => f.mutate(f.m.runs[0].rollout, x => { x.splice(1, 1); }, true)],
  ["missing accounting", f => f.mutate(f.m.runs[0].rollout, x => { x.splice(4, 1); }, true)],
  ["negative native counter", f => f.mutate(f.m.runs[0].rollout, x => { x[4].payload.info.total_token_usage.total_tokens = -1; }, true)],
  ["double-counted cache", f => f.mutate(f.m.runs[0].rollout, x => { x[4].payload.info.total_token_usage.total_tokens += 20; }, true)],
  ["inconsistent live sample", f => f.mutate(f.m.runs[0].supervisor, x => { x.samples[0].usage.total_tokens++; })],
  ["no positive live accounting", f => f.mutate(f.m.runs[0].supervisor, x => { x.samples = []; })],
  ["supervisor identity mismatch", f => f.mutate(f.m.runs[0].supervisor, x => { x.nativeId = id(98); })],
  ["missing subscription", f => f.mutate(f.m.subscription, x => { x.stderr = "not logged in"; })],
  ["API route", f => f.mutate(f.m.subscription, x => { x.stderr += " API key"; })],
  ["failed login status", f => f.mutate(f.m.subscription, x => { x.code = 1; })],
  ["future subscription", f => f.mutate(f.m.subscription, x => { x.observedAt = now + 1; })],
  ["implicit phone waiver", f => f.mutate(f.m.qualifications, x => { delete x.codex.waiver; })],
  ["fabricated phone verification", f => f.mutate(f.m.qualifications, x => { x["codex:high"].phoneVerified = true; })],
  ["command probe failure", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.code = 1; })],
  ["wrong command workspace", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.workspace = "/other"; })],
  ["wrong command", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.command = "echo success"; })],
  ["changed probe before run", f => f.mutate(f.m.runs[0].supervisor, x => { x.probeBeforeSha256 = "0".repeat(64); })],
  ["changed probe after run", f => f.mutate(f.m.runs[0].supervisor, x => { x.probeAfterSha256 = "0".repeat(64); })],
  ["changed command probe", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.probeAfterSha256 = "0".repeat(64); })],
  ["missing known target", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.targets.pop(); })],
  ["late preflight", f => f.mutate(f.m.runs[0].commandProbe!, x => { x.targets[0].existedAt = now; })],
  ["assistant claim instead of tool", f => f.mutate(f.m.runs[0].rollout, x => { x[2].payload.type = "message"; }, true)],
  ["unbound tool output", f => f.mutate(f.m.runs[0].rollout, x => { x[3].payload.call_id = "other"; }, true)],
  ["native command failed", f => { const r = f.m.runs[0]; const rows = Buffer.from(f.read(r.stream.path)).toString().split("\n"); rows[2] = rows[2].replace('"exit_code":0', '"exit_code":1'); const b = bytes(rows.join("\n")); f.files.set(r.stream.path, b); r.stream.sha256 = digest(b); }],
  ["time stop too early", f => f.mutate(f.m.runs[1].supervisor, x => { x.stopAt = x.startedAt + 24000; })],
  ["wrong original time estimate", f => f.mutate(f.m.runs[1].supervisor, x => { x.timeBudget.estimateSeconds = 24; })],
  ["missing time guard", f => f.mutate(f.m.runs[1].supervisor, x => { x.timeBudget = null; })],
  ["wrong token budget", f => f.mutate(f.m.runs[2].supervisor, x => { x.tokenBudget.estimateTokens = 99; })],
  ["missing descendant", f => f.mutate(f.m.runs[1].supervisor, x => { x.descendant = null; })],
  ["TERM ignoring not observed", f => f.mutate(f.m.runs[1].supervisor, x => { x.afterTerm.rows = []; })],
  ["descendant not killed", f => f.mutate(f.m.runs[1].supervisor, x => { x.signals.pop(); })],
  ["cleanup unknown", f => f.mutate(f.m.runs[1].supervisor, x => { x.final.error = "ps unavailable"; })],
  ["late descendant survives", f => f.mutate(f.m.runs[1].supervisor, x => { x.final.rows = [{ pid: 999, parent: x.descendant.pid, group: 999, identity: "late-child", state: "S" }]; })],
  ["surviving descendant", f => f.mutate(f.m.runs[1].supervisor, x => { x.final.rows = x.afterTerm.rows; })],
  ["unobserved group survivor", f => f.mutate(f.m.runs[1].supervisor, x => { x.final.rows = [{ ...x.before.rows[0], pid: 999, identity: "other" }]; })],
  ["PID reused before stop", f => f.mutate(f.m.runs[1].supervisor, x => { x.before.rows[0].identity = "other"; })],
  ["unbound signal identity", f => f.mutate(f.m.runs[1].supervisor, x => { x.signals[0].identity = "other"; })],
  ["task_completed before token stop", f => f.mutate(f.m.runs[2].rollout, x => { x.push({ ...x.at(-1), payload: { type: "task_completed" } }); }, true)],
  ["stop after natural completion", f => f.mutate(f.m.runs[2].rollout, x => { x.push({ ...x.at(-1), payload: { type: "task_complete" } }); }, true)],
  ["successful token completion", f => f.mutate(f.m.runs[2].supervisor, x => { x.exitCode = 0; x.signal = null; })],
  ["unknown token exit", f => f.mutate(f.m.runs[2].supervisor, x => { x.exitCode = null; x.signal = null; })],
  ["mocked SIGABRT is not a stop receipt", f => f.mutate(f.m.runs[2].supervisor, x => { x.signal = "SIGABRT"; })],
  ["expired proof", f => { f.m.expiresAt = now; }],
  ["excess proof lifetime", f => { f.m.expiresAt = startedAt + 86400001; }],
  ["reused file path", f => { f.m.sources.push({ ...f.m.sources[0] }); }],
];
for (const [name, change] of rejectionCases) test(`fail closed: ${name}`, () => {
  const f = fixture(); change(f); const r = f.collect();
  expect(r.status).not.toBe("verified"); expect(r.reason).toBeDefined(); expect(r.sourceAcceptance).toBe("not-accepted"); expect(r.cleanup).toBe("unknown");
});

for (const check of securityChecks) for (const channel of ["command", "native", "stream"] as const) test(`requires ${check} in ${channel} security receipt`, () => {
  const f = fixture(), r = f.m.runs[0];
  if (channel === "command") f.mutate(r.commandProbe!, x => { const o = JSON.parse(x.stdout); o[check] = false; x.stdout = JSON.stringify(o); });
  if (channel === "native") f.mutate(r.rollout, x => { const o = JSON.parse(x[3].payload.output.split("\n").find((l: string) => l.startsWith("{"))); o[check] = false; x[3].payload.output = JSON.stringify(o); }, true);
  if (channel === "stream") { const raw = Buffer.from(f.read(r.stream.path)).toString().replace(`\\"${check}\\":true`, `\\"${check}\\":false`); const b = bytes(raw); f.files.set(r.stream.path, b); r.stream.sha256 = digest(b); }
  expect(f.collect().status).toBe("refused");
});

test("100-token estimate must reach its frozen 200-token pause before stop", () => {
  const f = fixture(), r = f.m.runs[2];
  f.mutate(r.rollout, x => { x[2].payload.info.total_token_usage = { input_tokens: 80, output_tokens: 10, cached_input_tokens: 20, total_tokens: 90 }; }, true);
  f.mutate(r.supervisor, x => { x.samples[0].usage = { input_tokens: 80, output_tokens: 10, cached_input_tokens: 20, total_tokens: 90 }; });
  expect(f.collect().reason).toContain("100-token");
});

test("partial proof stays retained and does not cause retries or synthetic qualification", () => {
  const f = fixture(); f.files.delete(f.m.runs[4].rollout.path);
  const before = [...f.files.keys()], r = f.collect(); expect(r.verifiedRuns).toHaveLength(4); expect(r.status).toBe("refused");
  expect([...f.files.keys()]).toEqual(before); expect(f.collect()).toEqual(r);
});

test("F1: final clock regression after rereads refuses", () => {
  const f = fixture(); let calls = 0;
  const r = f.collect({ clock: () => ++calls === 9 ? now - 1 : now });
  expect(calls).toBe(9); expect(r.status).toBe("uncertain"); expect(r.reason).toContain("clock regression");
});
test("expiry during final reread is not acceptance", () => {
  const f = fixture(); let calls = 0;
  expect(f.collect({ clock: () => ++calls === 9 ? f.m.expiresAt : now }).status).toBe("uncertain");
});
for (const name of ["qualifications", "probe", "source", "rollout"] as const) test(`concurrent ${name} changes refuse after verification`, () => {
  const f = fixture(), counts = new Map<string, number>();
  const target = name === "qualifications" ? f.m.qualifications : name === "probe" ? f.m.probe : name === "source" ? f.m.sources[0] : f.m.runs[0].rollout;
  const r = f.collect({ read: path => { const n = (counts.get(path) ?? 0) + 1; counts.set(path, n); return path === target.path && n === 2 ? bytes("concurrent change") : f.read(path); } });
  expect(r.status).toBe("uncertain"); expect(r.sourceAcceptance).toBe("not-accepted"); expect(r.reason).toContain("changed");
});
for (const phase of ["initial", "final"] as const) test(`read-only F2/F3 boundary: ${phase} I/O failure returns structured result`, () => {
  const fault = "EIO";
  const f = fixture(); let reads = 0;
  const r = f.collect({ read: path => { if (path === f.m.qualifications.path && ++reads === (phase === "initial" ? 1 : 2)) throw Error(fault); return f.read(path); } });
  expect(r.status).toBe(phase === "initial" ? "refused" : "uncertain"); expect(r.reason).toContain(fault); expect(r.qualificationReplacement).toBe("not-performed");
});

test("CLI banners cannot supply events; torn native tails and malformed JSON fail", () => {
  for (const raw of ["OpenAI Codex banner only\n", '{"type":broken}\n', '{"type":"thread.started"}', "{}\n"]) {
    const f = fixture(), ref = f.m.runs[0].stream, b = bytes(raw); f.files.set(ref.path, b); ref.sha256 = digest(b);
    expect(f.collect().status).toBe("refused");
  }
});

test("default reader collects actual regular files and refuses symlinks/hardlinks/missing files", () => {
  const scratch = resolve(".factory-tmp/renewal-evidence-tests"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "retained-")), path = join(dir, "receipt"); writeFileSync(path, "fictional receipt\n");
  expect(Buffer.from(readCodexRenewalReceipt(path)).toString()).toBe("fictional receipt\n");
  const symbolic = join(dir, "symbolic"); symlinkSync(path, symbolic);
  expect(() => readCodexRenewalReceipt(symbolic)).toThrow();
  const hard = join(dir, "hard"); linkSync(path, hard);
  expect(() => readCodexRenewalReceipt(path)).toThrow("single-link");
  expect(() => readCodexRenewalReceipt(dir)).toThrow("regular"); expect(() => readCodexRenewalReceipt(join(dir, "missing"))).toThrow();
  expect(readFileSync(path, "utf8")).toBe("fictional receipt\n"); // retain, never delete
});


test("native counters cannot regress even when final/live values agree", () => {
  const f = fixture(), r = f.m.runs[0];
  f.mutate(r.rollout, rows => {
    const counter = structuredClone(rows[4]); counter.timestamp = new Date(r.startedAt + 110).toISOString();
    counter.payload.info.total_token_usage = { input_tokens: 99, cached_input_tokens: 20, output_tokens: 10, total_tokens: 109 };
    rows.splice(5, 0, counter);
  }, true);
  expect(f.collect().reason).toContain("accounting regression");
});

test("stream identity conflicts and forged completion cannot supply acceptance", () => {
  for (const event of [{ type: "thread.started", thread_id: id(98) }, { type: "turn.started", model: "other" }, { type: "turn.failed" }]) {
    const f = fixture(), ref = f.m.runs[0].stream, b = Buffer.concat([Buffer.from(f.read(ref.path)), bytes(jsonl([event]))]);
    f.files.set(ref.path, b); ref.sha256 = digest(b);
    expect(f.collect().status).toBe("refused");
  }
});

test("all six fictional captures pass the production filesystem reader", () => {
  const scratch = resolve(".factory-tmp/renewal-evidence-tests"); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "capture-")), f = fixture(dir);
  for (const [path, data] of f.files) writeFileSync(path, data);
  const original = readFileSync(f.m.qualifications.path);
  const result = collectCodexRenewalEvidence(f.m, { clock: () => now });
  expect(result.reason).toBeUndefined(); expect(result.status).toBe("verified"); expect(result.verifiedRuns).toHaveLength(6);
  expect(readFileSync(f.m.qualifications.path)).toEqual(original);
});


test("consistent printf receipts cannot replace the hashed probe", () => {
  const f=fixture(),r=f.m.runs[0],command="printf fake-security-success";r.command=command;
  f.mutate(r.commandProbe!,x=>{x.command=command;});
  f.mutate(r.rollout,x=>{x[2].payload.arguments=JSON.stringify({cmd:command});},true);
  const stream=Buffer.from(f.read(r.stream.path)).toString().replace(`/usr/bin/python3 ${f.m.probe.path}`,command);
  const b=bytes(stream);f.files.set(r.stream.path,b);r.stream.sha256=digest(b);
  expect(f.collect().reason).toContain("hashed workspace probe");
});
test("a late frozen time stop cannot qualify", () => {
  const f=fixture(),r=f.m.runs[1];r.endedAt=r.startedAt+305000;
  f.mutate(r.supervisor,x=>{x.endedAt=r.endedAt;x.stopAt=r.startedAt+300000;x.afterTerm.at=r.startedAt+302000;x.final.at=r.endedAt;for(const signal of x.signals)signal.at=r.startedAt+(signal.signal==="SIGKILL"?303000:300000);});
  expect(f.collect().status).toBe("refused");
});
test("delaying token TERM after observed threshold cannot qualify", () => {
  const f=fixture(),r=f.m.runs[2];r.endedAt=r.startedAt+305000;
  f.mutate(r.supervisor,x=>{x.endedAt=r.endedAt;x.final.at=r.endedAt;x.signals[0].at=r.startedAt+300000;});
  expect(f.collect().status).toBe("refused");
});

test("a native workdir override cannot substitute another relative probe",()=>{const f=fixture(),r=f.m.runs[0],command="/usr/bin/python3 probe.py";r.command=command;f.mutate(r.commandProbe!,x=>{x.command=command;});f.mutate(r.rollout,x=>{x[2].payload.arguments=JSON.stringify({cmd:command,workdir:"/unrelated-workspace"});},true);const raw=Buffer.from(f.read(r.stream.path)).toString().replace(`/usr/bin/python3 ${f.m.probe.path}`,command),b=bytes(raw);f.files.set(r.stream.path,b);r.stream.sha256=digest(b);expect(f.collect().status).toBe("refused");});
test("a late-only descendant cleanup observation cannot qualify",()=>{const f=fixture();f.mutate(f.m.runs[1].supervisor,x=>{x.final.at=now-1;});expect(f.collect().status).toBe("refused");});

test("installed CLI shell wrapper still binds the exact immutable probe",()=>{const f=fixture(),r=f.m.runs[0],raw=Buffer.from(f.read(r.stream.path)).toString().replace(`"command":"/usr/bin/python3 ${f.m.probe.path}"`,`"command":"/bin/zsh -c '/usr/bin/python3 ${f.m.probe.path}'"`),b=bytes(raw);f.files.set(r.stream.path,b);r.stream.sha256=digest(b);expect(f.collect().status).toBe("verified");});

test("turn context cwd cannot redirect a relative probe",()=>{const f=fixture(),r=f.m.runs[0];f.mutate(r.rollout,x=>{x[1].payload.cwd="/unrelated-workspace";},true);expect(f.collect().status).toBe("refused");});
test("an aborted native turn before the budget stop cannot qualify",()=>{const f=fixture(),r=f.m.runs[2];f.mutate(r.rollout,x=>{x.push({timestamp:new Date(r.startedAt+200).toISOString(),type:"event_msg",payload:{type:"turn_aborted"}});},true);expect(f.collect().status).toBe("refused");});

test("a failed earlier tool attempt cannot be hidden by a later passing probe",()=>{const f=fixture(),r=f.m.runs[0];f.mutate(r.rollout,x=>{x.splice(2,0,{timestamp:new Date(r.startedAt+5).toISOString(),type:"response_item",payload:{type:"function_call",name:"exec_command",call_id:"failed",arguments:JSON.stringify({cmd:"/usr/bin/python3 probe.py"})}},{timestamp:new Date(r.startedAt+6).toISOString(),type:"response_item",payload:{type:"function_call_output",call_id:"failed",output:"failed security probe"}});},true);expect(f.collect().status).toBe("refused");});
test("missing turn cwd is unknown rather than workspace evidence",()=>{const f=fixture();f.mutate(f.m.runs[0].rollout,x=>{delete x[1].payload.cwd;},true);expect(f.collect().status).toBe("refused");});

for(const failure of ['error-item','failed-status','tool-exit'] as const)test('explicit '+failure+' refuses despite passing booleans',()=>{const f=fixture(),r=f.m.runs[0];if(failure==='tool-exit')f.mutate(r.rollout,x=>{x[3].payload.output='Process exited with code 1\n'+x[3].payload.output;},true);else{const lines=Buffer.from(f.read(r.stream.path)).toString().split('\n');if(failure==='error-item')lines.splice(2,0,JSON.stringify({type:'item.completed',item:{type:'error',message:'failed'}}));else{const row=JSON.parse(lines[2]);row.item.status='failed';lines[2]=JSON.stringify(row);}const b=bytes(lines.join('\n'));f.files.set(r.stream.path,b);r.stream.sha256=digest(b);}expect(f.collect().status).toBe('refused');});
test('abort between stop intent and actual TERM cannot qualify',()=>{const f=fixture(),r=f.m.runs[2];f.mutate(r.supervisor,x=>{x.signals[0].at=r.startedAt+1200;});f.mutate(r.rollout,x=>{x.push({timestamp:new Date(r.startedAt+1100).toISOString(),type:'event_msg',payload:{type:'turn_aborted'}});},true);expect(f.collect().status).toBe('refused');});
