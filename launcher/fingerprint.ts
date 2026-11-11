// Turns the text of a problem into a signature, so the same problem on another
// day, ticket or run folder is recognised as the same problem. Pure functions:
// nothing here opens a file or a database.
//
// The ledger maps signatures to class ids through a table and stores the
// normaliser version beside each one. Retuning the normaliser means raising
// `version`; the ledger then re-maps the stored samples and no class id changes.
import { createHash } from "node:crypto";

export type Normaliser = { version: number; normalise(text: string): string };

/** Only this much of a text is fingerprinted, and exactly this much is kept as the sample to re-map later. */
export const SAMPLE_CHARS = 500;
export const sampleOf = (text: string) => text.slice(0, SAMPLE_CHARS);
const SIGNATURE_CHARS = 300;

export const NORMALISER: Normaliser = {
  version: 1,
  normalise: (text) =>
    text
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
      .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, "<time>")
      // Session ids, commit ids and millisecond times: long hex runs that hold a digit.
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<id>")
      .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, SIGNATURE_CHARS),
};

export type Signature = { signature: string; version: number; fallback: boolean };
/** The fallback when a text cannot be normalised: still stable, never grouped with anything else. */
export const rawHash = (text: string) => `raw:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/** Never throws. A normaliser that fails, or returns nothing, falls back to a hash of the raw text. */
export function signatureOf(text: string, normaliser: Normaliser = NORMALISER): Signature {
  const sample = sampleOf(String(text));
  try {
    const signature = normaliser.normalise(sample);
    if (typeof signature !== "string" || !signature.trim()) throw Error("empty signature");
    return { signature: signature.slice(0, SIGNATURE_CHARS), version: normaliser.version, fallback: false };
  } catch {
    return { signature: rawHash(sample), version: normaliser.version, fallback: true };
  }
}

/** A readable, folder-safe name for a class seen for the first time. It is given once and never recomputed. */
export function classIdFor(signature: string): string {
  const words = signature
    .replace(/<[a-z]+>|^raw:.*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let name = "";
  for (const word of words) {
    if ((name + "-" + word).length > 40) break;
    name = name ? `${name}-${word}` : word.slice(0, 40);
  }
  return `${name || "unparsed"}-${createHash("sha256").update(signature).digest("hex").slice(0, 6)}`;
}
