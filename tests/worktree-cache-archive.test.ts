import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../tracking/store";
import { ticket } from "./fixtures";
import { archiveWorktreeCaches, planWorktreeCacheArchive, type CacheArchiveConfig, type CacheArchiveScope } from "../launcher/worktree-cache-archive";

// Fictional, isolated local repositories only. Retain fixtures/receipts in
// ignored scratch; no cleanup deletion, network, signals, or installed state.
const scratch = resolve(".factory-tmp/cache-archive-tests");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
function git(path: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fictional Test", "-c", "user.email=fixture@example.invalid", "-C", path, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.status !== 0 || r.error) throw Error(`fixture Git: ${r.stderr} ${r.error ?? ""}`);
  return r.stdout.trim();
}
function fixture(options: { tracked?: boolean; unignored?: boolean } = {}) {
  const dir = mkdtempSync(join(scratch, "case-")), source = join(dir, "source"), roots = join(dir, "workspaces"), workspace = join(roots, "synthetic"), archive = join(dir, "archive");
  for (const p of [source, roots, archive]) mkdirSync(p, { mode: 0o700 });
  git(source, "init", "-b", "fixture");
  writeFileSync(join(source, ".gitignore"), `${options.unignored ? "" : ".next/cache/\n"}.turbo/\nnode_modules/.cache/\n.factory-delivery.bundle\n`);
  writeFileSync(join(source, "source.txt"), "preserve source\n");
  if (options.tracked) {
    mkdirSync(join(source, ".next/cache"), { recursive: true });
    writeFileSync(join(source, ".next/cache/entry"), "regenerable fixture cache");
    git(source, "add", "-f", ".next/cache/entry");
  }
  git(source, "add", "."); git(source, "commit", "-m", "fictional base");
  git(source, "worktree", "add", "-b", "fixture-worker", workspace);
  const path = join(workspace, ".next/cache");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "entry"), "regenerable fixture cache");
  writeFileSync(join(workspace, ".factory-delivery.bundle"), "preserved carrier");
  const now = Date.now() + 13 * 3600000, completed = now - 13 * 3600000;
  const s = new Store(":memory:"), id = "synthetic", native = "synthetic-native";
  s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief,native_id,pid,started) VALUES(?,?,?,?,?,?,?,?,?)").run(id, "example/demo#1", "builder", "codex", "finished", JSON.stringify(ticket()), native, null, completed - 1000);
  s.set(`native-evidence:${id}`, { verified: true, bound: true, id: native });
  s.set(`cleanup-evidence:${id}`, { verified: true });
  s.event(`workspace:${id}`, "workspace", { id, workspace }, "fixture undo", completed);
  s.event(`exit:${id}`, "worker-exit", { id, ok: true }, "fixture undo", completed);
  const publication = { id, repo: "example/demo", tree: git(workspace, "rev-parse", "HEAD^{tree}"), head: git(workspace, "rev-parse", "HEAD"), url: "https://github.com/example/demo/pull/1" };
  s.event(`publish:${id}`, "launcher-publish", publication, "fixture undo", completed);
  let refs: unknown = { complete: true, observedAt: now, receipt: "fictional complete process inventory", paths: [] };
  const config: CacheArchiveConfig = { worktreeRoots: [roots], repositories: { "example/demo": source }, archiveRoot: archive, processReferences: () => refs };
  const scope: CacheArchiveScope = { kind: "session", session: id };
  const plan = () => planWorktreeCacheArchive(s, config, scope, now);
  const run = (dryRun = false) => archiveWorktreeCaches(s, config, plan(), { dryRun, now });
  return { dir, source, workspace, roots, archive, path, s, id, native, now, completed, config, scope, publication, plan, run, refs: (r: unknown) => { refs = r; } };
}

