import {test,expect,describe} from 'bun:test';
import {Database} from 'bun:sqlite';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {IDLE_RULES,advanceIdleQueue,observeIdleQueue,openIdleState,pausedWithReadyActionId,replayIdleObservations,watchIdleQueue,type IdleQueueObservation} from '../launcher/idle-queue';
import {parseOwnerMessageId} from '../launcher/loop-contract';
import {pendingWakes} from '../launcher/wake';
import {readyForTopUp} from '../scripts/product-top-up';
import {HOUR,MINUTE,idleFixture} from './helpers/idle-queue-fixture';

const fixture=()=>idleFixture();
test('empty queue plus stopped builders at73% sends action once across restart, and actual wake is separate',()=>{const f=fixture();try{
 const a=watchIdleQueue(f.dir,f.mail,f.now);expect(a.alert).toBeTruthy();expect(a).toMatchObject({wake:null});
 expect(f.db.query('SELECT kind,recipient FROM messages').all()).toEqual([{kind:'action',recipient:'Coordinator'}]);
 f.db.query("UPDATE messages SET wake_state='woken',wake_id='actual-test-wake'").run();
 expect(watchIdleQueue(f.dir,f.mail,f.now+1)).toMatchObject({alert:a.alert,wake:'actual-test-wake'});
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 // A maintenance review never masks a builder stall.
 f.s.event('review','factory-challenge-started',{},'retain',f.now);expect(observeIdleQueue(f.s.db,f.c,f.now).lastActivity).toBe(f.now-21*60000);
}finally{f.s.close();f.db.close();}});
test('source errors and incomplete or stale inventories cannot prove an empty queue',()=>{const f=fixture();try{
 const p=Object.values(f.c.projects)[0]!;
 for(const state of [{error:'GitHub rate limit',observedAt:f.now},{observedAt:f.now,count:0,truncated:true,error:null},{observedAt:f.now-300001,count:0,truncated:false,error:null}]){
  f.s.set(`github:${p.repo}`,state);expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 }
}finally{f.s.close();f.db.close();}});
test('missing or malformed queue timestamps including fallback remain unknown',()=>{const f=fixture();try{
 for(const at of [undefined,null,0,-1,'now',f.now+.5]){
  f.s.set('heartbeat',{status:'ok',ready:0,at});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
  f.s.set('heartbeat',{status:'reconciling',at:f.now});f.s.set('last-successful-heartbeat',{status:'ok',ready:0,at});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 }
 f.s.set('heartbeat',{status:'ok',ready:0,at:f.now});
 const p=Object.values(f.c.projects)[0]!;
 for(const observedAt of [undefined,null,0,-1,'now',f.now+.5]){f.s.set(`github:${p.repo}`,{count:0,truncated:false,error:null,observedAt});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);}
}finally{f.s.close();f.db.close();}});
test('an incident retained before bridge failure still wakes after builders resume',()=>{const f=fixture();try{
 expect(()=>watchIdleQueue(f.dir,join(f.dir,'missing-mail.sqlite'),f.now)).toThrow('bridge unavailable');
 f.s.set('heartbeat',{at:f.now+1,status:'ok',ready:3});
 const r=watchIdleQueue(f.dir,f.mail,f.now+1);expect(r.eligible).toBe(false);expect(r.alert).toBeTruthy();
 expect(f.db.query('SELECT kind,recipient FROM messages').all()).toEqual([{kind:'action',recipient:'Coordinator'}]);
 expect(watchIdleQueue(f.dir,f.mail,f.now+2).alert).toBe(r.alert);expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
}finally{f.s.close();f.db.close();}});
test('finished custody still requires positive cleanup and a cleared PID',()=>{const f=fixture();try{
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('finished','example/demo#1','product','codex','finished','{}');
 f.s.set('cleanup-evidence:finished',{verified:false});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('cleanup-evidence:finished',{verified:true});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(true);
 f.s.db.query('UPDATE sessions SET pid=123 WHERE id=?').run('finished');expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
}finally{f.s.close();f.db.close();}});
test('an invalid ready draft is retained without disabling independent supply',()=>{const f=fixture();try{
 const repo=Object.values(f.c.projects)[0]!.repo;
 f.s.db.query('INSERT INTO tickets VALUES(?,?,?,?)').run(repo+'#1',JSON.stringify({number:1,state:'OPEN',title:'Unapproved draft',labels:[{name:'state:ready'}],body:'invalid'}),f.now,'retained');
 expect(readyForTopUp(f.s,f.c,f.now)).toEqual([]);expect(f.s.rows('tickets')).toHaveLength(1);
 expect(f.s.db.query("SELECT id FROM events WHERE kind='top-up-snapshot-refusal'").all()).toHaveLength(1);
 readyForTopUp(f.s,f.c,f.now+1);expect(f.s.db.query("SELECT id FROM events WHERE kind='top-up-snapshot-refusal'").all()).toHaveLength(1);
}finally{f.s.close();f.db.close();}});
test('twenty-minute boundary, fresh queue, pause, usage stop and unknown custody fail closed',()=>{const f=fixture();try{
 f.s.event('boundary','worker-cleanup',{verified:true},'retain',f.now-20*60000);
 expect(watchIdleQueue(f.dir,f.mail,f.now).alert).toBeNull();
 f.s.set('paused',true);expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);f.s.set('paused',false);
 f.s.set('heartbeat',{at:f.now,status:'error',ready:0});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now,status:'ok',ready:1});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now-300001,status:'ok',ready:0});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now,status:'ok',ready:0});f.s.set('readings',{codex:{observedAt:f.now,source:'native fixture',windows:[{used:.90,resetsAt:f.now+86400000},{used:.1,resetsAt:f.now+86400000}]}});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('readings',{codex:{observedAt:f.now,source:'native fixture',windows:[{used:.73,resetsAt:f.now+86400000},{used:.1,resetsAt:f.now+86400000}]}});
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('dormant','example/demo#1','product','codex','waiting-browser','{}');
 expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);f.s.set('cleanup-evidence:dormant',{verified:true});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(true);
}finally{f.s.close();f.db.close();}});

test('unavailable queue evidence alerts once after twenty minutes across reason changes and restart',()=>{const f=fixture();try{
 f.s.set('heartbeat',{at:f.now-300001,status:'ok',ready:0});
 expect(watchIdleQueue(f.dir,f.mail,f.now)).toMatchObject({eligible:false,observationUnavailable:true,alert:null});
 // A newer heartbeat with stale inventory is the same observation failure.
 f.s.set('heartbeat',{at:f.now+20*60000,status:'ok',ready:0});
 expect(watchIdleQueue(f.dir,f.mail,f.now+20*60000).alert).toBeNull();
 const r=watchIdleQueue(f.dir,f.mail,f.now+20*60000+1);
 expect(r.eligible).toBe(false);expect(r.alert).toStartWith('factory-queue-observation:');
 expect(f.db.query('SELECT kind,summary FROM messages').all()).toEqual([{kind:'action',summary:'Factory queue observation has been unavailable for over 20 minutes. Supply and builder activity need checking.'}]);
 expect(watchIdleQueue(f.dir,f.mail,f.now+21*60000).alert).toBe(r.alert);
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 // A positive observation ends the episode; it never fabricates idleness.
 f.s.set('heartbeat',{at:f.now+22*60000,status:'ok',ready:1});
 expect(watchIdleQueue(f.dir,f.mail,f.now+22*60000).observationUnavailable).toBeUndefined();
}finally{f.s.close();f.db.close();}});
test('paused and positively nonempty queues do not accumulate an observation gap',()=>{const f=fixture();try{
 f.s.set('paused',true);expect(watchIdleQueue(f.dir,f.mail,f.now).alert).toBeNull();
 expect(watchIdleQueue(f.dir,f.mail,f.now+30*60000).alert).toBeNull();
 f.s.set('paused',false);f.s.set('heartbeat',{at:f.now+60*60000,status:'ok',ready:2});
 expect(watchIdleQueue(f.dir,f.mail,f.now+60*60000)).toMatchObject({reason:'queue has ready work',alert:null});
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(0);
}finally{f.s.close();f.db.close();}});

