import { readdir, stat, readFile } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";

export type OwnerRun = { id: string; title: string; owner: string; purpose?: string; issue?: string | null; started: number; lastActivity: number | null; estimateSeconds: number | null };
export type BoardEvidence = { ownerRuns: OwnerRun[]; activity: Record<string, number>; ownerFinishedAt?: number };
const clean = (s:string) => s.replace(/https?:\/\/\S+|(?:^|\s)~?\/[\w./-]+/g,'').replace(/^[\s#*\-\d.)]+/,'').replace(/[*`]/g,'').replace(/\s+/g,' ').trim();
export function ownerIdentity(brief:string,fallback:string) {
  return /^You are (?:Alido\s*[·:]?\s*)?([a-z]+)/i.exec(brief.trim())?.[1]?.toLowerCase() ?? fallback;
}
export function ownerSummary(brief:string) {
  // Prefer an explicit task heading, then the first concrete action after the role/setup.
  const explicit = /^(?:Task|Goal|Outcome|Title):\s*(.+)$/im.exec(brief)?.[1];
  const lines = brief.split(/\n|(?<=[.!?])\s+(?=[A-Z])/).map(clean).filter(Boolean);
  const actions = lines.filter(line=>!/^You are |^(?:Vincent|Design reference|Headless|Last line|Pull first|Preserve|Do not|Never|Run |Tests?;|FIDELITY)/i.test(line));
  const first=explicit ? clean(explicit) : actions.find(line=>/^(?:Apply|Add|Build|Change|Check|Create|Derive|Details open|Fix|Implement|Make|Move|Open|Port|Remove|Repair|Replace|Show|Update|Use|Wire|Verify)\b/i.test(line)) ?? actions[0] ?? 'Review the current work';
  const title=first.replace(/\s*\([^)]*\)/g,'').replace(/^Details open as /i,'Show details in ').replace(/[.!?]$/,'').split(/\s+/).slice(0,12).join(' ').slice(0,100);
  const next=actions.find(line=>line!==first && line.length>25);
  return {title,purpose:[first,next].filter(Boolean).slice(0,2).map(line=>line!.replace(/[.!?]$/,'')+'.').join(' ').slice(0,500)};
}
export function ownerTitle(brief:string) { return ownerSummary(brief).title; }
export function ownerEstimate(explicit:number|undefined,configured:number|undefined,recent:number[]) {
  if(explicit && Number.isFinite(explicit) && explicit>0)return explicit;
  if(configured && Number.isFinite(configured) && configured>0)return configured;
  const sorted=recent.filter(n=>n>0 && Number.isFinite(n)).slice(-10).sort((a,b)=>a-b), n=sorted.length;
  return n ? n%2 ? sorted[(n-1)/2]! : (sorted[n/2-1]!+sorted[n/2]!)/2 : null;
}
const elapsed = (value: string) => {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return Number(days) * 86400 + clock!.split(":").reverse().reduce((sum, n, i) => sum + Number(n) * 60 ** i, 0);
};
// Read only native process descriptors, never log/transcript contents or arbitrary home files.
export async function boardEvidence(dir: string, now = Date.now(), configuredEstimate?:number): Promise<BoardEvidence> {
  const activity: Record<string, number> = {}, ownerRuns: OwnerRun[] = [];
  let ownerFinishedAt = 0;
  const recent = new Map<string,{at:number;seconds:number}[]>();
  try {
    const work = join(dir,"work");
    for (const owner of await readdir(work,{withFileTypes:true})) {
      if(!owner.isDirectory())continue;
      const parent=join(work,owner.name);
      for(const run of await readdir(parent,{withFileTypes:true})) {
        if(!run.isDirectory() || !run.name.startsWith("run-"))continue;
        const path=join(parent,run.name);
        for(const name of await readdir(path)) if(/^result(?:\.|$)/.test(name)) {
          const at=(await stat(join(path,name))).mtimeMs;
          if(at<=now) {
            ownerFinishedAt=Math.max(ownerFinishedAt,at);
            const prompt=['brief.md','brief.txt','prompt.txt','prompt.md'].find(n=>Bun.file(join(path,n)).size>0);
            if(prompt) {
              const brief=await readFile(join(path,prompt),'utf8'), started=(await stat(join(path,prompt))).mtimeMs;
              const identity=ownerIdentity(brief,owner.name), times=recent.get(identity) ?? [];
              times.push({at,seconds:(at-started)/1000});recent.set(identity,times);
            }
          }
        }
      }
    }
  } catch { /* Missing operational folders provide no completion evidence. */ }
  for (const name of await readdir(dir)) {
    const match = /^worker-([a-f0-9]{64})(?:-\d+)?\.jsonl$/.exec(name);
    if (match) { const at = (await stat(join(dir, name))).mtimeMs; activity[match[1]!] = Math.max(activity[match[1]!] ?? 0, at); }
  }
  try {
    const p = Bun.spawn(["/bin/ps", "-axo", "pid=,etime=,comm="], {stdout:"pipe", stderr:"ignore"});
    const rows = (await new Response(p.stdout).text()).split("\n").flatMap(line => {
      const m = /^\s*(\d+)\s+([\d:-]+)\s+(.+)$/.exec(line);
      return m && /\/(codex|claude)$/.test(m[3]!) ? [{pid:m[1]!,started:now-elapsed(m[2]!)*1000}] : [];
    });
    if (await p.exited !== 0 || !rows.length) return {activity,ownerRuns,ownerFinishedAt};
    const fds = Bun.spawn(["/usr/sbin/lsof", "-a", "-p", rows.map(r=>r.pid).join(","), "-d", "0,1,2", "-Fn"], {stdout:"pipe",stderr:"ignore"});
    const output = await new Response(fds.stdout).text(); await fds.exited;
    let pid = "";
    const runs = new Map<string, number>();
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      if (!line.startsWith("n")) continue;
      const path = dirname(line.slice(1)), rel = relative(join(dir,"work"),path).split(sep);
      if (rel.length !== 2 || !rel[1]?.startsWith("run-") || rel[0] === "..") continue;
      const started = rows.find(r=>r.pid===pid)?.started;
      if(started) runs.set(path,Math.min(runs.get(path) ?? started,started));
    }
    for (const [path, started] of runs) {
      const names = await readdir(path);
      if (names.some(n => /^result(?:\.|$)/.test(n))) continue;
      const briefName = ["brief.md","brief.txt","prompt.txt","prompt.md"].find(n=>names.includes(n));
      if (!briefName) continue;
      const brief = (await readFile(join(path,briefName),"utf8")).slice(0,12000);
      const summary = ownerSummary(brief), owner = ownerIdentity(brief,relative(join(dir,"work"),path).split(sep)[0]!);
      const logName = ["log.txt","native.jsonl","log.jsonl"].find(n=>names.includes(n));
      const lastActivity = logName ? (await stat(join(path,logName))).mtimeMs : null;
      const estimate = /estimateSeconds["'\s:]+(\d+)/.exec(brief);
      const issue=brief.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/)?.[0] ?? null;
      ownerRuns.push({id:relative(join(dir,"work"),path),...summary,owner,issue,started,lastActivity,estimateSeconds:ownerEstimate(estimate ? Number(estimate[1]) : undefined,configuredEstimate,(recent.get(owner) ?? []).sort((a,b)=>a.at-b.at).map(x=>x.seconds))});
    }
  } catch { /* No process proof means no owner-run claim. */ }
  return {activity,ownerRuns,ownerFinishedAt};
}
