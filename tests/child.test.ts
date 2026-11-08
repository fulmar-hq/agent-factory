import { expect, test } from "bun:test";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnWorker } from "../launcher/child";

for(const detached of [false,true]) test(`stop kills a TERM-ignoring descendant in ${detached ? "a separate" : "the parent"} group after its parent exits`, async () => {
  const dir=mkdtempSync(join(tmpdir(),"factory-group-")), fd=openSync(join(dir,"err"),"w");
  const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',\`process.on('SIGTERM',()=>{});setInterval(()=>{},100)\`],{stdio:'ignore',detached:${detached}});
    fs.writeFileSync('pids',String(child.pid));
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100);`;
  const p=spawnWorker({argv:[process.execPath,"-e",script],env:{PATH:process.env.PATH!}},dir,fd);
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
  } finally { await p.stop(); closeSync(fd); rmSync(dir,{recursive:true}); }
},10000);
