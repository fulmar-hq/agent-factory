import {githubPage} from './fixtures';
import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {config} from './fixtures';
import {refreshPulls,recordPulls,pullState,type PullSnapshot} from '../board/pulls';
test('complete open snapshots replace old PRs; failed or truncated reads retain evidence',async()=>{
 const s=new Store(':memory:'),c=config(),now=Date.now();
 const pr={number:1,url:'https://github.com/example/demo/pull/1',headRefOid:'abc',reviews:[],statusCheckRollup:[]};
 try{
  recordPulls(s,'example/demo',[pr],now-600001);
  await refreshPulls(s,c,now,async args=>{expect(args.join(' ')).toContain('closingIssuesReferences');return githubPage('pullRequests',[]);});
  expect(s.get<PullSnapshot>('board-pulls:example/demo')!.pulls).toEqual([]);
  await refreshPulls(s,c,now+600001,async()=>{throw Error('offline');});
  expect(s.get<PullSnapshot>('board-pulls:example/demo')!.error).toBe(true);
  await refreshPulls(s,c,now+1200002,async()=>githubPage('pullRequests',[pr],{total:2}));
  expect(s.get<PullSnapshot>('board-pulls:example/demo')!.pulls).toEqual([]);
  expect(pullState({...pr,statusCheckRollup:[{name:'Release hold',status:'IN_PROGRESS'}]})).toMatchObject({pending:false,releaseHeld:true});
  expect(pullState({...pr,statusCheckRollup:[{name:'Release hold',status:'COMPLETED',conclusion:'SUCCESS'}]}).releaseHeld).toBe(false);
  expect(pullState({...pr,statusCheckRollup:[{name:'Release hold',status:'COMPLETED',conclusion:'FAILURE'}]}).failed).toBe(true);
 }finally{s.close();}
});
