import { spawn, execFileSync } from "node:child_process";
import type { WorkerSpec } from "../adapters/workers";
type ProcessRow = {pid:number; parent:number; group:number; state:string; identity:string};
function processRows():ProcessRow[] {
  return execFileSync("ps",["-axo","pid=,ppid=,pgid=,stat=,lstart="],{encoding:"utf8"}).trim().split("\n").flatMap(line=>{
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return m ? [{pid:Number(m[1]),parent:Number(m[2]),group:Number(m[3]),state:m[4],identity:m[5]}] : [];
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
      // macOS can return EPERM for a group containing only exiting zombies.
      // Confirm the group has no live members; a live inaccessible group fails.
      if ((error as NodeJS.ErrnoException).code === "EPERM" && !processRows().some(row=>row.group===group && !row.state.startsWith("Z"))) return false;
      throw error;
    }
  };
  return {
    pid: child.pid,
    stdout: child.stdout!,
    exited,
    stop: () => stopping ??= (async () => {
      try {
        const groups=new Set<number>(child.pid ? [child.pid] : []);
        const owned = () => {
          const rows=collect();
          const live=rows.filter(row=>known.get(row.pid)?.identity===row.identity && !row.state.startsWith("Z"));
          for(const row of live) {
            const leader=known.get(row.group);
            if(leader && (rows.find(r=>r.pid===leader.pid)?.identity===leader.identity || !rows.some(r=>r.pid===leader.pid)))groups.add(row.group);
          }
          return live;
        };
        const terminate = (value: NodeJS.Signals) => {
          const live=owned();
          for(const group of groups)signal(group,value);
          // Also stop owned descendants that joined a group we do not own.
          for(const row of live)if(!groups.has(row.group)) {
            try {process.kill(row.pid,value);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
          }
          return live.length;
        };
        terminate("SIGTERM");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
          if(!terminate("SIGTERM"))break;
        }
        terminate("SIGKILL");
        const killed = Date.now()+1000;
        while(owned().length && Date.now()<killed) {
          terminate("SIGKILL");
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        if(owned().length)throw Error("owned worker descendants survived cleanup");
        if(trackingError)throw trackingError;
      } finally {clearInterval(tracker);}
    })(),
  };
}
