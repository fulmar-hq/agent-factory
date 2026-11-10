import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {TestEngine as Engine} from './fixtures';
import { Store } from "../tracking/store";
import { config, ticket, admission, now } from "./fixtures";
import { BrowserNeeded, BrowserResult, queueBrowser, browserJobs, browserDir, reconcileBrowsers, readBrowserJSON, resumeBrowser, type BrowserPorts, type BrowserJob } from "../launcher/browser";
import { browserArgs, queueBrowserMail, browserMailAnswer, browserNativeEvidence, verifyBrowserPageReceipt } from "../adapters/browser";
import { Database } from "bun:sqlite";

const request={result:"BROWSER_NEEDED",url:"https://console.example.test/settings",goal:"Read status",noCliApi:"This console exposes no CLI or API for status.",expectedEvidence:"Exact status text"};
function setup() {
  const dir=mkdtempSync(join(tmpdir(),"factory-browser-")), s=new Store(join(dir,"controller.sqlite")),e=new Engine(s,config());e.pause(false,"owner");
  const parent=e.admit(ticket(),admission());e.claimStart(parent.id,now);
  e.s.db.query("UPDATE sessions SET status='finished',native_id='11111111-1111-4111-8111-111111111111' WHERE id=?").run(parent.id);
  s.set(`cleanup-evidence:${parent.id}`,{verified:true});
  const j=queueBrowser(e,parent.id,request,now), calls:string[]=[];
  const ports:BrowserPorts={
    start:async(job)=>{calls.push(`start:${job.id}`);return job.native.slice(0,8);},
    observe:async()=>"running",stop:async()=>true,
    fallback:async()=>{calls.push("mail");return {address:"Codex Fixture",ref:"fixture-ref"};},
    notify:async()=>{calls.push("notify");},answer:async()=>null,resume:id=>{calls.push(`resume:${id}`);},
  };
  const current=()=>browserJobs(s).find(x=>x.id===j.id)!;
  const result=(job:BrowserJob,status:"done"|"blocked"="done")=>{
    mkdirSync(browserDir(dir,job),{recursive:true});
    writeFileSync(join(browserDir(dir,job),"result.json"),JSON.stringify({nonce:job.nonce,status,evidence:"Observed status",tabId:123,tabClosed:true,...(status==="blocked"?{blocker:"signin"}:{})}));
  };
  return {dir,s,e,parent,j,calls,ports,current,result,close:()=>{s.close();rmSync(dir,{recursive:true});}};
}

