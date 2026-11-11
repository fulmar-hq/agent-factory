import { expect, test } from "bun:test";
import { localReadings } from "../adapters/usage";
import type { Meter } from "../launcher/config";

// Fictional, injected observations only: no processes, files or home discovery.
const now = 1_800_000_000_000;
function meter(provider: "codex" | "claude", source: string, observedAt: number, used = .1): Meter {
  return { nativeProvider: provider, source, observedAt, windows: [
    { name: "weekly", durationMinutes: 10080, used, resetsAt: now + 604_800_000 },
  ] };
}
const receipt = meter("codex", "fictional receipt", now - 2000);
const status = meter("codex", "fictional status", now - 1000);
const claude = meter("claude", "fictional Claude receipt", now - 3000, .4);
const keys = ["receipt", "claude", "status"] as const;
const successes = { receipt, claude, status };
const failure = {
  reject: () => Promise.reject<Meter | undefined>(new Error("fictional rejected read")),
  throw: (): Promise<Meter | undefined> => { throw new Error("fictional synchronous throw"); },
};

for (const mode of ["reject", "throw"] as const) {
  for (const failed of keys) {
    test(`${failed} ${mode} leaves the other sources intact`, async () => {
      const calls: string[] = [];
      const source = (key: typeof keys[number]) => () => {
        calls.push(key);
        return key === failed ? failure[mode]() : Promise.resolve(successes[key]);
      };
      const result = await localReadings(now, {
        receipt: source("receipt"), claude: source("claude"), status: source("status"),
      });
      expect(calls.sort()).toEqual([...keys].sort());
      expect(result.codex).toBe(failed === "status" ? receipt : status);
      expect(result.claude).toBe(failed === "claude" ? undefined : claude);
    });
  }
}

// Every success/failure combination, including lone survivors and all failed.
for (let mask = 0; mask < 8; mask++) {
  const successful = mask;
  test(`independent sources preserve success subset ${successful}`, async () => {
    const source = (key: typeof keys[number], bit: number) => () => successful & bit
      ? Promise.resolve(successes[key])
      : failure[key === "claude" ? "throw" : "reject"]();
    const result = await localReadings(now, {
      receipt: source("receipt", 1), claude: source("claude", 2), status: source("status", 4),
    });
    expect(result.codex).toBe(successful & 4 ? status : successful & 1 ? receipt : undefined);
    expect(result.claude).toBe(successful & 2 ? claude : undefined);
  });
}

test("absent readings remain unknown and failed refreshes retain no earlier result", async () => {
  const sources = { receipt: async () => receipt, claude: async () => claude, status: async () => status };
  expect(await localReadings(now, sources)).toEqual({ codex: status, claude });
  expect(await localReadings(now + 1000, {
    receipt: failure.throw, claude: failure.reject, status: failure.throw,
  })).toEqual({ codex: undefined, claude: undefined });
  expect(await localReadings(now, {
    receipt: async () => undefined, claude: async () => undefined, status: async () => undefined,
  })).toEqual({ codex: undefined, claude: undefined });
});

test("polling preserves original timestamps and partial windows without merging sources", async () => {
  const newer = meter("codex", "fictional partial status", now - 500, .95);
  const older = { ...receipt, windows: [...receipt.windows,
    { name: "primary", durationMinutes: 300, used: .02, resetsAt: now + 3_600_000 },
  ] };
  const sources = { receipt: async () => older, claude: async () => claude, status: async () => newer };
  const original = JSON.stringify({ older, newer, claude });
  for (const pollAt of [now, now + 900_001]) {
    const result = await localReadings(pollAt, sources);
    expect(result.codex).toBe(newer);
    expect(result.codex?.windows).toBe(newer.windows);
    expect(result.codex?.windows).toHaveLength(1);
    expect(result.claude).toBe(claude);
    expect(result.claude?.windows).toBe(claude.windows);
  }
  expect(JSON.stringify({ older, newer, claude })).toBe(original);
});

for (const newerSource of ["receipt", "status"] as const) {
  for (const condition of ["high usage", "future timestamp", "expired reset", "missing windows", "wrong provider"] as const) {
    test(`newer ${newerSource} with ${condition} cannot be hidden by older low usage`, async () => {
      const newer = meter("codex", `fictional newer ${newerSource}`, now - 500);
      if (condition === "high usage") newer.windows[0].used = .95;
      if (condition === "future timestamp") newer.observedAt = now + 1000;
      if (condition === "expired reset") newer.windows[0].resetsAt = now - 1000;
      if (condition === "missing windows") newer.windows = [];
      if (condition === "wrong provider") newer.nativeProvider = "claude";
      const result = await localReadings(now, {
        receipt: async () => newerSource === "receipt" ? newer : receipt,
        claude: failure.reject,
        status: async () => newerSource === "status" ? newer : status,
      });
      // Selection retains invalid evidence for the existing gate to refuse.
      expect(result.codex).toBe(newer);
      expect(result.claude).toBeUndefined();
    });
  }
}

test("equal Codex timestamps keep existing receipt precedence", async () => {
  const tiedStatus = { ...status, observedAt: receipt.observedAt, windows: [{ ...status.windows[0], used: .95 }] };
  const result = await localReadings(now, {
    receipt: async () => receipt, claude: async () => claude, status: async () => tiedStatus,
  });
  expect(result.codex).toBe(receipt);
  expect(result.claude).toBe(claude);
});
