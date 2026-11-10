import { type Engine } from "./engine";
import { type Store } from "../tracking/store";

export type Question = {
  id: string; text: string; answer: string | null; at: number;
  addressed_to: string; resolved_at: number | null; resolved_by: string | null;
};
// Only positive subject evidence closes a question. Missing subjects stay open.
export function resolveQuestions(e: Engine, now = Date.now()) {
  return e.s.atomic(() => {
    let count = 0;
    for (const q of e.s.db.query("SELECT * FROM questions WHERE answer IS NULL AND resolved_at IS NULL").all() as Question[]) {
      let reason: string | undefined;
      if (q.id.startsWith("overrun:")) {
        const id = q.id.slice("overrun:".length), x = e.sessions().find(x => x.id === id);
        if (x?.status === "finished" || x?.status === "archived") reason = `session ${x.status}`;
        else if (x && ["starting", "running"].includes(x.status) && !e.budget(x).nextTurnBlocked) {
          const resumed = e.s.db.query("SELECT id FROM events WHERE kind='session-continuation' AND json_extract(data,'$.id')=? AND at>=?").get(id, q.at);
          if (resumed) reason = "session resumed under a new bounded budget";
        }
      } else if (q.id.startsWith("autonomy:")) {
        const decision = e.s.get<{state:string;outcome?:string}>(`autonomy-decision:${q.id.slice("autonomy:".length)}`);
        if (decision?.state === "defaulted") reason = `decision default applied${decision.outcome ? `: ${decision.outcome}` : ""}`;
        else if (decision?.state === "decided" || decision?.state === "owner-decided") reason = "owner decided";
      }
      if (!reason) continue;
      const by = `auto: ${reason}`;
      e.s.db.query("UPDATE questions SET resolved_at=?,resolved_by=? WHERE id=? AND answer IS NULL AND resolved_at IS NULL").run(now, by, q.id);
      e.s.event(crypto.randomUUID(), "question-auto-resolved", {id:q.id, reason, addressedTo:q.addressed_to}, "Retain question and subject evidence; reconcile subject before reopening", now);
      count++;
    }
    return count;
  });
}
export function boardQuestions(s: Store) {
  const rows = s.rows("questions") as Question[];
  return {
    questions: rows.filter(q => q.answer === null && q.resolved_at === null && q.addressed_to === "vincent"),
    ownerQuestions: rows.filter(q => q.answer === null && q.resolved_at === null && q.addressed_to === "owner"),
    resolvedQuestions: rows.filter(q => q.resolved_at !== null && q.resolved_by?.startsWith("auto: ")).sort((a,b) => b.resolved_at! - a.resolved_at!),
  };
}