for(const fallback of [false,true])test(`stale nonempty heartbeat cannot silence queue observation alarm (fallback=${fallback})`,()=>{const f=fixture();try{
 const key=fallback?'last-successful-heartbeat':'heartbeat';
 if(fallback)f.s.set('heartbeat',{at:f.now,status:'reconciling'});
 f.s.set(key,{at:f.now,status:'ok',ready:2});
 expect(watchIdleQueue(f.dir,f.mail,f.now+300001)).toMatchObject({eligible:false,observationUnavailable:true,alert:null});
 const r=watchIdleQueue(f.dir,f.mail,f.now+1500002);
 expect(r.alert).toStartWith('factory-queue-observation:');
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 for(const at of [undefined,0,f.now+3600001]){f.s.set(key,{at,status:'ok',ready:2});expect(observeIdleQueue(f.s.db,f.c,f.now+3600000).observationUnavailable).toBe(true);}
}finally{f.s.close();f.db.close();}});

// ---------------------------------------------------------------- repeats
// Thursday 12 Nov 2026, 00:30 Eastern: a fixed clock, so one test stays inside one Toronto day.
const THURSDAY=Date.parse('2026-11-12T00:30:00-05:00');
const SETTINGS={timezone:'America/Toronto',gapRuleActs:false};
// Eastern standard time, as "11-11 02:05".
const eastern=(at:number)=>new Date(at-5*HOUR).toISOString().slice(5,16).replace('T',' ');
type Fixture=ReturnType<typeof idleFixture>;
const mailRows=(f:Fixture)=>f.db.query('SELECT id,recipient,recipient_app,kind,summary FROM messages ORDER BY created_at,id').all() as {id:string;recipient:string;recipient_app:string;kind:string;summary:string}[];
const repeatWakes=(f:Fixture)=>(f.s.db.query("SELECT value FROM kv WHERE key GLOB 'owner-wake:intake:idle-repeat:*' ORDER BY json_extract(value,'$.at')").all() as {value:string}[]).map(r=>JSON.parse(r.value) as {id:string;owner:string;kind:string;state:string;payload:Record<string,any>});
const records=(f:Fixture,kind:string):Record<string,any>[]=>f.state<{id:string;json:string}>('SELECT id,json FROM records WHERE kind=? ORDER BY at',kind).map(r=>({id:r.id,...JSON.parse(r.json)}));
// What the launcher does with a dispatched intake wake that finds nothing to propose.
const settle=(f:Fixture,wake:string,at:number)=>{
 f.s.event(`owner-dispatch:${wake}`,'owner-wake-dispatch',{id:wake},'retain',at+MINUTE);
 f.s.set(`owner-wake:${wake}`,{...f.s.get<object>(`owner-wake:${wake}`),state:'done',cleanupVerified:true});
 f.s.event(`owner-complete:${wake}`,'owner-wake-complete',{id:wake,ok:true},'retain',at+2*MINUTE);
 f.s.set(`owner-result:${wake}`,{at:at+2*MINUTE,applied:true,mix:{product:0,other:0}});
};

