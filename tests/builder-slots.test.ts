import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../tracking/store';
import {TestEngine as Engine} from './fixtures';
import { builderSlots, reconcileCapacity, slotLimit, type SlotProcessEvidence } from '../launcher/capacity';
import { ConfigSchema } from '../launcher/config';
import { boardModel } from '../board/model';
import { supply } from '../launcher/autonomy';
import { observeSupplyIdle } from '../launcher/supply-idle';
import { queueBrowser as queueDetachedBrowser, resumeBrowser, saveBrowser, browserJobs, reconcileBrowsers, type BrowserPorts } from '../launcher/browser';
import { launchReady } from '../launcher/tick';
import { intakeLabel, issueTicket, type Issue } from '../adapters/github';
import { config, ticket, admission, meter, now } from './fixtures';

// All process evidence is fictional. No process-table permission is required.
const stopped:SlotProcessEvidence={identity:()=>null,absent:()=>true};
function setup(slots=6,path=':memory:') {
 const c=config();c.capacity.start_parallel=slots;
 const e=new Engine(new Store(path),c,stopped);e.pause(false,'owner');return e;
}
function dormant(e:Engine,n:number,status='paused',heavy=false) {
 const x=e.admit({...ticket(n),heavy},admission());
 e.s.db.query('UPDATE sessions SET status=?,native_id=?,actual_tokens=20,actual_seconds=2 WHERE id=?').run(status,`fictional-native-${n}`,x.id);
 e.s.set(`cleanup-evidence:${x.id}`,{verified:true});
 e.s.event(`cleanup:${x.id}`,'worker-cleanup',{verified:true},'Retain fictional cleanup');
 return e.sessions().find(s=>s.id===x.id)!;
}
// Pre-upgrade fixture: legacy waiting parents must still reconcile safely.
function queueBrowser(...args:Parameters<typeof queueDetachedBrowser>) {
 const j=queueDetachedBrowser(...args);delete j.detached;
 args[0].s.set(`browser-job:${j.id}`,j);
 args[0].s.db.query("UPDATE sessions SET status='waiting-browser' WHERE id=?").run(j.parent);
 args[0].s.set(`browser-parent:${j.parent}`,{child:j.id,state:"RW",deadline:j.deadline,default:"not done"});return j;
}

const request={result:'BROWSER_NEEDED',url:'https://console.example.test/status',goal:'Read fictional status',noCliApi:'No CLI for this fictional status',expectedEvidence:'Status text'};
function browserParent(e:Engine,n:number,heavy=false) {
 const x=dormant(e,n,'finished',heavy);
 return queueBrowser(e,x.id,request,now);
}
function returned(e:Engine,n:number,heavy=false) {
 const j=browserParent(e,n,heavy);j.state='returned';j.result={nonce:j.nonce,status:'done',evidence:'Fictional status ready',tabId:123,tabClosed:true};saveBrowser(e.s,j);return j;
}
const ports=(resume:(id:string)=>void):BrowserPorts=>({resume,start:async()=>{throw Error('unexpected browser start');},observe:async()=>'running',stop:async()=>true,fallback:async()=>{throw Error('unexpected fallback');},notify:async()=>{},answer:async()=>null});