test('low disk retains queued browser and returned parent until fresh capacity recovers',async()=>{
 const f=setup();
 try {
  f.e.diskProbe=()=>({at:now,path:'fictional',freeGiB:29,usedFraction:0.9});
  await reconcileBrowsers(f.e,f.dir,f.ports,now);
  expect(f.current().state).toBe('queued');expect(f.calls).toEqual([]);
  f.e.diskProbe=()=>({at:now,path:'fictional',freeGiB:30,usedFraction:0.8});
  await reconcileBrowsers(f.e,f.dir,f.ports,now+1);expect(f.current().state).toBe('running');
  f.result(f.current());f.ports.observe=async()=>'done';
  f.e.diskProbe=()=>({at:now,path:'fictional',freeGiB:29,usedFraction:0.9});
  await reconcileBrowsers(f.e,f.dir,f.ports,now+2);
  expect(f.e.sessions()[0].status).toBe('waiting-browser');
  expect(f.current().result?.status).toBe('done');expect(f.calls.some(c=>c.startsWith('resume:'))).toBe(false);
  f.e.diskProbe=()=>({at:now,path:'fictional',freeGiB:30,usedFraction:0.8});
  await reconcileBrowsers(f.e,f.dir,f.ports,now+3);
  expect(f.e.sessions()[0].status).toBe('starting');expect(f.calls.filter(c=>c.startsWith('resume:'))).toHaveLength(1);
 }finally{f.close();}
});
test("structured request is strict; handoff keeps parent claims, RW deadline and default",()=>{
  const f=setup();try {
    expect(f.e.sessions()[0].status).toBe("waiting-browser");
    expect(f.s.get(`browser-parent:${f.parent.id}`)).toMatchObject({child:f.j.id,state:"RW",deadline:now+7200000,default:"not done"});
    expect(f.s.rows("debits")).toHaveLength(1);
    expect(f.s.db.query("SELECT * FROM claims").all()).toHaveLength(1);
    expect(()=>queueBrowser(f.e,f.parent.id,request,now)).toThrow();
    for(const bad of [{...request,noCliApi:""},{...request,result:"SUCCESS"},{...request,extra:true},{...request,url:"file:///tmp/x"},{...request,url:"https://user:secret@example.test"}])expect(BrowserNeeded.safeParse(bad).success).toBe(false);
  }finally {f.close();}
});
test("one browser starts across duplicate ticks and delivers to original native parent once",async()=>{
  const f=setup();try {
    const other=f.e.admit({...ticket(2),estimateSeconds:200},admission());f.e.claimStart(other.id,now);
    f.s.db.query("UPDATE sessions SET status='finished',native_id=? WHERE id=?").run(f.parent.native_id ?? "22222222-2222-4222-8222-222222222222",other.id);
    f.s.set(`cleanup-evidence:${other.id}`,{verified:true});queueBrowser(f.e,other.id,{...request,goal:"Other status"},now);
    await reconcileBrowsers(f.e,f.dir,f.ports,now);await reconcileBrowsers(f.e,f.dir,f.ports,now+1);
    expect(f.calls.filter(x=>x.startsWith("start:"))).toHaveLength(1);
    f.result(f.current());f.ports.observe=async()=>"done";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+2);
    expect(f.e.sessions()[0].status).toBe("starting");
    expect(f.s.get(`continuation:${f.parent.id}`)).toMatchObject({native:"11111111-1111-4111-8111-111111111111"});
    expect(JSON.parse(readFileSync(join(f.dir,"workspaces",f.parent.id,".factory-tmp/browser-result.json"),"utf8"))).toMatchObject({status:"done",evidence:"Observed status"});
    f.ports.observe=async()=>"running";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+3);
    expect(f.calls.filter(x=>x===`resume:${f.parent.id}`)).toHaveLength(1);
  }finally{f.close();}
});
test("sign-in stops, asks Vincent once, and answer starts a fresh bounded browser turn",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current(),"blocked");f.ports.observe=async()=>"done";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+1);await reconcileBrowsers(f.e,f.dir,f.ports,now+2);
    expect(f.current().state).toBe("question");expect(f.calls.filter(x=>x==="notify")).toHaveLength(1);expect(f.calls.some(x=>x.startsWith("resume"))).toBe(false);
    const q=f.s.rows("questions")[0] as {text:string;addressed_to:string};expect(q.addressed_to).toBe("vincent");expect(q.text).toContain("Default: not done");
    const original=f.current().native;
    f.ports.answer=async()=>"I signed in. Try again.";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+3);
    expect(f.current().state).toBe("running");expect(f.current().native).not.toBe(original);expect(f.current().deadline).toBe(f.j.deadline);
    f.result(f.current());await reconcileBrowsers(f.e,f.dir,f.ports,now+4);
    expect(f.current().result?.status).toBe("done");
  }finally{f.close();}
});
test("deadline applies not done even with a late answer and returns it to parent",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current(),"blocked");f.ports.observe=async()=>"done";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+1);f.ports.answer=async()=>"Go";
    await reconcileBrowsers(f.e,f.dir,f.ports,f.j.deadline);
    expect(f.current().state).toBe("returned");expect(f.current().result?.status).toBe("not done");
    expect(f.calls.filter(x=>x.startsWith("start:"))).toHaveLength(1);
    expect(f.calls).toContain(`resume:${f.parent.id}`);
    expect(f.s.rows("questions")[0]).toMatchObject({answer:null,resolved_by:"auto: browser result returned"});
  }finally{f.close();}
});
test("failed start and native timeout queue one fallback and question, returning its receipt",async()=>{
  for(const failure of ["start","timeout"]) {
    const f=setup();try {
      if(failure==="start")f.ports.start=async()=>{throw Error("untrusted workspace");};
      await reconcileBrowsers(f.e,f.dir,f.ports,now);
      await reconcileBrowsers(f.e,f.dir,f.ports,now+600001);
      await reconcileBrowsers(f.e,f.dir,f.ports,now+600002);
      expect(f.current().state).toBe("fallback");expect(f.calls.filter(x=>x==="mail")).toHaveLength(1);expect(f.calls.filter(x=>x==="notify")).toHaveLength(1);
      f.result(f.current());await reconcileBrowsers(f.e,f.dir,f.ports,now+600003);
      expect(f.current().result?.status).toBe("done");expect(f.calls).toContain(`resume:${f.parent.id}`);
    }finally{f.close();}
  }
});
test("unknown stop retains browser custody and refuses fallback or another launch",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.ports.stop=async()=>false;
    await reconcileBrowsers(f.e,f.dir,f.ports,now+600001);
    expect(f.current().state).toBe("running");expect(f.calls).not.toContain("mail");
    await reconcileBrowsers(f.e,f.dir,f.ports,f.j.deadline);
    expect(f.current().result?.status).toBe("not done");expect(f.current().nativePending).toBe(true);expect(f.calls.some(x=>x.startsWith("resume"))).toBe(false);
  }finally{f.close();}
});
test("background native evidence ignores only explicit file-history metadata and fails closed",()=>{
  const f=setup(),id="33333333-3333-4333-8333-333333333333",cwd="/fictional/checkout",dir=join(f.dir,".claude/projects/-fictional-checkout"),path=join(dir,`${id}.jsonl`);
  try {
    mkdirSync(dir,{recursive:true});
    const rows=[{type:"file-history-snapshot",snapshot:{}},{type:"user",sessionId:id,cwd},{type:"assistant",sessionId:id,cwd,effort:"medium",message:{id:"a",model:"claude-opus-5-5",content:[],usage:{input_tokens:20,output_tokens:5}}}];
    const write=(r:unknown[])=>writeFileSync(path,r.map(x=>JSON.stringify(x)).join("\n")+"\n");
    write(rows);const proof=browserNativeEvidence(id,cwd,f.dir);expect(proof).toMatchObject({verified:true,tokens:25});
    const claimed={nonce:crypto.randomUUID(),status:"done" as const,evidence:"Claimed status",tabId:123,tabClosed:true};
    expect(()=>verifyBrowserPageReceipt(claimed,proof)).toThrow("closure evidence missing");
    expect(()=>verifyBrowserPageReceipt(claimed,{...proof,closedTabs:[123]})).toThrow("page evidence missing");
    write(rows.slice(0,2));expect(browserNativeEvidence(id,cwd,f.dir).verified).toBe(false);
    write([...rows,{type:"assistant",sessionId:id,effort:"high",message:{model:"other"}}]);expect(browserNativeEvidence(id,cwd,f.dir)).toMatchObject({verified:false,conflict:true});
    write([...rows,{type:"assistant",message:{model:"claude-opus-5-5"}}]);expect(()=>browserNativeEvidence(id,cwd,f.dir)).toThrow("custody mismatch");
    write([...rows,{type:"assistant",sessionId:crypto.randomUUID()}]);expect(()=>browserNativeEvidence(id,cwd,f.dir)).toThrow("custody mismatch");
  }finally{f.close();}
});
test("an earlier returned child cannot resume a parent waiting for a later browser goal",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current());f.ports.observe=async()=>"done";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+1);
    f.s.db.query("UPDATE sessions SET status='finished' WHERE id=?").run(f.parent.id);
    const next=queueBrowser(f.e,f.parent.id,{...request,goal:"Read another status"},now+2);
    f.ports.observe=async()=>"running";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+3);
    expect(f.e.sessions()[0].status).toBe("waiting-browser");expect(f.calls.filter(x=>x.startsWith("resume:"))).toHaveLength(1);
    expect(browserJobs(f.s).find(j=>j.id===next.id)?.state).toBe("running");
  }finally{f.close();}
});
test("parent receipt write refuses symlinks and synchronous resume failure rolls back its claim",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current());f.ports.observe=async()=>"done";
    f.ports.resume=()=>{throw Error("spawn refused");};
    await expect(reconcileBrowsers(f.e,f.dir,f.ports,now+1)).rejects.toThrow("spawn refused");
    expect(f.e.sessions()[0].status).toBe("waiting-browser");expect(f.s.get(`continuation:${f.parent.id}`)).toBeNull();
    const path=join(f.dir,"workspaces",f.parent.id,".factory-tmp/browser-result.json"),target=join(f.dir,"protected.json");
    writeFileSync(target,"preserve");rmSync(path);symlinkSync(target,path);
    expect(()=>resumeBrowser(f.e,f.current(),f.dir,()=>{})).toThrow();expect(readFileSync(target,"utf8")).toBe("preserve");
    rmSync(path);f.ports.resume=id=>{f.calls.push(`resume:${id}`);};
    await reconcileBrowsers(f.e,f.dir,f.ports,now+2);expect(f.e.sessions()[0].status).toBe("starting");
  }finally{f.close();}
});
test("a fallback deadline returns not done while late cleanup only releases custody",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);await reconcileBrowsers(f.e,f.dir,f.ports,now+600001);
    await reconcileBrowsers(f.e,f.dir,f.ports,f.j.deadline);
    expect(f.current()).toMatchObject({state:"returned",fallbackPending:true,result:{status:"not done"}});
    expect(f.e.sessions()[0].status).toBe("waiting-browser");
    expect(f.s.get(`browser-parent:${f.parent.id}`)).toMatchObject({state:"returned",custodyBlocked:true,result:{status:"not done"}});
    f.result(f.current());await reconcileBrowsers(f.e,f.dir,f.ports,f.j.deadline+1);
    expect(f.current().fallbackPending).toBe(false);expect(f.current().result?.status).toBe("not done");
    expect(f.e.sessions()[0].status).toBe("starting");
  }finally{f.close();}
});
test("a native result refused by verification cannot be laundered through fallback",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);const nativeNonce=f.current().nonce;f.result(f.current());
    f.ports.observe=async()=>{throw Error("native model evidence missing");};
    await reconcileBrowsers(f.e,f.dir,f.ports,now+1);await reconcileBrowsers(f.e,f.dir,f.ports,now+2);
    expect(f.current()).toMatchObject({state:"fallback",nativeReceiptNonce:nativeNonce});
    expect(f.current().nonce).not.toBe(nativeNonce);expect(f.current().result).toBeUndefined();
    expect(f.calls.some(x=>x.startsWith("resume:"))).toBe(false);
  }finally{f.close();}
});
test("malformed, stale and unclosed receipts cannot become successful browser results",async()=>{
  const f=setup();try {
    await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current());
    const path=join(browserDir(f.dir,f.current()),"result.json");
    const good=JSON.parse(readFileSync(path,"utf8"));
    expect(BrowserResult.safeParse({...good,tabClosed:false}).success).toBe(false);
    expect(BrowserResult.safeParse({...good,status:"success"}).success).toBe(false);
    writeFileSync(path,JSON.stringify({...good,nonce:crypto.randomUUID()}));f.ports.observe=async()=>"done";
    await reconcileBrowsers(f.e,f.dir,f.ports,now+1);
    expect(f.current().state).toBe("fallback");expect(f.calls.some(x=>x.startsWith("resume"))).toBe(false);
    const link=join(f.dir,"linked.json");symlinkSync(path,link);expect(()=>readBrowserJSON(link)).toThrow();
  }finally{f.close();}
});
test("browser flags are noninteractive with Chrome and exact receipt edit permission",()=>{
  const f=setup();try {
    const args=browserArgs(f.j,"brief","/private/fiction/result.json");
    expect(args.slice(0,3)).toEqual(["claude","--bg","--chrome"]);
    expect(args).toContain("dontAsk");expect(args).toContain("Edit(//private/fiction/result.json)");expect(args).not.toContain("bypassPermissions");expect(args).not.toContain("Bash");
  }finally{f.close();}
});
test("mail outbox is idempotent and only a correlated timely Telegram reply answers",()=>{
  const f=setup(),path=join(f.dir,"mail.sqlite"),db=new Database(path);
  try {
    db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,reply_to TEXT)");
    const id=`browser-question:${f.j.id}`;
    for(let i=0;i<2;i++)queueBrowserMail(id,"Vincent","telegram","Can you sign in?","",now,path);
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(1);
    db.query("INSERT INTO messages(id,sender_app,created_at,summary,body,reply_to) VALUES(?,?,?,?,?,?)").run("fake","codex",now+1,"Yes","",id);
    expect(browserMailAnswer(f.j,path)).toBeNull();
    db.query("INSERT INTO messages(id,sender_app,created_at,summary,body,reply_to) VALUES(?,?,?,?,?,?)").run("late","telegram",f.j.deadline,"Yes","",id);
    expect(browserMailAnswer(f.j,path)).toBeNull();
    db.query("INSERT INTO messages(id,sender_app,created_at,summary,body,reply_to) VALUES(?,?,?,?,?,?)").run("answer","telegram",now+2,"I signed in.","",id);
    expect(browserMailAnswer(f.j,path)).toBe("I signed in.");
  }finally{db.close();f.close();}
});