test('a 16.5-hour empty queue: first alarm, a repeat at about an hour, then two-hourly, one intake wake each and no mail per repeat',()=>{const f=idleFixture(THURSDAY);try{
 const idleSince=f.now-21*MINUTE,repeats:number[]=[];let firstAlarm:number|null=null;
 for(let at=f.now;at<=f.now+16.5*HOUR;at+=5*MINUTE){
  f.tick(at);const r=watchIdleQueue(f.dir,f.mail,at);
  if(r.alert&&firstAlarm===null)firstAlarm=at;
  if(!r.repeat)continue;
  expect(r.repeat.wake).toBe(`intake:idle-repeat:${idleSince}:${repeats.length+1}`);
  repeats.push(at);settle(f,r.repeat.wake!,at);
 }
 expect(firstAlarm).toBe(f.now);
 expect(repeats.map(at=>(at-firstAlarm!)/MINUTE)).toEqual([60,180,300,420,540,660,780,900]);
 expect(repeats.length).toBeLessThanOrEqual(IDLE_RULES.repeatsPerDay);
 // One Coordinator action for the first alarm, one line for Vincent, nothing per repeat.
 expect(mailRows(f)).toEqual([
  {id:`factory-idle-queue:${idleSince}`,recipient:'Coordinator',recipient_app:'claude',kind:'action',summary:'Factory had an empty queue and idle builders for over 20 minutes while usage allowed high-benefit work.'},
  {id:'loop:routine:idle:queue-empty:2026-11-12',recipient:'Vincent',recipient_app:'telegram',kind:'fyi',summary:'Idle 2 h: queue empty, intake returned no tasks.'},
 ]);
 // Each repeat is one wake of the existing intake kind, carrying why the queue is still empty.
 const wakes=repeatWakes(f);
 expect(wakes.map(w=>[w.owner,w.kind,w.payload.round,w.payload.ready])).toEqual(repeats.map((_,n)=>['product','product-intake',`idle-repeat:${idleSince}:${n+1}`,0]));
 expect(wakes.map(w=>w.payload.idleRepeat.lastIntake).slice(0,3)).toEqual(['has not finished a run','returned no tasks','returned no tasks; 2 runs since the queue emptied']);
 expect(wakes[0]!.payload).toMatchObject({intake_mode:'build',projects:f.c.projects,idleSince,idleRepeat:{step:1,firstAlarmAt:firstAlarm,context:null}});
 expect(f.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='owner-wake-queued'").get()).toEqual({n:8});
 // The record shows what became of each wake: dispatched, applied, and the ready count afterwards.
 const done=records(f,'repeat');
 expect(done).toHaveLength(8);
 for(const r of done)expect(r).toMatchObject({wakeState:'done',result:{applied:true,mix:{product:0,other:0}},readyAfter:0});
 expect(done.every(r=>r.dispatchedAt-r.firstAlarmAt>0&&Number.isSafeInteger(r.settled))).toBe(true);
}finally{f.close();}});

// An ordinary intake wake as the supply loop leaves it, in the state given.
const ordinaryIntake=(f:Fixture,at:number,state:string,id='intake:r1:1')=>{
 f.s.set('intake-round',{id:id.split(':')[1],at,attempt:1,wake:id});
 f.s.set(`owner-wake:${id}`,{id,owner:'product',kind:'product-intake',payload:{round:id.split(':')[1],ready:2,target:9,brief:'Product tasks only.',existing:[{id:'example/demo#7'}],occupied:[{id:'x'}]},state,at,...(state==='done'?{cleanupVerified:true}:{})});
};
test('a repeat wake reuses the newest ordinary intake view only when that intake finished under two hours ago and nothing was proposed from it',()=>{
 const cases:{age:number;after?:(f:Fixture)=>void;reused:boolean}[]=[
  {age:30*MINUTE,after:f=>f.s.set('owner-result:intake:r1:1',{at:f.now,applied:true,mix:{product:0,other:0}}),reused:true},
  {age:3*HOUR,after:f=>f.s.set('owner-result:intake:r1:1',{at:f.now,applied:true}),reused:false},
  // Its result has not been applied yet: what it proposed is not known.
  {age:30*MINUTE,reused:false},
  // It proposed a task. The view was built before that task existed and would not show it.
  {age:30*MINUTE,after:f=>{f.s.set('owner-result:intake:r1:1',{at:f.now,applied:true,mix:{product:1,other:0}});f.s.set('proposal:intake:r1:1:0',12);},reused:false},
 ];
 for(const {age,after,reused} of cases){const f=idleFixture(THURSDAY);try{
  const at=f.now+HOUR;
  ordinaryIntake(f,at-age,'done');after?.(f);
  watchIdleQueue(f.dir,f.mail,f.now);f.tick(at);
  expect(watchIdleQueue(f.dir,f.mail,at).repeat).toMatchObject({step:1,wake:`intake:idle-repeat:${f.now-21*MINUTE}:1`});
  const payload=repeatWakes(f)[0]!.payload;
  expect(payload).toMatchObject({round:`idle-repeat:${f.now-21*MINUTE}:1`,ready:0,occupied:[]});
  if(reused){
   expect(payload).toMatchObject({target:9,brief:'Product tasks only.',existing:[{id:'example/demo#7'}],idleRepeat:{context:{from:'intake:r1:1',at:at-age}}});
   expect(payload.idleRepeat.note).not.toContain('No view of the backlog');
  }else{
   expect(payload.existing).toBeUndefined();expect(payload.idleRepeat.context).toBeNull();
   expect(payload.idleRepeat.note).toContain('No view of the backlog is attached: read the current open issues first');
  }
 }finally{f.close();}}
});

// One intake at a time. On the recorded night the first repeat fell due while an ordinary intake
// was running; queuing beside it would have run two intakes back to back on one view of the backlog.
for(const state of ['queued','starting','running'])test(`a repeat is not queued beside an ordinary intake that is ${state}; it is asked again and queued once that intake has finished`,()=>{const f=idleFixture(THURSDAY);try{
 const due=f.now+HOUR;
 watchIdleQueue(f.dir,f.mail,f.now);
 ordinaryIntake(f,due-MINUTE,state);
 for(const at of [due,due+5*MINUTE]){
  f.tick(at);
  expect(watchIdleQueue(f.dir,f.mail,at)).toMatchObject({eligible:true,repeat:null,repeatWaiting:`intake wake intake:r1:1 is still ${state}`});
 }
 expect(repeatWakes(f)).toEqual([]);expect(records(f,'repeat')).toEqual([]);
 expect(f.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='owner-wake-queued'").get()).toEqual({n:0});
 // The ordinary intake finishes with nothing proposed: the repeat is queued at the next run.
 ordinaryIntake(f,due-MINUTE,'done');f.s.set('owner-result:intake:r1:1',{at:due+6*MINUTE,applied:true,mix:{product:0,other:0}});
 f.tick(due+10*MINUTE);
 const r=watchIdleQueue(f.dir,f.mail,due+10*MINUTE);
 expect(r.repeat).toMatchObject({step:1,wake:`intake:idle-repeat:${f.now-21*MINUTE}:1`});expect(r).not.toHaveProperty('repeatWaiting');
 expect(repeatWakes(f).map(w=>w.state)).toEqual(['queued']);
}finally{f.close();}});

test('an intake that stays in flight for 30 minutes past a due repeat: the step is recorded with the reason and no wake',()=>{const f=idleFixture(THURSDAY);try{
 const due=f.now+HOUR,recorded:number[]=[];
 watchIdleQueue(f.dir,f.mail,f.now);ordinaryIntake(f,due-MINUTE,'running');
 for(let at=due;at<=due+45*MINUTE;at+=5*MINUTE){f.tick(at);if(watchIdleQueue(f.dir,f.mail,at).repeat)recorded.push((at-due)/MINUTE);}
 expect(recorded).toEqual([30]);
 expect(records(f,'repeat')).toMatchObject([{step:1,wake:null,note:'intake wake intake:r1:1 is still running'}]);
 expect(repeatWakes(f)).toEqual([]);
}finally{f.close();}});

test('a repeat wake that is not dispatched within 30 minutes is withdrawn, and the next repeat queues a new one',()=>{const f=idleFixture(THURSDAY);try{
 const idleSince=f.now-21*MINUTE,wake=(step:number)=>`intake:idle-repeat:${idleSince}:${step}`,queued:number[]=[],withdrawn:[number,string[]][]=[];
 for(let at=f.now;at<=f.now+3*HOUR;at+=5*MINUTE){
  f.tick(at);const r=watchIdleQueue(f.dir,f.mail,at);
  if(r.repeat?.wake)queued.push((at-f.now)/MINUTE);
  if(r.withdrawn.length)withdrawn.push([(at-f.now)/MINUTE,r.withdrawn]);
 }
 expect(queued).toEqual([60,180]);expect(withdrawn).toEqual([[90,[wake(1)]]]);
 expect(repeatWakes(f).map(w=>[w.id,w.state])).toEqual([[wake(1),'expired'],[wake(2),'queued']]);
 // Only the second is left for the tick to dispatch; the first is on record as withdrawn, with why.
 expect(pendingWakes(f.s).map(w=>w.id)).toEqual([wake(2)]);
 expect(records(f,'repeat')).toMatchObject([{wake:wake(1),wakeState:'expired',withdrawn:'not dispatched within 30 minutes',settled:f.now+90*MINUTE,dispatchedAt:null},{wake:wake(2),previousWake:wake(1)}]);
 expect(f.s.db.query("SELECT id,json_extract(data,'$.why') AS why FROM events WHERE kind='idle-repeat-wake-withdrawn'").all()).toEqual([{id:`idle-repeat-withdrawn:${wake(1)}`,why:'not dispatched within 30 minutes'}]);
}finally{f.close();}});

// The wake says "the queue has been empty". It may start only while that is still what a run finds.
describe('a repeat wake that has not started is withdrawn when the idle it was queued for ends',()=>{
 const stopped=(at:number)=>[{used:.93,resetsAt:at+86400000},{used:.4,resetsAt:at+3*86400000}];
 const queuedRepeat=()=>{const f=idleFixture(THURSDAY),at=f.now+HOUR;watchIdleQueue(f.dir,f.mail,f.now);f.tick(at);const wake=watchIdleQueue(f.dir,f.mail,at).repeat!.wake!;expect(pendingWakes(f.s).map(w=>w.id)).toEqual([wake]);return {f,at,wake};};
 test('paused for four hours and resumed with ready work: nothing is left for the tick to dispatch',()=>{const {f,at,wake}=queuedRepeat();try{
  f.s.set('paused',true);f.s.event('pause-1','pause',{},'Set pause to false',at+2*MINUTE);
  f.tick(at+5*MINUTE,{ready:0,claimed:0,paused:true});
  expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE)).toMatchObject({reason:'paused',withdrawn:[wake],repeat:null});
  for(let t=at+10*MINUTE;t<=at+4*HOUR;t+=5*MINUTE){f.tick(t,{ready:0,claimed:0,paused:true});expect(watchIdleQueue(f.dir,f.mail,t).withdrawn).toEqual([]);}
  f.s.set('paused',false);f.s.event('resume-1','resume',{},'Set pause to true',at+4*HOUR+MINUTE);
  expect(pendingWakes(f.s)).toEqual([]);
  f.tick(at+4*HOUR+5*MINUTE,{ready:5,claimed:0});watchIdleQueue(f.dir,f.mail,at+4*HOUR+5*MINUTE);
  expect(pendingWakes(f.s)).toEqual([]);expect(repeatWakes(f).map(w=>w.state)).toEqual(['expired']);
  expect(records(f,'repeat')).toMatchObject([{wake,wakeState:'expired',withdrawn:'the idle it was queued for no longer holds: paused',settled:at+5*MINUTE}]);
 }finally{f.close();}});
 test('a usage stop that begins before the wake is dispatched',()=>{const {f,at,wake}=queuedRepeat();try{
  f.tick(at+5*MINUTE,{ready:0,claimed:0},stopped(at));
  expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE)).toMatchObject({reason:'usage does not allow work',withdrawn:[wake]});
  expect(pendingWakes(f.s)).toEqual([]);
  expect(records(f,'repeat')).toMatchObject([{withdrawn:'the idle it was queued for no longer holds: usage does not allow work'}]);
 }finally{f.close();}});
 test('ready work, a builder that ran in between, or queue evidence that can no longer be read',()=>{
  for(const [change,reason] of [
   [(f:Fixture,t:number)=>f.tick(t,{ready:5,claimed:0}),'queue has ready work'],
   [(f:Fixture,t:number)=>{f.tick(t);f.s.event('later-builder','worker-cleanup',{verified:true},'retain',t-MINUTE);},'a builder has run since'],
   [(f:Fixture,t:number)=>f.s.set('heartbeat',{at:t-6*MINUTE,status:'ok',ready:0}),'queue not freshly confirmed empty'],
  ] as const){const {f,at,wake}=queuedRepeat();try{
   change(f,at+5*MINUTE);
   expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE).withdrawn).toEqual([wake]);
   expect(records(f,'repeat')).toMatchObject([{withdrawn:`the idle it was queued for no longer holds: ${reason}`}]);
  }finally{f.close();}}
 });
 test('an ordinary intake queued beside it: the repeat gives way',()=>{const {f,at,wake}=queuedRepeat();try{
  ordinaryIntake(f,at+2*MINUTE,'queued','intake:r2:1');f.tick(at+5*MINUTE);
  expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE).withdrawn).toEqual([wake]);
  expect(pendingWakes(f.s).map(w=>w.id)).toEqual(['intake:r2:1']);
  expect(records(f,'repeat')).toMatchObject([{withdrawn:'ordinary intake wake intake:r2:1 is in flight'}]);
 }finally{f.close();}});
 test('a wake the tick has already claimed is left alone',()=>{const {f,at,wake}=queuedRepeat();try{
  f.s.set(`owner-wake:${wake}`,{...f.s.get<object>(`owner-wake:${wake}`),state:'starting'});f.s.set('paused',true);
  f.tick(at+5*MINUTE,{ready:0,claimed:0,paused:true});
  expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE).withdrawn).toEqual([]);
  expect(repeatWakes(f).map(w=>w.state)).toEqual(['starting']);
  expect(f.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='idle-repeat-wake-withdrawn'").get()).toEqual({n:0});
 }finally{f.close();}});
});