test('six retained sessions, two running and four dormant leave four builder slots; custody and paths survive',()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'builder-custody-'));
 try {
  const first=e.admit(ticket(1),admission()),second=e.admit(ticket(2),admission());
  for(const x of [first,second])e.s.db.query("UPDATE sessions SET status='running' WHERE id=?").run(x.id);
  const waits=['paused','waiting-browser','waiting-person','question'].map((status,n)=>dormant(e,n+3,status));
  e.s.db.query('UPDATE sessions SET pid=90001 WHERE id=?').run(waits[0]!.id);
  e.s.db.query('UPDATE sessions SET pid=90002 WHERE id=?').run(waits[1]!.id);
  e.s.set(`supervisor:${waits[1]!.id}`,'old-boot:start');
  e.slotEvidence={identity:pid=>pid===90002?'new-boot:start':null,absent:()=>true};
  const sessions=e.sessions(),claims=e.s.db.query('SELECT * FROM claims').all(),debits=e.s.rows('debits');
  e.s.set(`publish-base:${waits[0]!.id}`,'a'.repeat(40));
  writeFileSync(join(dir,'retained-work'),'fictional edits');
  expect(e.active()).toHaveLength(6);
  expect(e.slots()).toMatchObject({used:2,max:6,free:4});
  expect(boardModel(e,{},now).slots).toEqual({used:2,max:6,free:4});
  expect(e.sessions()).toEqual(sessions);expect(e.s.db.query('SELECT * FROM claims').all()).toEqual(claims);expect(e.s.rows('debits')).toEqual(debits);
  expect(readFileSync(join(dir,'retained-work'),'utf8')).toBe('fictional edits');
  expect(e.s.get(`publish-base:${waits[0]!.id}`)).toBe('a'.repeat(40));
  expect(()=>e.admit({...ticket(99),paths:ticket(3).paths},admission())).toThrow('path claimed');
  expect(()=>e.admit(ticket(3),admission())).toThrow('duplicate');
  for(let n=7;n<=10;n++)e.admit(ticket(n),admission());
  expect(e.slots().used).toBe(6);expect(e.active()).toHaveLength(10);
  expect(()=>e.admit(ticket(11),admission())).toThrow('slots full');
  expect(e.sessions().slice(0,6)).toEqual(sessions);expect(e.s.rows('debits').slice(0,6)).toEqual(debits);
 }finally{e.s.close();}
});

for(const status of ['reserved','starting','running','unknown','failed','waiting','unrecognized'])test(`${status} custody always consumes a slot even with cleanup`,()=>{
 const e=setup(1);try{
  const x=dormant(e,1,status);expect(builderSlots(e.s,e.c,stopped).used).toBe(1);
  expect(()=>e.admit(ticket(2),admission())).toThrow('slots full');expect(e.active()[0]!.id).toBe(x.id);
 }finally{e.s.close();}
});
for(const status of ['paused','waiting-browser','waiting-person','waiting-question','question'])test(`${status} requires positive cleanup and stopped process evidence`,()=>{
 const e=setup(1);try{
  const x=dormant(e,1,status);
  e.s.set(`cleanup-evidence:${x.id}`,{verified:false});expect(e.slots().used).toBe(1);
  e.s.set(`cleanup-evidence:${x.id}`,{verified:true});e.s.db.query('UPDATE sessions SET pid=90001 WHERE id=?').run(x.id);
  for(const evidence of [
   {identity:()=>null,absent:()=>false}, // bare null is insufficient
   {identity:()=>{throw Error('process table denied');},absent:()=>true},
   {identity:()=>null,absent:()=>{throw Error('EPERM');}},
   {identity:()=>'live-start',absent:()=>false},
  ] satisfies SlotProcessEvidence[]) {
   e.slotEvidence=evidence;expect(e.slots().used).toBe(1);expect(()=>e.admit(ticket(2),admission())).toThrow('slots full');
  }
  e.s.set(`supervisor:${x.id}`,'live-start');expect(e.slots().used).toBe(1);
  e.slotEvidence={identity:()=>'',absent:()=>true};expect(e.slots().used).toBe(1);
  e.s.set(`supervisor:${x.id}`,{invalid:'identity'});e.slotEvidence={identity:()=>'reused-start',absent:()=>false};expect(e.slots().used).toBe(1);
  e.s.set(`supervisor:${x.id}`,'live-start');
  e.slotEvidence={identity:()=>'reused-start',absent:()=>false};expect(e.slots().free).toBe(1);
  e.slotEvidence=stopped;expect(e.slots().free).toBe(1);
 }finally{e.s.close();}
});

test('freed normal slots retain heavy reservations and all usage/qualification gates',()=>{
 const e=setup(1);try{
  const x=dormant(e,1,'paused',true);expect(e.slots().free).toBe(1);
  expect(()=>e.admit({...ticket(2),heavy:true},admission())).toThrow('heavy slots full');
  for(const a of [{...admission(),meter:undefined},{...admission(),qualification:undefined},{...admission(),qualification:{...admission().qualification,model:'other'}},{...admission(),meter:meter(.70)},{...admission(),meter:meter(.90)}])expect(()=>e.admit(ticket(2),a)).toThrow();
  expect(()=>e.admit({...ticket(2),benefit:'high'},{...admission(),meter:meter(.90)})).toThrow('usage stop');
  e.admit({...ticket(2),benefit:'high'},{...admission(),meter:meter(.70)});
  expect(e.sessions()[0]).toEqual(x);expect(e.s.rows('debits')).toHaveLength(2);
 }finally{e.s.close();}
});

