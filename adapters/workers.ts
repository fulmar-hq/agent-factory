import type { Ticket } from "../launcher/config";
import { command } from "./github";
export type WorkerSpec = {
  argv: string[];
  env: Record<string, string>;
  nativeId?: string;
};
export function workerSpec(
  t: Ticket,
  workspace: string,
  mode: "print" | "background" = "print",
): WorkerSpec {
  const selected = t.model ?? (t.provider === "codex" ? "gpt-6.1-sol" : "opus");
  const model =
      t.provider === "claude" && selected === "opus-5.5" ? "opus" : selected,
    effort = t.effort ?? "medium";
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "SSH_AUTH_SOCK",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  // Explicit allowlist: never inherit API keys, provider routes, controller tokens or gh tokens.
  const prompt = `Work only this approved outcome: ${t.outcome}\nAllowed paths: ${t.paths.join(", ")}\nTest: ${t.test}\nNo helpers, funding, policy edits, releases, real messages or sign-ins. Preserve all work; signed commits only. Report receipts.\nIssue ${t.repo}#${t.number}`;
  if (t.provider === "codex")
    return {
      argv: [
        "codex",
        "exec",
        "--ignore-user-config",
        "--json",
        "--sandbox",
        "workspace-write",
        "-m",
        model,
        "-c",
        `model_reasoning_effort=${effort}`,
        "-C",
        workspace,
        prompt,
      ],
      env,
    };
  const nativeId = crypto.randomUUID();
  return {
    argv: [
      "claude",
      mode === "background" ? "--bg" : "-p",
      "--model",
      model,
      "--effort",
      effort,
      "--session-id",
      nativeId,
      ...(mode === "print"
        ? ["--output-format", "stream-json", "--verbose"]
        : ["--name", `factory-${t.number}`]),
      prompt,
    ],
    env,
    nativeId,
  };
}
export function sessionEvent(
  provider: string,
  line: string,
): { native?: string; tokens?: number; done?: boolean } {
  try {
    const x = JSON.parse(line);
    if (provider === "codex") {
      if (x.type === "thread.started") return { native: x.thread_id };
      if (x.type === "turn.completed")
        return {
          tokens: (x.usage?.input_tokens ?? 0) + (x.usage?.output_tokens ?? 0),
          done: true,
        };
    } else {
      if (x.type === "system" && x.session_id) return { native: x.session_id };
      if (x.type === "result")
        return {
          native: x.session_id,
          tokens: (x.usage?.input_tokens ?? 0) + (x.usage?.output_tokens ?? 0),
          done: true,
        };
    }
  } catch {}
  return {};
}
export async function wakeCodexApp(nativeId: string) {
  if (!/^[a-f0-9-]{36}$/.test(nativeId)) throw Error("native ID required");
  // Foreground is required. A queued message or `open -g` does not prove a turn started.
  await command(["open", `codex://threads/${nativeId}`]);
}
export async function claudeBackgroundStatus() {
  return JSON.parse(await command(["claude", "agents", "--json"]));
}

export function subscriptionStatus(provider: string, output: string) {
  if (provider === "codex")
    return /Logged in using ChatGPT/i.test(output) && !/API key/i.test(output);
  try {
    const x = JSON.parse(output);
    return (
      x.loggedIn === true &&
      x.authMethod === "claude.ai" &&
      x.apiProvider === "firstParty" &&
      !!x.subscriptionType
    );
  } catch {
    return false;
  }
}
export async function verifySubscription(provider: string) {
  const p = Bun.spawn(
    provider === "codex"
      ? ["codex", "login", "status"]
      : ["claude", "auth", "status"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const timer = setTimeout(() => p.kill(), 15000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0 || !subscriptionStatus(provider, out + "\n" + err))
      throw Error("subscription sign-in unverified; no key fallback");
  } finally {
    clearTimeout(timer);
  }
}
