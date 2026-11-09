export type Tone = "ok" | "info" | "warn" | "bad" | "rest";
export function usageTone(used: number | null, gates: { admit_below: number; stop_at: number }): Tone {
  return used === null ? "rest" : used >= gates.stop_at ? "bad" : used >= gates.admit_below ? "warn" : "ok";
}
// Spend colour is independent of the admission stop latch and its temporary threshold.
export function spendTone(dollars: number | null, plan: number, redAbove: number): Tone {
  return dollars === null ? "rest" : dollars > redAbove ? "bad" : dollars >= plan ? "warn" : "ok";
}
export function timingTone(seconds: number | null, estimate: number | null, lastActivity: number | null, now: number, quietMinutes: number) {
  const over = seconds !== null && estimate !== null && seconds > estimate;
  const quiet = lastActivity !== null && lastActivity <= now && now - lastActivity >= quietMinutes * 60000;
  const tone: Tone = over || quiet ? "warn" : seconds === null || estimate === null ? "rest" : "ok";
  return { over, quiet, barTone: tone };
}