test('browser wait and reacquisition retain the same heavy reservation',()=>{
 const e=setup(1),dir=mkdtempSync(join(tmpdir(),'heavy-browser-slot-'));try{
  const j=returned(e,1,true),original=e.sessions()[0]!;let starts=0;
  expect(e.slots().free).toBe(1);expect(()=>e.admit({...ticket(2),heavy:true},admission())).toThrow('heavy slots full');
  const other=e.admit(ticket(2),admission());resumeBrowser(e,j,dir,()=>starts++);expect(starts).toBe(0);
  e.finish(other.id,true);resumeBrowser(e,j,dir,()=>starts++);resumeBrowser(e,j,dir,()=>starts++);
  expect(starts).toBe(1);expect(e.sessions()[0]).toMatchObject({status:'starting',brief:original.brief,native_id:original.native_id});
  e.c.capacity.start_parallel=2;expect(()=>e.admit({...ticket(3),heavy:true},admission())).toThrow('heavy slots full');
 }finally{e.s.close();}
});

test('full paused continuation waits across restart, freezes approved extension and retries on a later tick',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paused-slot-')),path=join(dir,'state.sqlite');let e=setup(1,path);
 const x=dormant(e,1),y=e.admit(ticket(2),admission());e.s.set('token-calibration:codex',2000);
 const claims=e.s.db.query('SELECT * FROM claims').all(),debits=e.s.rows('debits');let starts=0;
 try{
  expect(e.continueSession(x.id,'fictional approved extension',()=>starts++)).toBeUndefined();
  expect(starts).toBe(0);expect(e.sessions()[0]).toEqual(x);expect(e.s.get(`token-extension:${x.id}`)).toBeNull();
  e.s.close();e=new Engine(new Store(path),e.c,stopped);e.s.set('token-calibration:codex',9000);
  await reconcileBrowsers(e,dir,ports(()=>starts++),now);expect(starts).toBe(0);
  e.finish(y.id,true);
  await reconcileBrowsers(e,dir,ports(()=>{throw Error('spawn refused');}),now+1);
  expect(e.sessions()[0]).toEqual(x);expect(e.s.get(`continuation-slot-wait:${x.id}`)).toMatchObject({tokens:2000});
  expect(e.s.get(`token-extension:${x.id}`)).toBeNull();expect(e.slots().free).toBe(1);
  await reconcileBrowsers(e,dir,ports(()=>{expect(e.slots().used).toBe(1);starts++;}),now+1);
  await reconcileBrowsers(e,dir,ports(()=>starts++),now+2);
  expect(starts).toBe(1);expect(e.s.get(`token-extension:${x.id}`)).toBe(2000);
  expect(e.sessions()[0]).toMatchObject({status:'starting',brief:x.brief,native_id:x.native_id,actual_seconds:x.actual_seconds,actual_tokens:x.actual_tokens});
  expect(e.s.db.query('SELECT * FROM claims').all()).toEqual(claims);expect(e.s.rows('debits')).toEqual(debits);
 }finally{e.s.close();}
});

test('missing or unreadable cleanup never frees a dormant slot; legacy verified cleanup remains usable',()=>{
 const e=setup(1);try{
  const x=e.admit(ticket(),admission());e.s.db.query("UPDATE sessions SET status='paused' WHERE id=?").run(x.id);
  expect(e.slots().used).toBe(1);
  e.s.event(`cleanup:${x.id}`,'worker-cleanup',{verified:true},'Retain fictional legacy proof');expect(e.slots().free).toBe(1);
  e.s.set(`cleanup-evidence:${x.id}`,{verified:false});expect(e.slots().used).toBe(1);
  e.s.db.query('UPDATE kv SET value=? WHERE key=?').run('unreadable',`cleanup-evidence:${x.id}`);expect(e.slots().used).toBe(1);
 }finally{e.s.close();}
});

