import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { TicketSchema } from "./config";
import type { Session } from "./engine";
import type { Store } from "../tracking/store";

// Deliberately unconnected API: no tick, disk warning, scheduler, or deletion.
// Call only under controller custody, with admissions/other filesystem writers
// excluded for the duration. The required trusted port must inventory command
// arguments, cwd and open files for ALL processes, resolving aliases to canonical
// paths; partial/denied reads are not
// complete. No default empty inventory can manufacture proof of inactivity.
export type ProcessReferences = {
  complete: true; observedAt: number; receipt: string; paths: string[];
};
export type CacheArchiveConfig = {
  worktreeRoots: readonly string[];
  repositories: Readonly<Record<string, string>>;
  archiveRoot?: string;
  processReferences: () => unknown;
};
export type CacheArchiveScope = { kind: "daily"; day: string } | { kind: "session"; session: string };
const age = 12 * 60 * 60 * 1000;
// Exact regenerable caches only; never entire dependencies, build outputs,
// scratch, source, Git metadata, transcripts, logs, or delivery carriers.
export const regenerableCaches = [".next/cache", ".turbo", "node_modules/.cache"] as const;
const undo = "Retain archive and custody receipt. With writers stopped, verify the manifest and move the exact archived directory back only if its original path is absent; never overwrite. Cross-device restore requires separate review.";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const clock = (now: number) => { const started = performance.now(); return () => now + Math.ceil(performance.now() - started); };
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith("../") && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));
const overlap = (a: string, b: string) => inside(a.toLowerCase(), b.toLowerCase()) || inside(b.toLowerCase(), a.toLowerCase());
function requireEvidence(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
function freshProcess(refs: ProcessReferences, now: number) {
  requireEvidence(refs.observedAt <= now && now - refs.observedAt <= 30000, "process-reference evidence stale/future");
}
function directory(path: string) {
  requireEvidence(isAbsolute(path) && resolve(path) === path, "absolute canonical directory required");
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    requireEvidence(st.isDirectory() && !st.isSymbolicLink(), "symlink/non-directory ancestor refused");
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  requireEvidence(realpathSync(path) === path, "directory alias refused");
  return lstatSync(path);
}
function git(repo: string, args: string[], input?: string) {
  // check-ignore consumes filenames, and explicitly rejects pathspec magic.
  const r = spawnSync("git", ["--no-optional-locks", ...(args[0] === "check-ignore" ? [] : ["--literal-pathspecs"]), "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    encoding: "utf8", input, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  requireEvidence(!r.error && r.status === 0 && !r.signal, `Git evidence unavailable: ${args[0]}`);
  return r.stdout;
}
function clean(repo: string) {
  directory(repo);
  requireEvidence(git(repo, ["rev-parse", "--show-toplevel"]).trim() === repo, "repository root mismatch");
  requireEvidence(!git(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]).trim(), "dirty source/worktree refused");
}
type Manifest = { digest: string; files: number; bytes: number; newest: number; paths: string[]; device: number };
function manifest(path: string): Manifest {
  directory(path);
  const device = lstatSync(path).dev, rows: unknown[] = [], paths: string[] = [];
  let files = 0, bytes = 0, newest = 0;
  const visit = (p: string) => {
    const s = lstatSync(p);
    requireEvidence(!s.isSymbolicLink() && s.dev === device, "symlink/mounted artifact refused");
    requireEvidence(s.isDirectory() || (s.isFile() && s.nlink === 1), "special/hardlinked artifact refused");
    newest = Math.max(newest, s.mtimeMs, s.ctimeMs);
    const name = relative(path, p);
    paths.push(p);
    if (s.isDirectory()) {
      // Moving the root changes its ctime; exclude that one value so the
      // retained fingerprint can also verify a non-overwriting restoration.
      rows.push([name, "directory", s.dev, s.ino, s.mode, s.mtimeMs, name ? s.ctimeMs : null]);
      for (const entry of readdirSync(p).sort()) visit(join(p, entry));
    } else {
      const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd);
        requireEvidence(before.ino === s.ino && before.dev === s.dev && before.size === s.size, "artifact changed during inspection");
        const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
        let length: number;
        while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
        const content = digest.digest("hex");
        const after = fstatSync(fd);
        requireEvidence(after.size === s.size && after.mtimeMs === s.mtimeMs && after.ctimeMs === s.ctimeMs, "artifact changed during read");
        rows.push([name, "file", s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs, content]);
        files++; bytes += s.size;
      } finally { closeSync(fd); }
    }
  };
  visit(path);
  requireEvidence(Number.isSafeInteger(bytes), "artifact byte count unknown");
  return { digest: hash(JSON.stringify(rows)), files, bytes, newest, paths, device };
}
type Event = { id: string; kind: string; at: number; data: string };
function events(s: Store, kind: string, id: string) {
  return (s.db.query("SELECT id,kind,at,data FROM events WHERE kind=? AND json_extract(data,'$.id')=? ORDER BY at,id").all(kind, id) as Event[]);
}
function custody(s: Store, config: CacheArchiveConfig, id: string, now: number) {
  const session = s.db.query("SELECT * FROM sessions WHERE id=?").get(id) as Session | null;
  requireEvidence(session && session.status === "finished" && session.pid === null && session.native_id, "live/waiting/unknown custody refused");
  const ticket = TicketSchema.parse(JSON.parse(session.brief));
  const native = s.get<{ verified?: boolean; bound?: boolean; id?: string }>(`native-evidence:${id}`);
  requireEvidence(native?.verified === true && native.bound === true && native.id === session.native_id, "native custody unknown");
  requireEvidence(s.get<{ verified?: boolean }>(`cleanup-evidence:${id}`)?.verified === true, "cleanup unknown");
  const browser = s.get<{ state?: string; custodyBlocked?: boolean }>(`browser-parent:${id}`);
  requireEvidence(!browser || (browser.state === "returned" && browser.custodyBlocked === false), "browser wait/custody unresolved");
  const jobs = s.db.query("SELECT value FROM kv WHERE key LIKE 'browser-job:%'").all() as { value: string }[];
  for (const row of jobs) {
    const j = JSON.parse(row.value) as { parent?: string; state?: string; nativePending?: boolean; fallbackPending?: boolean };
    if (j.parent === id) requireEvidence(j.state === "returned" && j.nativePending === false && j.fallbackPending === false, "browser job custody unresolved");
  }
  const workspaces = events(s, "workspace", id);
  requireEvidence(workspaces.length === 1, "workspace custody ambiguous/missing");
  const workspace = z.string().parse(JSON.parse(workspaces[0]!.data).workspace);
  directory(workspace);
  requireEvidence(config.worktreeRoots.some(root => workspace !== root && inside(root, workspace)), "workspace outside configured roots");
  const others = s.db.query("SELECT data FROM events WHERE kind='workspace' AND json_extract(data,'$.id')<>?").all(id) as { data: string }[];
  for (const row of others) {
    const other = z.object({ workspace: z.string() }).parse(JSON.parse(row.data));
    requireEvidence(!overlap(workspace, other.workspace), "overlapping workspace custody refused");
  }
  const source = config.repositories[ticket.repo];
  requireEvidence(source && !overlap(source, workspace), "configured source missing/overlapping");
  clean(source); clean(workspace);
  const exits = events(s, "worker-exit", id);
  requireEvidence(exits.length === 1 && JSON.parse(exits[0]!.data).ok === true, "successful completion unknown");
  const pubs = events(s, "launcher-publish", id);
  requireEvidence(pubs.length === 1, "publication unfinished/ambiguous");
  const pub = pubs[0]!, publication = z.object({ id: z.literal(id), repo: z.literal(ticket.repo), tree: z.string().regex(/^[a-f0-9]{40}$/), head: z.string().regex(/^[a-f0-9]{40}$/), url: z.url() }).parse(JSON.parse(pub.data));
  const url = new URL(publication.url);
  requireEvidence(url.origin === "https://github.com" && !url.username && !url.password && new RegExp(`^/${ticket.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`).test(url.pathname), "publication destination unknown");
  requireEvidence(pub.at >= exits[0]!.at && exits[0]!.at >= workspaces[0]!.at, "publication/completion ordering unknown");
  requireEvidence(git(workspace, ["rev-parse", "HEAD^{tree}"]).trim() === publication.tree, "publication tree mismatch");
  const completedAt = Math.max(pub.at, exits[0]!.at, workspaces[0]!.at);
  requireEvidence(Number.isSafeInteger(completedAt) && completedAt > 0 && now - completedAt >= age, "recent completion (<12h)/unknown time refused");
  return { session: id, native: session.native_id, workspace, source, completedAt, publication: { event: pub.id, ...publication }, completion: exits[0]!.id, workspaceEvent: workspaces[0]!.id };
}
export type CacheArchiveCandidate = ReturnType<typeof custody> & { path: string; cache: string; manifest: Manifest; custodyDigest: string };
export type CacheArchivePlan = {
  version: 1; id: string; scope: CacheArchiveScope; at: number; status: "ready" | "blocked";
  blockers: string[]; skipped: { session: string; path?: string; reason: string }[];
  candidates: CacheArchiveCandidate[]; count: number; files: number; bytes: number;
  archiveRoot?: string; processReceipt?: ProcessReferences; reclaimedBytes: 0;
};
function environment(config: CacheArchiveConfig, now: number) {
  requireEvidence(Number.isSafeInteger(now) && now > 0 && config.worktreeRoots.length > 0, "planning time/roots unknown");
  for (const root of config.worktreeRoots) directory(root);
  requireEvidence(config.archiveRoot, "separate archive destination not configured");
  const dest = directory(config.archiveRoot);
  requireEvidence((dest.mode & 0o077) === 0 && dest.uid === process.getuid?.(), "archive destination must be private and owned");
  for (const root of [...config.worktreeRoots, ...Object.values(config.repositories)]) {
    directory(root);
    requireEvidence(!overlap(root, config.archiveRoot), "archive destination overlaps source/worktree roots");
  }
  accessSync(config.archiveRoot, constants.W_OK | constants.X_OK);
  const space = statfsSync(config.archiveRoot);
  requireEvidence(space.bavail * space.bsize > 0, "archive destination has no usable space");
  const refs = z.object({ complete: z.literal(true), observedAt: z.number().int().positive(), receipt: z.string().trim().min(1), paths: z.array(z.string().refine(p => isAbsolute(p) && resolve(p) === p)) }).strict().parse(config.processReferences());
  freshProcess(refs, now);
  return { dest, refs };
}
function candidate(s: Store, config: CacheArchiveConfig, id: string, cache: string, now: number, refs: ProcessReferences): CacheArchiveCandidate {
  const c = custody(s, config, id, now), path = join(c.workspace, cache);
  requireEvidence(!refs.paths.some(p => overlap(p, c.workspace) || overlap(p, c.source)), "process-referenced workspace/source refused");
  const m = manifest(path);
  requireEvidence(now - m.newest >= age, "recent artifact (<12h) refused");
  requireEvidence(!git(c.workspace, ["ls-files", "--cached", "-z", "--", cache]), "tracked artifact refused");
  // Check every entry: an ignored parent does not prove an unignored child safe.
  const names = m.paths.map(p => relative(c.workspace, p));
  const ignored = new Set(git(c.workspace, ["check-ignore", "-z", "--stdin"], `${names.join("\0")}\0`).split("\0").filter(Boolean));
  requireEvidence(names.every(p => ignored.has(p)), "unignored artifact refused");
  return { ...c, path, cache, manifest: m, custodyDigest: hash(JSON.stringify(c)) };
}
/** Read-only daily/per-session planning. Exact paths/counts/bytes are private;
 * callers must not expose this result on the public board or in Git history. */
