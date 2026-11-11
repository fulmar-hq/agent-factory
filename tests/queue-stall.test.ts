import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {claimableReady,reviewPublished as reconcilePublished} from '../launcher/queue';
import {observeClaimProgress,checkClaimStall} from '../launcher/watchdog';
import {intakeLabel,type Issue} from '../adapters/github';
import {config,ticket,admission,now} from './fixtures';
const reviewPublished=(e:Engine,execute:Parameters<typeof reconcilePublished>[1])=>reconcilePublished(e,execute,()=> 'fictional-review-process');
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

test('independent watchdog ages a last successful claim without another tick',()=>{const e=setup();try{const x=e.admit(ticket(),admission());observeClaimProgress(e,{at:now,claimed:1,paused:false});e.finish(x.id,true);expect(checkClaimStall(e,now+7200001)).toMatchObject({state:'open'});}finally{e.s.close();}});

test('independent checks begin a conservative interval when full capacity becomes free',()=>{const e=setup();try{const workers=[e.admit(ticket(1),admission()),e.admit(ticket(2),admission())];observeClaimProgress(e,{at:now,claimed:2,paused:false});for(const x of workers)e.finish(x.id,true);expect(checkClaimStall(e,now+7200001)).toBeNull();expect(checkClaimStall(e,now+14400001)).toMatchObject({state:'open'});}finally{e.s.close();}});

test('dismissed reviews cannot replay an old publication over its retained return marker',async()=>{const r=fixture();try{await reviewPublished(r.e,async a=>a[1]==='pr'?JSON.stringify({state:'OPEN',url:'https://github.com/example/demo/pull/2',reviewDecision:'CHANGES_REQUESTED'}):r.execute(a));expect(r.e.s.get(`review-returned:${r.x.id}:${r.t.approvalDigest}`)).not.toBeNull();expect(await reviewPublished(r.e,r.execute)).toBe(0);expect(r.i.labels[0].name).toBe('state:ready');expect(r.calls.filter(a=>a.includes('edit'))).toHaveLength(0);}finally{r.e.s.close();}});

test('persisted continuation progress resets a normal zero-claim tick interval',()=>{const e=setup();try{observeClaimProgress(e,{at:now,claimed:0,paused:false});e.s.event('fresh-continuation','session-continuation',{},'retain',now+7199000);observeClaimProgress(e,{at:now+7200000,claimed:0,paused:false});expect(e.s.get('watchdog-stall')).toBeNull();}finally{e.s.close();}});
test('changes requested in the normal review state remain returned after dismissal',async()=>{const r=fixture();try{await reviewPublished(r.e,r.execute);r.e.s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run(r.x.ticket,JSON.stringify(r.i),now);r.e.s.set('board-pr:https://github.com/example/demo/pull/2',{at:now,review:'CHANGES_REQUESTED'});await reviewPublished(r.e,r.execute);expect(r.e.s.get(`review-returned:${r.x.id}:${r.t.approvalDigest}`)).not.toBeNull();r.i.labels=[{name:'state:ready'}];r.e.s.db.query('UPDATE tickets SET snapshot=?').run(JSON.stringify(r.i));expect(await reviewPublished(r.e,r.execute)).toBe(0);expect(r.i.labels[0].name).toBe('state:ready');}finally{r.e.s.close();}});

test('independent claim aging retains the actual intervening event time',()=>{const e=setup();try{observeClaimProgress(e,{at:now,claimed:0,paused:false});e.s.event('intervening-continuation','session-continuation',{},'retain',now+60000);expect(checkClaimStall(e,now+3600000)).toBeNull();expect(checkClaimStall(e,now+7260000)).toMatchObject({state:'open'});}finally{e.s.close();}});

test('independent watchdog recognizes real challenge starts',()=>{const e=setup();try{observeClaimProgress(e,{at:now,claimed:0,paused:false});e.s.event('challenge','factory-challenge-started',{},'retain',now+7199000);expect(checkClaimStall(e,now+7200000)).toBeNull();}finally{e.s.close();}});

test('a quota failure stops a multi-publication scan after one request and retains every session',async()=>{
 const r=fixture();try{
  const t={...ticket(2),approvalDigest:'ready:'+'b'.repeat(43)},x=r.e.admit(t,admission());r.e.finish(x.id,true);
  r.e.s.event('publish-two','launcher-publish',{id:x.id,url:'https://github.com/example/demo/pull/3'},'retain');
  let calls=0;await reviewPublished(r.e,async()=>{calls++;throw Error('gh failed: GraphQL: API rate limit already exceeded');});
  expect(calls).toBe(1);expect(r.e.sessions().every(x=>x.status==='finished')).toBe(true);
  expect(r.e.s.rows('events').filter((r:any)=>r.kind==='github-review-failure')).toHaveLength(1);
 }finally{r.e.s.close();}
});

test('expired shared review evidence defers polling to the shared reader instead of rescanning every publication',async()=>{
 const r=fixture();try{
  r.i.labels=[{name:'state:review'}];r.e.s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run(r.x.ticket,JSON.stringify(r.i),now);
  r.e.s.set('board-pr:https://github.com/example/demo/pull/2',{at:Date.now()-600001,review:'APPROVED'});
  expect(await reviewPublished(r.e,r.execute)).toBe(0);expect(r.calls).toHaveLength(0);
 }finally{r.e.s.close();}
});
