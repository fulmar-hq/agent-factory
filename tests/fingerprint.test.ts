import { expect, test } from "bun:test";
import { NORMALISER, SAMPLE_CHARS, classIdFor, rawHash, sampleOf, signatureOf } from "../launcher/fingerprint";
import { CLASS_ID } from "../launcher/loop-contract";

const session = (n: number) => n.toString(16).padStart(8, "0").repeat(8);
const bundle = (n: number) => `Error: exact tested tree required; inspect /Users/fictional/.factory/runs/delivery/${session(n)}/initial/publisher/tested-tree.json`;

test("the same failure on another session, home folder, day or ticket has one signature", () => {
  const first = signatureOf(bundle(1));
  for (let n = 2; n < 35; n++) expect(signatureOf(bundle(n))).toEqual(first);
  expect(first).toEqual({ signature: "error: exact tested tree required; inspect ~/.factory/runs/delivery/<id>/initial/publisher/tested-tree.json", version: 1, fallback: false });
  expect(signatureOf(bundle(1).replace("/Users/fictional", "/home/other")).signature).toBe(first.signature);
  expect(signatureOf("Publish of #3501 failed at 2026-11-10T19:02:11.250-05:00 after 3 tries (41.5 s)").signature).toBe(signatureOf("Publish of #17 failed at 2026-11-07 08:00 after 12 tries (9 s)").signature);
  expect(signatureOf("worker 0d5f6a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6 lost").signature).toBe("worker <id> lost");
});

test("different failures keep different signatures, and ordinary words are not mistaken for ids", () => {
  expect(signatureOf("SQLiteError: database is locked").signature).not.toBe(signatureOf("SQLiteError: database or disk is full").signature);
  expect(signatureOf("Error: commit paths outside approved scope").signature).toBe("error: commit paths outside approved scope");
  expect(signatureOf("defaced facade decade").signature).toBe("defaced facade decade");
});

test("a fingerprint error falls back to a raw hash and never throws", () => {
  const broken = { version: 7, normalise: () => { throw Error("bad pattern"); } };
  const fallback = signatureOf("anything at all", broken);
  expect(fallback).toEqual({ signature: rawHash("anything at all"), version: 7, fallback: true });
  expect(signatureOf("anything at all", broken)).toEqual(fallback);
  expect(signatureOf("something else", broken).signature).not.toBe(fallback.signature);
  for (const empty of [{ version: 7, normalise: () => "" }, { version: 7, normalise: () => undefined as unknown as string }]) expect(signatureOf("x", empty).fallback).toBe(true);
  expect(signatureOf("   ").fallback).toBe(true);
});

test("only the stored sample is fingerprinted, so a later normaliser can re-map it exactly", () => {
  const long = "disk ".repeat(200) + "tail that differs";
  expect(sampleOf(long)).toHaveLength(SAMPLE_CHARS);
  expect(signatureOf(long)).toEqual(signatureOf(sampleOf(long)));
  expect(signatureOf(long).signature.length).toBeLessThanOrEqual(300);
  expect(NORMALISER.version).toBe(1);
});

test("a first-sight class id is readable, folder-safe and stable", () => {
  const id = classIdFor(signatureOf(bundle(1)).signature);
  expect(id).toMatch(/^error-exact-tested-tree-required-inspect-[0-9a-f]{6}$/);
  expect(classIdFor(signatureOf(bundle(2)).signature)).toBe(id);
  for (const text of [bundle(1), "SQLiteError: database is locked", "!!!", "x".repeat(900), rawHash("y"), "Ünïcödé only ✓"]) expect(classIdFor(signatureOf(text).signature)).toMatch(CLASS_ID);
  expect(classIdFor(rawHash("y"))).toMatch(/^unparsed-[0-9a-f]{6}$/);
});