export function planWorktreeCacheArchive(s: Store, config: CacheArchiveConfig, scope: CacheArchiveScope, now = Date.now()): CacheArchivePlan {
  const currentTime = clock(now);
  const plan: CacheArchivePlan = { version: 1, id: randomUUID(), scope, at: now, status: "blocked", blockers: [], skipped: [], candidates: [], count: 0, files: 0, bytes: 0, reclaimedBytes: 0 };
  try {
    if (scope.kind === "daily") requireEvidence(/^\d{4}-\d{2}-\d{2}$/.test(scope.day) && new Date(`${scope.day}T00:00:00Z`).toISOString().slice(0, 10) === scope.day, "invalid planning day");
    else requireEvidence(scope.kind === "session" && scope.session.trim(), "invalid session scope");
    const { dest, refs } = environment(config, now);
    plan.archiveRoot = config.archiveRoot; plan.processReceipt = refs;
    const ids = scope.kind === "session" ? [scope.session] : (s.db.query("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]).map(x => x.id);
    for (const id of ids) {
      try { custody(s, config, id, now); }
      catch (error) { plan.skipped.push({ session: id, reason: String(error) }); continue; }
      for (const cache of regenerableCaches) {
        try { plan.candidates.push(candidate(s, config, id, cache, now, refs)); }
        catch (error) { plan.skipped.push({ session: id, path: cache, reason: String(error) }); }
      }
    }
    requireEvidence(new Set(plan.candidates.map(c => c.path.toLowerCase())).size === plan.candidates.length, "duplicate workspace custody refused");
    requireEvidence(plan.candidates.every(c => c.manifest.device === dest.dev), "cross-device rename unavailable; artifact retained (no delete fallback)");
    freshProcess(refs, currentTime());
    plan.count = plan.candidates.length; plan.files = plan.candidates.reduce((n, c) => n + c.manifest.files, 0); plan.bytes = plan.candidates.reduce((n, c) => n + c.manifest.bytes, 0);
    plan.status = "ready";
  } catch (error) { plan.blockers.push(String(error)); plan.candidates = []; plan.count = plan.files = plan.bytes = 0; }
  return plan;
}
type ArchiveMove = { source: string; destination: string; files: number; bytes: number; manifest: string; custody: CacheArchiveCandidate };
export type CacheArchiveReceipt = {
  id: string; plan: string; at: number; dryRun: boolean; status: "dry-run" | "archived" | "blocked";
  count: number; files: number; bytes: number; reclaimedBytes: 0; undo: string;
  planned: ArchiveMove[]; moved: ArchiveMove[];
  blockers: string[];
};
/** Rename-only, no copy/unlink fallback. EXDEV blocks and retains the artifact.
 * Same-volume archival is organization, with ZERO disk-reclamation claim.
 * Revalidates custody, process proof and exact manifests under an immediate DB
 * transaction. Private append-only intent precedes every filesystem mutation;
 * interruptions leave enough information to reconcile without replay/overwrite.
 * dryRun (the default) writes neither receipts nor directories. */
export function archiveWorktreeCaches(s: Store, config: CacheArchiveConfig, plan: CacheArchivePlan, options: { dryRun?: boolean; now?: number } = {}): CacheArchiveReceipt {
  const now = options.now ?? Date.now(), dryRun = options.dryRun ?? true;
  const currentTime = clock(now);
  const receipt: CacheArchiveReceipt = { id: randomUUID(), plan: plan.id, at: now, dryRun, status: "blocked", count: 0, files: 0, bytes: 0, reclaimedBytes: 0, undo, planned: [], moved: [], blockers: [] };
  // An outer transaction could roll back receipts after a successful rename.
  if (s.db.inTransaction) { receipt.blockers.push("archive requires its own committed intent; outer transaction refused"); return receipt; }
  const run = join(config.archiveRoot ?? "/", receipt.id);
  try {
    const current = s.atomic(() => {
      requireEvidence(plan.version === 1 && plan.status === "ready" && now >= plan.at && now - plan.at <= 30000, "blocked/stale/future plan refused");
      requireEvidence(plan.archiveRoot === config.archiveRoot, "archive destination changed");
      const { dest, refs } = environment(config, now);
      const current = plan.candidates.map(c => {
        requireEvidence(regenerableCaches.includes(c.cache as typeof regenerableCaches[number]), "cache outside allowlist");
        const fresh = candidate(s, config, c.session, c.cache, now, refs);
        requireEvidence(fresh.path === c.path && fresh.custodyDigest === c.custodyDigest && fresh.manifest.digest === c.manifest.digest, "planned custody/artifact changed");
        requireEvidence(fresh.manifest.device === dest.dev, "cross-device rename unavailable; artifact retained (no delete fallback)");
        return fresh;
      });
      requireEvidence(new Set(current.map(c => c.path.toLowerCase())).size === current.length, "duplicate archive candidate refused");
      freshProcess(refs, currentTime());
      receipt.planned = current.map((c, i) => ({ source: c.path, destination: join(run, String(i)), files: c.manifest.files, bytes: c.manifest.bytes, manifest: c.manifest.digest, custody: c }));
      if (!dryRun) requireEvidence(s.event(`cache-archive-intent:${receipt.id}`, "worktree-cache-archive-intent", { receipt, run, candidates: current, destinations: current.map((c, i) => ({ source: c.path, destination: join(run, String(i)) })), processReceipt: refs }, undo, now), "archive intent already exists");
      return current;
    }); // Intent is durable BEFORE touching the filesystem.
    if (dryRun) { receipt.status = "dry-run"; receipt.count = current.length; receipt.files = current.reduce((n, c) => n + c.manifest.files, 0); receipt.bytes = current.reduce((n, c) => n + c.manifest.bytes, 0); return receipt; }
    // UUID mkdir is exclusive; no existing destination or carrier is replaced.
    if (current.length) mkdirSync(run, { mode: 0o700 });
    for (const [index, c] of current.entries()) {
      s.atomic(() => {
        const destination = join(run, String(index));
        const at = currentTime(), { refs } = environment(config, at);
        const fresh = candidate(s, config, c.session, c.cache, at, refs);
        requireEvidence(fresh.custodyDigest === c.custodyDigest && fresh.manifest.digest === c.manifest.digest, "custody/artifact changed before rename");
        directory(config.archiveRoot!); directory(run);
        freshProcess(refs, currentTime());
        renameSync(c.path, destination);
        receipt.moved.push({ source: c.path, destination, files: c.manifest.files, bytes: c.manifest.bytes, manifest: c.manifest.digest, custody: c });
        receipt.count++; receipt.files += c.manifest.files; receipt.bytes += c.manifest.bytes;
        s.event(`cache-archive-move:${receipt.id}:${index}`, "worktree-cache-archive-move", receipt.moved.at(-1), undo, now);
      });
    }
    receipt.status = "archived";
  } catch (error) { receipt.blockers.push(String(error)); }
  // Failure after a rename retains successful moves. If result journaling fails,
  // the committed intent still contains every exact source/destination mapping.
  if (!dryRun) {
    try { s.event(`cache-archive-result:${receipt.id}`, "worktree-cache-archive-result", receipt, undo, now); }
    catch (error) { receipt.status = "blocked"; receipt.blockers.push(`result receipt unavailable: ${String(error)}`); }
  }
  return receipt;
}