test('repeats stop at twelve in any 24 hours across episodes, and a failed queue attempt is asked again',()=>{const state=openIdleState(':memory:');try{
 const empty=(at:number,lastActivity:number):IdleQueueObservation=>({at,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity,heartbeatAt:at,ready:0});
 const queued:number[]=[],queue=(at:number)=>()=>{queued.push(at);return {wake:`wake-${at}`};};
 // Thirteen short episodes in one day: each is alarmed, then repeats an hour later.
 const starts=Array.from({length:13},(_,n)=>THURSDAY+n*90*MINUTE);
 for(const start of starts){
  expect(advanceIdleQueue(state,empty(start+21*MINUTE,start),SETTINGS,queue(start)).repeat).toBeNull();
  if(start===starts[0]){
   // The controller was busy: nothing is recorded, so the next run asks again.
   const busy=advanceIdleQueue(state,empty(start+81*MINUTE,start),SETTINGS,()=>{throw Error('database is locked');});
   expect(busy).toMatchObject({repeat:null,repeatError:'Error: database is locked'});
  }
  const step=advanceIdleQueue(state,empty(start+82*MINUTE,start),SETTINGS,queue(start));
  expect(step.repeat?.step??null).toBe(start===starts[12]?null:1);
 }
 expect(queued).toEqual(starts.slice(0,12));
 // A day after the first repeat, the thirteenth episode may repeat.
 expect(advanceIdleQueue(state,empty(starts[0]!+82*MINUTE+24*HOUR,starts[12]!),SETTINGS,queue(0)).repeat).toMatchObject({step:1,episode:`factory-idle-queue:${starts[12]}`});
}finally{state.close();}});

// ------------------------------------------------- idle explained by a limit
test('idle under a usage stop for three hours: no repeat, no wake, one idle-by-limit record and one line naming the stop and its reset',()=>{const f=idleFixture(THURSDAY);try{
 const reset=Date.parse('2026-11-13T03:00:00-05:00'),stopped=[{used:.93,resetsAt:reset},{used:.4,resetsAt:reset+3*86400000}];
 const events=()=>f.s.db.query('SELECT COUNT(*) AS n FROM events').get();
 const before=events();
 for(let at=f.now;at<=f.now+3*HOUR;at+=5*MINUTE){
  f.tick(at,{ready:0,claimed:0},stopped);
  expect(watchIdleQueue(f.dir,f.mail,at)).toMatchObject({eligible:false,reason:'usage does not allow work',alert:null,repeat:null,idleByLimit:`idle-by-limit:usage-stop:${reset}`});
 }
 expect(records(f,'repeat')).toEqual([]);
 expect(records(f,'idle-by-limit')).toEqual([{id:`idle-by-limit:usage-stop:${reset}`,status:'idle by limit',limit:'usage-stop',what:'usage stop',since:null,until:reset,setBy:null,detail:null,ready:0,idleSince:f.now-21*MINUTE,effect:'no repeat alarm and no intake wake while this limit explains the idle'}]);
 expect(mailRows(f)).toEqual([{id:'loop:routine:idle:usage-stop:2026-11-12',recipient:'Vincent',recipient_app:'telegram',kind:'fyi',summary:'Idle 2 h: usage stop until Friday 03:00.'}]);
 expect(parseOwnerMessageId(mailRows(f)[0]!.id)).toMatchObject({tier:'routine',kind:'idle',subject:'usage-stop'});
 // The watcher wrote nothing to the controller: no wake, no event, the usage reading untouched.
 expect(f.s.db.query("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'owner-wake:%'").get()).toEqual({n:0});
 expect(events()).toEqual(before);
 // A stale or unknown usage reading is missing evidence, not a limit.
 const later=f.now+4*HOUR;f.tick(later,{ready:0,claimed:0},stopped);
 f.s.set('readings',{codex:{observedAt:later-16*MINUTE,source:'native fixture',windows:stopped}});
 const stale=observeIdleQueue(f.s.db,f.c,later);
 expect(stale).toMatchObject({eligible:false,reason:'usage does not allow work'});expect(stale.limit).toBeUndefined();
}finally{f.close();}});

test('paused with ready work and nothing running: one question to Platform at thirty minutes, no wake, and the pause untouched',()=>{const f=idleFixture(THURSDAY);try{
 const paused=f.now;
 f.s.set('paused',true);f.s.event('pause-1','pause',{owner:'Release',ownerSupplied:true,actor:'owner-control'},'Set pause to false',paused);
 // A second pause call must not move the start of the pause.
 f.s.event('pause-2','pause',{owner:'Coordinator',ownerSupplied:false,actor:'owner-control'},'Set pause to false',paused+10*MINUTE);
 const controller=()=>JSON.stringify([f.s.db.query('SELECT COUNT(*) AS n FROM events').get(),f.s.db.query("SELECT key,value FROM kv WHERE key NOT IN ('heartbeat','readings') AND key NOT LIKE 'github:%' ORDER BY key").all()]);
 const before=controller(),asked:number[]=[];
 for(let at=paused+5*MINUTE;at<=paused+125*MINUTE;at+=5*MINUTE){
  f.tick(at,{ready:31,claimed:0,paused:true,refusals:[{ticket:'example/demo#1',reason:'Error: factory paused'}]});
  const r=watchIdleQueue(f.dir,f.mail,at);
  expect(r).toMatchObject({eligible:false,reason:'paused',alert:null,repeat:null,ready:31,limit:{kind:'paused',since:paused,setBy:'Release'}});
  if(r.notices.includes(pausedWithReadyActionId(paused)))asked.push((at-paused)/MINUTE);
 }
 expect(asked).toEqual([30]);
 const rows=f.db.query('SELECT id,recipient,recipient_app,kind,summary,body FROM messages ORDER BY created_at').all() as Record<string,string>[];
 expect(rows.map(r=>[r.id,r.recipient,r.recipient_app,r.kind,r.summary])).toEqual([
  [`loop:action:platform:paused-with-ready:${paused}`,'Platform','codex','action','Factory paused since 00:30 with 31 ready and nothing running. Is this pause still intended?'],
  ['loop:routine:idle:paused:2026-11-12','Vincent','telegram','fyi','Idle 2 h: paused since 00:30 with 31 ready.'],
 ]);
 expect(rows[0]!.body).toContain('by Release');expect(rows[0]!.body).toContain('It does not resume the factory or change any limit');
 expect(records(f,'idle-by-limit')).toMatchObject([{status:'idle by limit',limit:'paused',since:paused,setBy:'Release',ready:31}]);
 // Nothing was resumed, queued or recorded in the controller by the watcher.
 expect(controller()).toBe(before);expect(f.s.get('paused')).toBe(true);expect(repeatWakes(f)).toEqual([]);
}finally{f.close();}});

