// Contract tests: the idle watcher's rows for Vincent and for Platform, written into Alido Mail's
// real store code on a temporary database and carried by Alido Mail's own delivery steps. No wake
// state is set by hand. The mail checkout is a separate repository and is absent in this
// repository's CI, where these are skipped; tests/idle-queue.test.ts pins the same rows' shape there.
// Run locally with FACTORY_REQUIRE_MAIL_SOURCE=1 to make a missing checkout a failure.
import {describe,expect,test} from 'bun:test';
import {pausedWithReadyActionId,watchIdleQueue} from '../launcher/idle-queue';
import {parseOwnerMessageId} from '../launcher/loop-contract';
import {releaseAction} from '../launcher/release-actions';
import {MINUTE,idleFixture} from './helpers/idle-queue-fixture';
import {openRealMailStore,realMailSource,type RealMailStore} from './helpers/real-mail-store';

// Thursday 12 Nov 2026, 00:30 Eastern.
const THURSDAY=Date.parse('2026-11-12T00:30:00-05:00');
const RESET=Date.parse('2026-11-13T03:00:00-05:00');
type Notice={id:string;recipient:string;queued:number|null;delivery:string|null;wake:string|null};
const notices=(f:ReturnType<typeof idleFixture>)=>f.state<Notice>('SELECT id,recipient,queued,delivery,wake FROM notices ORDER BY at,id');
// At START the factory has been paused for 50 minutes with 31 ready tasks, and no builder has
// run for 31 minutes (the fixture's last builder event is 21 minutes before its clock).
const START=THURSDAY+10*MINUTE;
function pausedFixture(mail:RealMailStore){
 const f=idleFixture(THURSDAY,mail.path),paused=THURSDAY-40*MINUTE;
 f.s.set('paused',true);f.s.event('pause-1','pause',{owner:'Release',ownerSupplied:true,actor:'owner-control'},'Set pause to false',paused);
 const tick=(at:number)=>f.tick(at,{ready:31,claimed:0,paused:true});
 tick(START);
 return {f,paused,tick,id:pausedWithReadyActionId(paused)};
}

