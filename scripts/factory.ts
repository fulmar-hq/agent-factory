#!/usr/bin/env bun
import { copyFile, mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigSchema, root } from "../launcher/config";
import { command, reconcile } from "../adapters/github";
import { Store } from "../tracking/store";

// Enrollment never admits work. Empty owners keep future ticks read-only too.
export async function addProject(repo: string, options: {
  dir?: string; dryRun?: boolean; execute?: typeof command;
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error("Use owner/repo");
  const dir = options.dir ?? root, path = join(dir, "config.yaml");
  const original = await readFile(path, "utf8");
  const config = ConfigSchema.parse(Bun.YAML.parse(original));
  const existing = Object.entries(config.projects).find(([, p]) => p.repo.toLowerCase() === repo.toLowerCase());
  const key = existing?.[0] ?? repo.toLowerCase().replace("/", "--");
  if (!existing && config.projects[key]) throw Error("Project key already in use");
  const entry = existing?.[1] ?? { repo, owners: [], tests: "Unverified: configure before enabling workers" };
  if (entry.owners.length) throw Error("Already enrolled for workers; use normal reconciliation");
  let proposed = original;
  if (!existing) {
    // Preserve comments, unknown installation policy and every unrelated byte.
    const lines = original.split("\n");
    const start = lines.findIndex(line => /^projects:\s*(?:#.*)?$/.test(line));
    if (start < 0) throw Error("projects must be a block mapping");
    let end = start + 1;
    while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
    lines.splice(end, 0, `  ${JSON.stringify(key)}: ${JSON.stringify(entry)}`);
    proposed = lines.join("\n");
    const validated = ConfigSchema.parse(Bun.YAML.parse(proposed));
    if (validated.projects[key]?.repo !== repo) throw Error("Enrollment validation failed");
  }
  const preview = new Store(":memory:");
  try {
    await reconcile(preview, { ...config, projects: { [key]: entry } }, Date.now(), options.execute ?? command);
    const source = preview.get<{ error: string | null; count: number; truncated: boolean }>(`github:${entry.repo}`);
    if (!source || source.error) throw Error(source?.error ?? "Backfill failed");
    if (source.truncated) throw Error("Backfill incomplete; enrollment refused");
    if (!options.dryRun) {
      if (await readFile(path, "utf8") !== original) throw Error("Config changed; retry enrollment");
      const id = randomUUID(), archive = join(dir, "archive", `add-project-${id}`);
      await mkdir(archive, { recursive: true, mode: 0o700 });
      await copyFile(path, join(archive, "config.yaml"));
      if (!existing) {
        const staged = join(archive, "config.next.yaml");
        await Bun.write(staged, proposed, { mode: 0o600 });
        await rename(staged, path);
      }
      const store = new Store(join(dir, "controller.sqlite"));
      try {
        store.atomic(() => {
          for (const row of preview.rows("tickets") as { id: string; snapshot: string; observed: number; decision: string }[]) {
            store.db.query("INSERT INTO tickets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,observed=excluded.observed,decision=excluded.decision")
              .run(row.id, row.snapshot, row.observed, row.decision);
          }
          store.set(`github:${entry.repo}`, source);
          store.event(`add-project:${id}`, "project-enrolled", { repo: entry.repo, key, count: source.count, readOnly: true }, `Restore config from ${archive}/config.yaml; retain snapshots and this event`);
        });
      } finally { store.close(); }
    }
    return { repo: entry.repo, key, issues: source.count, readOnly: true, dryRun: !!options.dryRun, alreadyEnrolled: !!existing };
  } finally { preview.close(); }
}

if (import.meta.main) {
  const [action, repo, ...flags] = process.argv.slice(2);
  if (action !== "add-project" || !repo || flags.some(f => f !== "--dry-run")) {
    throw Error("Usage: factory add-project <owner/repo> [--dry-run]");
  }
  console.log(JSON.stringify(await addProject(repo, { dryRun: flags.includes("--dry-run") }), null, 2));
}
