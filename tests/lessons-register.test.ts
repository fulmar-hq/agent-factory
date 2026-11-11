// The rules of docs/lessons.md, enforced. The verdict depends only on files in
// this checkout: no network and no clock, so it cannot turn red on a date.
import { expect, setSystemTime, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REGISTER = "docs/lessons.md";
/** Adding past these fails until Quality prunes: the register cannot only grow. */
const MAX_BYTES = 16_000;
const MAX_ROW_BYTES = 600;
const MAX_LESSON_CHARS = 200;
const MAX_UNPROVEN = 5;
/** Enforced nowhere: the size at which Quality prunes, so the limit is not reached by surprise. */
const PRUNE_AT_BYTES = 12_000;
const COLUMNS = ["id", "lesson", "paths", "home", "check", "status", "model"] as const;
const TABLE_HEAD = `| ${COLUMNS.join(" | ")} |`;
const HOMES = ["regression", "drill", "test", "gate", "instruction"];
/** The same shape as a failure class id in the loop contract: safe as a folder name. */
const CLASS_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PATH = /^[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)*$/;
const TEST_FILE = /^tests\/[A-Za-z0-9_.\/-]+[._]test\.[a-z]+$/;
const STATED = /^.{20,}$/;

/** What the rules may look at. Tests swap this to show what a missing marker or folder does. */
type Files = { read(path: string): string | null; list(path: string): string[] | null };
const repo = join(import.meta.dir, "..");
const quiet = <T>(f: () => T) => { try { return f(); } catch { return null; } };
const disk: Files = {
  read: (path) => quiet(() => readFileSync(join(repo, path), "utf8")),
  list: (path) => quiet(() => readdirSync(join(repo, path))),
};

type Row = Record<(typeof COLUMNS)[number], string>;
function tableRows(text: string): { rows: Row[]; problems: string[] } {
  const lines = text.split("\n"), start = lines.indexOf(TABLE_HEAD), problems: string[] = [];
  if (start < 0) return { rows: [], problems: [`no table headed ${TABLE_HEAD}`] };
  let end = start + 2;
  while (lines[end]?.startsWith("|")) end++;
  if (lines.some((line, at) => line.startsWith("|") && (at < start || at >= end))) problems.push("every row belongs in the one table");
  const rows: Row[] = [];
  for (const line of lines.slice(start + 2, end)) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.replaceAll("`", "").trim());
    if (cells.length !== COLUMNS.length) problems.push(`a row needs exactly ${COLUMNS.length} cells: ${line.slice(0, 60)}`);
    else if (Buffer.byteLength(line) > MAX_ROW_BYTES) problems.push(`${cells[0]}: the row is over ${MAX_ROW_BYTES} bytes`);
    else rows.push(Object.fromEntries(COLUMNS.map((column, at) => [column, cells[at]])) as Row);
  }
  return { rows, problems };
}

/** A check points back when it is named for the class, or is a test file that carries the class's marker. */
function pointsBack({ id, home, check }: Row, files: Files): boolean {
  const path = check.replace(/\/$/, "");
  const holdsFiles = (p: string) => (files.list(p)?.length ?? 0) > 0;
  if (home === "regression") return path === `regressions/${id}` && holdsFiles(path);
  if (home === "drill" && new RegExp(`^drills/${id}(\\.[a-z0-9]+)?$`).test(path)) return holdsFiles(path) || files.read(path) !== null;
  if (!TEST_FILE.test(path) || path.includes("..")) return false;
  return new RegExp(`\\blesson: ${id}(?![a-z0-9-])`).test(files.read(path) ?? "");
}

/** Every broken rule, in words. An empty list is a register that may merge. */
function registerProblems(text: string, files: Files): string[] {
  const { rows, problems } = tableRows(text);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) problems.push(`the register is ${bytes} bytes, over its ${MAX_BYTES} limit: Quality prunes or merges rows before another is added`);
  let last = "";
  for (const row of rows) {
    const bad = (why: string) => problems.push(`${row.id}: ${why}`);
    if (!CLASS_ID.test(row.id)) {
      bad("the id is not a failure class id");
      continue;
    }
    if (row.id <= last) bad("rows are sorted by id, one row per class");
    last = row.id;
    if (row.lesson.length > MAX_LESSON_CHARS || !row.lesson.includes(" because ")) bad(`the lesson is one sentence of at most ${MAX_LESSON_CHARS} characters that says why ("because")`);
    if (!row.paths.split(",").every((path) => PATH.test(path.trim()) && !path.includes(".."))) bad("paths are repository files, folders or * patterns, separated by commas");
    if (!HOMES.includes(row.home)) bad(`the home is one of: ${HOMES.join(", ")}`);
    if (!/^(checked|unproven)( always)?$/.test(row.status)) bad('the status is "checked" or "unproven", with " always" for a rule never withheld');
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(row.model)) bad('the model is a model version or "any"');
    const unproven = row.status.startsWith("unproven");
    if (row.home === "instruction") {
      if (!row.check.startsWith("reason: ") || !STATED.test(row.check.slice(8))) bad("an instruction row states why nothing that runs can hold it (reason: ...)");
      if (!unproven) bad("an instruction row is unproven: nothing that runs proves it");
      if (row.model === "any") bad("an instruction row names the model it was written for");
    } else if (unproven) {
      if (!row.check.startsWith("planned: ") || !STATED.test(row.check.slice(9))) bad("an unproven row names the check that will hold it (planned: ...)");
    } else if (!pointsBack(row, files)) bad(`the check does not point back at the row: it needs regressions/${row.id}, drills/${row.id} or a test file containing "lesson: ${row.id}"`);
  }
  const unproven = rows.filter((row) => row.status.startsWith("unproven")).length;
  if (unproven > MAX_UNPROVEN) problems.push(`${unproven} rows are unproven; at most ${MAX_UNPROVEN} may be`);
  return problems;
}

