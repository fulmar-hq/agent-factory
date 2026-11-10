import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../launcher/config';
import {TestEngine as Engine} from './fixtures';
import {Store} from '../tracking/store';
import {supply,expireDecisions,type IntakeRound} from '../launcher/autonomy';
import {observeSupplyIdle,type SupplyIdle} from '../launcher/supply-idle';
import {queueWake,pendingWakes} from '../launcher/wake';
import {enforceIntakeMode,intakeInstructions} from '../launcher/intake-policy';
import {config,ticket,admission,now} from './fixtures';

const minute=60000,empty={claimed:0,refusals:[]};
function setup(mode:'drain'|'build'='drain',minutes=10) {
 const c=ConfigSchema.parse({...config(),autonomy:{intake_mode:mode,intake_owner:'builder',idle_wake_minutes:minutes,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['.github']},restart:{max_retries:1,causes_per_hour:3}}});
 const dir=mkdtempSync(join(tmpdir(),'factory-supply-')),path=join(dir,'mail.sqlite'),mail=new Database(path);
 mail.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)');
 let s=new Store(join(dir,'controller.sqlite')),e=new Engine(s,c);e.pause(false,'owner');
 return {get e(){return e;},get s(){return s;},mail,path,dir,restart(){s.close();s=new Store(join(dir,'controller.sqlite'));e=new Engine(s,c);},close(){s.close();mail.close();rmSync(dir,{recursive:true});}};
}
function complete(e:Engine){
 const r=e.s.get<IntakeRound>('intake-round')!;
 e.s.set(`owner-wake:${r.wake}`,{...e.s.get<object>(`owner-wake:${r.wake}`),state:'done',cleanupVerified:true});
}
function intakeEvents(s:Store){return (s.rows('events') as {kind:string;data:string;at:number}[]).filter(r=>r.kind==='owner-wake-queued' && JSON.parse(r.data).kind==='product-intake');}

test('overnight idle regression: exhausted drain retries across restart, one alert at two hours',()=>{
 const f=setup();try {
  // Fictional replay of the 23:46 -> 08:48 shape; no private event data.
  const start=Date.parse('2030-01-01T23:46:00-05:00');
  supply(f.e,[],start,empty,f.path);
  complete(f.e);supply(f.e,[],start+minute,empty,f.path);
  complete(f.e);supply(f.e,[],start+2*minute,empty,f.path);
  const exhausted=f.s.get<IntakeRound>('intake-round')!;
  expect(exhausted.retryAt).toBe(start+12*minute);
  f.restart();
  supply(f.e,[],start+10*minute-1,empty,f.path);
  expect(f.s.get<IntakeRound>('intake-round')!.id).toBe(exhausted.id);
  supply(f.e,[],start+10*minute,empty,f.path);
  expect(f.s.get<IntakeRound>('intake-round')!.id).not.toBe(exhausted.id);
  expect(f.s.get<SupplyIdle>('supply-idle')!.since).toBe(start);
  for(let m=11;m<=542;m++){
   complete(f.e);supply(f.e,[],start+m*minute,empty,f.path);
   if(m===119)expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(0);
   if(m===120)expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(1);
  }
  expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(1);
  const wakes=intakeEvents(f.s);
  expect(wakes.length).toBeGreaterThan(10);expect(wakes.length).toBeLessThan(30);
  expect(wakes.at(-1)!.at).toBeGreaterThan(start+480*minute);
  const delays=(f.s.rows('events') as {kind:string;data:string}[]).filter(r=>r.kind==='intake-retry-scheduled').map(r=>JSON.parse(r.data).delay);
  expect(delays.slice(0,4)).toEqual([10,20,40,60].map(m=>m*minute));
 }finally{f.close();}
});

