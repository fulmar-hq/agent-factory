import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { QualificationSchema, type Qualification } from "./config";

// A5 is callable, not scheduled. Scheduling and the three-day observation are
// separate leaves. No command-only qualify-delivery adapter can implement this
// contract. In particular, prompts asking a model to assert success are not probes.
const ms = 60 * 60 * 1000;
const providerSchema = z.enum(["codex", "claude"]);
const requestSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  publisher: z.object({ repo: z.enum(["fulmar-hq/alido", "fulmar-hq/agent-factory"]), tree: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
}).strict();
export type RenewalRequest = z.infer<typeof requestSchema>;
const ref = z.string().min(1);
const time = z.number().int().positive();
const proofSchema = z.object({
  source: z.literal("native"), runId: ref, provider: providerSchema,
  nativeId: ref, startedAt: time, observedAt: time, expiresAt: time,
  version: ref, model: ref, effort: requestSchema.shape.effort,
  subscription: z.object({ route: z.literal("subscription"), receipt: ref }).strict(),
  // Both file and command tool boundaries must have actual denied invocations.
  denials: z.array(z.object({
    boundary: z.enum(["file", "command"]), operation: z.enum(["controller-read", "outside-write"]),
    result: z.literal("denied"), knownTarget: ref, toolCallId: ref, receipt: ref,
  }).strict()).min(4),
  accounting: z.object({ inputTokens: time, outputTokens: time, elapsedMs: time, receipt: ref }).strict(),
  stop: z.object({ processIdentity: ref, signal: z.enum(["SIGTERM", "SIGKILL"]),
    descendantsRemaining: z.literal(0), receipt: ref, containmentReceipt: ref }).strict(),
  phone: z.object({ nativeId: ref, steeringReceipt: ref }).strict(),
  publisher: z.object({ repo: requestSchema.shape.publisher.shape.repo,
    testedTree: requestSchema.shape.publisher.shape.tree, publishedTree: requestSchema.shape.publisher.shape.tree,
    commit: z.string().regex(/^[a-f0-9]{40}$/), githubVerifiedSignatureReceipt: ref, exactTreeTestReceipt: ref,
  }).strict(),
}).strict();
export type RenewalProof = z.infer<typeof proofSchema>;
export const renewalGates = ["subscription", "exact-model-effort", "native-tool-denials", "live-accounting", "stop-descendants", "phone-steering", "exact-tree-publisher"] as const;
export type RenewalContext = RenewalRequest & { runId: string; startedAt: number; previous: Qualification; archive: string };
export interface RenewalProbe {
  // Trusted launcher adapters only, never supplied by worker JSON, CLI flags,
  // or model text. Check capability without starting a model or other effects.
  unsupported(request: RenewalRequest, gates: typeof renewalGates): string | null;
  collect(context: RenewalContext): Promise<unknown>;
  // Independently reread retained native/tool/accounting/cleanup/publisher and
  // phone receipts, binding them to this NEW run. Return parsed observations,
  // never echo collect() or treat its flags/prose as evidence. This is a trust
  // boundary, like PublishAuthority; a schema is not a native receipt verifier.
  verify(context: RenewalContext, collected: unknown): Promise<unknown>;
}

export const unsupportedNativeProbe: RenewalProbe = {
  unsupported: () => "unsupported full native renewal probe: new subscription, model/effort, native-tool denials, accounting, stop/descendants, phone and exact-tree publisher verification unavailable; qualify-delivery, flags and prompts cannot qualify",
  collect: async () => { throw Error("unsupported native renewal probe"); },
  verify: async () => { throw Error("unsupported native receipt verifier"); },
};

export function renewalEligibility(expiresAt: number, now: number): boolean {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !Number.isSafeInteger(now) || now <= 0) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return expiresAt <= now + 6 * ms || (parts.find(p => p.type === "hour")?.value === "18" && parts.find(p => p.type === "minute")?.value === "00");
}

