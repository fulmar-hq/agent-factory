import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { command } from "../adapters/github";
import { root } from "../launcher/config";
import { Store } from "../tracking/store";
import type { History } from "./predict";
type Closed = {number:number;createdAt:string;closedAt:string;labels:{name:string}[]; body?:string};
export function closedHistory(repo: string, kind: string, rows: Closed[]): History[] {
  return rows.filter(r => r.closedAt).map(r => ({
    id:`${repo}:${kind}:${r.number}`, area:r.labels.find(l => l.name.startsWith("area:"))?.name ?? "unknown",
    kind:r.labels.find(l => l.name.startsWith("kind:"))?.name ?? kind, provider:"unknown",
    started:Date.parse(r.createdAt), completed:Date.parse(r.closedAt),
    imported:r.labels.some(l => /import|migrat/i.test(l.name)) || /linear\.app|imported from|migrated from/i.test(r.body ?? ""),
    seconds:null, tokens:null, elapsed:(Date.parse(r.closedAt)-Date.parse(r.createdAt))/1000,
  }));
}
export async function refreshHistory(s: Store, execute = command, now = Date.now()) {
  const rows: History[] = [];
  for (const repo of ["fulmar-hq/agent-factory","fulmar-hq/alido"]) {
    for (const kind of ["issue","pr"]) {
      const result = JSON.parse(await execute(["gh",kind,"list","--repo",repo,"--state","closed","--limit","10000","--json","number,createdAt,closedAt,labels,body"])) as Closed[];
      if (result.length >= 10000) throw Error("History truncated; prior evidence retained");
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
  try { console.log(await refreshHistory(s)); } finally {s.close();}
}