test('paused reacquisition requires stopped identity, cleanup, bounded extension and unpaused factory',()=>{
 const e=setup(1);try{
  const x=dormant(e,1);e.s.set('token-calibration:codex',2000);e.s.db.query('UPDATE sessions SET pid=90001 WHERE id=?').run(x.id);
  e.slotEvidence={identity:()=>null,absent:()=>false};
  expect(()=>e.continueSession(x.id,'fixture',()=>{})).toThrow('custody');
  e.slotEvidence=stopped;e.s.set(`cleanup-evidence:${x.id}`,{verified:false});expect(()=>e.continueSession(x.id,'fixture',()=>{})).toThrow('cleanup');
  e.s.set(`cleanup-evidence:${x.id}`,{verified:true});e.pause(true,'owner');expect(()=>e.continueSession(x.id,'fixture',()=>{})).toThrow('unpaused');e.pause(false,'owner');
  e.s.set('token-calibration:codex',1000);expect(()=>e.continueSession(x.id,'fixture',()=>{})).toThrow('bounded');
  e.s.set('token-calibration:codex',2000);e.continueSession(x.id,'fixture',()=>{});expect(e.sessions()[0]).toMatchObject({status:'starting',pid:null,native_id:x.native_id});
 }finally{e.s.close();}
});

test('synchronous paused spawn failure rolls back the slot, extension, stop and continuation claim',()=>{
 const e=setup(1);try{
  const x=dormant(e,1);e.s.set('token-calibration:codex',2000);e.s.set(`stop:${x.id}`,{reason:'retained'});
  const events=e.s.rows('events'),debits=e.s.rows('debits');
  expect(()=>e.continueSession(x.id,'fixture',()=>{expect(e.slots().used).toBe(1);throw Error('spawn refused');})).toThrow('spawn refused');
  expect(e.sessions()[0]).toEqual(x);expect(e.slots().free).toBe(1);expect(e.s.get(`continuation:${x.id}`)).toBeNull();expect(e.s.get(`token-extension:${x.id}`)).toBeNull();expect(e.s.get(`stop:${x.id}`)).toEqual({reason:'retained'});expect(e.s.rows('events')).toEqual(events);expect(e.s.rows('debits')).toEqual(debits);
 }finally{e.s.close();}
});

test('normal launchReady spawn rollback preserves dormant claims and debits, then admits once',async()=>{
 const e=setup(1);try{
  dormant(e,1);const original=e.sessions()[0],before=e.s.rows('debits');
  const raw={...ticket(2),costCents:50},i:Issue={number:2,title:raw.title,body:'```factory\n'+JSON.stringify(raw)+'\n```',state:'OPEN',url:'https://github.com/example/demo/issues/2',updatedAt:'fixture',labels:[{name:'state:ready'},{name:'kind:fix'},{name:'area:controller'}]};
  i.labels.push({name:intakeLabel(raw.repo,i)});const t=issueTicket(raw.repo,i)!;
  const execute=async(args:string[])=>args.includes('view')?JSON.stringify(i):'';
  await expect(launchReady(e,t,admission(),()=>{throw Error('spawn refused');},execute,()=>now)).rejects.toThrow('spawn refused');
  expect(e.sessions()).toEqual([original!]);expect(e.s.rows('debits')).toEqual(before);expect(e.slots().free).toBe(1);
  let starts=0;await launchReady(e,t,admission(),()=>starts++,execute,()=>now);
  expect(starts).toBe(1);expect(e.slots().used).toBe(1);expect(e.active()).toHaveLength(2);
 }finally{e.s.close();}
});

test('board and idle supply observe free slots while retaining occupied custody paths',()=>{
 const e=setup(1);try{
  const x=dormant(e,1);e.c=ConfigSchema.parse({...e.c,autonomy:{intake_owner:'builder',ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['launcher/config.ts']},restart:{max_retries:1,causes_per_hour:3}}});
  expect(boardModel(e,{},now).hero.mode).toBe('idle');
  expect(observeSupplyIdle(e,0,now,{claimed:0,refusals:[]})).toMatchObject({since:now});
  supply(e,[],now,{claimed:0,refusals:[]});
  const round=e.s.get<{wake:string}>('intake-round')!;
  expect(e.s.get<{payload:{free:number;occupied:unknown[]}}>(`owner-wake:${round.wake}`)?.payload).toMatchObject({free:1,occupied:[{id:x.id,paths:ticket().paths}]});
  const y=e.admit(ticket(2),admission());expect(observeSupplyIdle(e,0,now+1,{claimed:0,refusals:[]})).toBeNull();expect(e.s.get('supply-idle')).toBeNull();
  expect(e.active().map(x=>x.id)).toEqual([x.id,y.id]);
 }finally{e.s.close();}
});