function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error("bounded regular qualification file required");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function syncDir(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durable(path: string, bytes: string) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export type RenewalResult = { status: "renewed" | "refused" | "uncertain"; reason?: string; receipt?: string; claim?: string; expiresAt?: number };
export type RenewalOptions = {
  dir: string; request: RenewalRequest; probe?: RenewalProbe; clock?: () => number;
  // Fault injection for synthetic orchestration tests; never exposed in CLI.
  checkpoint?: (point: "archived" | "staged" | "before-replace" | "replaced") => void;
};

export async function renewQualification(options: RenewalOptions): Promise<RenewalResult> {
  const clock = options.clock ?? Date.now, probe = options.probe ?? unsupportedNativeProbe;
  let claim: string | undefined, receipt: string | undefined, lock: string | undefined;
  let replaced = false, nativeStarted = false, nativeVerified = false;
  try {
    const request = requestSchema.parse(options.request), now = clock();
    const path = join(options.dir, "qualifications.json");
    const original = readRegular(path);
    const all: unknown = JSON.parse(original);
    if (!all || typeof all !== "object" || Array.isArray(all)) throw Error("qualification map required");
    const records = all as Record<string, unknown>;
    // Expired original evidence is retained and may be renewed by a NEW run;
    // expiry is never advanced simply to make old evidence valid again.
    const previous = QualificationSchema.parse(records[request.provider]);
    if (!renewalEligibility(previous.expiresAt, now)) throw Error("not eligible: require 18:00 Toronto or expiry within six hours");
    const claims = join(options.dir, "renewal-claims");
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    syncDir(options.dir);
    // Serialize both providers' read/modify/replace. An interrupted lock is kept,
    // never time-expired or stolen: reconcile native custody before archiving it.
    const active = join(claims, "active");
    mkdirSync(active, { mode: 0o700 });
    lock = active;
    syncDir(claims);
    if (readRegular(path) !== original) throw Error("qualifications changed before claim");
    claim = join(claims, `${request.provider}-${previous.expiresAt}`);
    mkdirSync(claim, { mode: 0o700 });
    syncDir(claims);
    const runId = randomUUID();
    receipt = join(claim, "result.json");
    durable(join(claim, "claim.json"), json({ request, runId, startedAt: now, originalSha256: digest(original), previousExpiry: previous.expiresAt,
      undo: "Retain claims and all receipts. Reconcile native custody before restoring archived qualifications; expired evidence never authorizes work." }));
    durable(join(claim, "qualifications.original.json"), original);
    syncDir(claim);
    options.checkpoint?.("archived");
    const unsupported = probe.unsupported(request, renewalGates);
    if (unsupported !== null) throw Error(unsupported || "unsupported native renewal probe");
    const context: RenewalContext = { ...request, runId, startedAt: now, previous, archive: claim };
    nativeStarted = true;
    const collected = await probe.collect(context);
    // No caller-supplied qualification booleans are used to create authority.
    const proof = proofSchema.parse(await probe.verify(context, collected));
    const finished = clock();
    if (finished < now || proof.startedAt < now || proof.observedAt < proof.startedAt || proof.observedAt > finished ||
        proof.expiresAt <= finished || proof.expiresAt <= previous.expiresAt || proof.expiresAt > proof.observedAt + 24 * ms)
      throw Error("stale, expired or non-new native qualification evidence");
    if (proof.runId !== runId || proof.provider !== request.provider || proof.model !== request.model || proof.effort !== request.effort || proof.phone.nativeId !== proof.nativeId)
      throw Error("native identity/model/effort mismatch");
    for (const boundary of ["file", "command"] as const) for (const operation of ["controller-read", "outside-write"] as const)
      if (!proof.denials.some(d => d.boundary === boundary && d.operation === operation)) throw Error("missing native-tool denial");
    if (new Set(proof.denials.map(d => d.toolCallId)).size !== proof.denials.length) throw Error("reused native-tool invocation");
    if (proof.publisher.repo !== request.publisher.repo || proof.publisher.testedTree !== request.publisher.tree || proof.publisher.publishedTree !== request.publisher.tree)
      throw Error("publisher exact-tree evidence mismatch");
    nativeVerified = true;
    durable(join(claim, "verified-native-proof.json"), json(proof));
    const qualification: Qualification = QualificationSchema.parse({ qualified: true, subscription: true, policyIsolation: true,
      liveAccounting: true, stopVerified: true, phoneVerified: true, version: proof.version, model: proof.model, effort: proof.effort,
      expiresAt: proof.expiresAt, evidence: join(claim, "verified-native-proof.json") });
    const next = json({ ...records, [request.provider]: qualification });
    const staged = join(claim, "qualifications.next.json");
    durable(staged, next);
    durable(join(claim, "prepared.json"), json({ originalSha256: digest(original), nextSha256: digest(next), expiresAt: proof.expiresAt }));
    syncDir(claim);
    options.checkpoint?.("staged");
    options.checkpoint?.("before-replace");
    if (readRegular(path) !== original) throw Error("qualifications changed during probes");
    if (readRegular(staged) !== next) throw Error("staged qualification interrupted or changed");
    if (clock() >= proof.expiresAt) throw Error("qualification expired before replacement");
    renameSync(staged, path);
    replaced = true;
    syncDir(options.dir);
    options.checkpoint?.("replaced");
    const result: RenewalResult = { status: "renewed", receipt, claim, expiresAt: proof.expiresAt };
    durable(receipt, json(result));
    syncDir(claim);
    return result;
  } catch (error) {
    const result: RenewalResult = { status: replaced ? "uncertain" : "refused", reason: String(error), receipt, claim };
    // Never delete partially written artifacts, retry a claim, or roll back newer
    // evidence. A prepared journal plus original archive reconciles a crash.
    if (receipt) {
      try { durable(receipt, json(result)); syncDir(claim!); } catch { /* Retain interrupted receipt; caller still gets failure. */ }
    }
    return result;
  } finally {
    if (lock && (!nativeStarted || nativeVerified)) {
      // Completed/handled attempts archive the global mutex; hard interruptions
      // leave it in place, as do probes without verified native cleanup.
      // Provider/expiry claims are NEVER released.
      renameSync(lock, join(options.dir, "renewal-claims", `released-${randomUUID()}`));
      syncDir(join(options.dir, "renewal-claims"));
    }
  }
}