test('a limit that lasts for days is named to Vincent once every 24 hours, at the hour of its first line and never at midnight',()=>{const state=openIdleState(':memory:');try{
 const evening=Date.parse('2026-11-12T20:00:00-05:00'),reset=Date.parse('2026-11-16T03:00:00-05:00'),lines:string[]=[];
 for(let at=evening;at<=evening+50*HOUR;at+=30*MINUTE)for(const id of advanceIdleQueue(state,{at,eligible:false,reason:'usage does not allow work',lastActivity:at,heartbeatAt:at,ready:0,limit:{kind:'usage-stop',until:reset},idleSince:evening-HOUR},SETTINGS).notices)lines.push(`${eastern(at)} ${id}`);
 expect(lines).toEqual(['11-12 21:00 loop:routine:idle:usage-stop:2026-11-12','11-13 21:00 loop:routine:idle:usage-stop:2026-11-13','11-14 21:00 loop:routine:idle:usage-stop:2026-11-14']);
 expect((state.query('SELECT summary FROM notices ORDER BY at').all() as {summary:string}[]).map(r=>r.summary)).toEqual(['Idle 2 h: usage stop until Monday 03:00.','Idle 26 h: usage stop until Monday 03:00.','Idle 50 h: usage stop until Monday 03:00.']);
 expect(state.query("SELECT COUNT(*) AS n FROM records WHERE kind='idle-by-limit'").get()).toEqual({n:1});
}finally{state.close();}});

test('a pause is not an idle while a builder runs, asks nothing with no ready work, and names nobody when the caller was not recorded',()=>{const f=idleFixture(THURSDAY);try{
 f.s.set('paused',true);f.s.event('pause-1','pause',{},'Set pause to false',f.now);
 const at=f.now+45*MINUTE;f.tick(at,{ready:4,claimed:0,paused:true});
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('busy','example/demo#1','product','codex','running','{}');
 expect(observeIdleQueue(f.s.db,f.c,at)).toMatchObject({reason:'paused',ready:4});expect(observeIdleQueue(f.s.db,f.c,at).limit).toBeUndefined();
 f.s.db.query("UPDATE sessions SET status='finished' WHERE id='busy'").run();f.s.set('cleanup-evidence:busy',{verified:true});
 expect(observeIdleQueue(f.s.db,f.c,at).limit).toEqual({kind:'paused',since:f.now});
 f.tick(at,{ready:0,claimed:0,paused:true});
 const r=watchIdleQueue(f.dir,f.mail,at);
 expect(r.notices).toEqual([]);expect(r.idleByLimit).toBe(`idle-by-limit:paused:${f.now}`);
 expect(records(f,'idle-by-limit')).toMatchObject([{setBy:'not recorded',ready:0}]);expect(mailRows(f)).toEqual([]);
}finally{f.close();}});

// "Nothing running" is decided on the same proof as the empty-queue alarm: every builder at rest,
// no process, cleanup verified. A status alone is not that proof.
test('the pause question and the idle-by-limit record need every builder positively stopped, not only none marked running',()=>{const f=idleFixture(THURSDAY);try{
 const paused=f.now,at=paused+45*MINUTE;
 f.s.set('paused',true);f.s.event('pause-1','pause',{owner:'Release',ownerSupplied:true},'Set pause to false',paused);
 f.tick(at,{ready:31,claimed:0,paused:true});
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('builder','example/demo#1','product','codex','unknown','{}');
 const builder=(status:string,pid:number|null)=>{f.s.db.query('UPDATE sessions SET status=?,pid=? WHERE id=?').run(status,pid,'builder');return observeIdleQueue(f.s.db,f.c,at);};
 // A live process, or a slot about to start, whatever the status says: this is not an idle at all.
 for(const [status,pid] of [['unknown',4242],['paused',4242],['finished',4242],['reserved',null],['starting',null],['running',null]] as const){
  const o=builder(status,pid);
  expect(o).toMatchObject({reason:'paused',ready:31});expect(o.limit).toBeUndefined();expect(o.idleSince).toBeUndefined();expect(o.otherCause).toBeUndefined();
 }
 // No process, but nothing proves the builder stopped: timed, and said to be unconfirmed. Nobody is told "nothing running".
 for(const status of ['unknown','finished']){
  const o=builder(status,null);
  expect(o.limit).toBeUndefined();expect(o).toMatchObject({idleSince:paused-21*MINUTE,otherCause:'paused with 31 ready; builder custody not confirmed'});
 }
 const unproven=watchIdleQueue(f.dir,f.mail,at);
 expect(unproven.notices).toEqual([]);expect(unproven.idleByLimit).toBeNull();expect(mailRows(f)).toEqual([]);
 // Cleanup verified: now the pause explains the idle, and Platform is asked.
 f.s.set('cleanup-evidence:builder',{verified:true});f.tick(at+5*MINUTE,{ready:31,claimed:0,paused:true});
 expect(watchIdleQueue(f.dir,f.mail,at+5*MINUTE)).toMatchObject({limit:{kind:'paused',since:paused,setBy:'Release'},notices:[pausedWithReadyActionId(paused)]});
}finally{f.close();}});

// ------------------------------------------------- idle with no limit behind it
test('ready work that nothing claims for a reason that is not a limit is still timed: one line for Vincent, no repeat, no wake, no limit record',()=>{const f=idleFixture(THURSDAY);try{
 const lines:number[]=[],refusals=[1,2,3].map(n=>({ticket:`example/demo#${n}`,reason:'Error: repository workspace not configured'}));
 for(let at=f.now;at<=f.now+6*HOUR;at+=5*MINUTE){
  f.tick(at,{ready:3,claimed:0,refusals});
  const r=watchIdleQueue(f.dir,f.mail,at);
  expect(r).toMatchObject({eligible:false,reason:'queue has ready work',repeat:null,idleByLimit:null,idleSince:f.now-21*MINUTE,otherCause:'3 ready and none claimed: repository workspace not configured'});
  if(r.notices.length)lines.push((at-f.now)/MINUTE);
 }
 // Two hours after the last builder activity, plus the half hour an unexplained idle waits for a cause.
 expect(lines).toEqual([130]);
 expect(mailRows(f)).toEqual([{id:'loop:routine:idle:not-explained:2026-11-12',recipient:'Vincent',recipient_app:'telegram',kind:'fyi',summary:'Idle 2 h: 3 ready and none claimed: repository workspace not configured.'}]);
 expect(repeatWakes(f)).toEqual([]);expect(records(f,'repeat')).toEqual([]);expect(records(f,'idle-by-limit')).toEqual([]);
}finally{f.close();}});

