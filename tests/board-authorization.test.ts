import { expect, test } from "bun:test";
import { authorizationResponse, same } from "../board/server";

// Fictional credentials only; these tests never start the board or invoke controls.
const token = "a".repeat(64);
const port = 4318;
const origin = `http://127.0.0.1:${port}`;
const credential = `Bearer ${token}`;

test("comparison accepts an ASCII match and rejects wrong tokens", () => {
  expect(same(credential, credential)).toBe(true);
  expect(same(`Bearer ${"b".repeat(64)}`, credential)).toBe(false);
  expect(same("Bearer short", credential)).toBe(false);
  expect(same("", credential)).toBe(false);
});

test("equal character counts with unequal byte lengths fail closed", () => {
  for (const malformed of [`Bearer ${"é".repeat(64)}`, `Bearer ${"😀".repeat(32)}`]) {
    expect(malformed.length).toBe(credential.length);
    expect(Buffer.byteLength(malformed)).not.toBe(Buffer.byteLength(credential));
    expect(same(malformed, credential)).toBe(false);
    expect(same(credential, malformed)).toBe(false);
  }
});

function request(headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/pause`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, origin, authorization: credential, ...headers },
    body: "invalid JSON must not be read by the authorization guard",
  });
}

test("request boundary accepts only the exact bearer credential", () => {
  expect(authorizationResponse(request(), port, token)).toBeUndefined();
});

for (const [name, authorization] of [
  ["wrong token", `Bearer ${"b".repeat(64)}`],
  ["unequal UTF-8 bytes", `Bearer ${"é".repeat(64)}`],
  ["lowercase scheme", `bearer ${token}`],
  ["missing scheme", token],
  ["extra separator", `Bearer  ${token}`],
  ["empty credential", ""],
] as const) {
  test(`request boundary refuses ${name} with a no-store 403`, async () => {
    const req = request({ authorization });
    const response = authorizationResponse(req, port, token);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ error: "owner authorization required" });
    expect(req.bodyUsed).toBe(false);
  });
}

for (const header of ["authorization", "origin", "host"]) {
  test(`request boundary refuses a missing ${header} header`, () => {
    const req = request();
    req.headers.delete(header);
    const response = authorizationResponse(req, port, token);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(req.bodyUsed).toBe(false);
  });
}

test("request boundary retains origin and loopback host restrictions", () => {
  const cases: Record<string, string>[] = [
    { origin: "https://evil.invalid" },
    { origin: `http://localhost:${port}` },
    { origin: `http://127.0.0.1:${port + 1}` },
    { host: `localhost:${port}` },
    { host: "evil.invalid" },
    { host: `127.0.0.1:${port + 1}` },
  ];
  for (const headers of cases) {
    const response = authorizationResponse(request(headers), port, token);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
});
