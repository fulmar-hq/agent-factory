import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {Store} from '../tracking/store';
import {TestEngine as Engine,config} from './fixtures';
import {intakeContext,completeIntakeDraft} from '../launcher/intake-context';
const digest=(body:string)=>createHash('sha256').update(body).digest('hex');
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
 const e=new Engine(new Store(':memory:'),config());
 const issue={number:7,title:'Show request summary',body:'Existing product outcome.\n\n```factory\n{"old":"incomplete"}\n```',state:'OPEN',labels:[{name:'state:ready'},{name:'kind:fix'},{name:'area:runtime'}]};
 const proposal={repo:'example/demo',title:issue.title,existingIssue:7,bodyDigest:digest(issue.body)};
 const brief={category:'product',kind:'fix',area:'runtime',intakeEvidence:{kind:'issue',number:7},paths:['src/summary.ts'],outcome:'Show saved request summary'};
 const calls:string[][]=[];
 const execute=async(args:string[])=>{calls.push(args);if(args.includes('view'))return JSON.stringify(issue);if(args.includes('--body'))issue.body=args[args.indexOf('--body')+1];return '';};
 return {e,issue,proposal,brief,calls,execute};
}
test('unapproved product draft keeps prose and original issue; lost edit response reuses retained exact body',async()=>{
 const f=fixture();let lost=true;
 const execute=async(args:string[])=>{const v=await f.execute(args);if(args.includes('--body')&&lost){lost=false;throw Error('lost response');}return v;};
 try{
  await expect(completeIntakeDraft(f.e,f.proposal,f.brief,'proposal:fixture:0',execute)).rejects.toThrow('lost response');
  expect(await completeIntakeDraft(f.e,f.proposal,f.brief,'proposal:fixture:0',execute)).toBe(7);
  expect(f.issue.body).toContain('Existing product outcome.');expect(f.issue.body).not.toContain('"old"');
  expect(f.issue.body.match(/```factory/g)).toHaveLength(1);
  expect(f.calls.filter(a=>a.includes('--body'))).toHaveLength(1);
  expect(f.calls.some(a=>a.includes('create'))).toBe(false);
  expect(f.e.s.get('proposal:fixture:0')).toBe(7);
 }finally{f.e.s.close();}
});
for(const condition of ['changed','approved','building','blocked','attempted','wrong-source'])test(`draft completion refuses ${condition} without edits`,async()=>{
 const f=fixture();try{
  if(condition==='changed')f.issue.body+=' Owner edit.';
  if(condition==='approved')f.issue.labels.push({name:'ready:old'});
  if(condition==='building'||condition==='blocked')f.issue.labels[0]={name:`state:${condition}`};
  if(condition==='attempted')f.e.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('prior','example/demo#7','builder','codex','archived','{}');
  if(condition==='wrong-source')f.brief.intakeEvidence.number=8;
  await expect(completeIntakeDraft(f.e,f.proposal,f.brief,'proposal:fixture:0',f.execute)).rejects.toThrow();
  expect(f.calls.some(a=>a.includes('edit'))).toBe(false);
 }finally{f.e.s.close();}
});
