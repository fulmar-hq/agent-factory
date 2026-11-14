import {test,expect} from 'bun:test';
import {githubPages} from '../adapters/github-pages';
import {reconcile,intakeLabel} from '../adapters/github';
import {refreshPulls} from '../board/pulls';
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
  expect(calls).toBe(3);expect(result.map(t=>t.number)).toEqual([1002]);expect(s.get<any>('github:example/demo')).toMatchObject({count:1,truncated:false});
  expect(JSON.parse((s.rows('tickets') as any[]).find(t=>t.id==='example/demo#1').snapshot).state).toBe('CLOSED');
 }finally{s.close();}
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
   else {await refreshPulls(s,config(),now,execute);expect(s.get('board-pulls:example/demo')).toBeNull();}
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

test('repository underscores remain literal when finding missing open snapshots',async()=>{
 const s=new Store(':memory:'),c=config();c.projects.demo.repo='example/foo_bar';
 s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/fooXbar#1',JSON.stringify(issue(1)),now-1);
 let calls=0;try{
  await reconcile(s,c,now,async()=>{calls++;return '[[]]';},'open');
  expect(calls).toBe(2);expect(s.get<any>('github:example/foo_bar').error).toBeNull();
 }finally{s.close();}
});

test('shifted REST pages cannot hide an unseen or reopened ready issue before a stable follow-up',async()=>{
 for(const previouslyClosed of [false,true]){
  const s=new Store(':memory:'),lost={...issue(101),body:'```factory\n'+JSON.stringify(ticket(101))+'\n```',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};lost.labels.push({name:intakeLabel('example/demo',lost)});
  if(previouslyClosed)s.db.query('INSERT INTO tickets VALUES(?,?,?,NULL)').run('example/demo#101',JSON.stringify({...lost,state:'CLOSED'}),now-1);
  const row=(n:number)=>rest(n===101?lost:issue(n));
  // #201 closes after page one, shifting #101 off page two. Both reads have
  // 200 rows; only exact identities/content reveal the incomplete first pass.
  const shifted=[Array.from({length:100},(_,n)=>row(201-n)),Array.from({length:100},(_,n)=>row(100-n))];
  const stable=[Array.from({length:100},(_,n)=>row(200-n)),Array.from({length:100},(_,n)=>row(100-n))];
  let reads=0;
  try{
   const before=s.rows('tickets');
   expect(await reconcile(s,config(),now,async()=>JSON.stringify(reads++===0?shifted:stable),'open')).toEqual([]);
   expect(s.rows('tickets')).toEqual(before);expect(s.get<any>('github:example/demo').error).toContain('changed between complete observations');expect(reads).toBe(2);
   const ready=await reconcile(s,config(),now+1,async()=>JSON.stringify(stable),'open');
   expect(ready.map(t=>t.number)).toEqual([101]);expect(s.get<any>('github:example/demo').error).toBeNull();
  }finally{s.close();}
 }
});
