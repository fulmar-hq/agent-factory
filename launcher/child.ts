import { spawn, execFileSync } from "node:child_process";
import type { WorkerSpec } from "../adapters/workers";
type ProcessRow = {pid:number; parent:number; group:number; identity:string};
function processRows():ProcessRow[] {
  return execFileSync("ps",["-axo","pid=,ppid=,pgid=,lstart="],{encoding:"utf8"}).trim().split("\n").flatMap(line=>{
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return m ? [{pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),identity:m[4]}] : [];
  });
}
// Native tools may start their own groups. Retain observed descendants by process
// start identity, including orphans, and signal only groups led by owned processes.
export function spawnWorker(spec: WorkerSpec, cwd: string, stderr: number) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", stderr],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const known=new Map<number,ProcessRow>();
  let trackingError:unknown;
  const collect=()=>{
    const rows=processRows(), owned=new Set<number>();
    if(child.pid && child.exitCode===null && child.signalCode===null)owned.add(child.pid);
    for(const row of rows)if(known.get(row.pid)?.identity===row.identity)owned.add(row.pid);
    let changed=true;
    while(changed) {changed=false;for(const row of rows)if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
    for(const row of rows)if(owned.has(row.pid))known.set(row.pid,row);
    return rows;
  };
  const tracker=setInterval(()=>{try{collect();}catch(error){trackingError=error;}},100);
  tracker.unref();
  let stopping: Promise<void> | undefined;
  const signal = (group:number,value: NodeJS.Signals) => {
    try { process.kill(-group, value); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  return {
    pid: child.pid,
    stdout: child.stdout!,
    exited,
    stop: () => stopping ??= (async () => {
      try {
        const rows=collect();
        const groups=new Set<number>(child.pid ? [child.pid] : []);
        for(const row of rows) {
          if(known.get(row.pid)?.identity!==row.identity)continue;
          const leader=known.get(row.group);
          if(leader && (rows.find(r=>r.pid===leader.pid)?.identity===leader.identity || !rows.some(r=>r.pid===leader.pid)))groups.add(row.group);
        }
        for(const group of groups)signal(group,"SIGTERM");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
          let alive=false;
          for(const group of groups)try{process.kill(-group,0);alive=true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
          if(!alive)break;
        }
        for(const group of groups)signal(group,"SIGKILL");
        if(trackingError)throw trackingError;
      } finally {clearInterval(tracker);}
    })(),
  };
}
