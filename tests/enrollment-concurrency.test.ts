import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addProject } from "../scripts/factory";
import { configAt } from "../launcher/config";
import { Store } from "../tracking/store";

const scratch = resolve(".factory-tmp");
const execute = async () => JSON.stringify([{ number: 1, title: "Fictional", body: "", url: "https://github.com/fictional/one/issues/1", updatedAt: "2026-11-08", state: "OPEN", labels: [] }]);
async function installation() {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "enrollment-"));
  const original = await readFile("examples/config.yaml", "utf8") + "\n# Fictional unrelated policy\ncustom_policy: {enabled: true}\n";
  await writeFile(join(dir, "config.yaml"), original);
  return { dir, original };
}
async function waitFor(path: string) {
  const deadline = Date.now() + 10000;
  while (!await Bun.file(path).exists()) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}
// Separate runtimes share only fictional files. The archive barrier makes the
// formerly vulnerable interval deterministic without timing or process crashes.
async function child(dir: string, name: string, mode = "normal") {
  const runner = join(dir, `runner-${name}.ts`);
  await writeFile(runner, `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
const mkdir = fs.mkdir;
const [dir, name, mode] = process.argv.slice(2);
const wait = async (path) => {
  const deadline = Date.now() + 10000;
  while (!await Bun.file(path).exists()) {
    if (Date.now() > deadline) throw Error("barrier timed out");
    await Bun.sleep(5);
  }
};
mock.module("node:fs/promises", () => ({ ...fs, mkdir: async (path, options) => {
  if (String(path).includes("add-project-")) {
    await fs.writeFile(dir + "/archive-entered-" + name, "ready");
    if (mode === "hold") await wait(dir + "/archive-release-" + name);
    if (mode === "fail") throw Error("fictional archive failure");
    if (mode === "replace") {
      await fs.rename(dir + "/.add-project.claim", dir + "/retained-claim");
      await fs.writeFile(dir + "/.add-project.claim", "unknown replacement");
      throw Error("fictional custody replacement");
    }
  }
  return mkdir(path, options);
}}));
const { addProject } = await import(${JSON.stringify(resolve("scripts/factory.ts"))});
try {
  const result = await addProject("fictional/" + name, { dir, execute: async () => {
    await fs.writeFile(dir + "/read-" + name, "ready");
    await wait(dir + "/go-" + name);
    return ${JSON.stringify(await execute())};
  }});
  await fs.writeFile(dir + "/result-" + name, JSON.stringify({ ok: true, result }));
} catch (error) { await fs.writeFile(dir + "/result-" + name, JSON.stringify({ ok: false, error: String(error) })); }
`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", runner, dir, name, mode], { stdout: "ignore", stderr: "inherit" });
  const result = (async () => {
    await waitFor(join(dir, `result-${name}`));
    return JSON.parse(await readFile(join(dir, `result-${name}`), "utf8")) as { ok: boolean; error?: string };
  })();
  return { result, exited: proc.exited };
}

test("competing processes refuse custody, then retry preserves both entries and exact backups", async () => {
  const { dir, original } = await installation();
  const a = await child(dir, "one", "hold"), b = await child(dir, "two");
  await Promise.all([waitFor(join(dir, "read-one")), waitFor(join(dir, "read-two"))]);
  await writeFile(join(dir, "go-one"), "go");
  await waitFor(join(dir, "archive-entered-one"));
  let second;
  try {
    await writeFile(join(dir, "go-two"), "go");
    second = await b.result;
  } finally { await writeFile(join(dir, "archive-release-one"), "go"); }
  expect(await a.result).toMatchObject({ ok: true });
  expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
  expect(second).toMatchObject({ ok: false });
  expect(second.error).toContain("Enrollment custody exists");
  const first = await readFile(join(dir, "config.yaml"), "utf8");
  await addProject("fictional/two", { dir, execute });
  const both = await readFile(join(dir, "config.yaml"), "utf8");
  expect(both.replace(/  "fictional--(?:one|two)":.*\n/g, "")).toBe(original);
  const config = await configAt(join(dir, "config.yaml"));
  expect(config.projects["fictional--one"].owners).toEqual([]);
  expect(config.projects["fictional--two"].owners).toEqual([]);
  await addProject("fictional/two", { dir, execute });
  expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(both);
  const backups = await Promise.all((await readdir(join(dir, "archive"))).map(name => readFile(join(dir, "archive", name, "config.yaml"), "utf8")));
  expect(backups.sort()).toEqual([original, first, both].sort());
  const store = new Store(join(dir, "controller.sqlite"));
  try {
    expect(store.rows("tickets")).toHaveLength(2);
    expect(store.rows("events")).toHaveLength(3);
    expect(store.rows("sessions")).toHaveLength(0);
    expect(store.rows("debits")).toHaveLength(0);
  } finally { store.close(); }
  expect(await Bun.file(join(dir, ".add-project.claim")).exists()).toBe(false);
});

test("dry run is write-free even with unknown custody; unknown custody never reclaimed", async () => {
  const { dir, original } = await installation();
  await addProject("fictional/one", { dir, execute, dryRun: true });
  expect(await readdir(dir)).toEqual(["config.yaml"]);
  const claim = join(dir, ".add-project.claim");
  await writeFile(claim, "interrupted or unknown");
  const before = await readdir(dir);
  await addProject("fictional/one", { dir, execute, dryRun: true });
  expect(await readdir(dir)).toEqual(before);
  expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(original);
  await expect(addProject("fictional/one", { dir, execute })).rejects.toThrow("manually archive the claim");
  expect(await readFile(claim, "utf8")).toBe("interrupted or unknown");
  expect(await readdir(dir)).toEqual(before);
});

test("failure after replacement retains archive and permits read-only snapshot recovery", async () => {
  const { dir, original } = await installation();
  await mkdir(join(dir, "controller.sqlite")); // Fictional database-open failure.
  await expect(addProject("fictional/one", { dir, execute })).rejects.toThrow();
  expect(await Bun.file(join(dir, ".add-project.claim")).exists()).toBe(false);
  const enrolled = await readFile(join(dir, "config.yaml"), "utf8");
  expect(enrolled).toContain('"fictional--one"');
  const archives = await readdir(join(dir, "archive"));
  expect(archives).toHaveLength(1);
  expect(await readFile(join(dir, "archive", archives[0], "config.yaml"), "utf8")).toBe(original);
  await rename(join(dir, "controller.sqlite"), join(dir, "retained-failed-database"));
  await addProject("fictional/one", { dir, execute });
  expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(enrolled);
});

test("under-claim reread rejects changed policy and releases only its claim for retry", async () => {
  const { dir, original } = await installation();
  const changed = original + "# fictional concurrent editor\n";
  await expect(addProject("fictional/one", { dir, execute: async () => {
    await writeFile(join(dir, "config.yaml"), changed);
    return execute();
  } })).rejects.toThrow("Config changed");
  expect(await readdir(dir)).toEqual(["config.yaml"]);
  expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(changed);
  await addProject("fictional/one", { dir, execute });
});

test("archive failure cleans up owned custody; replacement custody is retained", async () => {
  for (const mode of ["fail", "replace"]) {
    const { dir, original } = await installation();
    const worker = await child(dir, "one", mode);
    await waitFor(join(dir, "read-one"));
    await writeFile(join(dir, "go-one"), "go");
    const result = await worker.result;
    expect(await worker.exited).toBe(0);
    expect(result.ok).toBe(false);
    expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(original);
    if (mode === "replace") {
      expect(result.error).toContain("custody changed");
      expect(await readFile(join(dir, ".add-project.claim"), "utf8")).toBe("unknown replacement");
      await expect(addProject("fictional/two", { dir, execute })).rejects.toThrow("Enrollment custody exists");
    } else {
      expect(result.error).toContain("fictional archive failure");
      expect(await Bun.file(join(dir, ".add-project.claim")).exists()).toBe(false);
      await addProject("fictional/one", { dir, execute });
    }
  }
});

test("enabled entries and failed source reads remain refused without writes", async () => {
  const { dir, original } = await installation();
  await expect(addProject("fictional/one", { dir, execute: async () => { throw Error("fictional offline"); } })).rejects.toThrow("fictional offline");
  const config = Bun.YAML.parse(original) as { projects: Record<string, unknown> };
  const repo = Object.values(config.projects)[0] as { repo: string };
  await expect(addProject(repo.repo, { dir, execute })).rejects.toThrow("Already enrolled for workers");
  expect(await readdir(dir)).toEqual(["config.yaml"]);
  expect(await readFile(join(dir, "config.yaml"), "utf8")).toBe(original);
});