test('morning idle regression: twelve completed leaves and 42 review issues wake intake by ten minutes',async()=>{
 const f=setup();try {
  for(let n=1;n<=12;n++){
   const a=admission(),started=now-(12-n)*50000;
   const x=f.e.admit(ticket(n),{...a,now:started,meter:{...a.meter!,observedAt:started}});f.e.finish(x.id,true);
   f.s.event(`publish:${x.id}`,'launcher-publish',{id:x.id},'retain fixture',now-1);
  }
  for(let n=1;n<=42;n++)f.s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run(`example/demo#${n}`,JSON.stringify({number:n,title:'Existing review work',state:'OPEN',labels:[{name:'state:review'}]}),now);
  queueWake(f.s,{id:'routine-ci',kind:'ci-finished',owner:'builder',payload:{}},now);
  supply(f.e,[],now,empty,f.path);complete(f.e);
  supply(f.e,[],now+minute,empty,f.path);complete(f.e);
  supply(f.e,[],now+2*minute,empty,f.path);
  supply(f.e,[],now+10*minute,empty,f.path);
  const r=f.s.get<IntakeRound>('intake-round')!,w=f.s.get<any>(`owner-wake:${r.wake}`);
  expect(r.attempt).toBe(1);expect(r.at).toBe(now+10*minute);
  expect(w.payload).toMatchObject({reviewCount:42,existingCount:42,free:2,ready:0,idleSince:now});
  expect(w.payload.existing).toHaveLength(42);expect(w.payload.brief).toContain('review, challenge or fix-up');
  expect(pendingWakes(f.s)[0].id).toBe(r.wake);
  expect(intakeInstructions(f.e.c,f.dir)).toContain('Review-state work is work to staff');
  // Review/fix-up leaves retain the same evidence and kind gates as repairs.
  await enforceIntakeMode(f.e,'example/demo',{kind:'fix',intakeEvidence:{kind:'issue',number:42}},f.dir,async()=>'{"number":42,"state":"OPEN"}');
  await expect(enforceIntakeMode(f.e,'example/demo',{kind:'feature',intakeEvidence:{kind:'issue',number:42}},f.dir)).rejects.toThrow('repairs only');
  expect(f.e.sessions()).toHaveLength(12);expect(f.e.active()).toHaveLength(0);
 }finally{f.close();}
});

test('a defaulted not-approved decision refuses old effects but cannot terminate intake',()=>{
 const f=setup('build');try {
  supply(f.e,[],now,empty,f.path);complete(f.e);
  supply(f.e,[],now+minute,empty,f.path);complete(f.e);
  supply(f.e,[],now+2*minute,empty,f.path);
  const r=f.s.get<IntakeRound>('intake-round')!;
  expireDecisions(f.s,now+123*minute);
  expect(f.s.get<any>(`autonomy-decision:intake-exhausted:${r.id}`)).toMatchObject({state:'defaulted',outcome:'not approved'});
  f.restart();supply(f.e,[],now+123*minute,empty,f.path);
  expect(f.s.get<IntakeRound>('intake-round')!.id).not.toBe(r.id);
  expect(f.s.rows('sessions')).toHaveLength(0);
 }finally{f.close();}
});

test('refused ready labels do not mask idle; configured deadline and bounded brief survive restart',()=>{
 const f=setup('drain',3);try {
  const ready=Array.from({length:5},(_,n)=>ticket(n+1));
  const observation={claimed:0,refusals:ready.map(t=>({ticket:`${t.repo}#${t.number}`,reason:'source evidence unavailable'}))};
  supply(f.e,ready,now,observation,f.path);complete(f.e);
  supply(f.e,ready,now+minute,observation,f.path);complete(f.e);
  supply(f.e,ready,now+2*minute,observation,f.path);f.restart();
  const before=intakeEvents(f.s).length;
  supply(f.e,ready,now+3*minute-1,observation,f.path);expect(intakeEvents(f.s)).toHaveLength(before);
  supply(f.e,ready,now+3*minute,observation,f.path);expect(intakeEvents(f.s)).toHaveLength(before+1);
  const r=f.s.get<IntakeRound>('intake-round')!,w=f.s.get<any>(`owner-wake:${r.wake}`);
  expect(w.payload.refusals).toHaveLength(5);expect(w.payload.ready).toBe(0);
 }finally{f.close();}
});

for(const state of ['queued','starting','running','unverified-cleanup'])test(`idle deadline never duplicates ${state} owner custody`,()=>{
 const f=setup();try {
  supply(f.e,[],now,empty,f.path);
  const r=f.s.get<IntakeRound>('intake-round')!,w=f.s.get<object>(`owner-wake:${r.wake}`);
  f.s.set(`owner-wake:${r.wake}`,{...w,state:state==='unverified-cleanup'?'done':state,cleanupVerified:false});
  f.s.set('intake-round',{...r,closed:true});
  supply(f.e,[],now+10*minute,empty,f.path);
  expect(intakeEvents(f.s)).toHaveLength(1);expect(f.s.get<IntakeRound>('intake-round')!.wake).toBe(r.wake);
 }finally{f.close();}
});

