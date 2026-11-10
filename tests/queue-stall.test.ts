import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {claimableReady,reviewPublished} from '../launcher/queue';
import {observeClaimProgress,checkClaimStall} from '../launcher/watchdog';
import {intakeLabel,type Issue} from '../adapters/github';
import {config,ticket,admission,now} from './fixtures';
function setup(){const e=new Engine(new Store(':memory:'),config());e.pause(false,'owner');return e;}
function fixture(){
 const e=setup(),t=ticket();
 const i:Issue={number:1,title:t.title,body:'```factory\n'+JSON.stringify(t)+'\n```',url:'fixture',state:'OPEN',updatedAt:'fixture',labels:[{name:'state:ready'}]};
 t.approvalDigest=intakeLabel(t.repo,i);
 const x=e.admit(t,admission());e.finish(x.id,true);
 e.s.event('publish-fixture','launcher-publish',{id:x.id,url:'https://github.com/example/demo/pull/2'},'retain');
 const calls:string[][]=[];
 const execute=async(a:string[])=>{calls.push(a);if(a[1]==='pr')return JSON.stringify({state:'OPEN',url:'https://github.com/example/demo/pull/2'});if(a.includes('view'))return JSON.stringify(i);if(a.includes('edit'))i.labels=[{name:'state:review'}];return '';};
 return {e,t,i,x,calls,execute};
}
test('finished published ready work moves to review once, retaining claim and approval',async()=>{
 const r=fixture();try{
  expect(await reviewPublished(r.e,r.execute)).toBe(1);expect(await reviewPublished(r.e,r.execute)).toBe(0);
  expect(r.calls.filter(a=>a.includes('edit'))).toHaveLength(1);
  expect(claimableReady(r.e,[r.t])).toHaveLength(0);expect(r.e.sessions()[0].approval_digest).toBe(r.t.approvalDigest!);
 }finally{r.e.s.close();}
});
test('label failure retries, newer content and missing publication never change labels',async()=>{
 const r=fixture();try{
  expect(await reviewPublished(r.e,async a=>{if(a.includes('edit'))throw Error('fixture network failure');return r.execute(a);})).toBe(0);
  expect(await reviewPublished(r.e,r.execute)).toBe(1);
  r.i.labels=[{name:'state:ready'}];r.i.body=r.i.body.replace('Make synthetic change','New bounded work');
  expect(await reviewPublished(r.e,r.execute)).toBe(0);
  r.e.s.db.query("UPDATE sessions SET status='unknown' WHERE id=?").run(r.x.id);
  expect(claimableReady(r.e,[{...r.t,approvalDigest:'ready:'+'a'.repeat(43)}])).toHaveLength(0);
 }finally{r.e.s.close();}
});
test('failed review stays returned; unknown PR state does not infer review success',async()=>{
 const r=fixture();try{
  expect(await reviewPublished(r.e,async a=>a[1]==='pr'?JSON.stringify({state:'OPEN',url:'https://github.com/example/demo/pull/2',reviewDecision:'CHANGES_REQUESTED'}):r.execute(a))).toBe(0);
  expect(r.i.labels[0].name).toBe('state:ready');
  expect(await reviewPublished(r.e,async a=>a[1]==='pr'?Promise.reject(Error('unknown')):r.execute(a))).toBe(0);
 }finally{r.e.s.close();}
});
test('healthy heartbeats and owner activity cannot hide two-hour zero-claim stall',()=>{
 const e=setup();try{
  const tick=(at:number,claimed=0,paused=false)=>observeClaimProgress(e,{at,claimed,paused});
  tick(now);tick(now+7199999);expect(e.s.get('watchdog-stall')).toBeNull();
  tick(now+7200000);tick(now+7260000);checkClaimStall(e,now+7300000);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='watchdog-stalled')).toHaveLength(1);
  tick(now+7400000,1);expect(e.s.get<{state:string}>('watchdog-stall')?.state).toBe('resolved');
  tick(now+7500000,0,true);tick(now+16000000);expect(e.s.get<{state:string}>('watchdog-stall')?.state).toBe('resolved');
 }finally{e.s.close();}
});
test('capacity occupied for two hours is not a zero-claim incident',()=>{
 const e=setup();try{
  e.admit(ticket(1),admission());e.admit(ticket(2),admission());
  observeClaimProgress(e,{at:now,claimed:0,paused:false});
  observeClaimProgress(e,{at:now+7200000,claimed:0,paused:false});
  expect(e.s.get('watchdog-stall')).toBeNull();
 }finally{e.s.close();}
});

test('unknown legacy digest and archived same digest do not count as supply',()=>{
 const r=fixture();try{
  r.e.archive(r.x.id,'fixture retained cleanup receipt','owner');
  expect(claimableReady(r.e,[r.t])).toHaveLength(0);
  r.e.s.db.query('UPDATE sessions SET approval_digest=NULL WHERE id=?').run(r.x.id);
  expect(claimableReady(r.e,[{...r.t,approvalDigest:'ready:'+'b'.repeat(43)}])).toHaveLength(0);
 }finally{r.e.s.close();}
});

test('stopped dormant custody cannot hide free builder slots from the watchdog',()=>{
 const e=setup();try{for(const n of [1,2]){const x=e.admit(ticket(n),admission());e.s.db.query("UPDATE sessions SET status='paused',pid=NULL WHERE id=?").run(x.id);e.s.set(`cleanup-evidence:${x.id}`,{verified:true});}expect(e.active()).toHaveLength(2);expect(e.slots().free).toBe(2);observeClaimProgress(e,{at:now,claimed:0,paused:false});observeClaimProgress(e,{at:now+7200000,claimed:0,paused:false});expect(e.s.get('watchdog-stall')).toMatchObject({state:'open'});expect(e.active()).toHaveLength(2);}finally{e.s.close();}
});