describe.skipIf(!realMailSource())('idle watcher mail through the real Alido Mail store',()=>{
 test("Vincent's idle line is sent once by Alido Mail's own send function, and the watcher reads the receipt back",async()=>{
  const mail=await openRealMailStore(),f=idleFixture(THURSDAY,mail.path);
  try{
   // Usage is stopped until Friday 03:00. Builders last did anything 21 minutes before the
   // fixture's clock, so the idle is two hours old at +100 minutes.
   const stopped=[{used:.93,resetsAt:RESET},{used:.4,resetsAt:RESET+3*86400000}];
   const at=THURSDAY+100*MINUTE,id='loop:routine:idle:usage-stop:2026-11-12';
   f.tick(at,{ready:0,claimed:0},stopped);
   expect(watchIdleQueue(f.dir,mail.path,at).notices).toEqual([id]);
   expect(mail.row(id)).toMatchObject({sender:'Factory Desk',recipient:'Vincent',recipient_app:'telegram',kind:'fyi',summary:'Idle 2 h: usage stop until Friday 03:00.',body:'',state:'unread',wake_state:'pending'});
   expect(parseOwnerMessageId(id)).toMatchObject({tier:'routine',kind:'idle',subject:'usage-stop',day:'2026-11-12'});
   expect(notices(f)).toEqual([{id,recipient:'Vincent',queued:at,delivery:'pending',wake:null}]);
   expect(mail.telegramSentAt(id)).toBeNull();
   expect(await mail.sendToVincent(at+MINUTE)).toEqual(['Factory Desk: Idle 2 h: usage stop until Friday 03:00.']);
   expect(mail.telegramSentAt(id)).toBe(at+MINUTE);
   // The next run reads Alido Mail's own receipt; it writes no second row and nothing is sent twice.
   f.tick(at+5*MINUTE,{ready:0,claimed:0},stopped);
   expect(watchIdleQueue(f.dir,mail.path,at+5*MINUTE).notices).toEqual([]);
   expect(notices(f)).toEqual([{id,recipient:'Vincent',queued:at,delivery:'woken',wake:expect.stringMatching(/^w_/)}]);
   expect(await mail.sendToVincent(at+6*MINUTE)).toEqual([]);
   expect(mail.db.query("select count(*) n from messages where recipient='Vincent'").get()).toEqual({n:1});
  }finally{f.close();mail.close();}
 });

 test('the pause question reaches Platform when Platform has a Codex thread, and the watcher reads the wake back',async()=>{
  const mail=await openRealMailStore({codexThreads:{Platform:'thread-platform'}}),{f,paused,tick,id}=pausedFixture(mail);
  try{
   expect(watchIdleQueue(f.dir,mail.path,START).notices).toEqual([id]);
   expect(id).toBe(`loop:action:platform:paused-with-ready:${paused}`);
   expect(mail.row(id)).toMatchObject({sender:'Factory Desk',recipient:'Platform',recipient_app:'codex',kind:'action',summary:'Factory paused since Wednesday 23:50 with 31 ready and nothing running. Is this pause still intended?',state:'unread',wake_state:'pending'});
   expect(mail.row(id)!.body).toContain('It does not resume the factory or change any limit');
   expect(await mail.ringCodex(START+10_000)).toBe(1);
   expect(mail.row(id)).toMatchObject({wake_state:'woken',wake_id:expect.stringMatching(/^w_/)});
   tick(START+5*MINUTE);
   expect(watchIdleQueue(f.dir,mail.path,START+5*MINUTE).notices).toEqual([]);
   expect(notices(f)).toEqual([{id,recipient:'Platform',queued:START,delivery:'woken',wake:mail.row(id)!.wake_id}]);
   expect(f.s.get('paused')).toBe(true);
  }finally{f.close();mail.close();}
 });

 test('with no Codex thread for Platform the question fails to wake, as it does live; the record shows it and Vincent still gets his line at two hours',async()=>{
  const mail=await openRealMailStore(),{f,paused,tick,id}=pausedFixture(mail);
  try{
   watchIdleQueue(f.dir,mail.path,START);
   expect(await mail.ringCodex(START+10_000)).toBe(0);
   expect(mail.row(id)).toMatchObject({wake_state:'failed',state:'unread'});
   expect(mail.db.query("select detail from wakes where recipient='Platform'").get()).toEqual({detail:'no thread in the Codex map'});
   tick(START+5*MINUTE);watchIdleQueue(f.dir,mail.path,START+5*MINUTE);
   expect(notices(f)).toEqual([{id,recipient:'Platform',queued:START,delivery:'failed',wake:null}]);
   // Builders last did anything 21 minutes before the fixture's clock, so the idle is two hours old at +100 minutes.
   const at=THURSDAY+100*MINUTE,line='loop:routine:idle:paused:2026-11-12';
   tick(at);
   expect(watchIdleQueue(f.dir,mail.path,at).notices).toEqual([line]);
   expect(await mail.sendToVincent(at)).toEqual(['Factory Desk: Idle 2 h: paused since Wednesday 23:50 with 31 ready.']);
   expect(mail.telegramSentAt(line)).toBe(at);
   expect(mail.db.query("select count(*) n from messages where recipient='Platform'").get()).toEqual({n:1});
   expect(paused).toBe(THURSDAY-40*MINUTE);expect(f.s.get('paused')).toBe(true);
  }finally{f.close();mail.close();}
 });

 test('when another writer already raised the same pause under the contract id, the watcher adds no second mail',async()=>{
  const mail=await openRealMailStore({codexThreads:{Platform:'thread-platform'}}),{f,id}=pausedFixture(mail);
  try{
   releaseAction(id,'Platform','Factory is paused with ready tasks.','Raised by the role router.',THURSDAY-MINUTE,mail.path);
   expect(watchIdleQueue(f.dir,mail.path,START).notices).toEqual([id]);
   expect(mail.db.query("select count(*) n from messages where recipient='Platform'").get()).toEqual({n:1});
   expect(mail.row(id)).toMatchObject({summary:'Factory is paused with ready tasks.'});
   expect(notices(f)).toEqual([{id,recipient:'Platform',queued:START,delivery:'pending',wake:null}]);
  }finally{f.close();mail.close();}
 });
});
