import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {config,ticket,now,TestEngine} from './fixtures';
import {ConfigSchema} from '../launcher/config';
import {enforceIntakeMode,intakeInstructions} from '../launcher/intake-policy';
import {reviewProductChanges,importHistoricalReviews,reviewDepth,reviewChecksGreen,type CodeReviewPort} from '../launcher/code-review';
import type {BoardPull} from '../board/pulls';
const policy={review_process:{rule:'one independent exact-head review on the same ticket and PR after green checks; never refill work',standard_minutes:15,deep_minutes:30,deep_when:'tenant separation, consent, sends, bookings, permissions, money or migrations'},refill:{rule:'product tasks only from the real backlog; never review or acceptance tickets',report_mix:true}};
const setup=()=>new TestEngine(new Store(':memory:'),ConfigSchema.parse({...config(),...policy,projects:{alido:{repo:'fulmar-hq/alido',owners:['builder'],tests:'bun test'}}}));
const p=(n=1):BoardPull=>({number:n,url:`https://github.com/fulmar-hq/alido/pull/${n}`,headRefOid:'a'.repeat(40),baseRefName:'QA',reviews:[],statusCheckRollup:['Verify','Secret scan'].map(name=>({name,status:'COMPLETED',conclusion:'SUCCESS'}))});
test('green requires actual verification and security; release hold stays a merge gate',()=>{
 expect(reviewChecksGreen(p(),'fulmar-hq/alido')).toBe(true);
 expect(reviewChecksGreen({...p(),statusCheckRollup:[]},'fulmar-hq/alido')).toBe(false);
 for(const bad of ['FAILURE','CANCELLED','PENDING'])expect(reviewChecksGreen({...p(),statusCheckRollup:[{name:'Verify',state:bad}]},'fulmar-hq/alido')).toBe(false);
 expect(reviewChecksGreen({...p(),statusCheckRollup:[...p().statusCheckRollup,{name:'Release hold',status:'IN_PROGRESS'}]},'fulmar-hq/alido')).toBe(true);
});
test('deep review follows one written risk rule across paths and changed content',()=>{
 for(const path of ['drizzle/001.sql','src/booking.ts','src/permissions.ts','src/tenant.ts','src/consent.ts','src/send.ts','src/billing.ts','src/pricing.ts','src/calendar.ts','src/auth.ts'])expect(reviewDepth([{filename:path}])).toBe('deep');
 expect(reviewDepth([{filename:'src/widget.ts',patch:'+ authorizeTenant(ctx)'}])).toBe('deep');
 expect(reviewDepth([{filename:'src/format.ts',patch:'+ return label.trim()'}])).toBe('standard');
});
test('automatic review reuses exact-head receipts and protects the frozen carrier and sources',async()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'code-review-'));let runs=0;
 try {
  writeFileSync(join(dir,'release-batch.json'),JSON.stringify({pr:2901,sources:[{number:1}]}));
  const port:CodeReviewPort={pulls:async()=>[p(1),p(2),p(3),p(2901)],files:async()=>[{filename:'src/booking.ts'}],review:async(pr,checkout,target,claimed)=>{runs++;expect(pr.number).toBe(2);expect(target.depth).toBe('deep');expect(checkout).toBe('/fake/source');claimed();e.s.set(`code-review:${target.repo}:${pr.number}:${pr.head}`,{state:'done'});return undefined;}};
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake/source'},port,now);expect(runs).toBe(1);
  port.pulls=async()=>[p(1),p(2),p(2901)];
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake/source'},port,now);expect(runs).toBe(1);
  writeFileSync(join(dir,'release-batch.json'),'{}');await expect(reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake/source'},port,now)).rejects.toThrow('protection');
 }finally{e.s.close();}
});
test('product refill rejects disguised reviews, nonbacklog sources and stale review drafts',async()=>{
 const e=setup();try {
  const raw={...ticket(),category:'product',kind:'fix',title:'Show calendar conflict',outcome:'Show the conflict beside the selected time',intakeEvidence:{kind:'issue',number:42}};
  const read=async()=>JSON.stringify({number:42,state:'OPEN',title:'Show calendar conflict',labels:[]});
  await enforceIntakeMode(e,'fulmar-hq/alido',raw,'/unused',read);
  for(const extra of [{title:'Challenge calendar conflicts'},{outcome:'Independently review calendar fixes'},{outcome:'Perform a read-only acceptance of the change'},{paths:['docs/work/booking-challenge.md']},{category:'review'},{intakeEvidence:{kind:'pr',number:42}}])await expect(enforceIntakeMode(e,'fulmar-hq/alido',{...raw,...extra},'/unused',read)).rejects.toThrow();
  await expect(enforceIntakeMode(e,'fulmar-hq/alido',raw,'/unused',async()=>JSON.stringify({number:42,state:'OPEN',title:'Accept calendar change',labels:[]}))).rejects.toThrow();
  expect(intakeInstructions(e.c,'/unused')).toContain('mix: {product: ticket count, other: 0}');
 }finally{e.s.close();}
});
test('empty refills report their mix and invalid mixed refills create no issue',async()=>{
 const {applyOwnerResults}=await import('../launcher/autonomy');const e=setup(),dir=mkdtempSync(join(tmpdir(),'product-refill-'));
 e.c.autonomy={intake_mode:'build',intake_owner:'builder',idle_wake_minutes:10,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['.github']},restart:{max_retries:1,causes_per_hour:3}};e.pause(false,'owner');
 try {
  const wake={id:'empty',owner:'builder',kind:'product-intake',payload:{round:'r'},state:'done',cleanupVerified:true,scratch:dir};
  writeFileSync(join(dir,'intake.json'),JSON.stringify({tickets:[],mix:{product:0,other:0}}));e.s.set('owner-wake:empty',wake);
  let calls=0;await applyOwnerResults(e,dir,undefined,now,async()=>{calls++;return '';});
  expect(calls).toBe(0);expect(e.s.get<any>('owner-result:empty')).toMatchObject({applied:true,mix:{product:0,other:0}});
  writeFileSync(join(dir,'intake.json'),JSON.stringify({tickets:[],mix:{product:0,other:1}}));e.s.set('owner-wake:mixed',{...wake,id:'mixed'});
  await applyOwnerResults(e,dir,undefined,now,async()=>{calls++;return '';});
  expect(calls).toBe(0);expect(e.s.get<any>('owner-result:mixed')).toMatchObject({applied:false,mix:{product:0,other:1}});
 }finally{e.s.close();}
});
test('pending historical migration never invents approvals or blocks actual new reviews',async()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'historical-reviews-'));try {
  e.c.review_process!.historical_receipts='pending';let reads=0;
  const port:CodeReviewPort={pulls:async()=>{reads++;return [p()];},files:async()=>[],review:async()=>undefined};
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake'},port,now);expect(reads).toBe(1);
  writeFileSync(join(dir,'historical-review-receipts.json'),JSON.stringify({complete:true,reviews:[{repo:'fulmar-hq/alido',pr:1,head:'a'.repeat(40),session:'invented',native:'invented',verdict:'PASS',verdictUrl:'https://github.com/fulmar-hq/alido/pull/1#issuecomment-1',evidence:'Reviewed exact source head '+'a'.repeat(40)}]}));
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake'},port,now);expect(reads).toBe(2);expect(e.s.get('historical-review-migration')).toMatchObject({complete:false,pending:1});
  expect(e.s.get('code-review:fulmar-hq/alido:1:'+'a'.repeat(40))).toBeNull();
 }finally{e.s.close();}
});

