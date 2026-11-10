import { builderSlots, type SlotProcessEvidence } from "./capacity";
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
  attempt: number;
  approval_digest: string | null;
};
export type Admission = {
  now: number;
  meter?: Meter;
  billing?: Billing;
  qualification?: Qualification;
  // Fresh all-state GitHub PR readback for these exact retained session branches.
  retryNoPr?: string[];
  recoverUsage?: boolean;
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
export function claimPath(path: string): string {
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
    public slotEvidence?: SlotProcessEvidence,
  ) {}
  sessions(): Session[] {
    return this.s.rows("sessions") as Session[];
  }
  active() {
    return this.sessions().filter(
      (s) => !["finished", "archived"].includes(s.status),
    );
  }
  slots() { return builderSlots(this.s, this.c, this.slotEvidence); }
  // One durable allowance across providers, ticks and restarts. Only a fresh
  // native observation made after that admission can rearm it.
  refreshUsage(provider: "codex" | "claude", meter: Meter | undefined, now: number) {
    this.s.atomic(() => {
      const prior = this.s.get<{id:string;provider:string;at:number}>("usage-bootstrap");
      if (!prior || prior.provider !== provider || !meter || meter.observedAt <= prior.at) return;
      try { usageGate(meter, true, now, this.c, provider); }
      catch { return; }
      this.s.event(`usage-refreshed:${prior.id}`, "usage-bootstrap-refreshed", { ...prior, observedAt: meter.observedAt }, "Retain the native observation and bootstrap admission receipt", now);
      this.s.set("usage-bootstrap", null);
    });
  }
  private recoveryEligible(t: Ticket, meter: Meter | undefined, now: number) {
    if (t.heavy || t.costCents !== 0 || t.estimateSeconds > 1800 || t.estimateTokens > 8000000)
      blocked("usage recovery requires small unpaid ticket");
    if (meter) {
      const parsed = MeterSchema.safeParse(meter);
      if (!parsed.success || parsed.data.nativeProvider !== t.provider || parsed.data.observedAt > now)
        blocked("usage recovery native evidence invalid");
      const used = Math.max(...parsed.data.windows.map(w => w.used));
      if (used >= this.c.usage_gates.stop_at) blocked("usage stop");
      if (used >= this.c.usage_gates.admit_below && t.benefit !== "high") blocked("high benefit only");
    }
  }
  workerUsage(id: string, meter: Meter | undefined, now: number) {
    const x = this.sessions().find(x => x.id === id);
    if (!x) blocked("unknown session");
    const t = JSON.parse(x.brief) as Ticket;
    try { usageGate(meter, t.benefit === "high", now, this.c, t.provider); }
    catch (error) {
      const allowance = this.s.get<{id:string;at:number}>("usage-bootstrap");
      if (!allowance || allowance.id !== id || now < allowance.at || now - allowance.at > 120000 || this.s.get(`continuation:${id}`) || !["Error: usage stale", "Error: usage unknown"].includes(String(error))) throw error;
      this.recoveryEligible(t, meter, now);
    }
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
  retryPrior(t: Ticket): Session[] {
    const prior = this.sessions().filter(x => x.ticket === ticketId(t)).sort((a,b) => a.attempt-b.attempt);
    if (!prior.length) return prior;
    if (!t.approvalDigest || prior.some(x => !x.approval_digest || x.approval_digest === t.approvalDigest)) blocked("duplicate event: digest already claimed or prior digest unknown");
    let lastArchive = 0;
    for (const x of prior) {
      if (x.status !== "archived") blocked("retry custody unresolved");
      if (x.pid !== null) {
        const current = processIdentity(x.pid), recorded = this.s.get<string>(`supervisor:${x.id}`);
        if (current && (!recorded || current === recorded)) blocked("retry supervisor still alive");
      }
      const archive = this.s.db.query("SELECT at FROM events WHERE kind='session-archive' AND json_extract(data,'$.id')=? AND length(trim(json_extract(data,'$.receipt')))>0 ORDER BY at DESC LIMIT 1").get(x.id) as {at:number}|null;
      if (!archive) blocked("retry custody receipt missing");
      lastArchive = Math.max(lastArchive, archive.at);
      if (this.s.db.query("SELECT id FROM events WHERE kind IN ('launcher-publish','worker-delivery') AND json_extract(data,'$.id')=?").get(x.id)) blocked("retry prior PR exists");
    }
    const approval = this.s.db.query("SELECT id FROM events WHERE kind='intake-approval' AND json_extract(data,'$.repo')=? AND json_extract(data,'$.number')=? AND json_extract(data,'$.label')=? AND length(trim(json_extract(data,'$.receipt')))>0 AND at>=?").get(t.repo,t.number,t.approvalDigest,lastArchive);
    if (!approval) blocked("retry requires new owner approval after archive");
    return prior;
  }
  admit(raw: unknown, a: Admission): Session {
    const original = TicketSchema.parse(raw);
    const defaults=this.c.ticket_budget_default;
    const completed=this.sessions().filter(x=>x.status==="finished" && x.actual_tokens>0).filter(x=>{
      const brief=JSON.parse(x.brief) as Ticket;
      return brief.provider===original.provider && brief.repo===original.repo && brief.area===original.area && brief.kind===original.kind;
    });
    const meanSeconds=completed.length ? Math.ceil(completed.reduce((n,x)=>n+x.actual_seconds,0)/completed.length) : undefined;
    const mean=completed.length ? Math.ceil(completed.reduce((n,x)=>n+x.actual_tokens,0)/completed.length) : undefined;
    const floor = defaults ? mean ?? defaults.estimate_tokens : this.s.get<number>(`token-calibration:${original.provider}`) ?? 0;
    // Forecasts may raise a reservation, never silently shrink approved bounds.
    const proposedTokens=original.estimateTokens;
    const proposedSeconds=original.estimateSeconds;
    const t = { ...original, estimateSeconds:defaults ? Math.max(proposedSeconds,meanSeconds ?? defaults.estimate_minutes*60) : original.estimateSeconds, estimateTokens: Math.max(proposedTokens, floor) };
    return this.s.atomic(() => {
      if (this.s.get("paused") !== false) blocked("factory paused");
      const prior = this.retryPrior(t);
      const autoRetry=this.s.get<{session:string}>(`automatic-retry:${ticketId(t)}`);
      const failure=autoRetry && this.s.get<{repo:string;provider:string;cause:string}>(`failure-class:${autoRetry.session}`);
      if(failure && this.s.get(`restart-held:${failure.repo}:${failure.provider}:${failure.cause}`))blocked("failure cause restart budget held");
      const attempt = prior.length ? prior[prior.length-1].attempt + 1 : 1;
      const id = prior.length ? createHash("sha256").update(`helper:v2:${ticketId(t)}:${t.approvalDigest}`).digest("hex") : eventId(t);
      if (this.s.db.query("SELECT id FROM events WHERE id=?").get(id)) blocked("duplicate event");
      if (prior.length && (a.retryNoPr?.length !== prior.length || prior.some(x => !a.retryNoPr!.includes(x.id)))) blocked("retry prior PR unknown");
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
      let bootstrap = false;
      this.refreshUsage(t.provider, a.meter, a.now);
      try { usageGate(a.meter, t.benefit === "high", a.now, this.c, t.provider); }
      catch (error) {
        if (!a.recoverUsage || !["Error: usage stale", "Error: usage unknown"].includes(String(error))) throw error;
        this.recoveryEligible(t, a.meter, a.now);
        if (this.s.get("usage-bootstrap") || this.active().length) blocked("usage recovery awaiting fresh native reading");
        bootstrap = true;
      }
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
      if (!this.slots().free)
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
          "INSERT INTO sessions(id,ticket,owner,provider,status,brief,attempt,approval_digest) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          ticketId(t),
          t.owner,
          t.provider,
          "reserved",
          JSON.stringify({ ...t, model, effort }),
          attempt,
          t.approvalDigest ?? null,
        );
      if (prior.length) this.s.event(`retry:${id}`, "session-retry", {id, ticket:ticketId(t), attempt, digest:t.approvalDigest, prior:prior.map(x=>x.id), noPr:a.retryNoPr}, "Stop and reconcile this attempt; retain all earlier sessions, claims, debits and receipts", a.now);
      for (const p of normalizedPaths)
        this.s.db.query("INSERT INTO claims VALUES(?,?)").run(p, id);
      debit(this.s, id, t.wallet, t.costCents, a.now);
      if (bootstrap) {
        const receipt = {id, provider:t.provider, at:a.now, observedAt:a.meter?.observedAt ?? null, estimateSeconds:t.estimateSeconds, estimateTokens:t.estimateTokens};
        this.s.set("usage-bootstrap", receipt);
        this.s.event(`usage-bootstrap:${id}`, "usage-bootstrap-admission", receipt, "Stop and reconcile the retained run; allowance rearms only after a newer fresh native reading", a.now);
      }
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
    this.s.set(`supervisor:${id}`, (this.slotEvidence?.identity ?? processIdentity)(pid));
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
      const budget=this.budget(x);
      this.s.set(`budget:${id}`,budget);
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
      if (ratio >= this.c.overrun.pause_at && !["finished", "archived"].includes(x.status)) {
        this.s.set(`stop:${id}`,{reason:"budget pause; next turn blocked",at:now,...budget});
        this.s.db
          .query(
            "UPDATE sessions SET status='paused' WHERE id=? AND status NOT IN ('finished','archived')",
          )
          .run(id);
        this.s.db
          .query("INSERT INTO questions(id,text,answer,at,addressed_to) VALUES(?,?,NULL,?,'vincent') ON CONFLICT(id) DO UPDATE SET answer=NULL,at=excluded.at,resolved_at=NULL,resolved_by=NULL WHERE questions.resolved_at IS NOT NULL")
          .run(
            `overrun:${id}`,
            "Work reached twice its time or token estimate. Close it or grant a bounded extension?",
            now,
          );
      }
    });
  }
  budget(x:Session) {
    const t=JSON.parse(x.brief) as Ticket;
    const tokens=this.s.get<number>(`token-extension:${x.id}`) ?? t.estimateTokens;
    return {estimateTokens:tokens,checkpointTokens:tokens*1.8,pauseTokens:tokens*2,
      estimateSeconds:t.estimateSeconds,checkpointSeconds:t.estimateSeconds*1.8,pauseSeconds:t.estimateSeconds*2,
      overshootTokens:Math.max(0,x.actual_tokens-tokens*2),overshootSeconds:Math.max(0,x.actual_seconds-t.estimateSeconds*2),
      nextTurnBlocked:x.actual_tokens>=tokens*2 || x.actual_seconds>=t.estimateSeconds*2,
      cachedTokens:this.s.get<number>(`cached-tokens:${x.id}`) ?? 0};
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
      if (!x || x.status !== "paused" || !x.native_id || x.provider !== "codex") blocked("stopped paused Codex custody required");
      if (!receipt?.trim() || this.s.get("paused") !== false) blocked("receipt and unpaused factory required");
      const cleanup = this.s.db.query("SELECT data FROM events WHERE id=?").get(`cleanup:${id}`) as {data:string}|null;
      if (!cleanup || (this.s.get<{verified:boolean}>(`cleanup-evidence:${id}`) ?? JSON.parse(cleanup.data)).verified !== true) blocked("verified cleanup required");
      const t = JSON.parse(x.brief) as Ticket;
      const waiting = this.s.get<{receipt:string;tokens:number}>(`continuation-slot-wait:${id}`);
      const tokens = waiting?.receipt===receipt ? waiting.tokens : this.s.get<number>("token-calibration:codex");
      if (!tokens || tokens <= t.estimateTokens || x.actual_tokens >= 2*tokens || x.actual_seconds >= 2*t.estimateSeconds) blocked("bounded calibrated extension required");
      const slots=this.slots();
      if(!slots.dormant.has(id))blocked("stopped paused Codex custody required");
      if(!slots.free) {
        this.s.set(`continuation-slot-wait:${id}`,{receipt,tokens});
        this.s.event(`continuation-slot-wait:${id}:${tokens}:${createHash('sha256').update(receipt).digest('hex')}`,"session-continuation-wait",{id,receipt,tokens},"Retain approved extension and custody; retry normal slot admission on a later tick");
        return;
      }
      const attempt = randomUUID();
      this.s.set(`continuation-slot-wait:${id}`,null);
      this.s.set(`token-extension:${id}`, tokens);
      const previousStop=this.s.get(`stop:${id}`);
      this.s.set(`stop:${id}`,null);
      this.s.set(`active-clock:${id}`,{at:Date.now(),seconds:x.actual_seconds});
      this.s.set(`continuation:${id}`, {attempt, native:x.native_id, receipt});
      this.s.db.query("UPDATE sessions SET status='starting',pid=NULL WHERE id=?").run(id);
      this.s.event(attempt, "session-continuation", {id, receipt, tokens, previous:x, previousStop}, "Stop session; preserve original baseline, accounting, native ID, claims and debits");
      spawn();
      return attempt;
    });
  }
  // The scheduled browser/continuation reconciliation supplies the normal
  // supervisor spawn. A queued extension never replaces its frozen approval.
  resumeContinuations(spawn:(id:string)=>void) {
    for(const row of this.s.db.query("SELECT key FROM kv WHERE key LIKE 'continuation-slot-wait:%' AND value!='null'").all() as {key:string}[]) {
      const id=row.key.slice('continuation-slot-wait:'.length);
      try {
        this.s.atomic(()=>{
          const waiting=this.s.get<{receipt:string}>(row.key);
          if(waiting)this.continueSession(id,waiting.receipt,()=>spawn(id));
        });
      }
      catch(error) {this.s.event(`continuation-slot-refused:${id}:${String(error)}`,"session-continuation-refused",{id,error:String(error)},"Retain waiting approval; reconcile custody and normal continuation gates");}
    }
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
