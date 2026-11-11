import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexReading } from "../adapters/usage";
import { usageGate } from "../launcher/engine";
import { now, config } from "./fixtures";
test("partial native usage stays real, drops content and credits, blocks missing window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-")),
    d = new Date(now),
    today = join(
      dir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
  mkdirSync(today, { recursive: true });
  writeFileSync(
    join(today, "fixture.jsonl"),
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      payload: {
        private: "never retained",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 3,
            resets_at: Math.floor(now / 1000) + 3600,
          },
          secondary: null,
          credits: { balance: "123" },
        },
      },
    }) + "\n",
  );
  try {
    const m = await codexReading(now, dir);
    expect(m?.windows[0].used).toBe(0.03);
    expect(JSON.stringify(m)).not.toMatch(/private|credits|123/);
    expect(() => usageGate(m, true, now, config())).toThrow("window missing");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

import {claudeReading, claudeMetadata} from "../adapters/usage";
test("Claude local structured subscription windows feed 70/90 gates without model calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-claude-"));
  mkdirSync(join(dir,"project"));
  const record = (used:number, timestamp = now) => ({timestamp:new Date(timestamp).toISOString(),
    rate_limits:{five_hour:{used_percentage:used,resets_at:now/1000+3600},seven_day:{used_percentage:12,resets_at:now/1000+604800}},
    message:"private prompt", usage:{input_tokens:10000}});
  try {
    writeFileSync(join(dir,"project","session.jsonl"),[record(70),record(0,now+1000)].map(x => JSON.stringify(x)).join("\n"));
    const reading = await claudeReading(now,dir);
    expect(reading?.windows.map(x=>x.used)).toEqual([.7,.12]);
    expect(JSON.stringify(reading)).not.toMatch(/private|input_tokens/);
    expect(()=>usageGate(reading,false,now,config())).toThrow("high benefit");
    expect(()=>usageGate(reading,true,now,config())).not.toThrow();
    expect(()=>usageGate(claudeMetadata(record(90)),true,now,config())).toThrow("usage stop");
    expect(()=>usageGate(claudeMetadata(record(1,now-900001)),true,now,config())).toThrow("stale");
    expect(claudeMetadata({timestamp:new Date(now).toISOString(),message:JSON.stringify(record(1))})).toBeUndefined();
    expect(claudeMetadata({...record(1),rate_limits:{five_hour:{used_percentage:101,resets_at:now/1000+3600}}})).toBeUndefined();
    expect(()=>usageGate(claudeMetadata({...record(1),rate_limits:{five_hour:record(1).rate_limits.five_hour}}),true,now,config())).toThrow("window missing");
  } finally {rmSync(dir,{recursive:true});}
});

test("Codex reads active prior-day rollouts and both real windows on every poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-rollout-"));
  const day = join(dir, "2020", "01", "01");
  mkdirSync(day, {recursive:true});
  const path = join(day, "active.jsonl");
  const record = (used:number, at=now) => ({timestamp:new Date(at).toISOString(), payload:{rate_limits:{limit_id:"codex",
    primary:{used_percent:used,resets_at:now/1000+3600},secondary:{used_percent:25,resets_at:now/1000+604800}}}});
  try {
    writeFileSync(path, JSON.stringify(record(10)));
    expect((await codexReading(now,dir))?.windows.map(w=>w.used)).toEqual([.1,.25]);
    writeFileSync(path, JSON.stringify(record(90)));
    const updated = await codexReading(now,dir);
    expect(()=>usageGate(updated,true,now,config())).toThrow("usage stop");
    expect(updated?.observedAt).toBe(now);
  } finally {rmSync(dir,{recursive:true});}
});

