import {pauseOwner} from '../launcher/release-pause';
import { refreshPulls } from "./pulls";
import { claudeReading } from "../adapters/usage";
import { boardEvidence } from "./runtime";
import { boardQuestions } from "../launcher/questions";
import { boardModel } from "./model";
import {slotLimit} from "../launcher/capacity";
import { issueTicket } from "../adapters/github";
import { estimate, history, score } from "../estimator/predict";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { Store } from "../tracking/store";
import {
  configAt,
  root,
  inputs,
  optionalJSON,
  QualificationSchema,
} from "../launcher/config";
import { Engine, usageGate } from "../launcher/engine";
import { available } from "../wallet/ledger";
export const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const security = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { ...security, "Content-Type": "application/json" },
  });
export function authorizationResponse(req: Request, port: number, token: string): Response | undefined {
  if (req.headers.get("host") !== `127.0.0.1:${port}`)
    return json({ error: "loopback host required" }, 403);
  if (req.method === "POST" && (
    req.headers.get("origin") !== `http://127.0.0.1:${port}` ||
    !same(req.headers.get("authorization") ?? "", `Bearer ${token}`)
  ))
    return json({ error: "owner authorization required" }, 403);
}
export async function board(dir = root, port = 4318) {
  const c = await configAt(join(dir, "config.yaml")),
    s = new Store(join(dir, "controller.sqlite")),
    e = new Engine(s, c);
  const token = String(await Bun.file(join(dir, "owner-token")).text()).trim();
  if (token.length < 32)
    throw Error("owner token missing or too short; run scripts/prepare.ts");
  let evidenceRefresh: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url),
        refusal = authorizationResponse(req, server.port!, token);
      if (refusal) return refusal;
      if (req.method === "POST") {
        try {
          const body = (await req.json()) as Record<string, unknown>;
          if (
            url.pathname === "/api/pause" &&
            typeof body.paused === "boolean"
          ) {
            e.pause(body.paused, "owner",pauseOwner(body.owner));
            return json({ paused: body.paused });
          }
          if (
            url.pathname === "/api/answer" &&
            typeof body.id === "string" &&
            typeof body.answer === "string" &&
            body.answer.length <= 4000
          ) {
            const result = s.db
              .query(
                "UPDATE questions SET answer=?,resolved_at=?,resolved_by='owner answer' WHERE id=? AND answer IS NULL AND resolved_at IS NULL",
              )
              .run(body.answer, Date.now(), body.id);
            if (!result.changes)
              return json({ error: "unresolved question not found" }, 409);
            s.event(
              randomUUID(),
              "owner-answer",
              body,
              "Append a corrected answer with a new decision; keep the original evidence",
            );
            return json({ ok: true });
          }
          if (
            url.pathname === "/api/archive" &&
            typeof body.id === "string" &&
            typeof body.receipt === "string"
          ) {
            e.archive(body.id, body.receipt, "owner");
            return json({ ok: true });
          }
          if (url.pathname === "/api/stop" && typeof body.id === "string") {
            const id = body.id;
            s.atomic(() => {
              s.db
                .query(
                  "UPDATE sessions SET status='paused' WHERE id=? AND status NOT IN ('finished','archived')",
                )
                .run(id);
              s.set(`stop:${id}`, { at: Date.now(), reason: "owner stop" });
              s.event(
                randomUUID(),
                "owner-stop",
                body,
                "Preserve custody; explicit bounded extension required to continue",
              );
            });
            return json({ ok: true });
          }
          return json({ error: "unsupported operation" }, 400);
        } catch {
          return json({ error: "invalid request" }, 400);
        }
      }
      if (req.method !== "GET") return json({ error: "method refused" }, 405);
      if (url.pathname === "/api/board") {
        const readings = s.get<Awaited<ReturnType<typeof inputs>>>("readings") ?? await inputs(dir);
        const now = Date.now();
        if(dir === root) {
          evidenceRefresh ??= refreshPulls(s,c,now).finally(()=>{evidenceRefresh=undefined;});
          await evidenceRefresh;
        }
        // Read the same native quota metadata used by the launcher gate, never token estimates.
        const claude = dir === root ? await claudeReading(now) : undefined;
        if(claude && (!readings.claude || claude.observedAt>readings.claude.observedAt))readings.claude=claude;
        return json(boardModel(e, readings, now, url.searchParams.get("lang") === "fr" ? "fr" : "en", await boardEvidence(dir,now,c.ticket_budget_default?.estimate_minutes ? c.ticket_budget_default.estimate_minutes*60 : undefined), url.searchParams.get("more") === "1"));
      }
      if(url.pathname === '/api/owner-work') {
        const run=url.searchParams.get('run'), evidence=await boardEvidence(dir);
        const owner=evidence.ownerRuns.find(x=>x.id===run);
        if(!owner)return json({error:'Live owner run not found'},404);
        const path=join(dir,'work',owner.id);
        for(const name of ['brief.md','brief.txt','prompt.txt','prompt.md']) {
          const file=Bun.file(join(path,name));
          if(await file.exists())return new Response((await file.text()).slice(0,12000),{headers:{...security,'Content-Type':'text/plain; charset=utf-8'}});
        }
        return json({error:'Work brief unavailable'},404);
      }
      if (url.pathname === "/api/state") {
        const r = s.get<Record<string, any>>("readings") ?? (await inputs(dir)),
          now = Date.now();
        const qs = ((await optionalJSON(join(dir, "qualifications.json"))) ??
          {}) as Record<string, unknown>;
        const owners = [];
        for (const [name, role] of Object.entries(c.owners)) {
          let brief = "unverified";
          try {
            brief = await readFile(join(dir, "owners", `${name}.md`), "utf8");
          } catch {}
          owners.push({ name, ...role, brief });
        }
        const past = history(s).filter(r => r.completed < now), evaluation = score(past);
        const evaluations = new Map<string, ReturnType<typeof score>>();
        return json({
          now,
          paused: s.get("paused"),
          heartbeat: s.get("heartbeat"),
          lastSuccessfulReconciliation:s.get("last-successful-reconciliation"),
          ownerWakes:s.db.query("SELECT value FROM kv WHERE key LIKE 'owner-wake:%'").all().map((r:any)=>JSON.parse(r.value)),
          versions: s.get("versions"),
          usage: r,
          usageAdmission: Object.fromEntries((["codex", "claude"] as const).map(provider => {
            try { usageGate(r[provider], false, now, c, provider); return [provider, "open"]; }
            catch (error) { return [provider, String(error).includes("high benefit only") ? "highOnly" : String(error).includes("stale") ? "stale" : "blocked"]; }
          })),
          estimator: {evaluation, source:s.get("estimate-history-source")},
          estimates: Object.fromEntries((s.rows("tickets") as {id:string;snapshot:string}[]).filter(row => JSON.parse(row.snapshot).state === "OPEN").map(row => {
            const i = JSON.parse(row.snapshot);
            const session = e.sessions().find(x => x.ticket === row.id);
            let t = session ? JSON.parse(session.brief) : {};
            if (!session) {
              try {t = issueTicket(row.id.slice(0,row.id.lastIndexOf("#")), i) ?? {};} catch {}
            }
            const target = {
              area:t.area ?? i.labels.find((l:{name:string}) => l.name.startsWith("area:"))?.name ?? "unknown",
              kind:t.kind ?? i.labels.find((l:{name:string}) => l.name.startsWith("kind:"))?.name ?? "unknown",
              provider:t.provider ?? "unknown",
            };
            const key = JSON.stringify(target);
            if (!evaluations.has(key)) evaluations.set(key, score(past.filter(r => r.provider === target.provider && r.area === target.area && r.kind === target.kind)));
            return [row.id, s.get(`estimate:${row.id}`) ?? estimate(past,target,now,evaluations.get(key)!)];
          })),
          wallet: {
            awsCents: available(s, c, "aws", now, r.billing),
            otherCents: available(s, c, "other", now),
            policy: c.wallet,
            debits: s.rows("debits"),
          },
          sources: Object.values(c.projects).map((p) => ({
            repo: p.repo,
            status: s.get(`github:${p.repo}`),
          })),
          qualifications: Object.fromEntries(
            ["codex", "claude"].map((p) => {
              const q = QualificationSchema.safeParse(qs[p]);
              return [
                p,
                q.success && q.data.expiresAt > now
                  ? "qualified"
                  : "unverified — new starts blocked",
              ];
            }),
          ),
          ...boardQuestions(s),
          tickets: s.rows("tickets"),
          sessions: e.sessions().map(x=>({...x,budget:e.budget(x)})),
          releases: s.rows("releases"),
          owners,
          slots: { used: e.active().length, max: slotLimit(s,c), controller: s.get("capacity-controller") },
          schedule: c.schedule,
        });
      }
      const file = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      }[url.pathname];
      if (file)
        return new Response(Bun.file(join(import.meta.dir, file)), {
          headers: security,
        });
      return json({ error: "not found" }, 404);
    },
  });
  return {
    server,
    close() {
      server.stop(true);
      s.close();
    },
  };
}
if (import.meta.main) {
  const b = await board();
  console.log(`Board: http://127.0.0.1:${b.server.port}`);
}