test('a returned browser parent waits at full capacity, retains result across restart, then reacquires once',async()=>{
 const f=setup();try{
  f.e.c.capacity.start_parallel=1;
  const other=f.e.admit(ticket(2),admission());f.e.claimStart(other.id,now);
  const original=f.e.sessions().find(x=>x.id===f.parent.id)!,claims=f.s.db.query('SELECT * FROM claims').all(),debits=f.s.rows('debits');
  await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current());f.ports.observe=async()=>'done';
  await reconcileBrowsers(f.e,f.dir,f.ports,now+1);await reconcileBrowsers(f.e,f.dir,f.ports,now+2);
  expect(f.e.sessions().find(x=>x.id===f.parent.id)).toEqual(original);expect(f.e.slots()).toMatchObject({used:1,free:0});
  expect(f.calls.filter(x=>x.startsWith('resume:'))).toHaveLength(0);expect(f.current().state).toBe('returned');
  const path=join(f.dir,'workspaces',f.parent.id,'.factory-tmp/browser-result.json'),result=readFileSync(path,'utf8');
  expect(JSON.parse(result)).toMatchObject({child:f.j.id,status:'done',evidence:'Observed status'});
  const reopened=new Store(join(f.dir,'controller.sqlite')),engine=new Engine(reopened,f.e.c);
  try{
   engine.finish(other.id,true);
   await reconcileBrowsers(engine,f.dir,f.ports,now+3);await reconcileBrowsers(engine,f.dir,f.ports,now+4);
   expect(engine.slots()).toMatchObject({used:1,free:0});expect(f.calls.filter(x=>x===`resume:${f.parent.id}`)).toHaveLength(1);
   expect(engine.sessions().find(x=>x.id===f.parent.id)).toMatchObject({status:'starting',native_id:original.native_id,brief:original.brief,actual_seconds:original.actual_seconds,actual_tokens:original.actual_tokens});
   expect(readFileSync(path,'utf8')).toBe(result);
  }finally{reopened.close();}
  expect(f.s.db.query('SELECT * FROM claims').all()).toEqual(claims);expect(f.s.rows('debits')).toEqual(debits);
 }finally{f.close();}
});

