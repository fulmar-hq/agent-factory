import { z } from "zod";
import { Store } from "./store";

const text = z.string().trim().min(1);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const definition = z.object({
  id: text,
  scope: text,
  question: text,
  tier: text,
  options: z.array(text).min(2),
  default: text,
  deadline: instant, // Absolute Unix epoch milliseconds, never a relative timeout.
  resolver: text,
}).strict().superRefine((d, ctx) => {
  if (new Set(d.options).size !== d.options.length || !d.options.includes(d.default))
    ctx.addIssue({ code: "custom", message: "Unique options must contain the default" });
});
export type DecisionDefinition = z.infer<typeof definition>;
export type DecisionOutcome = {
  option: string;
  resolvedBy: string;
  source: "answer" | "deadline";
  at: number;
};
export type Decision = DecisionDefinition & { outcome: DecisionOutcome | null };
type Row = { definition: string; outcome: string | null };
const undo = "Retain A3 definitions, outcomes and audit evidence; corrections require a new decision ID";

/** Durable state only. Call expire() on reconciliation; no timers or external effects.
 * Board/Telegram adapters and the full A3 end-to-end drill are a subsequent leaf.
 * Resolver is an identity supplied by a trusted adapter, not authentication here.
 * Scopes are opaque exact keys: pending(scope) never holds unrelated work globally.
 */
export class DecisionService {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS a3_decisions(id TEXT PRIMARY KEY, definition TEXT NOT NULL, deadline INTEGER NOT NULL, scope TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS a3_deadlines ON a3_decisions(deadline);
      CREATE TABLE IF NOT EXISTS a3_outcomes(id TEXT PRIMARY KEY REFERENCES a3_decisions(id), outcome TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS a3_definition_update BEFORE UPDATE ON a3_decisions BEGIN SELECT RAISE(ABORT,'decision is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS a3_definition_delete BEFORE DELETE ON a3_decisions BEGIN SELECT RAISE(ABORT,'decision is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS a3_outcome_update BEFORE UPDATE ON a3_outcomes BEGIN SELECT RAISE(ABORT,'outcome is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS a3_outcome_delete BEFORE DELETE ON a3_outcomes BEGIN SELECT RAISE(ABORT,'outcome is immutable'); END;
    `);
  }

  get(id: string): Decision | null {
    const row = this.store.db.query(`SELECT d.definition,o.outcome FROM a3_decisions d
      LEFT JOIN a3_outcomes o USING(id) WHERE d.id=?`).get(id) as Row | null;
    return row ? { ...JSON.parse(row.definition), outcome: row.outcome === null ? null : JSON.parse(row.outcome) } : null;
  }

  create(input: DecisionDefinition, now = Date.now()): Decision {
    const d = definition.parse(input);
    instant.parse(now);
    return this.store.atomic(() => {
      const previous = this.get(d.id);
      if (previous) {
        const { outcome: _, ...saved } = previous;
        if (JSON.stringify(saved) !== JSON.stringify(d)) throw Error("Decision ID already has a different definition");
        return previous;
      }
      this.store.db.query("INSERT INTO a3_decisions VALUES(?,?,?,?)")
        .run(d.id, JSON.stringify(d), d.deadline, d.scope);
      this.audit(d.id, "created", d, now);
      return { ...d, outcome: null };
    });
  }

  /** First committed outcome wins. At or after the deadline even a late answer defaults. */
  resolve(id: string, option: string, resolver: string, now = Date.now()): Decision {
    instant.parse(now);
    return this.store.atomic(() => {
      const d = this.get(id);
      if (!d) throw Error("Unknown decision");
      if (d.outcome) return d;
      if (now >= d.deadline) return this.finish(d, d.default, "deadline", now);
      if (resolver !== d.resolver) throw Error("Wrong resolver");
      if (!d.options.includes(option)) throw Error("Unknown option");
      return this.finish(d, option, "answer", now);
    });
  }

  /** Returns only newly defaulted decisions. Repeats/restarts append nothing. */
  expire(now = Date.now()): Decision[] {
    instant.parse(now);
    return this.store.atomic(() => {
      const rows = this.store.db.query(`SELECT d.id FROM a3_decisions d
        LEFT JOIN a3_outcomes o USING(id) WHERE o.id IS NULL AND d.deadline<=?
        ORDER BY d.deadline,d.id`).all(now) as { id: string }[];
      return rows.map(({ id }) => {
        const d = this.get(id)!;
        return this.finish(d, d.default, "deadline", now);
      });
    });
  }

  pending(scope: string): Decision[] {
    const rows = this.store.db.query(`SELECT d.id FROM a3_decisions d
      LEFT JOIN a3_outcomes o USING(id) WHERE o.id IS NULL AND d.scope=? ORDER BY d.deadline,d.id`)
      .all(scope) as { id: string }[];
    return rows.map(({ id }) => this.get(id)!);
  }

  private finish(d: Decision, option: string, source: DecisionOutcome["source"], at: number): Decision {
    const outcome: DecisionOutcome = { option, source, at, resolvedBy: source === "answer" ? d.resolver : "deadline-default" };
    this.store.db.query("INSERT INTO a3_outcomes VALUES(?,?)").run(d.id, JSON.stringify(outcome));
    const result = { ...d, outcome };
    this.audit(d.id, "resolved", result, at);
    return result;
  }

  private audit(id: string, phase: "created" | "resolved", data: unknown, at: number) {
    if (!this.store.event(JSON.stringify(["a3-decision", id, phase]), `a3-decision-${phase}`, data, undo, at))
      throw Error("Decision audit ID conflict"); // Roll back state rather than silently lose evidence.
  }
}
