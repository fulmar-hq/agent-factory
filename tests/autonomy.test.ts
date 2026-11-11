import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {TestEngine as Engine} from './fixtures';
import {ConfigSchema,type Ticket} from '../launcher/config';
import {slotLimit,reconcileCapacity} from '../launcher/capacity';
import {supply,autoApprove,prospective,failures,classifyFailure,applyOwnerResults,autonomyEffects,expireDecisions} from '../launcher/autonomy';
import {intakeLabel,type Issue} from '../adapters/github';
import {config,ticket,admission,now} from './fixtures';
function setup() {
 const c=ConfigSchema.parse({...config(),autonomy:{intake_mode:'build',intake_owner:'builder',ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['launcher/config.ts','.github']},restart:{max_retries:1,causes_per_hour:3}}});
 const e=new Engine(new Store(':memory:'),c);e.pause(false,'owner');return e;
}
function issue(n=1,extra:Record<string,unknown>={}):Issue {
 return {number:n,title:'Synthetic useful change',url:`https://github.com/example/demo/issues/${n}`,state:'OPEN',updatedAt:'fixture',labels:['state:ready','kind:fix','area:controller'].map(name=>({name})),body:'```factory\n'+JSON.stringify({...ticket(n),kind:'fix',area:'controller',estimateBasis:'Synthetic known bounded controller repair based on source inspection',...extra},null,2)+'\n```'};
}
function snapshot(e:Engine,i:Issue) {
 e.s.set('github:example/demo',{observedAt:now,error:null,truncated:false});
 e.s.db.query('INSERT OR REPLACE INTO tickets VALUES(?,?,?,NULL)').run(`example/demo#${i.number}`,JSON.stringify(i),now);
}
function github(issues:Issue[]) {
 const calls:string[][]=[];
 const execute=async(args:string[])=>{
  calls.push(args);
  if(args.includes('pr') && args.includes('list'))return '[]';
  if(args.includes('view'))return JSON.stringify(issues.find(i=>String(i.number)===args[3]));
  if(args.includes('edit')) {
   const i=issues.find(i=>String(i.number)===args[3])!;
   if(args.includes('--body'))i.body=args[args.indexOf('--body')+1];
   for(let n=0;n<args.length;n++){if(args[n]==='--add-label')i.labels.push({name:args[n+1]});if(args[n]==='--remove-label')i.labels=i.labels.filter(l=>l.name!==args[n+1]);}
  }
  return '';
 };return {execute,calls};
}
test('low supply wakes Product once, retries once, then a durable owner default',()=>{
 const e=setup();try {
  supply(e,[],now);supply(e,[],now+60000);
  let wakes=(e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='owner-wake-queued');expect(wakes).toHaveLength(1);
  const first=e.s.get<any>('intake-round');expect(e.s.get<any>(`owner-wake:${first.wake}`).payload.target).toBe(5);
  supply(e,[],now+1800001);const second=e.s.get<any>('intake-round');expect(second.attempt).toBe(2);
  supply(e,[],now+3600002);supply(e,[],now+3700002);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='autonomy-owner-decision')).toHaveLength(1);
  expireDecisions(e.s,now+11000000);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='autonomy-decision-default')).toHaveLength(1);
  // A live owner is never duplicated after its logical deadline.
  e.s.set(`owner-wake:${second.wake}`,{state:'running'});supply(e,[],now+12000000);
  expect(e.s.get<any>('intake-round').attempt).toBe(2);
 }finally{e.s.close();}
});
test('target is current slots plus three; claimed digests do not fill the buffer',()=>{
 const e=setup();try {
  e.c.capacity.controller={start:6,max:12,interval_minutes:60,busy_above:.8,failure_below:.3};
  const ready=Array.from({length:9},(_,n)=>prospective('example/demo',issue(n+1)));
  supply(e,ready,now);expect(e.s.get('intake-round')).toBeNull();
  supply(e,ready.slice(0,8),now);expect(e.s.get<any>('intake-round').attempt).toBe(1);
  supply(e,ready,now);expect(e.s.get<any>('intake-round').closed).toBe(true);
 }finally{e.s.close();}
});
test('policy approves useful disjoint leaves, only one docs leaf, rejects protected, oversized, conflicting and unexplained estimates',async()=>{
 const e=setup();try {
  const issues=[issue(1),issue(2,{paths:['docs/a.md']}),issue(3,{paths:['docs/b.md']}),issue(4,{paths:['launcher/config.ts']}),issue(5,{estimateSeconds:1801}),issue(6,{paths:['src/task-1.ts/sub']}),issue(7,{estimateBasis:''}),issue(8,{costCents:101}),issue(9,{paths:['./.github/workflows/check.yaml']}),issue(10,{paths:['docs/AGENTS.md']})];
  for(const i of issues)snapshot(e,i);
  const gh=github(issues);
  expect(await autoApprove(e,[],undefined,now,gh.execute)).toBe(2);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='intake-auto-approved')).toHaveLength(2);
  expect(issues[0].labels.some(l=>l.name===intakeLabel('example/demo',issues[0]))).toBe(true);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='autonomy-owner-decision')).toHaveLength(8);
  expect(await autoApprove(e,[],undefined,now,gh.execute)).toBe(0); // source replay cannot approve twice
  expect(e.s.get('round-docs:initial')).toBe(1);
 }finally{e.s.close();}
});
test('changed body between policy review and approval never receives a digest label',async()=>{
 const e=setup();try {
  const i=issue();snapshot(e,i);const changed={...i,body:i.body.replace('src/task-1.ts','AGENTS.md')};const gh=github([changed]);
  expect(await autoApprove(e,[],undefined,now,gh.execute)).toBe(0);
  expect(gh.calls.some(a=>a.includes('--add-label'))).toBe(false);
 }finally{e.s.close();}
});
test('stale or truncated sources cannot auto approve and malformed areas route to owner',async()=>{
 const e=setup();try {
  const i=issue();snapshot(e,i);const gh=github([i]);
  e.s.set('github:example/demo',{observedAt:now,truncated:true});expect(await autoApprove(e,[],undefined,now,gh.execute)).toBe(0);
  e.s.set('github:example/demo',{observedAt:now-1});expect(await autoApprove(e,[],undefined,now,gh.execute)).toBe(0);
  expect(gh.calls).toHaveLength(0);
 }finally{e.s.close();}
});
test('failure classes are deterministic and unknown evidence does not become retry success',()=>{
 expect(classifyFailure('token budget pause')).toBe('budget');expect(classifyFailure('CouldntReadCurrentDirectory')).toBe('sandbox');expect(classifyFailure('publisher timed out')).toBe('timeout');expect(classifyFailure('publisher test failed')).toBe('test');expect(classifyFailure('empty delivery')).toBe('publisher');expect(classifyFailure('native receipt missing')).toBe('unknown');
});
function failed(e:Engine,n=1) {
 const i=issue(n),t=prospective('example/demo',i);i.labels.push({name:t.approvalDigest!});
 const x=e.admit(t,admission());e.finish(x.id,false);
 e.s.event(`failure:${x.id}`,'worker-failure',{id:x.id,error:'publisher executable test failed'},'retain',now);
 e.s.db.query('UPDATE sessions SET native_id=? WHERE id=?').run('fixture-native',x.id);
 e.s.set(`cleanup-evidence:${x.id}`,{verified:true});
 return {x,i};
}
function diagnosis(e:Engine,id:string,session:string,scratch:string) {
 writeFileSync(join(scratch,'retry.json'),JSON.stringify({session,diagnosis:'Correct synthetic test command after inspecting the retained receipt',estimateBasis:'Same bounded leaf and original estimate based on source inspection',test:'bun test',outcome:'Correct this synthetic leaf with executable verification'}));
 e.s.set(`owner-wake:${id}`,{id,owner:'builder',kind:'failure-diagnosis',payload:e.s.get(`failure-class:${session}`),state:'done',cleanupVerified:true,scratch});
}
test('verified stopped failure gets one fresh digest, retained custody/debit, then normal admission',async()=>{
 const e=setup();try {
  const {x,i}=failed(e);failures(e,now);const dir=mkdtempSync(join(tmpdir(),'factory-auto-'));diagnosis(e,'fixture-diagnosis',x.id,dir);
  const gh=github([i]);await applyOwnerResults(e,dir,undefined,now,gh.execute);
  expect(e.sessions()[0].status).toBe('archived');expect(e.s.get(`automatic-retry:${x.ticket}`)).not.toBeNull();
  const t=prospective('example/demo',i);expect(t.approvalDigest).not.toBe(x.approval_digest);
  expect(e.retryPrior(t).map(x=>x.id)).toEqual([x.id]);
  const y=e.admit(t,{...admission(),retryNoPr:[x.id]});expect(y.attempt).toBe(2);expect(e.s.rows('debits')).toHaveLength(2);
  e.finish(y.id,false);failures(e,now+60000);
  expect(e.s.get(`owner-wake:diagnose:${y.id}`)).toBeNull();
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='automatic-retry-planned')).toHaveLength(1);
 }finally{e.s.close();}
});
for(const blocker of ['no-cleanup','live','has-pr','changed','unverified-owner'])test(`automatic retry fails closed: ${blocker}`,async()=>{
 const e=setup();try {
  const {x,i}=failed(e);failures(e,now);const dir=mkdtempSync(join(tmpdir(),'factory-auto-'));diagnosis(e,'fixture-diagnosis',x.id,dir);
  if(blocker==='no-cleanup')e.s.set(`cleanup-evidence:${x.id}`,{verified:false});
  if(blocker==='live')e.s.db.query('UPDATE sessions SET pid=? WHERE id=?').run(process.pid,x.id);
  if(blocker==='has-pr')e.s.event('delivered','launcher-publish',{id:x.id,url:'fixture'},'retain');
  if(blocker==='changed')i.body=i.body.replace('src/task-1.ts','src/other.ts');
  if(blocker==='unverified-owner')e.s.set('owner-wake:fixture-diagnosis',{...e.s.get<any>('owner-wake:fixture-diagnosis'),cleanupVerified:false});
  await applyOwnerResults(e,dir,undefined,now,github([i]).execute);
  expect(e.s.get(`automatic-retry:${x.ticket}`)).toBeNull();expect(e.sessions()).toHaveLength(1);
 }finally{e.s.close();}
});
test('cause restart budget pauses only that cause and diagnosis deadlines escalate once',()=>{
 const e=setup();try {
  for(let n=1;n<=3;n++){failed(e,n);e.archive(e.sessions().find(x=>x.ticket.endsWith('#'+n))!.id,'synthetic verified cleanup','owner');}
  failures(e,now);failures(e,now+3600001);
  expect(e.s.get('restart-held:example/demo:codex:test')).not.toBeNull();
  expect(e.s.get('restart-held:example/demo:codex:sandbox')).toBeNull();
  expect(e.s.get('paused')).toBe(false);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='failure-classified')).toHaveLength(3);
 }finally{e.s.close();}
});
test('overlapping tick effects have one durable lease; throw releases it',async()=>{
 const e=setup();try {
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);let ran=0;
  const a=autonomyEffects(e.s,async()=>{ran++;await wait;},()=>"fixture-process");
  expect(await autonomyEffects(e.s,async()=>ran++,()=>"fixture-process")).toBeUndefined();release();await a;expect(ran).toBe(1);
  await expect(autonomyEffects(e.s,async()=>{throw Error('fixture');},()=>"fixture-process")).rejects.toThrow();
  await autonomyEffects(e.s,async()=>ran++,()=>"fixture-process");expect(ran).toBe(2);
 }finally{e.s.close();}
});
test('capacity grows one per continuous healthy hour, caps at 12, retains state on restart',()=>{
 const e=setup();try {
  e.c.capacity.controller={start:6,max:12,interval_minutes:60,busy_above:.8,failure_below:.3};
  expect(slotLimit(e.s,e.c)).toBe(6);
  for(let minute=0;minute<=420;minute++)reconcileCapacity(e.s,e.c,slotLimit(e.s,e.c),'normal',now+minute*60000);
  expect(slotLimit(e.s,e.c)).toBe(12);expect(slotLimit(e.s,new Engine(e.s,e.c).c)).toBe(12);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='capacity-increased')).toHaveLength(6);
 }finally{e.s.close();}
});
for(const pressure of ['unknown','warning','critical'] as const)test(`capacity refuses growth with ${pressure} pressure, gaps, low occupancy and 30% failures`,()=>{
 const e=setup();try {
  e.c.capacity.controller={start:6,max:12,interval_minutes:60,busy_above:.8,failure_below:.3};
  for(let m=0;m<=60;m++)reconcileCapacity(e.s,e.c,6,pressure,now+m*60000);
  expect(slotLimit(e.s,e.c)).toBe(6);
  reconcileCapacity(e.s,e.c,6,'normal',now+120*60000);reconcileCapacity(e.s,e.c,6,'normal',now+180*60000);expect(slotLimit(e.s,e.c)).toBe(6);
  for(let n=0;n<10;n++)e.s.event(`exit:c${n}`,'worker-exit',{id:`c${n}`,ok:n>=3},'retain',now+181*60000);
  for(let m=181;m<=240;m++)reconcileCapacity(e.s,e.c,6,'normal',now+m*60000);
  expect(slotLimit(e.s,e.c)).toBe(6);
  reconcileCapacity(e.s,e.c,4,'normal',now+241*60000);expect(e.s.get<any>('capacity-controller').healthySince).toBeNull();
 }finally{e.s.close();}
});
test('verified intake output becomes one durable proposal and restart readback prevents duplicate creates',async()=>{
 const e=setup();try {
  const scratch=mkdtempSync(join(tmpdir(),'factory-intake-'));
  writeFileSync(join(scratch,'intake.json'),JSON.stringify({tickets:[{repo:'example/demo',title:'Useful controller leaf',brief:{...ticket(),area:'controller',kind:'fix',estimateBasis:'Bounded synthetic source inspection supports this small leaf'}}]}));
  const wake={id:'intake-fixture',owner:'builder',kind:'product-intake',payload:{round:'fixture-round'},state:'done',cleanupVerified:true,scratch};
  e.s.set('owner-wake:intake-fixture',wake);
  let creates=0;const calls:string[][]=[];
  const execute=async(args:string[])=>{calls.push(args);if(args.includes('list'))return '[]';if(args.includes('issue') && args.includes('create')){creates++;return 'https://github.com/example/demo/issues/12';}return '';};
  await applyOwnerResults(e,scratch,undefined,now,execute);
  expect(creates).toBe(1);expect(e.s.get('proposal-round:example/demo#12')).toBe('fixture-round');
  e.s.set('owner-result:intake-fixture',null);await applyOwnerResults(e,scratch,undefined,now,execute);expect(creates).toBe(1);
  expect(calls.some(a=>a.includes('factory-event:intake-fixture'))).toBe(false); // data lives in the JSON body, no executable event command
  expect(e.s.get<any>('owner-result:intake-fixture').applied).toBe(true);
 }finally{e.s.close();}
});
test('publisher failure counts against capacity even after successful native exit',()=>{
 const e=setup();try {
  e.c.capacity.controller={start:6,max:12,interval_minutes:60,busy_above:.8,failure_below:.3};
  e.s.event('native-ok','worker-exit',{id:'x',ok:true},'retain',now);e.s.event('publish-failed','worker-failure',{id:'x',error:'publish failed'},'retain',now+1);
  reconcileCapacity(e.s,e.c,6,'normal',now+2);expect(e.s.get<any>('capacity-controller').failureRate).toBe(1);
 }finally{e.s.close();}
});
test('only useful published work rearms an exhausted intake round',()=>{
 const e=setup();try {
  supply(e,[],now);supply(e,[],now+1800001);
  const round=e.s.get<any>('intake-round');
  const docs=e.admit({...ticket(21),paths:['docs/fixture.md']},admission());e.finish(docs.id,true);
  e.s.event('publish-doc','launcher-publish',{id:docs.id},'retain',now+1800002);
  supply(e,[],now+3600002);expect(e.s.get<any>('intake-round').id).toBe(round.id);
  const code=e.admit(ticket(22),admission());e.finish(code.id,true);
  e.s.event('publish-code','launcher-publish',{id:code.id},'retain',now+3600003);
  supply(e,[],now+3600004);expect(e.s.get<any>('intake-round').id).not.toBe(round.id);
 }finally{e.s.close();}
});
test('a restart hold acquired after retry approval still blocks final admission',async()=>{
 const e=setup();try {
  const {x,i}=failed(e);failures(e,now);const dir=mkdtempSync(join(tmpdir(),'factory-auto-'));diagnosis(e,'fixture-diagnosis',x.id,dir);
  await applyOwnerResults(e,dir,undefined,now,github([i]).execute);
  e.s.set('restart-held:example/demo:codex:test',{at:now});
  expect(()=>e.admit(prospective('example/demo',i),{...admission(),retryNoPr:[x.id]})).toThrow('restart budget held');
  expect(e.sessions()).toHaveLength(1);
 }finally{e.s.close();}
});