test("daily and per-session plans identify only exact eligible ignored cache with private evidence", () => {
  const f = fixture(), before = f.s.rows("events").length;
  for (const p of [f.plan(), planWorktreeCacheArchive(f.s, f.config, { kind: "daily", day: "2026-11-10" }, f.now)]) {
    expect(p.status).toBe("ready"); expect(p.skipped.filter(x => !x.reason.includes("ENOENT"))).toEqual([]); expect(p.count).toBe(1); expect(p.files).toBe(1);
    expect(p.bytes).toBe(Buffer.byteLength("regenerable fixture cache"));
    expect(p.candidates[0]).toMatchObject({ path: f.path, session: f.id, native: f.native, source: f.source, publication: f.publication });
    expect(p.candidates[0]!.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(p.reclaimedBytes).toBe(0);
  }
  expect(f.s.rows("events").length).toBe(before);
});

test("default and explicit dry runs do not write receipts or move artifacts", () => {
  const f = fixture(), plan = f.plan(), before = f.s.rows("events").length;
  for (const r of [archiveWorktreeCaches(f.s, f.config, plan, { now: f.now }), f.run(true)]) {
    expect(r.status).toBe("dry-run"); expect(r.count).toBe(1); expect(r.bytes).toBe(plan.bytes);
    expect(r.planned[0]).toMatchObject({ source: f.path, files: 1, manifest: plan.candidates[0]!.manifest.digest });
    expect(r.moved).toEqual([]);
  }
  expect(f.s.rows("events").length).toBe(before);
  expect(existsSync(f.path)).toBe(true);
});

test("archive preserves exact cache and carriers, journals custody/undo, and permits non-overwriting restoration", () => {
  const f = fixture(), plan = f.plan(), r = f.run();
  expect(r.status).toBe("archived"); expect(r.count).toBe(1); expect(r.bytes).toBe(plan.bytes); expect(r.reclaimedBytes).toBe(0);
  const move = r.moved[0]!;
  expect(move.source).toBe(f.path); expect(readFileSync(join(move.destination, "entry"), "utf8")).toBe("regenerable fixture cache");
  expect(existsSync(f.path)).toBe(false); expect(lstatSync(join(f.archive, r.id)).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(f.workspace, ".factory-delivery.bundle"), "utf8")).toBe("preserved carrier");
  expect(readFileSync(join(f.source, "source.txt"), "utf8")).toBe("preserve source\n");
  const rows = f.s.rows("events") as { kind: string; undo: string; data: string }[];
  expect(rows.filter(e => e.kind.startsWith("worktree-cache-archive")).map(e => e.kind)).toEqual(["worktree-cache-archive-intent", "worktree-cache-archive-move", "worktree-cache-archive-result"]);
  expect(rows.at(-1)!.undo).toContain("never overwrite"); expect(JSON.parse(rows.at(-1)!.data)).toEqual(r);
  expect(f.plan().count).toBe(0);
  renameSync(move.destination, move.source);
  expect(f.plan().candidates[0]!.manifest.digest).toBe(move.manifest);
});

for (const status of ["starting", "running", "paused", "waiting-browser", "unknown", "archived"]) test(`skip ${status} session even with publication`, () => {
  const f = fixture(); f.s.db.query("UPDATE sessions SET status=?").run(status);
  expect(f.plan().count).toBe(0); expect(f.run().moved).toEqual([]); expect(existsSync(f.path)).toBe(true);
});

for (const change of ["pid", "native", "cleanup", "exit", "publication", "workspace", "source", "recent", "tree", "browser"]) test(`unknown or unsafe ${change} evidence refuses eligibility`, () => {
  const f = fixture();
  if (change === "pid") f.s.db.query("UPDATE sessions SET pid=123").run();
  if (change === "native") f.s.set(`native-evidence:${f.id}`, { verified: true, bound: true, id: "other" });
  if (change === "cleanup") f.s.set(`cleanup-evidence:${f.id}`, { verified: false });
  if (change === "exit") f.s.event("extra-exit", "worker-exit", { id: f.id, ok: false }, "fixture", f.completed);
  if (change === "publication") f.s.event("extra-publication", "launcher-publish", f.publication, "fixture", f.completed);
  if (change === "workspace") f.s.event("extra-workspace", "workspace", { id: f.id, workspace: f.workspace }, "fixture", f.completed);
  if (change === "source") delete (f.config.repositories as Record<string, string>)["example/demo"];
  if (change === "recent") return expect(planWorktreeCacheArchive(f.s, f.config, f.scope, f.completed + 12 * 3600000 - 1).count).toBe(0);
  if (change === "tree") { writeFileSync(join(f.workspace, "other.txt"), "different tree"); git(f.workspace, "add", "."); git(f.workspace, "commit", "-m", "different tree"); }
  if (change === "browser") f.s.set(`browser-parent:${f.id}`, { state: "RW" });
  expect(f.plan().count).toBe(0); expect(existsSync(f.path)).toBe(true);
});

for (const location of ["source", "workspace"] as const) test(`dirty ${location} is preserved and skipped`, () => {
  const f = fixture(); writeFileSync(join(f[location], "source.txt"), "uncommitted work");
  expect(f.plan().count).toBe(0); expect(f.run().count).toBe(0);
  expect(readFileSync(join(f[location], "source.txt"), "utf8")).toBe("uncommitted work");
});

