import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigSchema} from '../launcher/config';
import {TestEngine as Engine} from './fixtures';
import {Store} from '../tracking/store';
import {applyOwnerResults,autoApprove,supply} from '../launcher/autonomy';
import {enforceIntakeMode,intakeInstructions} from '../launcher/intake-policy';
import {config,ticket,admission,now} from './fixtures';
import type {Issue} from '../adapters/github';
function setup() {
 const c=ConfigSchema.parse({...config(),autonomy:{intake_owner:'builder',ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['.github']},restart:{max_retries:1,causes_per_hour:3}}});
 const e=new Engine(new Store(':memory:'),c);e.pause(false,'owner');return e;
}
const scratch=()=>mkdtempSync(join(tmpdir(),'factory-drain-'));
const quote='Add the intake trigger and the failure classifier.';
function plan(dir:string){writeFileSync(join(dir,'autonomy-correction-plan.md'),`## 5. Steps\n**A4. Close the loop.**\n${quote}\n**A5. Qualification.**\nOther scope.\n## 6. Metrics\n`);}
const brief=(intakeEvidence?:unknown)=>({...ticket(),kind:'fix',area:'controller',estimateBasis:'Synthetic bounded existing-work repair with a concrete source',intakeEvidence});
test('mode defaults to drain, accepts build, rejects unknown values',()=>{
 const e=setup();try {
  expect(e.c.autonomy!.intake_mode).toBe('drain');
  expect(ConfigSchema.parse({...e.c,autonomy:{...e.c.autonomy,intake_mode:'build'}}).autonomy!.intake_mode).toBe('build');
  expect(()=>ConfigSchema.parse({...e.c,autonomy:{...e.c.autonomy,intake_mode:'other'}})).toThrow();
 }finally{e.s.close();}
});
test('drain checks open issue and PR readbacks and fails closed on closed, wrong and unavailable evidence',async()=>{
 const e=setup();try {
  for(const kind of ['issue','pr']) {
   const raw=brief({kind,number:42});const calls:string[][]=[];
   await enforceIntakeMode(e,'example/demo',raw,scratch(),async args=>{calls.push(args);return JSON.stringify({number:42,state:'OPEN'});});
   expect(calls[0].slice(0,4)).toEqual(['gh',kind,'view','42']);expect(calls[0]).toContain('example/demo');
   for(const source of [{number:42,state:'CLOSED'},{number:43,state:'OPEN'},{}])await expect(enforceIntakeMode(e,'example/demo',raw,scratch(),async()=>JSON.stringify(source))).rejects.toThrow();
   await expect(enforceIntakeMode(e,'example/demo',raw,scratch(),async()=>{throw Error('offline');})).rejects.toThrow();
  }
  await expect(enforceIntakeMode(e,'example/demo',{...brief({kind:'issue',number:42}),kind:'feature'},scratch())).rejects.toThrow('repairs only');
 }finally{e.s.close();}
});
test('only recorded failures in the same repo qualify; active work keeps custody',async()=>{
 const e=setup();try {
  const active=e.admit(ticket(),admission());const raw=brief({kind:'session',session:active.id});
  await expect(enforceIntakeMode(e,'example/demo',raw,scratch())).rejects.toThrow('failed session');
  e.finish(active.id,false);e.s.event('failure-fixture','worker-failure',{id:active.id,error:'test failed'},'retain',now);
  await enforceIntakeMode(e,'example/demo',raw,scratch());
  await expect(enforceIntakeMode(e,'other/repo',raw,scratch())).rejects.toThrow('wrong repo');
  const running=e.admit(ticket(2),admission());supply(e,[],now);
  expect(e.sessions().find(x=>x.id===running.id)?.status).toBe(running.status);
  expect(e.s.get<any>(`owner-wake:${e.s.get<any>('intake-round').wake}`).payload.intake_mode).toBe('drain');
 }finally{e.s.close();}
});
test('factory work needs the real step and exact private plan quote, in the factory repo',async()=>{
 const e=setup(),dir=scratch();plan(dir);try {
  const raw=brief({kind:'factory-plan',step:'A4',quote});
  await enforceIntakeMode(e,'fulmar-hq/agent-factory',raw,dir);
  await expect(enforceIntakeMode(e,'example/demo',raw,dir)).rejects.toThrow('belongs');
  await expect(enforceIntakeMode(e,'fulmar-hq/agent-factory',brief({kind:'factory-plan',step:'A5',quote}),dir)).rejects.toThrow('not found');
  await expect(enforceIntakeMode(e,'fulmar-hq/agent-factory',raw,scratch())).rejects.toThrow();
  expect(intakeInstructions(e.c,dir)).toContain(quote);expect(intakeInstructions(e.c,dir)).toContain('empty tickets array');
 }finally{e.s.close();}
});
test('a stale build wake cannot create new scope after drain; empty intake is accepted',async()=>{
 const e=setup(),dir=scratch();try {
  writeFileSync(join(dir,'intake.json'),JSON.stringify({tickets:[{repo:'example/demo',title:'New product scope',brief:brief()}]}));
  const wake={id:'stale-build',owner:'builder',kind:'product-intake',payload:{round:'old',intake_mode:'build'},state:'done',cleanupVerified:true,scratch:dir};e.s.set('owner-wake:stale-build',wake);
  let calls=0;await applyOwnerResults(e,dir,undefined,now,async()=>{calls++;return '';});
  expect(calls).toBe(0);expect(e.s.get<any>('owner-result:stale-build').applied).toBe(false);
  writeFileSync(join(dir,'intake.json'),'{"tickets":[]}');e.s.set('owner-wake:empty',{...wake,id:'empty'});
  await applyOwnerResults(e,dir,undefined,now,async()=>{calls++;return '';});
  expect(calls).toBe(0);expect(e.s.get<any>('owner-result:empty').applied).toBe(true);
 }finally{e.s.close();}
});
test('drain creates referenced repairs and blocks unproven drafts from auto-approval',async()=>{
 const e=setup(),dir=scratch();try {
  writeFileSync(join(dir,'intake.json'),JSON.stringify({tickets:[{repo:'example/demo',title:'Repair existing work',brief:{...brief({kind:'issue',number:42}),execution:{computerControl:false,browser:false,signIn:false,aws:false,localDatabase:false,closeCollaboration:false}}}]}));
  e.s.set('owner-wake:repair',{id:'repair',owner:'builder',kind:'product-intake',payload:{round:'repair'},state:'done',cleanupVerified:true,scratch:dir});
  const calls:string[][]=[];const execute=async(args:string[])=>{calls.push(args);if(args.includes('view'))return '{"number":42,"state":"OPEN"}';if(args.includes('list'))return '[]';if(args.includes('create') && args.includes('issue'))return 'https://github.com/example/demo/issues/12';return '';};
  await applyOwnerResults(e,dir,undefined,now,execute);expect(e.s.get('proposal:repair:0')).toBe(12);
  expect(calls.find(a=>a.includes('--body'))?.join(' ')).toContain('intakeEvidence');
  const i:Issue={number:13,title:'Old new scope draft',body:'```factory\n'+JSON.stringify(brief())+'\n```',url:'',updatedAt:'',state:'OPEN',labels:['state:ready','kind:fix','area:controller'].map(name=>({name}))};
  e.s.set('github:example/demo',{observedAt:now});e.s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/demo#13',JSON.stringify(i),now);
  calls.length=0;expect(await autoApprove(e,[],undefined,now,execute,dir)).toBe(0);expect(calls).toHaveLength(0);
 }finally{e.s.close();}
});
test('auto-approval rechecks the repair source and pins the approved block digest',async()=>{
 const e=setup(),dir=scratch();try {
  const i:Issue={number:13,title:'Repair existing work',body:'```factory\n'+JSON.stringify(brief({kind:'pr',number:42}))+'\n```',url:'',updatedAt:'',state:'OPEN',labels:['state:ready','kind:fix','area:controller'].map(name=>({name}))};
  e.s.set('github:example/demo',{observedAt:now});e.s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/demo#13',JSON.stringify(i),now);
  let state='CLOSED';const calls:string[][]=[];
  const execute=async(args:string[])=>{calls.push(args);if(args[1]==='pr')return JSON.stringify({number:42,state});if(args.includes('view'))return JSON.stringify(i);return '';};
  expect(await autoApprove(e,[],undefined,now,execute,dir)).toBe(0);
  expect(calls.some(a=>a.includes('--add-label'))).toBe(false);
  state='OPEN';calls.length=0;
  expect(await autoApprove(e,[],undefined,now,execute,dir)).toBe(1);
  expect(calls.some(a=>a.includes('--add-label') && a.some(x=>x.startsWith('ready:')))).toBe(true);
 }finally{e.s.close();}
});
test('build explicitly permits proposals without drain evidence',async()=>{
 const e=setup();try {
  e.c.autonomy!.intake_mode='build';let reads=0;
  await enforceIntakeMode(e,'example/demo',{},scratch(),async()=>{reads++;throw Error('not needed');});
  expect(reads).toBe(0);expect(intakeInstructions(e.c,scratch())).toContain('New useful product scope is permitted');
 }finally{e.s.close();}
});

test('an exhausted drain round stops without asking to invent more work',()=>{
 const e=setup();try {
  supply(e,[],now);supply(e,[],now+1800001);supply(e,[],now+3600002);supply(e,[],now+3700002);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='drain-intake-exhausted')).toHaveLength(1);
  expect((e.s.rows('events') as {kind:string}[]).filter(r=>r.kind==='autonomy-owner-decision')).toHaveLength(0);
 }finally{e.s.close();}
});