test('historical verdicts require the retained native result for that exact target and verdict',()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'review-result-binding-'));
 const native='fictional-independent-review';
 try {
  e.s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief,native_id) VALUES(?,?,?,?,?,?,?)").run('review-worker','fulmar-hq/alido#8','builder','codex','finished',JSON.stringify({repo:'fulmar-hq/alido',kind:'review',title:'Review PR7 head '+ 'a'.repeat(40)}),native);
  e.s.event('worker-exit:review-worker','worker-exit',{id:'review-worker',ok:true},'fixture');e.s.set('cleanup-evidence:review-worker',{verified:true});
  const record={repo:'fulmar-hq/alido',pr:99,head:'b'.repeat(40),session:'review-worker',native,verdict:'PASS',verdictUrl:'https://github.com/fulmar-hq/alido/pull/99#issuecomment-1',evidence:'Reviewed exact head '+'b'.repeat(40)};
  writeFileSync(join(dir,'historical-review-receipts.json'),JSON.stringify({complete:true,reviews:[record]}));
  const key='code-review:fulmar-hq/alido:99:'+'b'.repeat(40);
  importHistoricalReviews(e.s,e.c,dir);expect(e.s.get(key)).toBeNull();
  const result={repo:'fulmar-hq/alido',pr:7,head:'a'.repeat(40),ok:true,native:{id:native,verified:true},cleanup:{verified:true},review:{head:'a'.repeat(40),verdict:'PASS',findings:[],installedGaps:[]}};
  e.s.event('actual-result','code-review-verdict',result,'fixture');importHistoricalReviews(e.s,e.c,dir);expect(e.s.get(key)).toBeNull();
  e.s.event('wrong-verdict','code-review-verdict',{...result,pr:99,head:record.head,review:{...result.review,head:record.head,verdict:'CHANGES_REQUESTED'}},'fixture');importHistoricalReviews(e.s,e.c,dir);expect(e.s.get(key)).toBeNull();
  e.s.event('bound-result','code-review-verdict',{...result,pr:99,head:record.head,review:{...result.review,head:record.head}},'fixture');importHistoricalReviews(e.s,e.c,dir);expect(e.s.get(key)).toMatchObject({state:'done',retainedResult:'bound-result'});
 }finally{e.s.close();}
});