test('idle alert retries same bridge ID after failure/crash; progress rearms a new episode',()=>{
 const f=setup();try {
  observeSupplyIdle(f.e,0,now,empty,f.path);
  observeSupplyIdle(f.e,0,now+120*minute,empty,join(f.dir,'missing.sqlite'));
  expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(0);
  observeSupplyIdle(f.e,0,now+120*minute,empty,f.path);
  const idle=f.s.get<SupplyIdle>('supply-idle')!;
  f.s.set(`supply-idle-alert:${idle.id}`,null);f.restart();
  observeSupplyIdle(f.e,0,now+180*minute,empty,f.path);
  expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(1);
  observeSupplyIdle(f.e,0,now+181*minute,{claimed:1,refusals:[]},f.path);
  expect(f.s.get('supply-idle')).toBeNull();
  observeSupplyIdle(f.e,0,now+182*minute,empty,f.path);
  observeSupplyIdle(f.e,0,now+302*minute,empty,f.path);
  expect(f.mail.query('SELECT * FROM messages').all()).toHaveLength(2);
  expect(f.mail.query('SELECT recipient,recipient_app FROM messages LIMIT 1').get()).toEqual({recipient:'Vincent',recipient_app:'telegram'});
 }finally{f.close();}
});

test('paused/full capacity or claimable work clear the idle clock; configuration keeps literals',()=>{
 const f=setup();try {
  for(const cause of ['paused','full','claimable']){
   observeSupplyIdle(f.e,0,now,empty,f.path);
   if(cause==='paused')f.e.pause(true,'owner');
   if(cause==='full')for(let n=1;n<=2;n++)f.e.admit(ticket(n),admission());
   observeSupplyIdle(f.e,cause==='claimable'?1:0,now+minute,empty,f.path);
   expect(f.s.get('supply-idle')).toBeNull();f.e.pause(false,'owner');
   for(const x of f.e.active())f.e.finish(x.id,true);
  }
  const autonomy=f.e.c.autonomy!;
  const {idle_wake_minutes,...withoutDefault}=autonomy;
  expect(ConfigSchema.parse({...f.e.c,autonomy:withoutDefault}).autonomy!.idle_wake_minutes).toBe(10);
  for(const value of [0,61,1.5])expect(()=>ConfigSchema.parse({...f.e.c,autonomy:{...autonomy,idle_wake_minutes:value}})).toThrow();
  expect(()=>ConfigSchema.parse({...f.e.c,autonomy:{...autonomy,ready_buffer:4}})).toThrow();
  expect(()=>ConfigSchema.parse({...f.e.c,overrun:{checkpoint_at:2,pause_at:3}})).toThrow();
 }finally{f.close();}
});

for(const existing of ['incident','progress','end-of-tick'])test(`idle alert shares the retained watchdog ${existing} identity`,()=>{
 const f=setup();try {
  observeSupplyIdle(f.e,0,now,empty,f.path);
  const since=now+(existing==='end-of-tick'?25:0),id=`claim-stall:${since}`;
  if(existing==='incident')f.s.set('watchdog-stall',{id,state:'open',since:now});
  else f.s.set('claim-progress',{since,at:since,free:true,claimed:0});
  observeSupplyIdle(f.e,0,now+120*minute,empty,f.path);
  // The older watchdog may write before or after this tick, using the same ID.
  f.mail.query('INSERT OR IGNORE INTO messages(id) VALUES(?)').run(id);
  expect(f.mail.query('SELECT id FROM messages').all()).toEqual([{id}]);
  f.s.set('claim-progress',{since:now+minute,free:true,claimed:0});
  const idle=f.s.get<SupplyIdle>('supply-idle')!;
  f.s.set(`supply-idle-alert:${idle.id}`,null);f.restart();
  observeSupplyIdle(f.e,0,now+121*minute,empty,f.path);
  expect(f.mail.query('SELECT id FROM messages').all()).toEqual([{id}]);
 }finally{f.close();}
});
