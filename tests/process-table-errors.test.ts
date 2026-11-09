import { expect, test } from "bun:test";
import type { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnWorker } from "../launcher/child";

const start="Sun Nov  8 12:34:56 2026";
const row=(pid=42,parent=1,group=42,state="Ss",identity=start)=>
  `  ${pid}  ${parent}  ${group} ${state} ${identity}\n`;
// A process table cannot be empty even when the worker has disappeared.
const absent=row(1,0,1);

function fixture(read: (call:number)=>string, signal?: (pid:number,value:NodeJS.Signals | number | undefined)=>void) {
  // Construct an event emitter/stream only; never spawn or signal a real process.
  const child=Object.assign(new EventEmitter(),{
    pid:42,stdout:new PassThrough(),exitCode:null as number | null,signalCode:null,
  });
  let reads=0;
  const signals: Array<[number,NodeJS.Signals | number | undefined]>=[];
  const runtime={
    spawn: (()=>child) as unknown as typeof spawn,
    execFileSync: ((file,argv,options)=>{
      expect(file).toBe("/bin/ps");
      expect(argv).toEqual(["-axo","pid=,ppid=,pgid=,stat=,lstart="]);
      expect(options).toMatchObject({encoding:"utf8",env:{LC_ALL:"C"}});
      return read(++reads);
    }) as typeof execFileSync,
    kill: (pid:number,value?:NodeJS.Signals | number)=>{
      signals.push([pid,value]);
      signal?.(pid,value);
      return true as const;
    },
  };
  const worker=spawnWorker({argv:["fictional-worker"],env:{}},"/fictional",2,runtime);
  return {worker,child,signals,reads:()=>reads};
}

const malformed=[
  ["garbage","not a process table\n"],
  ["partial table",absent+"truncated row\n"],
  ["truncated fields","42 1 42 Ss\n"],
  ["invalid state",row().replace("Ss","bogus")],
  ["invalid start",row().replace(start,"unknown")],
  ["invalid time",row().replace("12:34:56","25:34:56")],
  ["empty",""],
  ["whitespace"," \n\t\n"],
] as const;
for(const [name,snapshot] of malformed) test(`rejects ${name} successful snapshot`,async()=>{
  const {worker,signals}=fixture(()=>snapshot);
  await expect(worker.stop()).rejects.toThrow(/process table (malformed|empty)/);
  expect(worker.cleanup.verified).toBe(false);
  expect(signals).toEqual([]);
});

for(const field of [0,1,2])for(const invalid of ["-1","1.5","NaN","Infinity","9007199254740992","9".repeat(400)])
  test(`rejects numeric field ${field}: ${invalid.slice(0,20)}`,async()=>{
    const fields=["42","1","42"];
    fields[field]=invalid;
    const {worker}=fixture(()=>`${fields.join(" ")} Ss ${start}\n`);
    await expect(worker.stop()).rejects.toThrow(/process table (malformed|invalid numeric field)/);
    expect(worker.cleanup.verified).toBe(false);
  });

// Cover every observation in stop(), including the independent final group check.
for(const [name,snapshot] of [malformed[0],malformed[1],malformed[6]])
for(const failedRead of [1,2,3,4,5,6])test(`observation ${failedRead} cannot prove absence with ${name} output`,async()=>{
  const {worker}=fixture(call=>call===failedRead ? snapshot : absent);
  await expect(worker.stop()).rejects.toThrow(/process table (malformed|empty)/);
  expect(worker.cleanup.verified).toBe(false);
});

for(const failure of [
  Object.assign(Error("mocked abort"),{status:null,signal:"SIGABRT"}),
  Object.assign(Error("mocked failure"),{status:1,signal:null}),
  Object.assign(Error("mocked denial"),{code:"EPERM"}),
])test(`retains process-table failure diagnostics: ${failure.message}`,async()=>{
  const {worker}=fixture(()=>{throw failure;});
  try {
    await worker.stop();
    throw Error("expected observation failure");
  } catch(error) {
    expect(error).toBeInstanceOf(Error);
    const receipt=error as Error;
    expect(receipt.message).toBe(`process table unavailable (status=${"status" in failure ? failure.status ?? "unknown" : "unknown"}, signal=${"signal" in failure ? failure.signal ?? "none" : "none"}, code=${"code" in failure ? failure.code : "none"})`);
    expect(receipt.cause).toBe(failure);
  }
  expect(worker.cleanup.verified).toBe(false);
});

