import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnWorker } from "../launcher/child";

for(const [detached,groupDenied] of [[false,false],[true,false],[true,true]] as const) test(`stop kills a TERM-ignoring descendant in ${detached ? "a separate" : "the parent"} group after its parent exits${groupDenied ? " when group signals return EPERM" : ""}`, async () => {
  const dir=mkdtempSync(join(tmpdir(),"factory-group-")), fd=openSync(join(dir,"err"),"w");
  const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',\`process.on('SIGTERM',()=>{});setInterval(()=>{},100)\`],{stdio:'ignore',detached:${detached}});
    fs.writeFileSync('pids',String(child.pid));
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100);`;
  const p=spawnWorker({argv:[process.execPath,"-e",script],env:{PATH:process.env.PATH!}},dir,fd);
  const originalKill=process.kill.bind(process);
  const killSpy=groupDenied ? spyOn(process,"kill").mockImplementation(((pid:number,value?:NodeJS.Signals | number)=>{
    if(pid<0)throw Object.assign(Error("fictional group denial"),{code:"EPERM"});
    return originalKill(pid,value);
  }) as typeof process.kill) : undefined;
  try {
    let descendant=0;
    for(let i=0;i<100;i++) {
      try {descendant=Number(readFileSync(join(dir,"pids"),"utf8"));break;}catch{}
      await new Promise(r=>setTimeout(r,20));
    }
    expect(descendant).toBeGreaterThan(0);
    // Let the descendant install its TERM handler.
    await new Promise(r=>setTimeout(r,150));
    await p.stop(); await p.exited;
    let alive=true;
    for(let i=0;i<100;i++) {
      try {process.kill(descendant,0);}catch{alive=false;break;}
      // Linux may retain a killed orphan as a zombie until init reaps it.
      if(process.platform==='linux') {
        try {if(readFileSync(`/proc/${descendant}/stat`,'utf8').split(') ')[1].startsWith('Z')) {alive=false;break;}}catch{alive=false;break;}
      }
      await new Promise(r=>setTimeout(r,20));
    }
    expect(alive).toBe(false);
    expect(p.cleanup.verified).toBe(true);
    if(groupDenied)expect(p.cleanup.deniedSignals.length).toBeGreaterThan(0);
  } finally { await p.stop(); killSpy?.mockRestore(); closeSync(fd); rmSync(dir,{recursive:true}); }
},10000);

test('trusted observations retain actual TERM and cleanup evidence; observer failure stays unverified',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-observe-')),fd=openSync(join(dir,'err'),'w');
 const signals:{pid:number;identity:string;signal:string;at:number}[]=[],snapshots:{stage:string;at:number;pids:number[]}[]=[];
 const p=spawnWorker({argv:[process.execPath,'-e',"process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},100)"],env:{PATH:process.env.PATH!}},dir,fd,{signal:(pid,identity,signal,at)=>signals.push({pid,identity,signal,at}),snapshot:(stage,rows,at)=>snapshots.push({stage,at,pids:rows.map(r=>r.pid)})});
 try{await new Promise<void>(resolve=>p.stdout.once('data',()=>resolve()));await p.stop();await p.exited;expect(p.cleanup.verified).toBe(true);expect(signals.some(r=>r.pid===p.pid&&r.signal==='SIGTERM'&&r.identity.length>0)).toBe(true);expect(snapshots.at(-1)?.stage).toBe('final');expect(snapshots.at(-1)?.pids.includes(p.pid!)).toBe(false);}finally{await p.stop();closeSync(fd);}
 const secondFd=openSync(join(dir,'second-err'),'w'),second=spawnWorker({argv:[process.execPath,'-e',"console.log('ready');setInterval(()=>{},100)"],env:{PATH:process.env.PATH!}},dir,secondFd,{snapshot:()=>{throw Error('fictional capture I/O failure');}});
 try{await new Promise<void>(resolve=>second.stdout.once('data',()=>resolve()));await expect(second.stop()).rejects.toThrow('capture I/O failure');await second.exited;expect(second.cleanup.verified).toBe(false);}finally{await second.stop().catch(()=>{});closeSync(secondFd);}
},10000);