test('an idle is timed through unreadable queue evidence, unknown usage and mixed refusals, and never while a builder may be running',()=>{const f=idleFixture(THURSDAY);try{
 const at=f.now+3*HOUR,since=f.now-21*MINUTE;
 // The tick stopped writing a fresh heartbeat three hours ago.
 f.s.set('heartbeat',{at:at-6*MINUTE,status:'ok',ready:0});
 expect(observeIdleQueue(f.s.db,f.c,at)).toMatchObject({observationUnavailable:true,reason:'queue not freshly confirmed empty',idleSince:since,otherCause:'queue reading unavailable'});
 f.tick(at);f.s.set(`github:${Object.values(f.c.projects)[0]!.repo}`,{observedAt:at,count:0,truncated:true,error:null});
 expect(observeIdleQueue(f.s.db,f.c,at)).toMatchObject({observationUnavailable:true,idleSince:since,otherCause:'issue inventory unavailable'});
 f.tick(at);f.s.set('readings',{codex:{observedAt:at-16*MINUTE,source:'native fixture',windows:[{used:.5,resetsAt:at+86400000},{used:.5,resetsAt:at+86400000}]}});
 expect(observeIdleQueue(f.s.db,f.c,at)).toMatchObject({reason:'usage does not allow work',idleSince:since,otherCause:'queue empty, usage reading stale or unknown'});
 f.tick(at,{ready:3,claimed:0,refusals:[{reason:'Error: slots full'},{reason:'Error: slots full'},{reason:'Error: worker unqualified'}]});
 expect(observeIdleQueue(f.s.db,f.c,at)).toMatchObject({idleSince:since,otherCause:'3 ready and none claimed: slots full and 1 other reason'});
 // The watcher writes the line with the cause as far as it is known.
 f.s.set('heartbeat',{at:at-6*MINUTE,status:'ok',ready:0});
 expect(watchIdleQueue(f.dir,f.mail,at).notices).toEqual(['loop:routine:idle:not-explained:2026-11-12']);
 expect(mailRows(f).filter(r=>r.recipient==='Vincent').map(r=>r.summary)).toEqual(['Idle 3 h: queue reading unavailable.']);
 // A builder that may be running: the same unreadable evidence is not an idle.
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('busy','example/demo#1','product','codex','running','{}');
 const busy=observeIdleQueue(f.s.db,f.c,at);
 expect(busy.observationUnavailable).toBe(true);expect(busy.idleSince).toBeUndefined();expect(busy.otherCause).toBeUndefined();
}finally{f.close();}});

// ------------------------------------------------- Vincent's line is bounded here
describe("Vincent's idle line is bounded by the watcher itself",()=>{
 const base=(at:number)=>({at,eligible:false,reason:'fixture',lastActivity:at,heartbeatAt:at});
 const lineIds=(state:Database)=>(state.query("SELECT id FROM notices WHERE recipient='Vincent' ORDER BY at").all() as {id:string}[]).map(n=>n.id.split(':')[3]);
 const held=(state:Database)=>(state.query("SELECT json FROM records WHERE kind='idle-line-held' ORDER BY at").all() as {json:string}[]).map(r=>JSON.parse(r.json) as {line:string;because:string});
 test('seven causes in one day are two lines, and the other five are on record as held',()=>{const state=openIdleState(':memory:');try{
  const day=Date.parse('2026-11-12T01:00:00-05:00'),kinds=['paused','usage-stop','disk-refused','worker-unqualified','usage-window-missing','wallet-stop'] as const;
  const steps=kinds.map((kind,n)=>advanceIdleQueue(state,{...base(day+n*3*HOUR),ready:2,limit:{kind,since:day-3*HOUR},idleSince:day-3*HOUR},SETTINGS));
  steps.push(advanceIdleQueue(state,{at:day+18*HOUR,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity:day-3*HOUR,heartbeatAt:day+18*HOUR,ready:0},SETTINGS));
  expect(lineIds(state)).toEqual(['paused','usage-stop']);
  expect(steps.map(s=>s.lineHeld)).toEqual([null,null,...Array(5).fill('2 idle lines were written in the last 24 hours')]);
  expect(held(state).map(h=>h.line)).toEqual(['Idle 9 h: disk admission refused, 2 ready.','Idle 12 h: worker unqualified, 2 ready.','Idle 15 h: usage window missing, 2 ready.','Idle 18 h: wallet stop, 2 ready.','Idle 21 h: queue empty.']);
  // A day after the first line there is room again.
  expect(advanceIdleQueue(state,{...base(day+24*HOUR+MINUTE),ready:2,limit:{kind:'disk-refused',since:day-3*HOUR},idleSince:day-3*HOUR},SETTINGS).notices).toEqual(['loop:routine:idle:disk-refused:2026-11-13']);
 }finally{state.close();}});
 test('an idle with no established cause waits half an hour for one, and is never a second line',()=>{const state=openIdleState(':memory:');try{
  const since=THURSDAY,unknown=(at:number):IdleQueueObservation=>({...base(at),observationUnavailable:true,idleSince:since,otherCause:'queue reading unavailable'});
  const empty=(at:number):IdleQueueObservation=>({at,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity:since,heartbeatAt:at,ready:0,intake:'returned no tasks'});
  // Unreadable at the two-hour mark, readable five minutes later: the line names the cause.
  expect(advanceIdleQueue(state,unknown(since+2*HOUR),SETTINGS)).toMatchObject({notices:[],lineHeld:null});
  expect(advanceIdleQueue(state,empty(since+2*HOUR+5*MINUTE),SETTINGS).notices).toEqual(['loop:routine:idle:queue-empty:2026-11-12']);
  // Unreadable again later: no second line for the same idle.
  expect(advanceIdleQueue(state,unknown(since+3*HOUR),SETTINGS)).toMatchObject({notices:[],lineHeld:'an idle line was written in the last 24 hours and no new cause is established'});
  expect(lineIds(state)).toEqual(['queue-empty']);expect(held(state)).toEqual([{line:'Idle 3 h: queue reading unavailable.',because:'an idle line was written in the last 24 hours and no new cause is established'}]);
 }finally{state.close();}});
 test("when the launcher's own two-hour line already went to Vincent for this idle, the watcher adds no second one until a day later",()=>{const f=idleFixture(THURSDAY);try{
  const vincent=()=>mailRows(f).filter(r=>r.recipient==='Vincent').map(r=>r.summary);
  // What launcher/supply-idle.ts records when it queues "nothing claimable for 2 hours".
  const told=f.now+95*MINUTE;f.s.event('supply-idle-alert:episode','supply-idle-alert',{id:'episode',since:told-2*HOUR},'retain',told);
  for(let at=f.now;at<=f.now+3*HOUR;at+=5*MINUTE){
   f.tick(at);const r=watchIdleQueue(f.dir,f.mail,at);
   if(at-f.now>=100*MINUTE)expect(r).toMatchObject({launcherLineAt:told,lineHeld:`the launcher's own two-hour line was queued at ${new Date(told).toISOString()}`,notices:[]});
  }
  expect(vincent()).toEqual([]);
  expect(records(f,'idle-line-held')).toEqual([{id:'idle-line-held:loop:routine:idle:queue-empty:2026-11-12',line:'Idle 2 h: queue empty, intake has not finished a run.',because:`the launcher's own two-hour line was queued at ${new Date(told).toISOString()}`}]);
  // A limit is a different cause and is still named.
  const reset=Date.parse('2026-11-13T03:00:00-05:00');f.tick(f.now+3*HOUR+5*MINUTE,{ready:0,claimed:0},[{used:.93,resetsAt:reset},{used:.4,resetsAt:reset}]);
  expect(watchIdleQueue(f.dir,f.mail,f.now+3*HOUR+5*MINUTE).notices).toEqual(['loop:routine:idle:usage-stop:2026-11-12']);
  // A day after the launcher's line the idle is named again, by the watcher.
  const later=told+24*HOUR+5*MINUTE;f.tick(later);
  expect(watchIdleQueue(f.dir,f.mail,later).notices).toEqual(['loop:routine:idle:queue-empty:2026-11-13']);
  expect(vincent()).toEqual(['Idle 3 h: usage stop until Friday 03:00.','Idle 26 h: queue empty, intake has not finished a run.']);
 }finally{f.close();}});
});