test("a tracker observation failure remains unverified after valid snapshots",async()=>{
  let snapshot="malformed";
  const {worker}=fixture(()=>snapshot);
  await new Promise(resolve=>setTimeout(resolve,120));
  snapshot=absent;
  await expect(worker.stop()).rejects.toThrow("process table malformed");
  expect(worker.cleanup.verified).toBe(false);
});

test("valid macOS/Linux rows, zero kernel IDs and zombies permit verified absence",async()=>{
  const snapshot="\n"+row(0,0,0,"R")+absent+row(42,1,42,"Z+")+row(43,42,43,"Z")+
    row(91,1,91,"I<", "Mon Jan  1 00:00:00 2024")+row(92,1,92,"Ssl+")+" \n";
  const {worker,signals}=fixture(()=>snapshot);
  const stopping=worker.stop();
  expect(worker.stop()).toBe(stopping);
  await stopping;
  expect(worker.cleanup.verified).toBe(true);
  expect(worker.cleanup.groups).toEqual([42]);
  expect(signals).toEqual([[-42,"SIGTERM"],[-42,"SIGTERM"],[-42,"SIGKILL"]]);
});

test("TERM denial retains diagnostics and still signals pinned individuals",async()=>{
  let live=true;
  const {worker,signals}=fixture(()=>live ? absent+row() : absent,(pid,value)=>{
    if(pid<0)throw Object.assign(Error("fictional denial"),{code:"EPERM"});
    if(value==="SIGTERM")live=false;
  });
  await worker.stop();
  expect(worker.cleanup.verified).toBe(true);
  expect(worker.cleanup.deniedSignals).toEqual(["-42:SIGTERM","-42:SIGKILL"]);
  expect(signals).toContainEqual([42,"SIGTERM"]);
});

test("retains individual signal denial when later observations prove absence",async()=>{
  let live=true;
  const {worker}=fixture(()=>live ? absent+row() : absent,()=>{
    live=false;
    throw Object.assign(Error("fictional denial"),{code:"EPERM"});
  });
  await worker.stop();
  expect(worker.cleanup.verified).toBe(true);
  expect(worker.cleanup.deniedSignals).toEqual(["-42:SIGTERM","42:SIGTERM","-42:SIGKILL"]);
});

test("keeps descendant identity pinned after parent exit and PID reuse",async()=>{
  let initial=true;
  const {worker,child,signals}=fixture(()=>initial ? absent+row()+row(43,42,43) :
    absent+row(43,1,99,"S", "Sun Nov  8 12:35:00 2026"),(pid)=>{
    if(pid===42) {initial=false;child.exitCode=0;}
  });
  await worker.stop();
  expect(worker.cleanup.verified).toBe(true);
  expect(worker.cleanup.groups).toEqual([42,43]);
  expect(signals.filter(([pid])=>pid===43)).toEqual([[43,"SIGTERM"]]);
  expect(signals.some(([pid])=>pid===99 || pid===-99)).toBe(false);
});

test("escalates a TERM-ignoring pinned descendant to KILL after parent exit",async()=>{
  let parent=true,descendant=true;
  const {worker,child,signals}=fixture(()=>absent+(parent ? row() : "")+(descendant ? row(43,parent ? 42 : 1,43) : ""),(pid,value)=>{
    if(pid===42) {parent=false;child.exitCode=0;}
    if(pid===43 && value==="SIGKILL")descendant=false;
  });
  await worker.stop();
  expect(worker.cleanup.verified).toBe(true);
  expect(signals).toContainEqual([-43,"SIGTERM"]);
  expect(signals).toContainEqual([-43,"SIGKILL"]);
  expect(signals).toContainEqual([43,"SIGKILL"]);
},6000);
