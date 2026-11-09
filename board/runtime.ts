import { readdir, stat, readFile } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";

export type OwnerRun = { id: string; title: string; owner: string; started: number; lastActivity: number; estimateSeconds: number | null };
export type BoardEvidence = { ownerRuns: OwnerRun[]; activity: Record<string, number> };
export function ownerTitle(brief: string) {
  const sentence = brief.split(/(?<=[.!?])\s|\n/)[0]!.replace(/^#+\s*/, "").trim();
  const role = /^You are (?:Alido\s*[·:]?\s*)?(.+?)(?:\s+in\s|\s+for\s|[.;]|$)/i.exec(sentence)?.[1];
  return role ? role.replace(/[()]/g," ").replace(/\s+/g," ").trim() + " work" : sentence;
}
const elapsed = (value: string) => {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return Number(days) * 86400 + clock!.split(":").reverse().reduce((sum, n, i) => sum + Number(n) * 60 ** i, 0);
};
// Read only native process descriptors, never log/transcript contents or arbitrary home files.
export async function boardEvidence(dir: string, now = Date.now()): Promise<BoardEvidence> {
  const activity: Record<string, number> = {}, ownerRuns: OwnerRun[] = [];
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
    if (await p.exited !== 0 || !rows.length) return {activity,ownerRuns};
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
      const title = ownerTitle(brief);
      const logName = ["log.txt","native.jsonl","log.jsonl"].find(n=>names.includes(n));
      const lastActivity = logName ? (await stat(join(path,logName))).mtimeMs : started;
      const estimate = /estimateSeconds["'\s:]+(\d+)/.exec(brief);
      ownerRuns.push({id:relative(join(dir,"work"),path),title,owner:relative(join(dir,"work"),path).split(sep)[0]!,started,lastActivity,estimateSeconds:estimate ? Number(estimate[1]) : null});
    }
  } catch { /* No process proof means no owner-run claim. */ }
  return {activity,ownerRuns};
}
