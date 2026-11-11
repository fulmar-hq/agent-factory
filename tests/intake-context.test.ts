import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {TestEngine as Engine,config,ticket} from './fixtures';
import {intakeContext} from '../launcher/intake-context';
import {applyOwnerResults,supply} from '../launcher/autonomy';

test('product refill sees refused ready and real backlog before a large review queue',()=>{
 const review=Array.from({length:70},(_,n)=>({id:`example/site#${n+1}`,labels:[{name:'state:review'}]}));
 const ready={id:'example/site#80',labels:[{name:'state:ready'}],decision:'approved intake changed or approval missing'};
 const backlog={id:'example/site#81',labels:[{name:'kind:feature'}]};
 const factory={id:'fulmar-hq/agent-factory#1',labels:[{name:'state:ready'}]};
 expect(intakeContext([...review,backlog,ready,factory],true).slice(0,2)).toEqual([ready,backlog]);
 expect(intakeContext([...review,backlog,ready,factory],true)).not.toContain(factory);
 expect(intakeContext([backlog,...review],false)[0]).toEqual(review[0]);
});
function fixture(){
 const c=config();c.refill={rule:'product tasks only from the real backlog; never review or acceptance tickets',report_mix:true};
 c.autonomy={intake_mode:'build',intake_owner:'builder',idle_wake_minutes:10,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['AGENTS.md']},restart:{max_retries:1,causes_per_hour:3}};
 const e=new Engine(new Store(':memory:'),c);e.s.set('paused',false);return e;
}
test('supply passes a refused draft decision and source to Product without treating its label as runnable',()=>{
 const e=fixture();try{
  const issue={number:7,title:'Show request summary',body:'Existing coding outcome.',state:'OPEN',labels:[{name:'state:ready'},{name:'kind:fix'},{name:'area:runtime'}]};
  e.s.db.query('INSERT INTO tickets VALUES(?,?,?,?)').run('example/demo#7',JSON.stringify(issue),Date.now(),'Error: factory intake block missing');
  supply(e,[],Date.now());
  const round=e.s.get<{wake:string}>('intake-round')!;
  const wake=e.s.get<{payload:{ready:number;existing:{decision:string;source:string}[];brief:string}}>(`owner-wake:${round.wake}`)!;
  expect(wake.payload.ready).toBe(0);
  expect(wake.payload.existing[0]).toMatchObject({decision:'Error: factory intake block missing',source:'Existing coding outcome.'});
  expect(wake.payload.brief).toContain('named owner');
 }finally{e.s.close();}
});
// GitHub's issue-body update has no proven compare-and-swap contract here.
// Refuse every existing-draft update proposal before even reading remote state:
// there can be no clobber, owner-setup conversion or false label completion.
for(const scenario of ['author-edit-interleaving','owner-only-setup','missing-kind-area-labels','existingIssue-only','bodyDigest-only'])test(`existing draft result fails closed: ${scenario}`,async()=>{
 const e=fixture(),scratch=mkdtempSync(join(tmpdir(),'intake-refused-'));
 const original={body:scenario==='owner-only-setup'?'Owner must enter a sign-in code.':'Retain the author outcome.',labels:scenario==='missing-kind-area-labels'?['state:ready']:['state:ready','kind:fix','area:runtime']};
 const proposal={repo:'example/demo',title:'Configure provider access',brief:{...ticket(),category:'product',kind:'fix',area:'runtime',intakeEvidence:{kind:'issue',number:7}},...(scenario==='bodyDigest-only'?{}:{existingIssue:7}),...(scenario==='existingIssue-only'?{}:{bodyDigest:'a'.repeat(64)})};
 writeFileSync(join(scratch,'intake.json'),JSON.stringify({tickets:[proposal],mix:{product:1,other:0}}));
 const id=`intake:${scenario}`,calls:string[][]=[];
 e.s.set(`owner-wake:${id}`,{id,owner:'builder',kind:'product-intake',payload:{round:'fixture'},state:'done',cleanupVerified:true,scratch});
 try{
  await applyOwnerResults(e,scratch,undefined,Date.now(),async args=>{calls.push(args);throw Error('existing issue update must not reach GitHub');});
  expect(e.s.get(`owner-result:${id}`)).toMatchObject({applied:false});
  expect(calls).toEqual([]);
  expect(original.body).toBe(scenario==='owner-only-setup'?'Owner must enter a sign-in code.':'Retain the author outcome.');
  expect(e.s.get(`proposal:${id}:0`)).toBeNull();
 }finally{e.s.close();}
});
