import {test,expect,spyOn} from 'bun:test';
import {Store} from '../tracking/store';
import {ReleaseExecutor,recordAcceptance,type ReleasePort,type ReleaseContext,type ReleaseStep} from '../launcher/release';
const revision='a'.repeat(40),tree='b'.repeat(40),artifact='sha256:'+'c'.repeat(64);
function rig(){
 let now=Date.parse('2026-11-09T19:00:00-05:00');const s=new Store(':memory:');
 const calls:ReleaseStep[]=[],pending=new Set<ReleaseStep>(),failed=new Set<ReleaseStep>();
 let brake:string|null=null,overlap=false;
 const port:ReleasePort={snapshot:async()=>({revision,tree,holdId:'fixture-hold',held:true,overlap}),perform:async(step)=>{calls.push(step);return {step};},observe:async(step,c)=>({state:pending.has(step)?'pending':failed.has(step)?'failure':'success',evidence:{artifact,completedAt:now,holdId:'fixture-hold',revision,tree,production:'d'.repeat(40),rollback:'fixture-stopped-pair',healthy:true}})};
 const executor=new ReleaseExecutor(s,port,async()=>brake,()=>now);
 return {s,executor,calls,pending,failed,set:(time:string)=>{now=Date.parse(`2026-11-09T${time}:00-05:00`);},brake:(value:string)=>{brake=value;},overlap:()=>{overlap=true;},now:()=>now};
}
async function qa(r:ReturnType<typeof rig>){await r.executor.run('preflight');r.set('20:00');await r.executor.run('qa');}
function accept(r:ReturnType<typeof rig>,change:object={}){return recordAcceptance(r.s,`qa-deployed:2026-11-09:${tree}`,'native-fixture',{day:'2026-11-09',revision,tree,artifact,verdict:'ACCEPT',evidence:'fictional hosted evidence',...change},r.now());}
test('calendar night runs without chat, promotes same accepted tree with different production SHA',async()=>{
 const r=rig();await qa(r);accept(r);r.set('21:30');await r.executor.run('production');await r.executor.run('reconcile');
 expect(r.calls).toEqual(['preflight','qa','promote','readback']);expect(r.executor.effect('2026-11-09','readback')?.state).toBe('success');r.s.close();
});
test('duplicate launch and restart do not replay effects',async()=>{
 const r=rig();await qa(r);await r.executor.run('qa');const restarted=new ReleaseExecutor(r.s,r.executor.port,async()=>null,r.now);await restarted.run('qa');expect(r.calls).toEqual(['preflight','qa']);r.s.close();
});
test('deliberate check failure refuses and wakes diagnosis without a hang',async()=>{
 const r=rig();r.failed.add('preflight');await r.executor.run('preflight');r.set('20:00');expect((await r.executor.run('qa')).state).toBe('refused');expect(r.calls).toEqual(['preflight']);expect(r.s.get('owner-wake:release-failed:2026-11-09:preflight')).toBeTruthy();r.s.close();
});
test('late calendar firing refuses before remote effect',async()=>{const r=rig();r.set('20:01');expect((await r.executor.run('qa')).state).toBe('refused');expect(r.calls).toEqual([]);r.s.close();});
test('missing mismatched or late ACCEPT cannot promote',async()=>{
 for(const kind of ['missing','mismatch','late']){const r=rig();await qa(r);if(kind==='mismatch')expect(()=>accept(r,{tree:'e'.repeat(40)})).toThrow();if(kind==='late'){r.set('21:20');expect(()=>accept(r)).toThrow();}r.set('21:30');expect((await r.executor.run('production')).state).toBe('refused');expect(r.calls).toEqual(['preflight','qa']);r.s.close();}
});
test('uncertain dispatch stays claimed after restart and never replays',async()=>{const r=rig();r.executor.port.perform=async()=>{r.calls.push('preflight');throw Error('unknown HTTP outcome');};await r.executor.run('preflight');await r.executor.run('preflight');expect(r.calls).toEqual(['preflight']);expect(r.executor.effect('2026-11-09','preflight')?.state).toBe('claimed');r.s.close();});
test('pending QA survives restart, deadline persists refusal',async()=>{const r=rig();r.pending.add('qa');await qa(r);r.set('21:20');await r.executor.run('reconcile');expect(r.executor.effect('2026-11-09','qa')?.state).toBe('failure');r.s.close();});
test('wallet and overlap gates refuse',async()=>{for(const kind of ['wallet','overlap']){const r=rig();if(kind==='wallet')r.brake('wallet stopped');else r.overlap();expect((await r.executor.run('preflight')).state).toBe('refused');expect(r.calls).toEqual([]);r.s.close();}});
test('clock is rechecked after asynchronous admission reads',async()=>{const r=rig();const snapshot=r.executor.port.snapshot;r.executor.port.snapshot=async()=>{const value=await snapshot();r.set('19:01');return value;};await r.executor.run('preflight');expect(r.calls).toEqual([]);r.s.close();});
test('concurrent windows atomically claim once',async()=>{const r=rig();await Promise.all([r.executor.run('preflight'),r.executor.run('preflight')]);expect(r.calls).toEqual(['preflight']);r.s.close();});
test('hold epoch change refuses QA and Quality artifact mismatch refuses acceptance',async()=>{
 const r=rig();await r.executor.run('preflight');const original=r.executor.port.snapshot;r.executor.port.snapshot=async()=>({...await original(),holdId:'changed-hold'});r.set('20:00');expect((await r.executor.run('qa')).state).toBe('refused');expect(r.calls).toEqual(['preflight']);r.s.close();
 const a=rig();await qa(a);expect(()=>accept(a,{artifact:'other-artifact'})).toThrow();a.s.close();
});
test('deadline release events run before old CI wakes and expired acceptance never starts',async()=>{
 const {queueWake,pendingWakes,dispatchWake}=await import('../launcher/wake');
 const now=Date.parse('2026-11-09T20:30:00-05:00'),clock=spyOn(Date,'now').mockReturnValue(now);
 const s=new Store(':memory:');
 try {
  s.set('owner-runtime:quality',{workspace:process.cwd()});
  queueWake(s,{id:'old-ci',owner:'quality',kind:'ci-finished',payload:{}},now-3000);
  // Insert valid first, but the older expired wake must still sort first.
  queueWake(s,{id:'accept-now',owner:'quality',kind:'qa-deployed',payload:{deadline:now+60000}},now-1000);
  queueWake(s,{id:'accept-expired',owner:'quality',kind:'qa-deployed',payload:{deadline:now}},now-2000);
  const wakes=pendingWakes(s),starts:string[]=[];
  expect(wakes.map(w=>w.id)).toEqual(['accept-expired','accept-now','old-ci']);
  expect(dispatchWake(s,wakes[0],id=>{starts.push(id);})).toBe(false);
  expect(starts).toEqual([]);
  expect(s.get<{state:string;cleanupVerified:boolean}>('owner-wake:accept-expired')).toMatchObject({state:'expired',cleanupVerified:true});
  expect(s.get('owner-runtime:quality')).toEqual({workspace:process.cwd()});
  expect(pendingWakes(s).map(w=>w.id)).toEqual(['accept-now','old-ci']);
  expect(dispatchWake(s,wakes[1],id=>{starts.push(id);})).toBe(true);
  expect(starts).toEqual(['accept-now']);
  expect(s.get<{state:string}>('owner-wake:accept-now')?.state).toBe('starting');
  expect(s.get<{state:string}>('owner-wake:old-ci')?.state).toBe('queued');
 } finally {clock.mockRestore();s.close();}
});