test('main product bases work and unsupported bases consume no review claim',async()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'review-main-base-'));let reviews=0,files=0,reads=0;
 e.c.projects={demo:{repo:'example/demo',owners:['builder'],tests:'bun test'}};
 const target={...p(9),url:'https://github.com/example/demo/pull/9',baseRefName:'main'};
 try {
  const port:CodeReviewPort={pulls:async()=>{reads++;return [target];},files:async()=>{files++;return [{filename:'src/widget.ts'}];},review:async(pr,source,t,claim)=>{reviews++;expect(t.baseRef).toBe('main');claim();return undefined;}};
  e.s.set('board-pulls:example/demo',{at:now,pulls:[{...target,baseRefName:undefined}]});
  await reviewProductChanges(e.s,e.c,dir,{'example/demo':'/fake'},port,now);expect(reviews).toBe(1);expect(reads).toBe(1);
  target.baseRefName='unexpected';await reviewProductChanges(e.s,e.c,dir,{'example/demo':'/fake'},port,now);expect(reviews).toBe(1);expect(files).toBe(1);
 }finally{e.s.close();}
});

test('unbound old historical keys retain evidence and cannot suppress a real review',async()=>{
 const e=setup(),dir=mkdtempSync(join(tmpdir(),'old-unbound-review-'));let reviews=0;
 try {
  const key='code-review:fulmar-hq/alido:1:'+'a'.repeat(40);e.s.set(key,{historical:true,state:'done',verdict:'PASS'});
  const port:CodeReviewPort={pulls:async()=>[p()],files:async()=>[{filename:'src/widget.ts'}],review:async(pr,source,t,claim)=>{reviews++;expect(e.s.get(key)).toBeNull();claim();return undefined;}};
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake'},port,now);expect(reviews).toBe(1);expect(e.s.db.query("SELECT data FROM events WHERE kind='historical-review-invalidated'").all()).toHaveLength(1);
 }finally{e.s.close();}
});