test("Claude unified window events require an original timestamp and both windows", () => {
  const event = {type:"rate_limit_event",timestamp:new Date(now).toISOString(),rate_limit_info:{status:"allowed",unifiedWindows:{
    five_hour:{utilization:.12,resetsAt:now/1000+3600},seven_day:{utilization:.45,resetsAt:now/1000+604800}}}};
  expect(claudeMetadata(event)?.windows.map(w=>w.used)).toEqual([.12,.45]);
  expect(claudeMetadata({...event,timestamp:undefined})).toBeUndefined();
  const partial = claudeMetadata({...event,rate_limit_info:{unifiedWindows:{seven_day:event.rate_limit_info.unifiedWindows.seven_day}}});
  expect(()=>usageGate(partial,true,now,config())).toThrow("window missing");
  expect(()=>usageGate(claudeMetadata({...event,timestamp:new Date(now-900001).toISOString()}),true,now,config())).toThrow("stale");
});

import { ConfigSchema } from "../launcher/config";
import { codexMetadata } from "../adapters/usage";
import {TestEngine as Engine} from './fixtures';
import { Store } from "../tracking/store";
import { ticket, admission } from "./fixtures";
const exposedConfig = () => ConfigSchema.parse({...config(), usage_windows: {
  rule: "gate on every window the provider actually exposes; require at least one fresh native window (<= max age); 70/90% thresholds apply to each exposed window; missing data = refuse",
}});
const weekly = (used = 6, at = now) => codexMetadata({timestamp:new Date(at).toISOString(),payload:{rate_limits:{limit_id:"codex",
  primary:{used_percent:used,window_minutes:10080,resets_at:now/1000+604800},secondary:null}}});
test("configured exposed-window policy admits one fresh native weekly window", () => {
  const s = new Store(":memory:"), e = new Engine(s, exposedConfig());
  try {
    e.pause(false,"owner");
    expect(e.admit(ticket(), {...admission(),meter:weekly()}).status).toBe("reserved");
    expect(weekly()).toMatchObject({nativeProvider:"codex",windows:[{name:"primary",durationMinutes:10080,used:.06}]});
    expect(()=>usageGate(weekly(),false,now,config())).toThrow("window missing");
  } finally { s.close(); }
});
test("exposed windows still refuse stale, future, expired, absent and non-native evidence", () => {
  const c = exposedConfig();
  for (const at of [now-900001,now+1]) expect(()=>usageGate(weekly(6,at),true,now,c)).toThrow("stale");
  const expired = weekly()!; expired.windows[0].resetsAt=now;
  expect(()=>usageGate(expired,true,now,c)).toThrow("stale");
  expect(()=>usageGate(undefined,true,now,c)).toThrow("unknown");
  expect(()=>usageGate({...weekly(),windows:[]},true,now,c)).toThrow("unknown");
  expect(()=>usageGate({...weekly(),nativeProvider:undefined},true,now,c)).toThrow("native usage unknown");
  expect(()=>usageGate(weekly(),true,now,c,"claude")).toThrow("native usage unknown");
});
test("70/90 thresholds apply to every exposed window, including a single weekly window", () => {
  const c=exposedConfig();
  expect(()=>usageGate(weekly(70),false,now,c)).toThrow("high benefit only");
  expect(()=>usageGate(weekly(70),true,now,c)).not.toThrow();
  expect(()=>usageGate(weekly(90),true,now,c)).toThrow("usage stop");
  const two=weekly()!;
  two.windows.push({used:.9,resetsAt:now+3600000,name:"secondary"});
  expect(()=>usageGate(two,true,now,c)).toThrow("usage stop");
  two.windows[1].used=.1; two.windows[1].resetsAt=now;
  expect(()=>usageGate(two,true,now,c)).toThrow("stale");
  const claude=claudeMetadata({timestamp:new Date(now).toISOString(),rate_limits:{seven_day:{used_percentage:6,resets_at:now/1000+604800}}});
  expect(()=>usageGate(claude,false,now,c,"claude")).not.toThrow();
  expect(claude?.windows[0].name).toBe("seven_day");
});

