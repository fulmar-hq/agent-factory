import { expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CALIBRATION_BOUNDS as bounds, calibrateTokens, turnTokens } from "../launcher/budgets";

const day = "2026-11-08";
const scratch = join(process.cwd(), ".factory-tmp");
mkdirSync(scratch, { recursive: true });
function fixture() {
  const home = mkdtempSync(join(scratch, "calibration-"));
  const directories = ["2026/11/08", "2026/11/09"].map(date => {
    const dir = join(home, ".codex/sessions", date);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { home, first: directories[0], second: directories[1] };
}
function row(payload: unknown, timestamp = "2026-11-08T12:00:00Z") {
  return JSON.stringify({ type: "event_msg", timestamp, payload }) + "\n";
}
function token(total: number, timestamp?: string) {
  return row({ type: "token_count", info: { total_token_usage: {
    total_tokens: total, cached_input_tokens: Math.floor(total / 2),
  } } }, timestamp);
}
function completed(total: number, timestamp?: string, type = "task_complete") {
  return token(total, timestamp) + row({ type }, timestamp);
}
const five = [1, 2, 3, 4, 5].map(n => completed(n * 100)).join("");
function sized(path: string, size: number) {
  const content = Buffer.alloc(size, 32);
  content.write(five);
  writeFileSync(path, content);
}

test("complete cross-UTC-day population preserves baselines, cache, p90 and Toronto filtering", () => {
  const { home, first, second } = fixture();
  const a = join(first, "a.jsonl"), b = join(second, "b.jsonl");
  writeFileSync(a,
    completed(9000000, "2026-11-08T04:59:59Z") +
    completed(9100000, "2026-11-08T05:00:00Z") +
    token(9100000) + // Duplicate cumulative readings never add cached input again.
    completed(9300000, "2026-11-09T00:00:00Z", "task_completed") +
    token(99000000)); // No completion: exclude the in-flight turn.
  writeFileSync(b,
    completed(300000, "2026-11-09T01:00:00Z") +
    completed(700000, "2026-11-09T02:00:00Z") +
    completed(2200001, "2026-11-09T04:59:59Z") +
    completed(99000000, "2026-11-09T05:00:00Z"));
  writeFileSync(join(second, "ignored.txt"), "ignored");
  expect(calibrateTokens(home, day)).toEqual({
    tokens: 2000000, p90: 1500001, samples: 5, sources: [a, b],
    dates: ["2026-11-08", "2026-11-09"], torontoDay: day,
  });
});

test("out-of-day completions advance the cumulative baseline", () => {
  expect(turnTokens(
    completed(1000, "2026-11-08T04:59:59Z") +
    completed(1100, "2026-11-08T05:00:00Z") +
    completed(1300, "2026-11-09T05:00:00Z") +
    completed(1400, "2026-11-09T04:00:00Z"), day,
  )).toEqual([100, 100]);
});

test("ordinary complete input uses nearest-rank p90 rather than its maximum", () => {
  const { home, first } = fixture();
  let total = 0;
  writeFileSync(join(first, "ten.jsonl"), Array.from({ length: 10 }, (_, i) => {
    total += (i + 1) * 1000001;
    return completed(total);
  }).join(""));
  expect(calibrateTokens(home, day)).toMatchObject({ samples: 10, p90: 9000009, tokens: 10000000 });
});

test("fewer than five completed turns refuses; an in-flight reading cannot supply the fifth", () => {
  const { home, first } = fixture();
  writeFileSync(join(first, "four.jsonl"), [1, 2, 3, 4].map(n => completed(n * 100)).join("") + token(500));
  expect(() => calibrateTokens(home, day)).toThrow("five completed native turns required");
});

test("oversized file refuses even with five complete turns at both beginning and tail", () => {
  const { home, first } = fixture();
  const path = join(first, "large.jsonl");
  writeFileSync(path, five);
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, bounds.fileBytes + 1);
    const tail = Buffer.from(five);
    writeSync(fd, tail, 0, tail.length, bounds.fileBytes + 1 - tail.length);
  } finally { closeSync(fd); }
  expect(() => calibrateTokens(home, day)).toThrow("calibration refused: file byte bound exceeded");
});

test("file count is bounded across both dates, including files without turns", () => {
  const { home, first, second } = fixture();
  for (let i = 0; i < bounds.files; i++)
    writeFileSync(join(i % 2 ? first : second, `${i}.jsonl`), i === 0 ? five : "");
  expect(calibrateTokens(home, day).samples).toBe(5);
  writeFileSync(join(second, "excess.jsonl"), "");
  expect(() => calibrateTokens(home, day)).toThrow("calibration refused: file count bound exceeded");
});

test("exact file and aggregate bounds accept complete input; one extra byte refuses", () => {
  const { home, first, second } = fixture();
  expect(bounds.aggregateBytes % bounds.fileBytes).toBe(0);
  const count = bounds.aggregateBytes / bounds.fileBytes;
  for (let i = 0; i < count; i++) sized(join(i % 2 ? first : second, `${i}.jsonl`), bounds.fileBytes);
  expect(calibrateTokens(home, day)).toMatchObject({ samples: count * 5, p90: 100, tokens: 1000000 });
  writeFileSync(join(second, "excess.jsonl"), "\n");
  expect(() => calibrateTokens(home, day)).toThrow("calibration refused: aggregate byte bound exceeded");
});

test("non-JSONL directory entries cannot cause unbounded enumeration", () => {
  const { home, first } = fixture();
  writeFileSync(join(first, "complete.jsonl"), five);
  for (let i = 1; i < bounds.directoryEntries; i++) writeFileSync(join(first, `${i}.txt`), "");
  expect(calibrateTokens(home, day).samples).toBe(5);
  writeFileSync(join(first, "excess.txt"), "");
  expect(() => calibrateTokens(home, day)).toThrow("calibration refused: directory entry bound exceeded");
});

test("missing date directories are supported without traversing other dates", () => {
  const { home } = fixture();
  // A separate synthetic home has only the first UTC date.
  const onlyFirst = join(home, "only-first");
  const dir = join(onlyFirst, ".codex/sessions/2026/11/08");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "complete.jsonl"), five);
  expect(calibrateTokens(onlyFirst, day).samples).toBe(5);
  expect(() => calibrateTokens(home, day)).toThrow("five completed native turns required");
});

test("unreadable or nonregular JSONL entries refuse rather than returning a partial population", () => {
  const { home, first } = fixture();
  writeFileSync(join(first, "complete.jsonl"), five);
  mkdirSync(join(first, "directory.jsonl"));
  expect(() => calibrateTokens(home, day)).toThrow("regular JSONL file required");
  const other = fixture();
  writeFileSync(join(other.first, "complete.jsonl"), five);
  symlinkSync(join(other.first, "missing"), join(other.first, "link.jsonl"));
  expect(() => calibrateTokens(other.home, day)).toThrow();
});
