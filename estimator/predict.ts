import { z } from "zod";
import type { Store } from "../tracking/store";
const positive = z.number().finite().positive();
export const HistorySchema = z.object({
  id: z.string(), area: z.string(), kind: z.string(), provider: z.string(),
  started: positive, completed: positive, imported: z.boolean().default(false),
  seconds: positive.nullable(), tokens: positive.nullable(), elapsed: positive.nullable(),
});
export type History = z.infer<typeof HistorySchema>;
export type Features = Pick<History, "area" | "kind" | "provider">;
const dimensions = ["seconds", "tokens", "elapsed"] as const;
type Dimension = typeof dimensions[number];
export function history(s: Store): History[] {
  const rows = [...(s.get<unknown[]>("estimate-history") ?? [])];
  for (const x of s.rows("sessions") as {ticket: string; status: string; brief: string; started: number | null; actual_seconds: number; actual_tokens: number}[]) {
    if (x.status !== "finished" || !x.started) continue;
    const t = JSON.parse(x.brief);
    // Completion receipt is required: polling/elapsed time is not inferred as active work.
    const actual = s.get<{completed: number; seconds: number; tokens: number}>(`actual:${x.ticket}`);
    if (actual) rows.push({id:x.ticket, area:t.area ?? "unknown", kind:t.kind ?? "unknown", provider:t.provider,
      started:x.started, completed:actual.completed, seconds:actual.seconds > 0 ? actual.seconds : null, tokens:actual.tokens > 0 ? actual.tokens : null,
      elapsed:(actual.completed-x.started)/1000});
  }
  const unique = new Map<string, History>();
  for (const row of rows) {
    const p = HistorySchema.safeParse(row);
    if (p.success && !p.data.imported && p.data.completed > p.data.started) unique.set(p.data.id,p.data);
  }
  return [...unique.values()].sort((a,b) => a.completed-b.completed);
}
function predict(rows: History[], target: Features, at: number, dimension: Dimension, recent: boolean): number | null {
  const prior = rows.filter(r => !r.imported && r.completed < at && r[dimension] !== null && r.provider === target.provider);
  const comparable = prior.filter(r => r.area === target.area && r.kind === target.kind);
  const pool = comparable.length >= 3 ? comparable : prior;
  const selected = recent ? pool.slice(-5) : pool;
  return selected.length ? selected.reduce((sum,r) => sum+r[dimension]!,0)/selected.length : null;
}
export function score(rows: History[]) {
  const errors = Object.fromEntries(dimensions.map(d => [d,{count:0, candidate:0, mean:0}])) as Record<Dimension,{count:number;candidate:number;mean:number}>;
  // Chronological held-out predictions: every training row completed before target launch.
  for (const row of rows) for (const d of dimensions) {
    if (row.imported || row[d] === null || rows.filter(r => r.completed < row.started && r.provider === row.provider && r[d] !== null).length < 5) continue;
    const candidate = predict(rows,row,row.started,d,true), mean = predict(rows,row,row.started,d,false);
    if (candidate === null || mean === null) continue;
    errors[d].count++;
    errors[d].candidate += Math.abs(candidate-row[d]!);
    errors[d].mean += Math.abs(mean-row[d]!);
  }
  const ratio = (d: Dimension) => errors[d].mean > 0 ? errors[d].candidate/errors[d].mean : null;
  const better = errors.seconds.count >= 20 && errors.tokens.count >= 20 && errors.elapsed.count >= 20 &&
    ratio("seconds") !== null && ratio("seconds")! <= .9 && ratio("tokens") !== null && ratio("tokens")! <= .9 &&
    errors.elapsed.candidate <= errors.elapsed.mean;
  return {status:better ? "better" : "not-better", errors, ratios: {seconds:ratio("seconds"),tokens:ratio("tokens"),elapsed:ratio("elapsed")}};
}
export function estimate(rows: History[], target: Features, at: number, evaluation = score(rows.filter(r => r.completed < at && r.provider === target.provider && r.area === target.area && r.kind === target.kind))) {
  const recent = evaluation.status === "better";
  return {version:"recent-five-v1", at, method:recent ? "recent-five" : "mean", confidence:"historical evidence only",
    helperHours: convert(predict(rows,target,at,"seconds",recent),3600),
    tokens:predict(rows,target,at,"tokens",recent), elapsedHours:convert(predict(rows,target,at,"elapsed",recent),3600),
    evaluation};
}
function convert(value: number | null, divisor: number) { return value === null ? null : value/divisor; }
