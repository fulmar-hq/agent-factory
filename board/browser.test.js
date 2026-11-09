import { test, expect } from "bun:test";
// Run against a real board with BOARD_URL and BOARD_SCREENSHOTS set. Ordinary unit CI needs no browser.
test.skipIf(!process.env.BOARD_URL)("board renders without overflow, raw JSON, ISO timestamps or CSP errors; sheet traps and restores focus", async () => {
  const proc = Bun.spawn([process.execPath, new URL('./verify.mjs',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe',env:process.env});
  const [out,err,code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  expect(err).toBe('');expect(code).toBe(0);expect(JSON.parse(out)).toHaveLength(8);
},180000);
