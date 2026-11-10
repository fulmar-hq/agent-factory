import {test,expect} from 'bun:test';
import {githubPages} from '../adapters/github-pages';
import {reconcile,intakeLabel} from '../adapters/github';
import {githubWakes,pendingWakes} from '../launcher/wake';
import {Store} from '../tracking/store';
import {githubPage,config,ticket,now} from './fixtures';
const issue=(number:number)=>({number,title:'Fictional work',body:'',url:`https://github.com/example/demo/issues/${number}`,updatedAt:'2026-11-10',state:'OPEN',labels:[] as {name:string}[]});
const pr=(number:number)=>({number,title:'Fictional PR',url:`https://github.com/example/demo/pull/${number}`,headRefOid:'a'.repeat(40),reviews:[],statusCheckRollup:[]});
test('more than 1000 historical issues do not suppress approved ready work',async()=>{
 const rows=Array.from({length:1001},(_,n)=>({...issue(n+1),state:'CLOSED'}));
 const ready={...issue(1002),body:'```factory\n'+JSON.stringify(ticket(1002))+'\n```',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};ready.labels.push({name:intakeLabel('example/demo',ready)});rows.push(ready);
 const s=new Store(':memory:');let n=0;
 try{const result=await reconcile(s,config(),now,async args=>{expect(args).toContain('graphql');if(n)expect(args).toContain(`endCursor=page-${n}`);const batch=rows.slice(n*100,++n*100);return githubPage('issues',batch,{total:rows.length,next:n*100<rows.length,cursor:`page-${n}`});});expect(result.map(t=>t.number)).toEqual([1002]);expect(s.get<any>('github:example/demo')).toMatchObject({count:1002,truncated:false});}finally{s.close();}
});
test('owner reconciliation includes second PR page and deduplicates its review',async()=>{
 const s=new Store(':memory:');s.set('owner-github-primed:example/demo',true);
 const rows=Array.from({length:128},(_,n)=>pr(n+1));(rows[127].reviews as any[]).push({id:'last-review',state:'APPROVED',submittedAt:'2026-11-10'});
 try{for(let repeat=0;repeat<2;repeat++){let n=0;await githubWakes(s,config(),async()=>githubPage('pullRequests',rows.slice(n*100,++n*100),{total:128,next:n===1,cursor:`page-${n}`}),now);}expect(s.get<any>('board-pulls:example/demo').pulls).toHaveLength(128);expect(pendingWakes(s).filter(w=>w.kind==='review-returned')).toHaveLength(1);}finally{s.close();}
});
test('late-page failure publishes neither partial tickets nor owner events',async()=>{
 const s=new Store(':memory:');s.set('owner-github-primed:example/demo',true);
 let n=0;const execute=async()=>{if(n++)throw Error('second page offline');return githubPage('issues',[issue(1)],{total:2,next:true,cursor:'next'});};
 try{expect(await reconcile(s,config(),now,execute)).toEqual([]);expect(s.rows('tickets')).toEqual([]);expect(s.get<any>('github:example/demo').error).toContain('offline');let p=0;await expect(githubWakes(s,config(),async()=>{if(p++)throw Error('offline');return githubPage('pullRequests',[pr(1)],{total:2,next:true,cursor:'next'});})).rejects.toThrow('offline');expect(pendingWakes(s)).toEqual([]);expect(s.get('board-pulls:example/demo')).toBeNull();}finally{s.close();}
});
test('malformed, repeated and missing cursors, GraphQL errors and changed totals refuse',async()=>{
 for(const scenario of ['missing','repeated','total','duplicate','errors','nested']){let n=0;await expect(githubPages('example/demo','issues',async()=>{n++;const raw=JSON.parse(githubPage('issues',[issue(scenario==='duplicate'?1:n)],{total:scenario==='total'?n+2:3,next:true,cursor:scenario==='missing'?null:'same'}));if(scenario==='errors')raw.errors=[{message:'partial'}];if(scenario==='nested')raw.data.repository.issues.nodes[0].labels.pageInfo.hasNextPage=true;return JSON.stringify(raw);})).rejects.toThrow();expect(n).toBeLessThanOrEqual(2);}
});
