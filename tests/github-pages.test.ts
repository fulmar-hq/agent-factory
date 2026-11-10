import {test,expect} from 'bun:test';
import {githubPages} from '../adapters/github-pages';
import {reconcile,intakeLabel} from '../adapters/github';
import {githubWakes,pendingWakes} from '../launcher/wake';
import {Store} from '../tracking/store';
import {githubPage,config,ticket,now} from './fixtures';
const issue=(number:number)=>({number,title:'Fictional work',body:'',url:`https://github.com/example/demo/issues/${number}`,updatedAt:'2026-11-10',state:'OPEN',labels:[] as {name:string}[]});
const pr=(number:number)=>({number,title:'Fictional PR',url:`https://github.com/example/demo/pull/${number}`,headRefOid:'a'.repeat(40),reviews:[],statusCheckRollup:[]});
const rest=(i:ReturnType<typeof issue>)=>({...i,state:i.state.toLowerCase(),html_url:i.url,updated_at:i.updatedAt,closed_at:null});
test('scheduler reads only complete open REST inventory while retaining closed history',async()=>{
 const ready={...issue(1002),body:'```factory\n'+JSON.stringify(ticket(1002))+'\n```',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};ready.labels.push({name:intakeLabel('example/demo',ready)});
 const s=new Store(':memory:');let calls=0;
 try{
  const old=issue(1);s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/demo#1',JSON.stringify(old),now-1);
  const result=await reconcile(s,config(),now,async args=>{calls++;if(args.includes('--paginate'))expect(args.at(-1)).toContain('state=open');return args.includes('--paginate')?JSON.stringify([[rest(ready)]]):JSON.stringify({...rest(old),state:'closed',closed_at:'2026-11-10'});},'open');
  expect(calls).toBe(2);expect(result.map(t=>t.number)).toEqual([1002]);expect(s.get<any>('github:example/demo')).toMatchObject({count:1,truncated:false});
  expect(JSON.parse((s.rows('tickets') as any[]).find(t=>t.id==='example/demo#1').snapshot).state).toBe('CLOSED');
 }finally{s.close();}
});
test('owner reconciliation includes second PR page and deduplicates its review',async()=>{
 const s=new Store(':memory:');s.set('owner-github-primed:example/demo',true);
 const rows=Array.from({length:128},(_,n)=>pr(n+1));(rows[127].reviews as any[]).push({id:'last-review',state:'APPROVED',submittedAt:'2026-11-10'});
 try{for(let repeat=0;repeat<2;repeat++){let n=0;await githubWakes(s,config(),async()=>githubPage('pullRequests',rows.slice(n*100,++n*100),{total:128,next:n===1,cursor:`page-${n}`}),now);}expect(s.get<any>('board-pulls:example/demo').pulls).toHaveLength(128);expect(pendingWakes(s).filter(w=>w.kind==='review-returned')).toHaveLength(1);}finally{s.close();}
});
test('late-page failure publishes neither partial tickets nor owner events',async()=>{
 const s=new Store(':memory:');s.set('owner-github-primed:example/demo',true);
 const execute=async()=>{throw Error('second page offline');};
 try{expect(await reconcile(s,config(),now,execute,'open')).toEqual([]);expect(s.rows('tickets')).toEqual([]);expect(s.get<any>('github:example/demo').error).toContain('offline');let p=0;await expect(githubWakes(s,config(),async()=>{if(p++)throw Error('offline');return githubPage('pullRequests',[pr(1)],{total:2,next:true,cursor:'next'});})).rejects.toThrow('offline');expect(pendingWakes(s)).toEqual([]);expect(s.get('board-pulls:example/demo')).toBeNull();}finally{s.close();}
});
test('malformed, repeated and missing cursors, GraphQL errors and changed totals refuse',async()=>{
 for(const scenario of ['missing','repeated','total','duplicate','errors','nested']){let n=0;await expect(githubPages('example/demo','issues',async()=>{n++;const raw=JSON.parse(githubPage('issues',[issue(scenario==='duplicate'?1:n)],{total:scenario==='total'?n+2:3,next:true,cursor:scenario==='missing'?null:'same'}));if(scenario==='errors')raw.errors=[{message:'partial'}];if(scenario==='nested')raw.data.repository.issues.nodes[0].labels.pageInfo.hasNextPage=true;return JSON.stringify(raw);})).rejects.toThrow();expect(n).toBeLessThanOrEqual(2);}
});

test('issue and PR URL identities must exactly match node number before any effects',async()=>{
 for(const kind of ['issues','pullRequests'] as const){
  const s=new Store(':memory:');s.set('owner-github-primed:example/demo',true);
  const rows=kind==='issues'?[issue(1),{...issue(2),url:issue(1).url}]:[pr(1),{...pr(2),url:pr(1).url}];
  const execute=async()=>githubPage(kind,rows);
  try{
   await expect(githubPages('example/demo',kind,execute)).rejects.toThrow('identity mismatch');
   if(kind==='issues'){expect(await reconcile(s,config(),now,execute,'open')).toEqual([]);expect(s.rows('tickets')).toEqual([]);}
   else {await expect(githubWakes(s,config(),execute,now)).rejects.toThrow('identity mismatch');expect(s.get('board-pulls:example/demo')).toBeNull();expect(pendingWakes(s)).toEqual([]);}
  }finally{s.close();}
 }
});

test('offset shifts cannot manufacture closure or publish a partial ready queue',async()=>{
 const s=new Store(':memory:');const lost={...issue(101),body:'```factory\n'+JSON.stringify(ticket(101))+'\n```',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};lost.labels.push({name:intakeLabel('example/demo',lost)});
 s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/demo#101',JSON.stringify(lost),now-1);
 const pages=[Array.from({length:100},(_,n)=>rest(issue(n+1))),Array.from({length:99},(_,n)=>rest(issue(n+102)))];
 try{
  const result=await reconcile(s,config(),now,async args=>JSON.stringify(args.includes('--paginate')?pages:rest(lost)),'open');
  expect(result).toEqual([]);expect(s.get<any>('github:example/demo').error).toContain('inventory changed');
  expect(JSON.parse((s.rows('tickets') as any[])[0].snapshot).state).toBe('OPEN');expect(s.rows('tickets')).toHaveLength(1);
 }finally{s.close();}
});