test('capacity controller literals and busy-only growth stay unchanged',()=>{
 const e=setup();try{
  e.c=ConfigSchema.parse({...e.c,capacity:{...e.c.capacity,controller:{start:6,max:12,interval_minutes:60,busy_above:.8,failure_below:.3}}});
  const running=[1,2].map(n=>e.admit(ticket(n),admission()));for(const x of running)e.s.db.query("UPDATE sessions SET status='running' WHERE id=?").run(x.id);
  for(let n=3;n<=6;n++)dormant(e,n);
  for(let minute=0;minute<=60;minute++)reconcileCapacity(e.s,e.c,e.slots().occupied.filter(x=>['starting','running'].includes(x.status)).length,'normal',now+minute*60000);
  expect(slotLimit(e.s,e.c)).toBe(6);
  for(let minute=61;minute<=481;minute++)reconcileCapacity(e.s,e.c,slotLimit(e.s,e.c),'normal',now+minute*60000);
  expect(slotLimit(e.s,e.c)).toBe(12);expect(e.c.usage_gates).toMatchObject({admit_below:.70,stop_at:.90});
 }finally{e.s.close();}
});

// Each competitor is a separate Bun process and independent SQLite connection.
// The gate releases both only after their controller initialization completes.
for(const modes of [['paused','new'],['browser','new'],['paused','browser']] as const)test(`independent processes race final slot: ${modes.join(' versus ')}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'builder-slot-race-')),path=join(dir,'state.sqlite'),gate=join(dir,'go'),e=setup(1,path);
 const paused=dormant(e,1),browser=returned(e,2);e.s.set('token-calibration:codex',2000);
 const module=(path:string)=>JSON.stringify(new URL(path,import.meta.url).href);
 const children=modes.map(mode=>{
  const script=`
   import {existsSync,writeFileSync} from 'node:fs';
   import {TestEngine as Engine} from ${module('./fixtures.ts')};
   import {Store} from ${module('../tracking/store.ts')};
   import {config,ticket,admission} from ${module('./fixtures.ts')};
   import {browserJobs,resumeBrowser} from ${module('../launcher/browser.ts')};
   const s=new Store(${JSON.stringify(path)}),c=config();c.capacity.start_parallel=1;
   const e=new Engine(s,c,{identity:()=>null,absent:()=>true});
   writeFileSync(${JSON.stringify(join(dir,mode+'.ready'))},'ready');
   while(!existsSync(${JSON.stringify(gate)}))await Bun.sleep(5);
   const spawn=id=>{if(e.slots().used!==1)throw Error('oversubscribed');s.set('spawn:'+id,true);};
   try {
    if(${JSON.stringify(mode)}==='paused')e.continueSession(${JSON.stringify(paused.id)},'fixture race',()=>spawn(${JSON.stringify(paused.id)}));
    else if(${JSON.stringify(mode)}==='browser')resumeBrowser(e,browserJobs(s)[0],${JSON.stringify(dir)},spawn);
    else s.atomic(()=>{const x=e.admit(ticket(3),admission());if(!e.claimStart(x.id))throw Error('start refused');spawn(x.id);});
   }catch(error){if(!String(error).includes('slots full'))throw error;}
   s.close();
  `;
  return Bun.spawn([process.execPath,'--no-env-file','--eval',script],{stdout:'pipe',stderr:'pipe'});
 });
 try{
  const deadline=Date.now()+5000;while(!modes.every(mode=>existsSync(join(dir,mode+'.ready')))){if(Date.now()>deadline)throw Error('race startup timeout');await Bun.sleep(10);}
  writeFileSync(gate,'go');
  for(const child of children){const err=await new Response(child.stderr).text();expect(await child.exited,err).toBe(0);expect(err).toBe('');}
  expect(e.slots().used).toBe(1);expect(e.s.db.query("SELECT key FROM kv WHERE key LIKE 'spawn:%'").all()).toHaveLength(1);
  expect(e.sessions().filter(x=>x.status==='starting')).toHaveLength(1);
  expect(e.sessions().filter(x=>[paused.id,browser.parent].includes(x.id))).toHaveLength(2);
  expect(e.s.rows('debits')).toHaveLength(e.sessions().length);
  expect(browserJobs(e.s)[0]!.result).toEqual(browser.result);
 }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await Promise.all(children.map(child=>child.exited));e.s.close();}
},15000);
