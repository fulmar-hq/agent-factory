import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject } from "../scripts/factory";
import { configAt } from "../launcher/config";
import { Store } from "../tracking/store";

async function installation() {
  const dir = await mkdtemp(join(tmpdir(), "factory-enrollment-"));
  const text = await Bun.file(join(import.meta.dir, "../examples/config.yaml")).text();
  await Bun.write(join(dir, "config.yaml"), text + "\n# Keep unknown policy\ncustom_policy: {enabled: true}\n");
  return dir;
}
const issue = { number: 7, title: "Fictional issue", body: "", url: "https://github.com/example/site/issues/7", updatedAt: "2026-11-07", state: "OPEN", labels: [] };
test("enrollment dry run has no writes; apply preserves policy, backfills and stays read-only on repeat", async () => {
  const dir = await installation(), path = join(dir, "config.yaml");
  const original = await readFile(path, "utf8");
  const calls: string[][] = [];
  const execute = async (args: string[]) => { calls.push(args); return JSON.stringify([issue]); };
  expect(await addProject("example/site", { dir, dryRun: true, execute })).toMatchObject({ issues: 1, readOnly: true, dryRun: true });
  expect(await readdir(dir)).toEqual(["config.yaml"]);
  expect(await readFile(path, "utf8")).toBe(original);
  await addProject("example/site", { dir, execute });
  const enrolled = await readFile(path, "utf8");
  expect(enrolled).toContain("custom_policy: {enabled: true}");
  expect((await configAt(path)).projects["example--site"].owners).toEqual([]);
  await addProject("example/site", { dir, execute });
  expect(await readFile(path, "utf8")).toBe(enrolled);
  const store = new Store(join(dir, "controller.sqlite"));
  try {
    expect(store.rows("tickets")).toHaveLength(1);
    expect(store.rows("sessions")).toHaveLength(0);
    expect(store.rows("debits")).toHaveLength(0);
    expect(store.rows("events")).toHaveLength(2);
  } finally { store.close(); }
  expect(calls.every(args => args[0] === "gh" && args[1] === "issue" && args[2] === "list")).toBe(true);
});
test("invalid repo, source failure and truncated backfill never change config", async () => {
  const dir = await installation(), path = join(dir, "config.yaml"), original = await readFile(path, "utf8");
  await expect(addProject("bad;repo", { dir })).rejects.toThrow("owner/repo");
  await expect(addProject("example/site", { dir, execute: async () => { throw Error("source offline"); } })).rejects.toThrow("source offline");
  await expect(addProject("example/site", { dir, execute: async () => JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ ...issue, number: i + 1 }))) })).rejects.toThrow("1000");
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(dir)).toEqual(["config.yaml"]);
});
