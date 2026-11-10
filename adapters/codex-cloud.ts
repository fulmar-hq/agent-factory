import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * #134: default-off, standalone boundary. No scheduler, board, schema, local
 * slot, usage (0.70/0.90) or capacity (6/12) changes. Native subscription only.
 *
 * Source acceptance: UNVERIFIED. No authoritative CLI cloud source/docs were
 * accessible in the implementation worker. Do not invent commands or wire
 * dispatch from help text, injected fixtures, task URLs or a source-only claim.
 * Installed acceptance: SEPARATE; `inspect()` retains version/help observations,
 * never operation qualification. Implementation-time attempts at `codex
 * --version` and `codex cloud --help` were denied (operation not permitted).
 *
 * No lifecycle command is implemented until its authoritative, version-matched
 * contract is reviewed. This is an explicit unsupported adapter, not a working
 * cloud delivery path. Parent owns scheduler/board and one authorized end-to-end
 * proof before queue enablement. Cloud delivery requires a direct PR, Release
 * squash, an independent exact-head challenge before Release merge/Coordinator
 * installation, and no signing credentials. None is asserted by these tests.
 * Undo: revert these two standalone files; preserve operational evidence.
 */

const Requirements = z.strictObject({
  dependencyInventoryComplete: z.literal(true),
  browser: z.boolean(),
  aws: z.boolean(),
  localDatabase: z.boolean(),
  privateDependencies: z.boolean(),
});
const Request = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  requirements: Requirements,
});
export type CloudRequest = z.infer<typeof Request>;
export type CloudEligibility = { eligible: boolean; reasons: string[] };

// Explicit reviewed declarations, never keyword inference from a prompt. An
// incomplete/unknown inventory refuses; eligibility alone grants no admission.
export function cloudEligibility(input: unknown): CloudEligibility {
  const parsed = Request.safeParse(input);
  if (!parsed.success) return { eligible: false, reasons: ["Complete reviewed dependency declarations, repository and exact head required"] };
  const reasons: string[] = [];
  for (const [key, reason] of [
    ["browser", "Browser dependency refused"],
    ["aws", "AWS dependency refused"],
    ["localDatabase", "Local database dependency refused"],
    ["privateDependencies", "Private dependency refused"],
  ] as const) if (parsed.data.requirements[key]) reasons.push(reason);
  return { eligible: reasons.length === 0, reasons };
}

export type CloudOperation = "start" | "status" | "result" | "pr";
export type CloudCommandResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
};
export type CloudCommand = (argv: readonly string[]) => Promise<CloudCommandResult>;
export type CloudProbe = { argv: readonly string[]; result: CloudCommandResult };
export type CloudAcceptance = {
  source: { status: "unverified"; reason: string };
  installed: {
    status: "not-inspected" | "unavailable" | "observed";
    probes: CloudProbe[];
  };
};
export type CloudOutcome =
  | { status: "disabled"; operation: CloudOperation }
  | { status: "ineligible"; operation: "start"; reasons: string[] }
  | { status: "unsupported"; operation: CloudOperation; missingEvidence: string[]; acceptance: CloudAcceptance };

const missing: Record<CloudOperation, string> = {
  start: "Version-matched authoritative headless start command, task identity and uncertain-start recovery contract unavailable",
  status: "Version-matched authoritative headless status command, exact task binding and terminal-state contract unavailable",
  result: "Version-matched authoritative headless result command and repository/head/result binding contract unavailable",
  pr: "Version-matched authoritative headless direct-PR creation/readback and cloud-task/repository/head linkage contract unavailable",
};

// This runner can only inspect local help/version. No cloud request, shell,
// browser, API, PR mutation, local patch application or command fallback exists.
const localInspection: CloudCommand = (argv) => new Promise((resolve) => {
  if (JSON.stringify(argv) !== '["codex","--version"]' &&
      JSON.stringify(argv) !== '["codex","cloud","--help"]') {
    resolve({ exitCode: null, signal: null, stdout: "", stderr: "", error: "Only local version/help inspection is permitted" });
    return;
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
  execFile("codex", argv.slice(1), {
    env, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
    killSignal: "SIGTERM", shell: false,
  }, (error, stdout, stderr) => resolve({
    exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
    signal: error?.signal ?? null, stdout, stderr,
    ...(error ? { error: error.message } : {}),
  }));
});

export class CodexCloudAdapter {
  private readonly enabled: boolean;
  private readonly command: CloudCommand;
  private acceptance: CloudAcceptance = {
    source: { status: "unverified", reason: "Authoritative local CLI cloud source/docs and version match unavailable; no lifecycle command accepted" },
    installed: { status: "not-inspected", probes: [] },
  };

  constructor(options: { enabled?: boolean; command?: CloudCommand } = {}) {
    this.enabled = options.enabled === true;
    this.command = options.command ?? localInspection;
  }

  // Explicit, read-only inspection works while disabled. Help/version evidence
  // is useful even when no cloud headless operation can be accepted.
  async inspect(): Promise<CloudAcceptance> {
    const probes: CloudProbe[] = [];
    for (const argv of [["codex", "--version"], ["codex", "cloud", "--help"]]) {
      let result: CloudCommandResult;
      try { result = await this.command([...argv]); }
      catch (error) { result = { exitCode: null, signal: null, stdout: "", stderr: "", error: String(error) }; }
      probes.push({ argv, result: structuredClone(result) });
    }
    const observed = probes.every(({ result: r }) => r.exitCode === 0 && r.signal === null && !r.error && r.stdout.trim().length > 0);
    this.acceptance = { ...this.acceptance, installed: { status: observed ? "observed" : "unavailable", probes } };
    return structuredClone(this.acceptance);
  }

  async start(request: unknown): Promise<CloudOutcome> {
    if (!this.enabled) return { status: "disabled", operation: "start" };
    const eligibility = cloudEligibility(request);
    if (!eligibility.eligible) return { status: "ineligible", operation: "start", reasons: eligibility.reasons };
    return this.unsupported("start");
  }

  async status(_taskId: string): Promise<CloudOutcome> { return this.unsupported("status"); }
  async result(_taskId: string): Promise<CloudOutcome> { return this.unsupported("result"); }
  async linkPR(_taskId: string): Promise<CloudOutcome> { return this.unsupported("pr"); }

  private unsupported(operation: CloudOperation): CloudOutcome {
    if (!this.enabled) return { status: "disabled", operation };
    const missingEvidence = [missing[operation]];
    if (this.acceptance.installed.status !== "observed") {
      missingEvidence.push("Successful installed `codex --version` and `codex cloud --help` observations missing; see separate installed probes");
    }
    return { status: "unsupported", operation, missingEvidence, acceptance: structuredClone(this.acceptance) };
  }
}