const real = readFileSync(join(repo, REGISTER), "utf8");
const seeded = tableRows(real).rows;
const checked = seeded.filter((row) => row.status.startsWith("checked"));
/** A register holding only these rows, for showing one rule at a time. */
const register = (...rows: string[]) => [TABLE_HEAD, "| --- |", ...rows].join("\n");
const row = (id: string, over: Partial<Row> = {}) =>
  `| ${Object.values({ id, lesson: "Do the thing, because it failed without it.", paths: "`launcher/*.ts`, `docs`", home: "test", check: "`tests/example.test.ts`", status: "checked", model: "any", ...over }).join(" | ")} |`;
const fixtures: Files = {
  read: (path) => (path === "tests/example.test.ts" ? "// lesson: aa\n// lesson: bb-long\n" : path === "drills/aa.json" ? "{}" : null),
  list: (path) => (path === "regressions/aa" ? ["input.json"] : path === "regressions/empty" ? [] : null),
};

test("the register passes its own rules, today and a year from now", () => {
  expect(registerProblems(real, disk)).toEqual([]);
  setSystemTime(new Date("2027-11-11T12:00:00Z"));
  try {
    expect(registerProblems(real, disk)).toEqual([]);
  } finally {
    setSystemTime();
  }
});

// The two lessons that recurred after being written down once. Removing either
// row is an operator decision, made by changing this test.
test("the register keeps the two recurred lessons among at least eight rows", () => {
  expect(seeded.length).toBeGreaterThanOrEqual(8);
  const lesson = (id: string) => seeded.find((r) => r.id === id)?.lesson ?? "";
  expect(lesson("job-path-missing-tool")).toStartWith("Verify in the job's real environment");
  expect(lesson("coordinator-holds-heartbeat")).toStartWith("The Coordinator must not hold the heartbeat");
});

test("taking away a checked row's marker, or the folder named for it, fails the register", () => {
  expect(checked.length).toBeGreaterThanOrEqual(3);
  for (const { id, check } of checked) {
    const marker = `lesson: ${id}`, path = check.replace(/\/$/, "");
    const without: Files = {
      read: (p) => (p === path && !TEST_FILE.test(p) ? null : (disk.read(p)?.replaceAll(marker, "") ?? null)),
      list: (p) => (p === path ? null : disk.list(p)),
    };
    expect(registerProblems(real, without)).toEqual([expect.stringContaining(`${id}: the check does not point back`)]);
  }
});

test("a check must point back at its row: an existing file, another row's marker or an empty folder does not pass", () => {
  expect(registerProblems(register(row("aa")), fixtures)).toEqual([]);
  expect(registerProblems(register(row("aa", { home: "regression", check: "regressions/aa/" })), fixtures)).toEqual([]);
  expect(registerProblems(register(row("aa", { home: "drill", check: "drills/aa.json" })), fixtures)).toEqual([]);
  expect(registerProblems(register(row("aa", { home: "drill" })), fixtures)).toEqual([]);
  expect(registerProblems(register(row("aa", { status: "checked always" })), fixtures)).toEqual([]);
  const refused: Partial<Row>[] = [
    { check: "README.md" },
    { check: "tests/fixtures.ts" },
    { check: "tests/missing.test.ts" },
    { check: "drills/aa.json" },
    { home: "regression" },
    { home: "regression", check: "regressions/bb" },
    { home: "drill", check: "drills/bb.json" },
    { home: "drill", check: "drills/aa.d/../../README.md" },
  ];
  for (const over of refused) expect(registerProblems(register(row("aa", over)), fixtures)).toEqual([expect.stringContaining("aa: the check does not point back")]);
  // "lesson: bb-long" is another row's marker, and regressions/empty holds nothing.
  expect(registerProblems(register(row("bb")), fixtures)).toHaveLength(1);
  expect(registerProblems(register(row("empty", { home: "regression", check: "regressions/empty" })), fixtures)).toHaveLength(1);
});

test("an instruction row needs a stated reason, a named model and an honest status", () => {
  const instruction = (over: Partial<Row>) => registerProblems(register(row("aa", { home: "instruction", check: "reason: no code path can see what a chat decides to run", status: "unproven", model: "example-model-1", ...over })), fixtures);
  expect(instruction({})).toEqual([]);
  for (const check of ["", "tests/example.test.ts", "reason: because", "planned: a drill that will exist one day"]) expect(instruction({ check })).toEqual([expect.stringContaining("states why")]);
  expect(instruction({ status: "checked" })).toEqual([expect.stringContaining("is unproven")]);
  expect(instruction({ model: "any" })).toEqual([expect.stringContaining("names the model")]);
});

test("at most five rows are unproven, and each names its planned check", () => {
  const unproven = (count: number) => register(...Array.from({ length: count }, (_, n) => row(`class-${n}`, { check: "planned: the drill that replays this failure", status: "unproven" })));
  expect(registerProblems(unproven(5), fixtures)).toEqual([]);
  expect(registerProblems(unproven(6), fixtures)).toEqual(["6 rows are unproven; at most 5 may be"]);
  expect(registerProblems(register(row("aa", { status: "unproven" })), fixtures)).toEqual([expect.stringContaining("planned:")]);
  const spare = MAX_UNPROVEN - seeded.filter((r) => r.status.startsWith("unproven")).length;
  expect(spare).toBeGreaterThanOrEqual(0);
  const extra = Array.from({ length: spare + 1 }, (_, n) => row(`zz-${n}`, { check: "planned: the drill that replays this failure", status: "unproven" }));
  expect(registerProblems([real.trimEnd(), ...extra].join("\n"), disk)).toEqual([expect.stringContaining("at most 5")]);
});

test("a register or a row over its byte limit fails, so adding forces pruning", () => {
  const spare = MAX_BYTES - Buffer.byteLength(real);
  expect(registerProblems(real + "x".repeat(spare), disk)).toEqual([]);
  expect(registerProblems(real + "x".repeat(spare + 1), disk)).toEqual([expect.stringContaining(`over its ${MAX_BYTES} limit`)]);
  expect(registerProblems(register(row("aa", { paths: Array(60).fill("launcher/a.ts").join(", ") })), fixtures)).toEqual([`aa: the row is over ${MAX_ROW_BYTES} bytes`]);
});

test("rows are well formed: sorted unique class ids, a lesson that says why, known values, one table", () => {
  const one = (over: Partial<Row>, id = "aa") => registerProblems(register(row(id, over)), fixtures);
  expect(registerProblems(register(row("bb-long"), row("aa")), fixtures)).toEqual([expect.stringContaining("sorted by id")]);
  expect(registerProblems(register(row("aa"), row("aa")), fixtures)).toEqual([expect.stringContaining("one row per class")]);
  for (const id of ["Not_An_Id", "a(b", "-aa"]) expect(one({}, id)).toEqual([expect.stringContaining("not a failure class id")]);
  expect(one({ lesson: "Do the thing." })).toEqual([expect.stringContaining("says why")]);
  expect(one({ lesson: `Do it, because ${"y".repeat(MAX_LESSON_CHARS)}.` })).toEqual([expect.stringContaining("at most 200")]);
  for (const paths of ["", "/etc/hosts", "../outside", "launcher/a.ts; rm"]) expect(one({ paths })).toEqual([expect.stringContaining("paths are")]);
  expect(one({ home: "memory" })).toContainEqual(expect.stringContaining("the home is one of"));
  expect(one({ status: "proven" })).toContainEqual(expect.stringContaining("the status is"));
  expect(one({ model: "" })).toEqual([expect.stringContaining("the model is")]);
  expect(registerProblems(register("| aa | only three | cells |"), fixtures)).toEqual([expect.stringContaining("exactly 7 cells")]);
  expect(registerProblems(`${row("aa")}\n\n${register(row("bb-long"))}`, fixtures)).toEqual(["every row belongs in the one table"]);
  expect(registerProblems("# Lessons\n", fixtures)).toEqual([expect.stringContaining("no table headed")]);
});

test("the header states who writes the row and the limits enforced here", () => {
  const header = real.slice(0, real.indexOf(TABLE_HEAD));
  for (const rule of ["The author of the fix writes or updates the row, in the fix pull request", "The one reviewer accepts the row", "Quality owns this file and its pruning", "the product's lessons table"]) expect(header).toContain(rule);
  for (const limit of [MAX_BYTES, PRUNE_AT_BYTES, MAX_ROW_BYTES, MAX_LESSON_CHARS]) expect(header).toContain(limit.toLocaleString("en-US"));
  expect(header).toContain(`At most ${MAX_UNPROVEN} rows are unproven`);
  // Between the prune line and the limit there is always room for a working day of fixes.
  expect(Math.floor((MAX_BYTES - PRUNE_AT_BYTES) / MAX_ROW_BYTES)).toBeGreaterThanOrEqual(6);
});