test("recent descendant refuses entire cache; exactly 12h is eligible", () => {
  const f = fixture(); utimesSync(join(f.path, "entry"), new Date(f.now), new Date(f.now));
  expect(f.plan().count).toBe(0);
  utimesSync(join(f.path, "entry"), new Date(f.now - 12 * 3600000), new Date(f.now - 12 * 3600000));
  expect(f.plan().count).toBe(1);
});

test("tracked files inside ignored cache refuse whole artifact", () => {
  const f = fixture({ tracked: true }), p = f.plan();
  expect(p.count).toBe(0); expect(p.skipped.some(x => x.reason.includes("tracked artifact"))).toBe(true);
  expect(git(f.workspace, "status", "--porcelain")).toBe("");
});

test("unignored cache is retained as untracked source work", () => {
  const f = fixture({ unignored: true });
  expect(f.plan().count).toBe(0); expect(existsSync(f.path)).toBe(true);
});

for (const where of ["entry", "cache", "ancestor", "archive"]) test(`symlink ${where} refuses without following`, () => {
  const f = fixture();
  if (where === "entry") symlinkSync(join(f.source, "source.txt"), join(f.path, "link"));
  if (where === "cache") { renameSync(f.path, join(f.dir, "saved-cache")); symlinkSync(join(f.dir, "saved-cache"), f.path); }
  if (where === "ancestor") { renameSync(join(f.workspace, ".next"), join(f.dir, "saved-next")); symlinkSync(join(f.dir, "saved-next"), join(f.workspace, ".next")); }
  if (where === "archive") { const link = join(f.dir, "archive-link"); symlinkSync(f.archive, link); f.config.archiveRoot = link; }
  expect(f.plan().count).toBe(0); expect(f.run().count).toBe(0);
  expect(readFileSync(join(f.source, "source.txt"), "utf8")).toBe("preserve source\n");
});

for (const evidence of [undefined, { complete: false }, { complete: true, observedAt: 1, receipt: "stale", paths: [] }]) test(`missing/partial/stale process inventory blocks globally: ${JSON.stringify(evidence)}`, () => {
  const f = fixture(); f.refs(evidence);
  expect(f.plan().status).toBe("blocked"); expect(f.run().status).toBe("blocked"); expect(existsSync(f.path)).toBe(true);
});
for (const target of ["workspace", "source", "path"] as const) test(`process reference to ${target} refuses`, () => {
  const f = fixture(); f.refs({ complete: true, observedAt: f.now, receipt: "fictional inventory", paths: [f[target]] });
  expect(f.plan().count).toBe(0); expect(existsSync(f.path)).toBe(true);
});

for (const destination of ["missing", "overlap", "public", "absent"]) test(`unusable ${destination} archive destination blocks and retains`, () => {
  const f = fixture();
  if (destination === "missing") delete f.config.archiveRoot;
  if (destination === "overlap") f.config.archiveRoot = f.workspace;
  if (destination === "public") chmodSync(f.archive, 0o755);
  if (destination === "absent") f.config.archiveRoot = join(f.dir, "not-created");
  expect(f.plan().status).toBe("blocked"); expect(f.run().status).toBe("blocked"); expect(existsSync(f.path)).toBe(true);
});

for (const change of ["cache", "custody", "destination", "process", "allowlist", "duplicate", "stale"]) test(`execution revalidates ${change} and retains artifacts`, () => {
  const f = fixture(), p = f.plan();
  if (change === "cache") writeFileSync(join(f.path, "entry"), "changed");
  if (change === "custody") f.s.db.query("UPDATE sessions SET status='waiting-browser'").run();
  if (change === "destination") f.config.archiveRoot = f.roots;
  if (change === "process") f.refs({ complete: true, observedAt: f.now, receipt: "new process", paths: [f.path] });
  if (change === "allowlist") p.candidates[0]!.cache = "source.txt";
  if (change === "duplicate") p.candidates.push(p.candidates[0]!);
  const r = archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now + (change === "stale" ? 30001 : 0) });
  expect(r.status).toBe("blocked"); expect(r.count).toBe(0); expect(existsSync(f.path)).toBe(true);
});

test("invalid scope and unknown session never invent work", () => {
  const f = fixture();
  expect(planWorktreeCacheArchive(f.s, f.config, { kind: "daily", day: "2026-02-30" }, f.now).status).toBe("blocked");
  expect(planWorktreeCacheArchive(f.s, f.config, { kind: "session", session: "missing" }, f.now).count).toBe(0);
});

