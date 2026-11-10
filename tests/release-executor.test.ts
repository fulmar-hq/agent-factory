import {test,expect} from 'bun:test';
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
test('squashed carrier binds Quality and Production to the actual merged QA revision',async()=>{
 const r=rig(),merged='f'.repeat(40),batch={version:1 as const,day:'2026-11-09',base:'c'.repeat(40),revision,tree,pr:7,ref:'feat/fixture-batch',holdId:'fixture-hold',sources:[{number:8,head:revision,ref:'feat/source',title:'Fictional change'}],overlaps:[],review:'fictional independent review'};
 let current=revision;
 const snapshot=r.executor.port.snapshot;
 r.executor.port.snapshot=async()=>({...await snapshot(),revision:current});
 r.executor.port.observe=async(step)=>({state:'success',evidence:{artifact,completedAt:r.now(),holdId:'fixture-hold',revision,tree,...(step==='qa'?{qaRevision:merged}:{})}});
 const executor=new ReleaseExecutor(r.s,r.executor.port,async()=>null,r.now,()=>{},batch);
 await executor.run('preflight');r.set('20:00');await executor.run('qa');
 expect(executor.effect(batch.day,'qa')?.context.revision).toBe(merged);
 expect(()=>recordAcceptance(r.s,`qa-deployed:${batch.day}:${tree}`,'native',{day:batch.day,revision,tree,artifact,verdict:'ACCEPT',evidence:'fictional'})).toThrow();
 recordAcceptance(r.s,`qa-deployed:${batch.day}:${tree}`,'native',{day:batch.day,revision:merged,tree,artifact,verdict:'ACCEPT',evidence:'fictional'},r.now());
 current=merged;r.set('21:30');await executor.run('production');
 expect(executor.effect(batch.day,'promote')?.context.revision).toBe(merged);
 expect(r.calls).toEqual(['preflight','qa','promote','readback']);r.s.close();
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
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const s=new Store(':memory:');s.set('owner-runtime:quality',{workspace:mkdtempSync(join(tmpdir(),'quality-deadline-'))});
 queueWake(s,{id:'old-ci',owner:'quality',kind:'ci-finished',payload:{}});
 queueWake(s,{id:'accept-now',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}});
 queueWake(s,{id:'accept-expired',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()-1}});
 expect(pendingWakes(s)[0].id).toBe('accept-now');let starts=0;
 expect(dispatchWake(s,pendingWakes(s).find(w=>w.id==='accept-expired')!,()=>{starts++;})).toBe(false);
 expect(starts).toBe(0);expect(s.get<{state:string}>('owner-wake:accept-expired')?.state).toBe('expired');s.close();
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
