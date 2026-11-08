import { root, type Ticket } from "../launcher/config";
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve, dirname } from "node:path";
import { command } from "./github";
export type WorkerSpec = {
  argv: string[];
  env: Record<string, string>;
  nativeId?: string;
  settings?: ReturnType<typeof claudeSettings>;
};
// Deny every private asset except this run's worktree (normally nested under root).
// Do not deny the ancestor itself: native deny rules take precedence over allows.
export function privateDenyPaths(privateDir: string, workspace: string): string[] {
  const canonical = (p: string) => existsSync(p) ? realpathSync(p) : resolve(p);
  const base = canonical(privateDir), work = canonical(workspace);
  if (base === work) throw Error("private root cannot be a worker workspace");
  const tail = relative(base, work);
  if (tail.startsWith("..") || isAbsolute(tail)) return [base];
  const parts = tail.split("/");
  const denied: string[] = [];
  let parent = base;
  for (const part of parts) {
    for (const name of readdirSync(parent)) if (name !== part) denied.push(join(parent, name));
    parent = join(parent, part);
  }
  return denied;
}
export function claudeSettings(workspace: string, privateDir = root) {
  const denied = privateDenyPaths(privateDir, workspace);
  return {
    switchModelsOnFlag: false,
    permissions: {
      allow: ["Bash"],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      deny: [
        ...denied.flatMap(p => [`Read(/${p}/**)`, `Edit(/${p}/**)`]),
        "Edit(//tmp/**)", "Edit(//private/tmp/**)",
      ],
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [],
      network: { allowedDomains: [], allowLocalBinding: true, allowAllUnixSockets: false, allowUnixSockets: [] },
      filesystem: { denyRead: [process.env.HOME ?? "/Users", ...denied], allowRead: [workspace], denyWrite: denied },
    },
  };
}
export function materializeSettings(spec: WorkerSpec, path: string) {
  if (!spec.settings) return spec;
  // New immutable run asset; never overwrite an earlier run's policy.
  writeFileSync(path, JSON.stringify(spec.settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const argv = [...spec.argv];
  argv[argv.indexOf("--settings") + 1] = path;
  return { ...spec, argv };
}
export function workerSpec(
  t: Ticket,
  workspace: string,
  mode: "print" | "background" = "print",
  privateDir = root,
  delivery?: {native?:string},
): WorkerSpec {
  const selected = t.model ?? (t.provider === "codex" ? "gpt-6.1-sol" : "opus-5.5");
  const model =
      t.provider === "claude" && ["opus", "opus-5.5"].includes(selected) ? "claude-opus-5-5" : selected,
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
  const prompt = `Work only this approved outcome: ${t.outcome}\nAllowed paths: ${t.paths.join(", ")}\nTest: ${t.test}\nNo helpers, funding, policy edits, releases, real messages or sign-ins. Preserve all work; leave unsigned local commits for launcher publication. Report receipts.\nIssue ${t.repo}#${t.number}`;
  if (t.provider === "codex") {
    const files: Record<string,string> = {":minimal":"read", ":workspace_roots":"write", "/Library/Developer":"read", "/System/Library/OpenSSL/openssl.cnf":"read"};
    // All commands have this boundary, including commands in resumed sessions.
    // The harness alone retains its subscription connection and transcript access.
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.TMPDIR = join(workspace,".factory-tmp");
    for (const path of [process.execPath, Bun.which("node")]) {
      if (!path || !existsSync(path)) throw Error("pinned toolchain missing");
      files[realpathSync(path)]="read";
      env.PATH = env.PATH + ":" + dirname(realpathSync(path));
    }
    files[join(workspace,"node_modules")]="read";
    if (delivery) files[join(workspace,".git")]="write"; // trusted setup supplied standalone metadata
    const sockets: string[] = [];
    const deliveryPrompt = delivery ? "\nLeave an unsigned commit and .factory-delivery.bundle (git bundle create .factory-delivery.bundle HEAD). The launcher tests the snapshot and signs/publishes after worker cleanup. Never sign or push. Use .factory-tmp for scratch." : "";
    const filesystem = Object.entries(files).map(([p,a])=>`${JSON.stringify(p)}=${JSON.stringify(a)}`).join(", ");
    return {
      argv: [
        "codex",
        "exec",
        "--ignore-user-config",
        "--json",
        "--ignore-rules",
        "-c", 'approval_policy="never"',
        "-c", 'default_permissions="factory"',
        "-c", `permissions.factory.filesystem={ ${filesystem} }`,
        "-c", `permissions.factory.network.unix_sockets={ ${sockets.map(p=>`${JSON.stringify(p)}="allow"`).join(", ")} }`,
        "-c", `permissions.factory.network.enabled=false`,
        "-c", "permissions.factory.network.allowed_domains=[]",
        "-c", `features.network_proxy.enabled=false`,
        "-c", `features.network_proxy.unix_sockets={ ${sockets.map(p=>`${JSON.stringify(p)}="allow"`).join(", ")} }`,
        "-c", "allow_login_shell=false",
        "-c", 'shell_environment_policy.inherit="all"',
        "-c", 'web_search="disabled"',
        "-m",
        model,
        "-c",
        `model_reasoning_effort=${effort}`,
        ...(delivery?.native ? ["resume",delivery.native] : ["-C",workspace]),
        prompt + deliveryPrompt,
      ],
      env,
    };
  }
  env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
  const nativeId = crypto.randomUUID();
  const settings = claudeSettings(workspace, privateDir);
  return {
    argv: [
      "claude",
      mode === "background" ? "--bg" : "-p",
      "--safe-mode",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-chrome",
      "--restricted",
      "--tools", "Bash,Read,Edit,Write,Glob,Grep",
      "--permission-mode", "acceptEdits",
      "--settings", JSON.stringify(settings),
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
    settings,
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
          done: x.is_error === false && x.subtype === "success" && x.stop_reason !== "refusal",
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
  readonly models = new Set<string>();
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
        if (typeof m?.model === "string") this.models.add(m.model);
        if (x.type === "result" && x.modelUsage && typeof x.modelUsage === "object")
          for (const model of Object.keys(x.modelUsage)) this.models.add(model);
        if (m?.id && m.usage) {
          if(event?.type === "message_start") this.current = m.id;
          const u = m.usage;
          const values = [u.input_tokens ?? 0,u.cache_read_input_tokens ?? 0,u.cache_creation_input_tokens ?? 0,u.output_tokens ?? 0];
          if (values.every(n => Number.isSafeInteger(n) && n >= 0)) {
            const input = values[0]+values[1]+values[2];
            this.inputs.set(m.id,input);
            this.messages.set(m.id,Math.max(this.messages.get(m.id) ?? 0,input+values[3]));
          }
        }
        const output = event?.type === "message_delta" ? event.usage?.output_tokens : undefined;
        const messageId = typeof x.api_message_id === "string" ? x.api_message_id : this.current;
        if (messageId && Number.isSafeInteger(output) && output >= 0)
          this.messages.set(messageId,Math.max(this.messages.get(messageId) ?? 0,(this.inputs.get(messageId) ?? 0)+output));
        this.tokens = Math.max(this.tokens,[...this.messages.values()].reduce((a,b)=>a+b,0));
      }
    } catch {}
    if (receipt.tokens !== undefined && Number.isSafeInteger(receipt.tokens) && receipt.tokens >= 0)
      this.tokens = Math.max(this.tokens,receipt.tokens);
    return {...receipt,tokens:this.tokens};
  }
}
