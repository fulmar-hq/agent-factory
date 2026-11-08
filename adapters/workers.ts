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
      t.provider === "claude" && selected === "opus-5.5" ? "claude-opus-5-5" : selected,
    effort = t.effort ?? "medium";
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",

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
        "--ignore-rules",
        "-c", 'approval_policy="never"',
        "-c", 'default_permissions="factory"',
        "-c", 'permissions.factory.filesystem={ ":minimal"="read", ":workspace_roots"="write", "/tmp"="read", ":tmpdir"="read", "/Library/Developer"="read", "/opt/homebrew"="read" }',
        "-c", "permissions.factory.network.enabled=false",
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
  env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
  const nativeId = crypto.randomUUID();
  return {
    argv: [
      "claude",
      mode === "background" ? "--bg" : "-p",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-chrome",
      "--restricted",
      "--tools", "Bash,Read,Edit,Write,Glob,Grep",
      "--permission-mode", "acceptEdits",
      "--settings", JSON.stringify({
        permissions: {blockReadsOutsideWorkingDirectories:true},
        sandbox: {enabled:true, failIfUnavailable:true, autoAllowBashIfSandboxed:true, allowUnsandboxedCommands:false, excludedCommands:[], filesystem:{denyRead:[env.HOME ?? "/Users"], allowRead:[workspace]}},
      }),
      "--permission-prompts",
      "none",
      "--model",
      model,
      "--effort",
      effort,
      "--session-id",
      nativeId,
      ...(mode === "print"
        ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
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
          tokens: (x.usage?.input_tokens ?? 0) + (x.usage?.output_tokens ?? 0) +
            (x.usage?.cache_read_input_tokens ?? 0) + (x.usage?.cache_creation_input_tokens ?? 0),
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

// Streaming and transcript copies share message IDs; never add two sources together.
export class WorkerAccounting {
  tokens = 0;
  private messages = new Map<string, number>();
  private inputs = new Map<string, number>();
  private current = "";
  ingest(provider: string, line: string) {
    const receipt = sessionEvent(provider, line);
    try {
      const x = JSON.parse(line);
      if (provider === "codex" && x.type === "event_msg" && x.payload?.type === "token_count") {
        const n = x.payload.info?.total_token_usage?.total_tokens;
        if (Number.isSafeInteger(n) && n >= 0) this.tokens = Math.max(this.tokens, n);
      }
      if (provider === "claude") {
        const event = x.type === "stream_event" ? x.event : null;
        const m = event?.type === "message_start" ? event.message : x.type === "assistant" ? x.message : null;
        if (m?.id && m.usage) {
          this.current = m.id;
          const u = m.usage;
          const values = [u.input_tokens ?? 0,u.cache_read_input_tokens ?? 0,u.cache_creation_input_tokens ?? 0,u.output_tokens ?? 0];
          if (values.every(n => Number.isSafeInteger(n) && n >= 0)) {
            const input = values[0]+values[1]+values[2];
            this.inputs.set(m.id,input);
            this.messages.set(m.id,Math.max(this.messages.get(m.id) ?? 0,input+values[3]));
          }
        }
        const output = event?.type === "message_delta" ? event.usage?.output_tokens : undefined;
        if (this.current && Number.isSafeInteger(output) && output >= 0)
          this.messages.set(this.current,Math.max(this.messages.get(this.current) ?? 0,(this.inputs.get(this.current) ?? 0)+output));
        this.tokens = Math.max(this.tokens,[...this.messages.values()].reduce((a,b)=>a+b,0));
      }
    } catch {}
    if (receipt.tokens !== undefined && Number.isSafeInteger(receipt.tokens) && receipt.tokens >= 0)
      this.tokens = Math.max(this.tokens,receipt.tokens);
    return {...receipt,tokens:this.tokens};
  }
}