test('ready work that no builder took is idle by limit only when every refusal was a limit',()=>{const f=idleFixture(THURSDAY);try{
 const refused=(...reasons:string[])=>{f.tick(f.now,{ready:reasons.length,claimed:0,refusals:reasons.map((reason,n)=>({ticket:`example/demo#${n}`,reason}))});return observeIdleQueue(f.s.db,f.c,f.now);};
 expect(refused('Error: worker unqualified','Error: worker unqualified')).toMatchObject({reason:'queue has ready work',ready:2,limit:{kind:'worker-unqualified'},idleSince:f.now-21*MINUTE});
 expect(refused('Error: disk admission refused: less than 30 GiB free or capacity unknown').limit).toEqual({kind:'disk-refused'});
 expect(refused('Error: usage window missing').limit).toEqual({kind:'usage-window-missing'});
 expect(refused('Error: wallet empty').limit).toEqual({kind:'wallet-stop'});
 expect(refused('Error: high benefit only').limit).toEqual({kind:'usage-stop',until:f.now+86400000,detail:'high-benefit work only'});
 // A defect among the refusals, a claim, or a running builder means this is not a limit's idle.
 expect(refused('Error: worker unqualified','Error: repository workspace not configured').limit).toBeUndefined();
 expect(refused('Error: slots full').limit).toBeUndefined();
 f.tick(f.now,{ready:1,claimed:1,refusals:[{ticket:'example/demo#1',reason:'Error: worker unqualified'}]});expect(observeIdleQueue(f.s.db,f.c,f.now).limit).toBeUndefined();
 const text=advanceIdleQueue(openIdleState(':memory:'),{...refused('Error: worker unqualified'),idleSince:f.now-3*HOUR},SETTINGS);
 expect(text.limit).toBe(`idle-by-limit:worker-unqualified:${f.now-3*HOUR}`);expect(text.notices).toEqual(['loop:routine:idle:worker-unqualified:2026-11-12']);
}finally{f.close();}});

test('an empty-queue observation says how the last intake ended',()=>{const f=idleFixture(THURSDAY);try{
 const intake=()=>observeIdleQueue(f.s.db,f.c,f.now).intake;
 expect(intake()).toBe('has not finished a run');
 f.s.event('owner-complete:intake:a:1','owner-wake-complete',{id:'intake:a:1',ok:false},'retain',f.now-10*MINUTE);
 expect(intake()).toBe('did not finish its last run');
 f.s.event('owner-complete:intake:b:1','owner-wake-complete',{id:'intake:b:1',ok:true},'retain',f.now-8*MINUTE);
 expect(intake()).toBe('has a result the launcher has not applied yet');
 f.s.set('owner-result:intake:b:1',{at:f.now,applied:false});f.s.event('owner-result-refused:intake:b:1:x','owner-result-refused',{id:'intake:b:1',error:'Error: refill product/other mix must match product-only tickets'},'retain',f.now-7*MINUTE);
 expect(intake()).toBe('had its last result refused by the launcher: Error: refill product/other mix must match product-only tickets');
 f.s.set('owner-result:intake:b:1',{at:f.now,applied:true,mix:{product:1,other:0}});f.s.set('proposal:intake:b:1:0',12);
 expect(intake()).toBe('proposed tasks but none is ready to claim');
 // A decision or diagnosis wake finishing is not an intake.
 f.s.event('owner-complete:decision:x','owner-wake-complete',{id:'decision:x',ok:false},'retain',f.now-MINUTE);
 expect(intake()).toBe('proposed tasks but none is ready to claim');
}finally{f.close();}});

// ------------------------------------------------ a recorded idle, replayed
// A fictional day and a half with the shape of the idle recorded on 10-11 November 2026: a pause
// left on for 74 minutes with ready work, a night of missing queue evidence, then an empty queue
// for almost twelve hours that loses its inventory reading for 15 minutes in every 45 and spends
// three of those hours under a usage stop. The real observations are private operational data and
// stay out of Git; `bun launcher/idle-queue.ts --replay <copy>` replays a private copy.
function recordedShape() {
 const day=Date.parse('2026-11-17T00:00:00-05:00'),at=(hour:number,minute:number)=>day+hour*HOUR+minute*MINUTE;
 const paused=at(15,16)+7000,resumed=at(16,30)+8000,emptied=at(24,12)+41000,reset=at(31,40);
 const seen=(t:number,reason:string):IdleQueueObservation=>({at:t,eligible:false,reason,lastActivity:t,heartbeatAt:t});
 const observations:IdleQueueObservation[]=[];
 for(let t=at(15,5);t<=at(36,10);t+=5*MINUTE){
  const reading=(t-at(24,20))/(5*MINUTE);
  if(t<at(15,20))observations.push(seen(t,'builder active or custody unknown'));
  else if(t<=at(16,30))observations.push({...seen(t,'paused'),ready:t<at(15,25)?16:t<at(15,50)?25:31,limit:{kind:'paused',since:paused}});
  else if(t<at(24,20))observations.push({...seen(t,reading%2?'complete fresh project inventory unavailable':'queue not freshly confirmed empty'),observationUnavailable:true});
  else if(t>=at(36,0))observations.push({...seen(t,'queue has ready work'),ready:3});
  else if(reading%9>=6)observations.push({...seen(t,'complete fresh project inventory unavailable'),observationUnavailable:true});
  else if(t>=at(28,45)&&t<at(31,45))observations.push({...seen(t,'usage does not allow work'),ready:0,limit:{kind:'usage-stop',until:reset},idleSince:emptied});
  else observations.push({at:t,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity:emptied,heartbeatAt:t-50000,ready:0,intake:'returned no tasks'});
 }
 return {observations,paused,resumed,emptied,reset};
}
describe('replay of a recorded idle: a pause with ready work, then an empty queue overnight',()=>{
 const shape=recordedShape(),replay=replayIdleObservations(shape.observations,SETTINGS);
 test('first alarm, a repeat about an hour later, then two-hourly while the queue stays eligible; none under the usage stop',()=>{
  expect(replay.alarms.filter(a=>a.id.startsWith('factory-idle-queue:')).map(a=>eastern(a.opened))).toEqual(['11-18 00:35']);
  // Due at 01:35, 03:50, 06:05 and 09:50. Each fires at the first eligible reading on or after
  // its time: the third waits out the usage stop (04:50 to 07:40) and is not made up afterwards.
  expect(replay.wakes.map(w=>eastern(w.at))).toEqual(['11-18 01:50','11-18 04:05','11-18 07:50','11-18 10:05']);
  expect(replay.wakes.filter(w=>w.at>=shape.emptied+4.5*HOUR&&w.at<shape.reset)).toEqual([]);
  for(const w of replay.wakes)expect(replay.wakes.filter(x=>x.at>w.at-24*HOUR&&x.at<=w.at).length).toBeLessThanOrEqual(IDLE_RULES.repeatsPerDay);
  expect(replay.records.filter(r=>r.kind==='repeat').map(r=>[r.step,r.refusal,r.wake])).toEqual([1,2,3,4].map(step=>[step,'returned no tasks',`intake:idle-repeat:${shape.emptied}:${step}`]));
 });
 test('no mail per repeat: the only rows are the pause question and one line for Vincent per cause that day',()=>{
  expect(replay.notices.map(n=>[eastern(n.at),n.recipient,n.id,n.summary])).toEqual([
   ['11-17 15:50','Platform',`loop:action:platform:paused-with-ready:${shape.paused}`,'Factory paused since 15:16 with 31 ready and nothing running. Is this pause still intended?'],
   ['11-18 02:15','Vincent','loop:routine:idle:queue-empty:2026-11-18','Idle 2 h: queue empty, intake returned no tasks.'],
   ['11-18 04:50','Vincent','loop:routine:idle:usage-stop:2026-11-18','Idle 4 h: usage stop until 07:40.'],
  ]);
  // The first alarm is the only thing the Coordinator is sent for the idle itself.
  expect(replay.alarms.map(a=>a.id.split(':')[0])).toEqual(['factory-queue-observation','factory-idle-queue']);
 });
 test('the pause with 31 ready: one question to Platform at the first reading past 30 minutes, no intake wake, both limits on record',()=>{
  const asked=replay.notices.filter(n=>n.recipient==='Platform');
  expect(asked).toHaveLength(1);
  expect((asked[0]!.at-shape.paused)/MINUTE).toBeGreaterThanOrEqual(30);expect((asked[0]!.at-shape.paused)/MINUTE).toBeLessThan(35);
  expect(replay.wakes.filter(w=>w.at>=shape.paused&&w.at<=shape.resumed)).toEqual([]);
  expect(replay.records.filter(r=>r.kind==='idle-by-limit').map(r=>[eastern(r.at),r.limit,r.status,r.setBy])).toEqual([['11-17 15:20','paused','idle by limit','not recorded'],['11-18 04:50','usage-stop','idle by limit',null]]);
 });
 test('the changed observation-gap rule in record-only mode is written down beside the rule that still sends',()=>{
  // Today's rule sends once for the long night and never again for the on-and-off loss that follows.
  expect(replay.alarms.filter(a=>a.id.startsWith('factory-queue-observation:')).map(a=>eastern(a.opened))).toEqual(['11-17 17:00']);
  // The changed rule would have opened one episode, earlier, and kept it open through the on-and-off loss.
  expect(replay.gapEpisodes.map(e=>[eastern(e.since),eastern(e.opened),e.rule,e.ended])).toEqual([['11-17 16:35','11-17 16:45','3 readings in a row',null]]);
  const acting=replayIdleObservations(shape.observations,{...SETTINGS,gapRuleActs:true});
  expect(acting.alarms.filter(a=>a.id.startsWith('factory-queue-observation:')).map(a=>eastern(a.opened))).toEqual(['11-17 16:45']);
  expect(acting.wakes).toEqual(replay.wakes);expect(acting.notices).toEqual(replay.notices);
 });
});

