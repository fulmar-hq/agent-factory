import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {config,ticket,now,TestEngine} from './fixtures';
import {ConfigSchema} from '../launcher/config';
import {enforceIntakeMode,intakeInstructions} from '../launcher/intake-policy';
import {reviewProductChanges,reviewDepth,reviewChecksGreen,type CodeReviewPort} from '../launcher/code-review';
import type {BoardPull} from '../board/pulls';
const policy={review_process:{rule:'one independent exact-head review on the same ticket and PR after green checks; never refill work',standard_minutes:15,deep_minutes:30,deep_when:'tenant separation, consent, sends, bookings, permissions, money or migrations'},refill:{rule:'product tasks only from the real backlog; never review or acceptance tickets',report_mix:true}};
const setup=()=>new TestEngine(new Store(':memory:'),ConfigSchema.parse({...config(),...policy,projects:{alido:{repo:'fulmar-hq/alido',owners:['builder'],tests:'bun test'}}}));
const p=(n=1):BoardPull=>({number:n,url:`https://github.com/fulmar-hq/alido/pull/${n}`,headRefOid:'a'.repeat(40),reviews:[],statusCheckRollup:['Verify','Secret scan'].map(name=>({name,status:'COMPLETED',conclusion:'SUCCESS'}))});
test('green requires actual verification and security; release hold stays a merge gate',()=>{
 expect(reviewChecksGreen(p(),'fulmar-hq/alido')).toBe(true);
 expect(reviewChecksGreen({...p(),statusCheckRollup:[]},'fulmar-hq/alido')).toBe(false);
 for(const bad of ['FAILURE','CANCELLED','PENDING'])expect(reviewChecksGreen({...p(),statusCheckRollup:[{name:'Verify',state:bad}]},'fulmar-hq/alido')).toBe(false);
 expect(reviewChecksGreen({...p(),statusCheckRollup:[...p().statusCheckRollup,{name:'Release hold',status:'IN_PROGRESS'}]},'fulmar-hq/alido')).toBe(true);
});
test('deep review follows one written risk rule across paths and changed content',()=>{
 for(const path of ['drizzle/001.sql','src/booking.ts','src/permissions.ts','src/tenant.ts','src/consent.ts','src/send.ts','src/billing.ts'])expect(reviewDepth([{filename:path}])).toBe('deep');
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
