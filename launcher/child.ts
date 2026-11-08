import { spawn, execFileSync } from "node:child_process";
import type { WorkerSpec } from "../adapters/workers";
type ProcessRow = {pid:number; parent:number; group:number; state:string; identity:string};
function processRows():ProcessRow[] {
  let text:string;
  try {
    text=execFileSync("/bin/ps",["-axo","pid=,ppid=,pgid=,stat=,lstart="],{encoding:"utf8",env:{...process.env,LC_ALL:"C"}});
  } catch(error) {
    const failure=error as {status?:number|null;signal?:string|null;code?:string};
    throw Error(`process table unavailable (status=${failure.status ?? "unknown"}, signal=${failure.signal ?? "none"}, code=${failure.code ?? "none"})`,{cause:error});
  }
  return text.trim().split("\n").flatMap(line=>{
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
  const cleanup = { groups: [] as number[], deniedSignals: [] as string[], verified: false };
  const denied = (pid: number, value: NodeJS.Signals) => {
    const key = `${pid}:${value}`;
    if (!cleanup.deniedSignals.includes(key)) cleanup.deniedSignals.push(key);
  };
  const signal = (group:number,value: NodeJS.Signals) => {
    try { process.kill(-group, value); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // A group signal can race native sandbox teardown. Keep trying individual
      // owned processes and verify the process table instead of aborting cleanup.
      if ((error as NodeJS.ErrnoException).code === "EPERM") { denied(-group,value); return false; }
      throw error;
    }
  };
  return {
    pid: child.pid,
    stdout: child.stdout!,
    exited,
    cleanup,
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
          // Also target pinned individuals if a group signal was only partial,
          // or a descendant joined a group whose leader we do not own.
          for(const row of live) {
            try {process.kill(row.pid,value);}catch(error){
              if((error as NodeJS.ErrnoException).code==="EPERM")denied(row.pid,value);
              else if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;
            }
          }
          cleanup.groups=[...groups];
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
        const survivors = owned();
        const groupSurvivors = processRows().filter(row=>groups.has(row.group) && !row.state.startsWith("Z"));
        if(survivors.length || groupSurvivors.length)throw Error("owned worker descendants survived cleanup");
        if(trackingError)throw trackingError;
        cleanup.verified=true;
      } finally {clearInterval(tracker);}
    })(),
  };
}