test('browser resume requires positive stale-PID evidence, frozen budget and cleanup',async()=>{
 const f=setup();try{
  f.e.slotEvidence={identity:()=>null,absent:()=>false};
  await reconcileBrowsers(f.e,f.dir,f.ports,now);f.result(f.current());f.ports.observe=async()=>'done';
  f.s.db.query('UPDATE sessions SET pid=90001 WHERE id=?').run(f.parent.id);
  await reconcileBrowsers(f.e,f.dir,f.ports,now+1);
  expect(f.e.sessions()[0]!.status).toBe('waiting-browser');expect(f.e.slots().used).toBe(1);
  f.e.slotEvidence={identity:()=>null,absent:()=>true};
  f.s.db.query('UPDATE sessions SET actual_tokens=2000 WHERE id=?').run(f.parent.id);
  await reconcileBrowsers(f.e,f.dir,f.ports,now+2);expect(f.calls.filter(x=>x.startsWith('resume:'))).toHaveLength(0);
  expect(f.s.get(`token-extension:${f.parent.id}`)).toBeNull();
  // Reconcile only fictional accounting to exercise the independent cleanup gate.
  f.s.db.query('UPDATE sessions SET actual_tokens=0 WHERE id=?').run(f.parent.id);
  f.s.set(`cleanup-evidence:${f.parent.id}`,{verified:false});
  await reconcileBrowsers(f.e,f.dir,f.ports,now+3);expect(f.calls.filter(x=>x.startsWith('resume:'))).toHaveLength(0);
  f.s.set(`cleanup-evidence:${f.parent.id}`,{verified:true});
  await reconcileBrowsers(f.e,f.dir,f.ports,now+4);
  expect(f.e.sessions()[0]).toMatchObject({status:'starting',pid:null,brief:f.parent.brief});expect(f.calls.filter(x=>x.startsWith('resume:'))).toHaveLength(1);
 }finally{f.close();}
});