import {claudeStatus} from '../adapters/usage';
const quotaPanel=(all=43,model=18)=>`Settings  Status  Config  Usage  Stats
Session
Total duration (API): 0s
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Current week (all models)
${all}% ${all}% used
Resets Nov 14 at 4pm (America/Toronto)
Current week (Fable)
${model}% ${model}% used
Resets Nov 14 at 3:59pm (America/Toronto)
Usage credits are off
Esc to cancel`;
async function parseQuota(text:string) {
 const child=Bun.spawn(['/usr/bin/python3','-I','-B',new URL('../scripts/claude-usage.py',import.meta.url).pathname,'--parse'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 child.stdin.write(JSON.stringify({text,observedAt:Date.parse('2026-11-12T19:00:00-05:00')}));child.stdin.end();
 const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);expect(code).toBe(0);return JSON.parse(out);
}
test('native Claude quota panel retains every actually exposed window and timezone reset',async()=>{
 const meter=await parseQuota(quotaPanel());
 expect(meter).toMatchObject({nativeProvider:'claude',windows:[{name:'Current week (all models)',used:.43,resetsAt:Date.parse('2026-11-14T16:00:00-05:00')},{name:'Current week (Fable)',used:.18,resetsAt:Date.parse('2026-11-14T15:59:00-05:00')}]});
 expect((await parseQuota(quotaPanel(82,91))).windows.map((w:any)=>w.used)).toEqual([.82,.91]);
 expect(meter.windows.some((w:any)=>w.name==='five_hour')).toBe(false);
 const redrawn=quotaPanel().replace('\nCurrent week (Fable)','\nEsc to cancel\u001b[14B\u001b[2K\u001b[GCurrent week (Fable)');
 expect((await parseQuota(redrawn)).windows.map((w:any)=>w.used)).toEqual([.43,.18]);
});
test('incomplete, login, unknown reset, inconsistent percentages and model usage panels cannot supply quota',async()=>{
 for(const text of [quotaPanel().replace('Resets Nov 14 at 3:59pm (America/Toronto)',''),quotaPanel()+'\nEnter y/n:',quotaPanel().replace('Nov 14 at 4pm','an unknown time'),quotaPanel().replace('43% 43%','43% 44%'),quotaPanel(101),quotaPanel().replace('0 input','1 input'),quotaPanel().replace(/Current week \(all models\)\n43% 43% used\nResets Nov 14 at 4pm \(America\/Toronto\)\n/,''),quotaPanel()+'\nUsage: 1 input, 0 output, 0 cache read, 0 cache write',quotaPanel()+'\nTotal duration (API): 1s','9% used; status allowed'])expect(await parseQuota(text)).toBeNull();
});
test('explicit Claude quota reader validates native provider, source and actual observation time',async()=>{
 const native=()=>({observedAt:Date.now(),nativeProvider:'claude',windows:[{name:'Current week (all models)',used:.23,resetsAt:Date.now()+3600000}],source:'native Claude /usage TUI'});
 expect(await claudeStatus(async(args,cwd,timeout)=>{expect(args.slice(0,3)).toEqual(['/usr/bin/python3','-I','-B']);expect(cwd).toBe('/fictional/trusted');expect(timeout).toBe(10000);return JSON.stringify(native());},'/fictional/trusted')).toMatchObject({nativeProvider:'claude'});
 for(const raw of [null,{...native(),observedAt:1},{...native(),nativeProvider:'codex'},{...native(),source:'fictional status allowed'}])expect(await claudeStatus(async()=>JSON.stringify(raw))).toBeUndefined();
});

test('quota helper drains late quota rows and tears down its CLI group despite diagnostic failure or SIGTERM',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'factory-quota-custody-'));
 const helper=new URL('../scripts/claude-usage.py',import.meta.url).pathname;
 try{
  for(const mode of ['diagnostic-failure','signal','staged-high','staged-incomplete']){
   const pidFile=join(directory,`${mode}.pids`),fixture=join(directory,`fixture-${mode}.py`),wrapper=join(directory,`${mode}-wrapper.py`),diagnostic=join(directory,`${mode}.json`);
   writeFileSync(diagnostic,'retained diagnostic sentinel');
   const panel=mode==='signal'?'':quotaPanel().replaceAll('Nov 14','Dec 30');
   const aggregate=panel.replace(/Current week \(Fable\)\n18% 18% used\nResets Dec 30 at 3:59pm \(America\/Toronto\)\n/,'');
   const late='\u001b[18B\u001b[2K\u001b[GCurrent week (Fable)\n91% 91% used\n'+(mode==='staged-high'?'Resets Dec 30 at 3:59pm (America/Toronto)\n':'')+'Usage credits are off\nEsc to cancel';
   const emit=mode.startsWith('staged-')?`print(${JSON.stringify(aggregate)},flush=True)\ntime.sleep(.15)\nprint(${JSON.stringify(late)},flush=True)`:`print(${JSON.stringify(panel)},flush=True)`;
   writeFileSync(fixture,`import os,sys,subprocess,json,time\nchild=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])\nwith open(${JSON.stringify(pidFile+'.tmp')},'w') as handle: handle.write(json.dumps([os.getpid(),child.pid]))\nos.replace(${JSON.stringify(pidFile+'.tmp')},${JSON.stringify(pidFile)})\nprint('$',flush=True)\nsys.stdin.readline()\n${emit}\ntime.sleep(60)\n`);
   writeFileSync(wrapper,`import importlib.util,subprocess,sys,json,os\nspec=importlib.util.spec_from_file_location('quota',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.time.time=lambda:${Date.parse('2026-11-12T19:00:00-05:00')/1000}\noriginal=m.subprocess.Popen\nm.subprocess.Popen=lambda args,**kwargs:original([sys.executable,'-I','-B',${JSON.stringify(fixture)}],**kwargs)\nos.environ['FACTORY_CLAUDE_USAGE_RECEIPT']=${JSON.stringify(diagnostic)}\nm.install_signal_handlers()\nprint(json.dumps(m.read_usage(.6,.05)))\n`);
   const child=Bun.spawn(['/usr/bin/python3','-I','-B',wrapper],{stdout:'pipe',stderr:'pipe'});
   const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
   let pids:number[]=[];
   try{
    const deadline=Date.now()+2000;while(!existsSync(pidFile)&&Date.now()<deadline)await Bun.sleep(10);
    if(!existsSync(pidFile)){child.kill('SIGTERM');await child.exited;throw Error(await errors);}
    pids=JSON.parse(readFileSync(pidFile,'utf8'));
    if(mode==='signal')child.kill('SIGTERM');
    const [out,err,exit]=await Promise.all([output,errors,child.exited]);
    if(mode==='diagnostic-failure'||mode==='staged-high'){expect(exit).toBe(0);expect(JSON.parse(out).nativeProvider).toBe('claude');expect(err).toContain('diagnostic unavailable');if(mode==='staged-high')expect(JSON.parse(out).windows.map((w:any)=>w.used)).toEqual([.43,.91]);}
    else if(mode==='signal')expect(exit).toBe(143);
    else {expect(exit).not.toBe(0);expect(err).toContain('complete quota panel unavailable');}
    expect(readFileSync(diagnostic,'utf8')).toBe('retained diagnostic sentinel');
    for(const pid of pids){
     const ps=Bun.spawn(['/bin/ps','-p',String(pid),'-o','state='],{stdout:'pipe',stderr:'pipe'});
     const state=(await new Response(ps.stdout).text()).trim();await ps.exited;
     expect(!state||state.startsWith('Z')).toBe(true);
    }
   }finally{child.kill('SIGKILL');for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}}
  }
 }finally{rmSync(directory,{recursive:true});}
},10000);
