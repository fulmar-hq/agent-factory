import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { command } from "../adapters/github";
import { root, configAt } from "../launcher/config";
import { Store } from "../tracking/store";
import { z } from "zod";
import { HistorySchema, type History } from "./predict";
const ClosedRowsSchema = z.array(z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime({offset:true}),
  closedAt: z.iso.datetime({offset:true}),
  labels: z.array(z.object({name:z.string()})),
  body: z.string().optional(),
}));
export function closedHistory(repo: string, kind: string, response: unknown): History[] {
  if (Array.isArray(response) && response.length >= 10000) throw Error("History truncated; prior evidence retained");
  const rows = ClosedRowsSchema.parse(response);
  const identities = new Set<number>();
  return rows.map(r => {
    if (identities.has(r.number)) throw Error("Duplicate history issue identity; prior evidence retained");
    identities.add(r.number);
    const started = Date.parse(r.createdAt), completed = Date.parse(r.closedAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) {
      throw Error("Invalid history interval; prior evidence retained");
    }
    return HistorySchema.parse({
      id:`${repo}:${kind}:${r.number}`, area:r.labels.find(l => l.name.startsWith("area:"))?.name ?? "unknown",
      kind:r.labels.find(l => l.name.startsWith("kind:"))?.name ?? kind, provider:"unknown",
      started, completed,
      imported:r.labels.some(l => /import|migrat/i.test(l.name)) || /linear\.app|imported from|migrated from/i.test(r.body ?? ""),
      seconds:null, tokens:null, elapsed:(completed-started)/1000,
    });
  });
}
export async function refreshHistory(s: Store, execute = command, now = Date.now(), repos = ["fulmar-hq/agent-factory"]) {
  const rows: History[] = [];
  for (const repo of [...new Set(repos)]) {
    for (const kind of ["issue","pr"]) {
      const result: unknown = JSON.parse(await execute(["gh",kind,"list","--repo",repo,"--state","closed","--limit","10000","--json","number,createdAt,closedAt,labels,body"]));
      rows.push(...closedHistory(repo,kind,result));
    }
  }
  s.atomic(() => {
    // Append snapshots to the event log; old operational evidence remains recoverable.
    s.event(randomUUID(),"estimate-history-refresh",{rows,observedAt:now},"Restore a prior history snapshot from this append-only event log",now);
    s.set("estimate-history",rows);
    s.set("estimate-history-source",{observedAt:now,count:rows.length, note:"GitHub timings are elapsed only; helper-hours and usage require native actual receipts"});
  });
  return {count:rows.length};
}
if (import.meta.main) {
  const s = new Store(join(root,"controller.sqlite"));
  try {
    const config = await configAt();
    console.log(await refreshHistory(s,command,Date.now(),["fulmar-hq/agent-factory",...Object.values(config.projects).map(p=>p.repo)]));
  } finally {s.close();}
}
