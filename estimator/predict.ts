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
type Attempt = {id: string; ticket: string; status: string; brief: string; started: number | null; actual_seconds: number; actual_tokens: number};
const ActualSchema = z.object({completed: positive, seconds: z.number().finite().nonnegative(), tokens: z.number().finite().nonnegative()});
function chronological(rows: History[]): History[] {
  return [...rows].sort((a,b) => {
    // IDs break completion ties; remaining fields also stabilize duplicate-ID direct inputs.
    for (const key of ["completed", "id", "started", "area", "kind", "provider", ...dimensions] as const) {
      const left = a[key], right = b[key];
      if (left === right) continue;
      return left === null || (right !== null && left < right) ? -1 : 1;
    }
    return Number(a.imported)-Number(b.imported);
  });
}
export function history(s: Store): History[] {
  const rows = [...(s.get<unknown[]>("estimate-history") ?? [])];
  const attempts = new Map<string, Attempt[]>();
  for (const x of s.rows("sessions") as Attempt[]) {
    attempts.set(x.ticket, [...(attempts.get(x.ticket) ?? []), x]);
  }
  const archivedFinished = new Map<string, number>();
  for (const event of s.rows("events") as {kind: string; data: string; at: number}[]) {
    if (event.kind !== "session-archive") continue;
    let data:{id?:string;previousStatus?:string};try{const raw:unknown=JSON.parse(event.data);const parsed=z.object({id:z.string().min(1).optional(),previousStatus:z.string().optional()}).safeParse(raw);if(!parsed.success)continue;data=parsed.data;}catch{continue;}
    if (data.id && data.previousStatus === "finished" && Number.isFinite(event.at)) {
      archivedFinished.set(data.id, Math.min(archivedFinished.get(data.id) ?? Infinity, event.at));
    }
  }
  for (const [ticket, sessions] of attempts) {
    // Ticket-level legacy receipts carry no attempt identity. Match retained
    // counters and successful custody; never resolve ambiguity by row order.
    const parsed = ActualSchema.safeParse(s.get<unknown>(`actual:${ticket}`));
    if (!parsed.success) continue;
    const actual = parsed.data;
    const candidates = sessions.filter(x => x.started !== null && Number.isFinite(x.started) && x.started > 0 && x.started < actual.completed &&
      (x.status === "finished" || (x.status === "archived" && (archivedFinished.get(x.id) ?? -Infinity) >= actual.completed)) &&
      x.actual_seconds === actual.seconds && x.actual_tokens === actual.tokens);
    if (candidates.length !== 1) continue;
    const x = candidates[0];
    let t:{area?:string;kind?:string;provider?:string};try{const parsed=z.object({area:z.string().optional(),kind:z.string().optional(),provider:z.string().optional()}).safeParse(JSON.parse(x.brief));if(!parsed.success)continue;t=parsed.data;}catch{continue;}
    // Completion receipt is required: polling/elapsed time is not inferred as active work.
    rows.push({id:x.ticket, area:t.area ?? "unknown", kind:t.kind ?? "unknown", provider:t.provider,
      started:x.started, completed:actual.completed, seconds:actual.seconds > 0 ? actual.seconds : null, tokens:actual.tokens > 0 ? actual.tokens : null,
      elapsed:(actual.completed-x.started!)/1000});
  }
  const unique = new Map<string, History>();
  for (const row of rows) {
    const p = HistorySchema.safeParse(row);
    if (p.success && !p.data.imported && p.data.completed > p.data.started) unique.set(p.data.id,p.data);
  }
  return chronological([...unique.values()]);
}
function predict(rows: History[], target: Features, at: number, dimension: Dimension, recent: boolean): number | null {
  const prior = chronological(rows.filter(r => !r.imported && r.completed < at && r[dimension] !== null && r.provider === target.provider));
  const comparable = prior.filter(r => r.area === target.area && r.kind === target.kind);
  const pool = comparable.length >= 3 ? comparable : prior;
  const selected = recent ? pool.slice(-5) : pool;
  return selected.length ? selected.reduce((sum,r) => sum+r[dimension]!,0)/selected.length : null;
}
export function score(rows: History[]) {
  const errors = Object.fromEntries(dimensions.map(d => [d,{count:0, candidate:0, mean:0}])) as Record<Dimension,{count:number;candidate:number;mean:number}>;
  // Chronological held-out predictions: every training row completed before target launch.
  for (const row of chronological(rows)) for (const d of dimensions) {
    if (row.imported || row[d] === null || rows.filter(r => !r.imported && r.completed < row.started && r.provider === row.provider && r[d] !== null).length < 5) continue;
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