test("rename failure retains artifact and committed exact intent, with no deletion fallback", () => {
  const f = fixture(), p = f.plan();
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(Error("EXDEV fictional device boundary"), { code: "EXDEV" }); });
  let r;
  try { r = archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now }); }
  finally { rename.mockRestore(); }
  expect(r.status).toBe("blocked"); expect(r.count).toBe(0); expect(r.blockers.join()).toContain("EXDEV");
  expect(existsSync(f.path)).toBe(true);
  const intent = f.s.db.query("SELECT data FROM events WHERE kind='worktree-cache-archive-intent'").get() as { data: string };
  expect(JSON.parse(intent.data).destinations).toEqual([{ source: f.path, destination: join(f.archive, r.id, "0") }]);
});

test("cross-device and full destination planning refuse without moving", () => {
  const f = fixture(), original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (args[0] === f.archive) Object.defineProperty(result, "dev", { value: Number(result!.dev) + 1 });
    return result;
  }) as typeof fs.lstatSync);
  try { expect(f.plan().status).toBe("blocked"); expect(existsSync(f.path)).toBe(true); }
  finally { stat.mockRestore(); }
  const full = fs.statfsSync(f.archive);
  const space = spyOn(fs, "statfsSync").mockReturnValue({ ...full, bavail: 0 });
  try { expect(f.plan().status).toBe("blocked"); expect(existsSync(f.path)).toBe(true); }
  finally { space.mockRestore(); }
});

test("committed intent survives result journaling failure after a successful rename", () => {
  const f = fixture(), p = f.plan(), event = f.s.event.bind(f.s);
  f.s.event = (...args: Parameters<Store["event"]>) => {
    if (["worktree-cache-archive-move", "worktree-cache-archive-result"].includes(args[1])) throw Error("fictional receipt failure");
    return event(...args);
  };
  const r = archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now });
  expect(r.status).toBe("blocked"); expect(r.count).toBe(1);
  expect(readFileSync(join(r.moved[0]!.destination, "entry"), "utf8")).toBe("regenerable fixture cache");
  expect(f.s.db.query("SELECT id FROM events WHERE kind='worktree-cache-archive-intent'").all()).toHaveLength(1);
});

test("outer transaction refuses so rollback cannot erase archive intents", () => {
  const f = fixture(), p = f.plan();
  const r = f.s.atomic(() => archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now }));
  expect(r.status).toBe("blocked"); expect(r.blockers.join()).toContain("outer transaction"); expect(existsSync(f.path)).toBe(true);
});

test("custody shared with another session refuses even in per-session plans", () => {
  const f = fixture(); f.s.event("other-workspace", "workspace", { id: "other-live-session", workspace: f.workspace }, "fixture", f.completed);
  expect(f.plan().count).toBe(0); expect(existsSync(f.path)).toBe(true);
});

test("hardlinked cache entries refuse, preserving both names", () => {
  const f = fixture(), alias = join(f.dir, "cache-alias");
  linkSync(join(f.path, "entry"), alias);
  expect(f.plan().count).toBe(0); expect(existsSync(alias)).toBe(true); expect(existsSync(join(f.path, "entry"))).toBe(true);
});

test("a new process reference after intent refuses the move", () => {
  const f = fixture(), p = f.plan(); let reads = 0;
  f.config.processReferences = () => ({ complete: true, observedAt: f.now, receipt: "fictional fresh inventory", paths: ++reads > 1 ? [f.path] : [] });
  const r = archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now });
  expect(r.status).toBe("blocked"); expect(r.count).toBe(0); expect(existsSync(f.path)).toBe(true);
  expect(f.s.db.query("SELECT id FROM events WHERE kind='worktree-cache-archive-intent'").all()).toHaveLength(1);
});

test("partial archive retains completed moves and refuses the failed artifact without replay", () => {
  const f = fixture(), second = join(f.workspace, ".turbo");
  mkdirSync(second); writeFileSync(join(second, "entry"), "second regenerable cache");
  const p = f.plan(); expect(p.count).toBe(2);
  const original = fs.renameSync; let calls = 0;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (++calls === 2) throw Error("fictional second rename refusal");
    original(from, to);
  });
  let r;
  try { r = archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now }); }
  finally { rename.mockRestore(); }
  expect(r.status).toBe("blocked"); expect(r.count).toBe(1); expect(r.planned).toHaveLength(2);
  expect(existsSync(r.moved[0]!.destination)).toBe(true); expect(existsSync(second)).toBe(true);
  expect(archiveWorktreeCaches(f.s, f.config, p, { dryRun: false, now: f.now }).status).toBe("blocked");
  expect(existsSync(second)).toBe(true);
});