test('acceptance deadline is rechecked at dispatch after queue ordering',async()=>{
 const {queueWake,pendingWakes,dispatchWake}=await import('../launcher/wake');
 const now=Date.parse('2026-11-09T21:19:59-05:00'),clock=spyOn(Date,'now').mockReturnValue(now);
 const s=new Store(':memory:');
 try {
  s.set('owner-runtime:quality',{workspace:process.cwd()});
  queueWake(s,{id:'old-ci',owner:'quality',kind:'ci-finished',payload:{}},now-2000);
  queueWake(s,{id:'accept-boundary',owner:'quality',kind:'qa-deployed',payload:{deadline:now+1000}},now-1000);
  const wakes=pendingWakes(s),starts:string[]=[];
  expect(wakes.map(w=>w.id)).toEqual(['accept-boundary','old-ci']);
  clock.mockReturnValue(now+1000);
  expect(dispatchWake(s,wakes[0],id=>{starts.push(id);})).toBe(false);
  expect(starts).toEqual([]);
  expect(s.get<{state:string}>('owner-wake:accept-boundary')?.state).toBe('expired');
  expect(pendingWakes(s).map(w=>w.id)).toEqual(['old-ci']);
 } finally {clock.mockRestore();s.close();}
});

test('latched scheduled windows record skip without snapshots, debits or deploys',async()=>{
 const r=rig();r.brake('AWS stop latched');
 r.executor.port.snapshot=async()=>{throw Error('remote snapshot must not run');};
 for(const [clock,stage] of [['19:00','preflight'],['20:00','qa'],['21:30','production']] as const){
  r.set(clock);expect(await r.executor.run(stage)).toEqual({state:'skipped',reason:'QA deploy skipped: AWS stop latched'});
  expect(r.s.get(`executor:2026-11-09:${stage}`)).toBeNull();
 }
 expect(r.calls).toEqual([]);
 expect((r.s.db.query('SELECT COUNT(*) AS n FROM debits').get() as {n:number}).n).toBe(0);
 r.s.close();
});
