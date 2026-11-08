import { processIdentity } from "./process";
import { estimate, history } from "../estimator/predict";
import { randomUUID, createHash } from "node:crypto";
import {
  TicketSchema,
  MeterSchema,
  QualificationSchema,
  type Config,
  type Ticket,
  type Meter,
  type Billing,
  type Qualification,
} from "./config";
import { Store } from "../tracking/store";
import { available, debit, awsRefusal } from "../wallet/ledger";
export type Session = {
  id: string;
  ticket: string;
  owner: string;
  provider: string;
  status: string;
  brief: string;
  native_id: string | null;
  pid: number | null;
  started: number | null;
  actual_seconds: number;
  actual_tokens: number;
  checkpoint: number;
};
export type Admission = {
  now: number;
  meter?: Meter;
  billing?: Billing;
  qualification?: Qualification;
};
export const ticketId = (t: Ticket) => `${t.repo}#${t.number}`;
export const eventId = (t: Ticket) =>
  createHash("sha256")
    .update(`helper:v1:${ticketId(t)}`)
    .digest("hex");
function blocked(reason: string): never {
  throw Error(reason);
}
export function usageGate(raw: unknown, high: boolean, now: number, c: Config, provider?: "codex" | "claude") {
  const p = MeterSchema.safeParse(raw);
  if (!p.success) blocked("usage unknown");
  const m = p.data;
  if (c.usage_windows) {
    if (!m.nativeProvider || (provider && m.nativeProvider !== provider)) blocked("native usage unknown");
  } else if (m.windows.length < 2) blocked("usage window missing");
  if (
    m.observedAt > now ||
    now - m.observedAt > c.usage_gates.max_meter_age_minutes * 60000 ||
    m.windows.some((w) => w.resetsAt <= now)
  )
    blocked("usage stale");
  const used = Math.max(...m.windows.map((w) => w.used));
  if (used >= c.usage_gates.stop_at) blocked("usage stop");
  if (used >= c.usage_gates.admit_below && !high) blocked("high benefit only");
}
// Claims are compared conservatively across case-insensitive workspaces, including old rows.
function claimPath(path: string): string {
  if (
    path.startsWith("/") ||
    /[^\x20-\x7e]/.test(path) ||
    /[\\\x00-\x1f*?\[\]{}:]/.test(path) ||
    path.split("/").some((x) => x === ".." || x === "")
  )
    blocked("invalid paths");
  const normalized = path
    .split("/")
    .filter((x) => x !== ".")
    .join("/")
    .normalize("NFC")
    .toLowerCase();
  if (!normalized) blocked("invalid paths");
  return normalized;
}
export class Engine {
  constructor(
    public s: Store,
    public c: Config,
  ) {}
  sessions(): Session[] {
    return this.s.rows("sessions") as Session[];
  }
  active() {
    return this.sessions().filter(
      (s) => !["finished", "archived"].includes(s.status),
    );
  }
  pause(paused: boolean, actor: "owner" | "helper") {
    if (actor !== "owner") blocked("owner only");
    this.s.atomic(() => {
      this.s.set("paused", paused);
      this.s.event(
        randomUUID(),
        paused ? "pause" : "resume",
        {},
        `Set pause to ${!paused}`,
      );
    });
  }
  admit(raw: unknown, a: Admission): Session {
    const original = TicketSchema.parse(raw);
    const floor = this.s.get<number>(`token-calibration:${original.provider}`) ?? 0;
    const t = { ...original, estimateTokens: Math.max(original.estimateTokens, floor) },
      id = eventId(t);
    return this.s.atomic(() => {
      if (this.s.get("paused") !== false) blocked("factory paused");
      if (this.s.db.query("SELECT id FROM events WHERE id=?").get(id))
        blocked("duplicate event");
      const project = Object.values(this.c.projects).find(
        (p) => p.repo === t.repo,
      );
      if (
        !project ||
        !project.owners.includes(t.owner) ||
        !this.c.owners[t.owner]
      )
        blocked("unenrolled owner or repo");
      if (this.c.owners[t.owner].harness !== t.provider)
        blocked("provider mismatch");
      const normalizedPaths = [...new Set(t.paths.map(claimPath))];
      usageGate(a.meter, t.benefit === "high", a.now, this.c, t.provider);
      const q = QualificationSchema.safeParse(a.qualification);
      const model = t.model ?? this.c.owners[t.owner].model,
        effort = t.effort ?? this.c.owners[t.owner].effort;
      if (
        !q.success ||
        q.data.expiresAt <= a.now ||
        q.data.model !== model ||
        q.data.effort !== effort
      )
        blocked("worker unqualified");
      const active = this.active();
      if (active.length >= this.c.capacity.start_parallel)
        blocked("slots full");
      if (
        t.heavy &&
        active.filter((x) => JSON.parse(x.brief).heavy).length >=
          this.c.capacity.heavy_test_slots
      )
        blocked("heavy slots full");
      const paths = this.s.db
        .query(
          `SELECT path FROM claims JOIN sessions ON claims.session=sessions.id WHERE sessions.status NOT IN ('finished','archived')`,
        )
        .all() as { path: string }[];
      if (
        normalizedPaths.some((p) =>
          paths.some(
            (x) =>
              p === claimPath(x.path) ||
              p.startsWith(claimPath(x.path) + "/") ||
              claimPath(x.path).startsWith(p + "/"),
          ),
        )
      )
        blocked("path claimed");
      if (t.wallet === "aws") {
        const refusal = awsRefusal(this.s, this.c, a.now, a.billing);
        if (refusal) blocked(refusal);
      }
      if (t.costCents > available(this.s, this.c, t.wallet, a.now, a.billing))
        blocked("wallet empty");
      this.s.set(`estimate:${ticketId(t)}`, estimate(history(this.s), t, a.now));
      this.s.event(
        id,
        "reservation",
        t,
        "Stop and archive session; debit remains conservative until month end",
        a.now,
      );
      this.s.db
        .query(
          "INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          ticketId(t),
          t.owner,
          t.provider,
          "reserved",
          JSON.stringify({ ...t, model, effort }),
        );
      for (const p of normalizedPaths)
        this.s.db.query("INSERT INTO claims VALUES(?,?)").run(p, id);
      debit(this.s, id, t.wallet, t.costCents, a.now);
      return this.sessions().find((x) => x.id === id)!;
    });
  }
  claimStart(id: string, now = Date.now()) {
    return this.s.atomic(() => {
      if (this.s.get("paused") !== false) return false;
      const changed =
        this.s.db
          .query(
            "UPDATE sessions SET status='starting',started=? WHERE id=? AND status='reserved'",
          )
          .run(now, id).changes === 1;
      if (changed)
        this.s.event(
          `start:${id}`,
          "start-attempt",
          { id },
          "Never retry an uncertain spawn; reconcile native custody",
          now,
        );
      return changed;
    });
  }
  register(id: string, pid: number, native: string | null) {
    this.s.set(`supervisor:${id}`, processIdentity(pid));
    this.s.db
      .query(
        "UPDATE sessions SET status='running',pid=?,native_id=COALESCE(?,native_id) WHERE id=? AND status IN ('starting','running')",
      )
      .run(pid, native, id);
    this.s.event(
      `custody:${id}:${native ?? pid}`,
      "custody",
      { id, pid, native },
      "Retain logs and native ID; archive only after handoff",
    );
  }
  account(id: string, seconds: number, tokens: number, now = Date.now()) {
    if (
      !Number.isFinite(seconds) ||
      !Number.isFinite(tokens) ||
      seconds < 0 ||
      tokens < 0
    )
      blocked("invalid accounting");
    this.s.atomic(() => {
      this.s.db
        .query(
          "UPDATE sessions SET actual_seconds=MAX(actual_seconds,?),actual_tokens=MAX(actual_tokens,?) WHERE id=?",
        )
        .run(seconds, tokens, id);
      const x = this.sessions().find((x) => x.id === id);
      if (!x) blocked("unknown session");
      const t = JSON.parse(x.brief) as Ticket;
      const ratio = Math.max(
        x.actual_seconds / t.estimateSeconds,
        x.actual_tokens / (this.s.get<number>(`token-extension:${id}`) ?? t.estimateTokens),
      );
      if (ratio >= this.c.overrun.checkpoint_at) {
        this.s.db.query("UPDATE sessions SET checkpoint=1 WHERE id=?").run(id);
        this.s.event(
          `checkpoint:${id}`,
          "checkpoint",
          { id, ratio },
          "Keep original estimate on rework",
          now,
        );
      }
      if (ratio >= this.c.overrun.pause_at) {
        this.s.db
          .query(
            "UPDATE sessions SET status='paused' WHERE id=? AND status NOT IN ('finished','archived')",
          )
          .run(id);
        this.s.db
          .query("INSERT OR IGNORE INTO questions VALUES(?,?,NULL,?)")
          .run(
            `overrun:${id}`,
            "Work reached twice its time or token estimate. Close it or grant a bounded extension?",
            now,
          );
      }
    });
  }
  finish(id: string, ok: boolean) {
    const current = this.sessions().find(x => x.id === id);
    if (ok && current?.started && !["paused", "archived", "finished"].includes(current.status)) {
      this.s.set(`actual:${current.ticket}`, {completed:Date.now(), seconds:current.actual_seconds, tokens:current.actual_tokens});
    }
    this.s.db
      .query(
        "UPDATE sessions SET status=? WHERE id=? AND status NOT IN ('paused','archived')",
      )
      .run(ok ? "finished" : "unknown", id);
    this.s.event(
      `exit:${id}`,
      "worker-exit",
      { id, ok },
      "Preserve workspace and logs; failed/uncertain work is never automatically retried",
    );
  }
  continueSession(id: string, receipt: string, spawn: () => void) {
    return this.s.atomic(() => {
      const x = this.sessions().find(x => x.id === id);
      if (!x || x.status !== "paused" || x.pid !== null || !x.native_id || x.provider !== "codex") blocked("stopped paused Codex custody required");
      if (!receipt?.trim() || this.s.get("paused") !== false) blocked("receipt and unpaused factory required");
      const cleanup = this.s.db.query("SELECT data FROM events WHERE id=?").get(`cleanup:${id}`) as {data:string}|null;
      if (!cleanup || (this.s.get<{verified:boolean}>(`cleanup-evidence:${id}`) ?? JSON.parse(cleanup.data)).verified !== true) blocked("verified cleanup required");
      const t = JSON.parse(x.brief) as Ticket;
      const tokens = this.s.get<number>("token-calibration:codex");
      if (!tokens || tokens <= t.estimateTokens || x.actual_tokens >= 2*tokens || x.actual_seconds >= 2*t.estimateSeconds) blocked("bounded calibrated extension required");
      const attempt = randomUUID();
      this.s.set(`token-extension:${id}`, tokens);
      const previousStop=this.s.get(`stop:${id}`);
      this.s.set(`stop:${id}`,null);
      this.s.set(`active-clock:${id}`,{at:Date.now(),seconds:x.actual_seconds});
      this.s.set(`continuation:${id}`, {attempt, native:x.native_id, receipt});
      this.s.db.query("UPDATE sessions SET status='starting' WHERE id=?").run(id);
      this.s.event(attempt, "session-continuation", {id, receipt, tokens, previous:x, previousStop}, "Stop session; preserve original baseline, accounting, native ID, claims and debits");
      spawn();
      return attempt;
    });
  }
  archive(id: string, receipt: string, actor: string) {
    if (actor !== "owner") blocked("owner only");
    if (!receipt?.trim() || receipt.length > 4000)
      blocked("custody receipt required");
    this.s.atomic(() => {
      const x = this.sessions().find((x) => x.id === id);
      if (!x || !["unknown", "paused", "finished"].includes(x.status))
        blocked("session not archivable");
      if (x.pid !== null) {
        try {
          process.kill(x.pid, 0);
          const recorded = this.s.get<string>(`supervisor:${id}`);
          const current = processIdentity(x.pid);
          // Legacy records lack identity: require reconciliation without guessing.
          if (current && (!recorded || recorded === current))
            blocked("supervisor still alive");
        } catch (error) {
          if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      this.s.db
        .query("UPDATE sessions SET status='archived' WHERE id=?")
        .run(id);
      this.s.event(
        randomUUID(),
        "session-archive",
        { id, receipt, previousStatus: x.status },
        "Preserve native session, worktree, claims and debits. Reconcile custody before a bounded continuation; never reset the ticket claim or refund.",
      );
    });
  }
  release(
    stage: "qa" | "production",
    revision: string,
    receipt: string,
    actor: string,
    now = Date.now(),
  ) {
    return this.s.atomic(() => {
      if (actor !== "release" || this.s.get("paused") !== false)
        blocked("release refused");
      if (!/^[a-f0-9]{40}$/.test(revision) || !receipt)
        blocked("revision and receipt required");
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.c.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const val = (k: string) => parts.find((x) => x.type === k)!.value;
      const day = `${val("year")}-${val("month")}-${val("day")}`,
        time = `${val("hour")}:${val("minute")}`;
      if (
        time !==
        (stage === "qa"
          ? this.c.schedule.qa_window
          : this.c.schedule.production_window)
      )
        blocked("missed release window");
      if (
        stage === "production" &&
        !this.s.db
          .query(
            "SELECT id FROM releases WHERE day=? AND stage='qa' AND revision=?",
          )
          .get(day, revision)
      )
        blocked("QA revision mismatch");
      const acceptance = this.s.get<{
        revision: string;
        day: string;
        receipt: string;
      }>("qa-acceptance");
      if (
        stage === "production" &&
        (!acceptance ||
          acceptance.revision !== revision ||
          acceptance.day !== day ||
          !acceptance.receipt)
      )
        blocked("QA acceptance missing");
      const id = `${day}:${stage}`;
      this.s.db
        .query("INSERT INTO releases VALUES(?,?,?,?,?,?)")
        .run(id, day, stage, revision, receipt, now);
      this.s.event(
        id,
        "release-authorization",
        { revision, receipt },
        "Use project containment runbook; no off-window new promotion",
        now,
      );
      return id;
    });
  }
}