// ------------------------------------------------ changed observation-gap rule
describe('changed observation-gap rule',()=>{
 const unknown=(at:number):IdleQueueObservation=>({at,eligible:false,reason:'queue not freshly confirmed empty',lastActivity:at,heartbeatAt:at,observationUnavailable:true});
 const known=(at:number):IdleQueueObservation=>({at,eligible:false,reason:'queue has ready work',lastActivity:at,heartbeatAt:at});
 const gapAlarms=(state:Database)=>(state.query("SELECT id,opened FROM incidents WHERE id LIKE 'factory-queue-observation:%' ORDER BY opened").all() as {id:string;opened:number}[]).map(a=>(a.opened-THURSDAY)/MINUTE);
 test('on-and-off loss never trips the continuous rule but is 20 minutes in an hour; the episode ends only after a clean hour',()=>{for(const acting of [false,true]){const state=openIdleState(':memory:');try{
  const tripped:number[]=[];
  for(let n=0;n<=12;n++){const at=THURSDAY+n*5*MINUTE;if(advanceIdleQueue(state,n%2?known(at):unknown(at),{...SETTINGS,gapRuleActs:acting}).gapRule)tripped.push(n*5);}
  expect(tripped[0]).toBe(35);expect(tripped.at(-1)).toBe(60);
  expect(gapAlarms(state)).toEqual(acting?[35]:[]);
  // Clean readings from 65 minutes on. The last hour still holds 20 lost minutes until 90, and the
  // episode stays open, as one episode, until a whole hour has passed without the rule tripping.
  const open=()=>state.query('SELECT since,rule,ended FROM gap_rule').all();
  for(let n=13;n<=29;n++)advanceIdleQueue(state,known(THURSDAY+n*5*MINUTE),{...SETTINGS,gapRuleActs:acting});
  expect(open()).toEqual([{since:THURSDAY,rule:'20 minutes in an hour',ended:null}]);
  advanceIdleQueue(state,known(THURSDAY+150*MINUTE),{...SETTINGS,gapRuleActs:acting});
  expect(open()).toEqual([{since:THURSDAY,rule:'20 minutes in an hour',ended:THURSDAY+150*MINUTE}]);
  expect(gapAlarms(state)).toEqual(acting?[35]:[]);
 }finally{state.close();}}});
 test('three unavailable readings in a row trip at ten minutes; record-only keeps the twenty-minute rule sending',()=>{for(const acting of [false,true]){const state=openIdleState(':memory:');try{
  const rules=[0,5,10,15,20,25].map(m=>advanceIdleQueue(state,unknown(THURSDAY+m*MINUTE),{...SETTINGS,gapRuleActs:acting}).gapRule);
  expect(rules).toEqual([null,null,'3 readings in a row','3 readings in a row','3 readings in a row','3 readings in a row']);
  expect(gapAlarms(state)).toEqual(acting?[10]:[25]);
 }finally{state.close();}}});
 test('the watcher sends on the changed rule only once the loop switch is acting; a broken switch file changes nothing and says so',()=>{
  const run=(flags?:string)=>{const f=idleFixture(THURSDAY);try{
   if(flags!==undefined)writeFileSync(join(f.dir,'loop-flags.json'),flags);
   f.s.set('heartbeat',{at:f.now-6*MINUTE,status:'ok',ready:0});
   const results=[0,5,10].map(m=>watchIdleQueue(f.dir,f.mail,f.now+m*MINUTE));
   return {results,mail:mailRows(f).map(r=>[r.recipient,r.kind,r.id]),summaries:mailRows(f).map(r=>r.summary)};
  }finally{f.close();}};
  const off=run();
  expect(off.results.map(r=>r.gapRule)).toEqual([null,null,'3 readings in a row']);expect(off.mail).toEqual([]);expect(off.results[2]).not.toHaveProperty('switchAlarm');
  const on=run(JSON.stringify({version:1,switches:{'idle-observation-gap':{mode:'acting',actor:'operator (test)',at:THURSDAY,parityReport:'/tmp/gap-replay.json',parityReportSha256:'0'.repeat(64)}}}));
  expect(on.mail).toEqual([['Coordinator','action',`factory-queue-observation:${THURSDAY}`]]);
  // Sent at ten minutes on three readings: the mail must not say "over 20 minutes".
  expect(on.summaries).toEqual(['Factory queue observation has been unavailable for 3 readings in a row. Supply and builder activity need checking.']);
  const broken=run('{"version":1,"switches":{"idle-observation-gap":{"mode":"acting"}}}');
  expect(broken.mail).toEqual([]);expect(broken.results[2]!.switchAlarm).toContain('loop switch file rejected');
 });
 test('acting adds the changed rule to the twenty-minute rule: a job that runs every 40 minutes still alarms at its second unavailable reading',()=>{for(const acting of [false,true]){const state=openIdleState(':memory:');try{
  const rules=[0,40,80,120].map(m=>advanceIdleQueue(state,unknown(THURSDAY+m*MINUTE),{...SETTINGS,gapRuleActs:acting}).gapRule);
  // Too sparse for 20 counted minutes in an hour, but three in a row is three in a row at any spacing.
  expect(rules).toEqual([null,null,'3 readings in a row','3 readings in a row']);
  // Today's rule sends at 40 minutes whether or not the switch is acting, and it stays one incident.
  expect(gapAlarms(state)).toEqual([40]);
  expect(state.query('SELECT since,rule FROM gap_rule').all()).toEqual([{since:THURSDAY,rule:'3 readings in a row'}]);
 }finally{state.close();}}});
 test('the mail for an on-and-off loss says 20 minutes within an hour, and keeps that text on every later run',()=>{const f=idleFixture(THURSDAY);try{
  writeFileSync(join(f.dir,'loop-flags.json'),JSON.stringify({version:1,switches:{'idle-observation-gap':{mode:'acting',actor:'operator (test)',at:THURSDAY,parityReport:'/tmp/gap-replay.json',parityReportSha256:'0'.repeat(64)}}}));
  const gapMail=()=>mailRows(f).filter(r=>r.id.startsWith('factory-queue-observation:')).map(r=>r.summary);
  for(let n=0;n<=9;n++){
   const at=f.now+n*5*MINUTE;
   // Odd runs read a busy queue; even runs find the heartbeat stale.
   if(n%2)f.tick(at,{ready:2,claimed:1});else f.s.set('heartbeat',{at:at-6*MINUTE,status:'ok',ready:0});
   watchIdleQueue(f.dir,f.mail,at);
   expect(gapMail()).toEqual(n<7?[]:['Factory queue observation has been unavailable for 20 minutes within an hour. Supply and builder activity need checking.']);
  }
 }finally{f.close();}});
});