test('product-only result application cannot create disguised acceptance or scratch tickets',async()=>{
 const {applyOwnerResults}=await import('../launcher/autonomy');const e=setup(),dir=mkdtempSync(join(tmpdir(),'product-only-application-'));
 e.c.autonomy={intake_mode:'build',intake_owner:'builder',idle_wake_minutes:10,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['.github']},restart:{max_retries:1,causes_per_hour:3}};e.pause(false,'owner');
 try {
  const raw={...ticket(),category:'product',kind:'fix',area:'booking',outcome:'Show the selected booking time',intakeEvidence:{kind:'issue',number:42}};
  const cases=[{title:'Booking acceptance result',brief:{...raw,paths:['.factory-tmp'],outcome:'Run hosted acceptance of the booking change and record the verdict.'}}, {title:'Show selected booking time',brief:{...raw,paths:['.factory-tmp']}}, {title:'Show selected booking time',brief:{...raw,paths:['src/calendar.test.ts']}}];
  let creates=0;
  const execute=async(args:string[])=>{if(args.includes('create'))creates++;if(args[1]==='issue'&&args[2]==='view')return JSON.stringify({number:42,state:'OPEN',title:'Hosted booking acceptance',labels:[{name:'kind:accept'}]});return '[]';};
  for(const [n,c] of cases.entries()){
   writeFileSync(join(dir,'intake.json'),JSON.stringify({tickets:[{repo:'fulmar-hq/alido',...c}],mix:{product:1,other:0}}));
   const id='disguised-'+n;e.s.set('owner-wake:'+id,{id,owner:'builder',kind:'product-intake',payload:{round:'r'},state:'done',cleanupVerified:true,scratch:dir});
   await applyOwnerResults(e,dir,undefined,now,execute);expect(e.s.get('owner-result:'+id)).toMatchObject({applied:false});
  }
  expect(creates).toBe(0);
  for(const source of [{title:'Hosted booking acceptance',labels:[]},{title:'Booking outcome',labels:[{name:'kind:accept'}]}])await expect(enforceIntakeMode(e,'fulmar-hq/alido',{...raw,title:'Fix booking display'},dir,async()=>JSON.stringify({number:42,state:'OPEN',...source}))).rejects.toThrow('source');
  for(const copy of ['Change consent accept control copy','Show the Accept button label','Accept button copy','Review progress label','Show website review progress'])await enforceIntakeMode(e,'fulmar-hq/alido',{...raw,title:copy,outcome:copy},dir,async()=>JSON.stringify({number:42,state:'OPEN',title:copy,labels:[{name:'kind:fix'}]}));
 }finally{e.s.close();}
});

test('factory preparation failure consumes the same new-review allowance as the product lane',async()=>{
 const {maintenancePort}=await import('../scripts/maintain-factory');const e=setup(),dir=mkdtempSync(join(tmpdir(),'one-review-pass-')),pass={claims:0};let preparations=0,productCalls=0;
 const run:typeof import('../adapters/factory-challenge').runFactoryChallenge=async(store,pull,root,source,claimed)=>{claimed?.();preparations++;store.set(`factory-challenge:${pull.number}:${pull.head}`,{state:'blocked',error:'fictional fetch failed before native spawn'});return undefined;};
 try {
  const factory=maintenancePort(e.s,run,pass);await factory.challenge({number:7,head:'c'.repeat(40),tree:'',createdAt:'',draft:false,state:'OPEN',mergeState:'CLEAN',verify:true});
  expect(pass.claims).toBe(1);expect(e.s.db.query("SELECT id FROM events WHERE kind='factory-challenge-started'").all()).toHaveLength(0);
  const product:CodeReviewPort={pulls:async()=>{productCalls++;return [p()];},files:async()=>[{filename:'src/widget.ts'}],review:async()=>{productCalls++;return undefined;}};
  await reviewProductChanges(e.s,e.c,dir,{'fulmar-hq/alido':'/fake'},product,now,pass);expect(preparations).toBe(1);expect(productCalls).toBe(0);
 }finally{e.s.close();}
});
