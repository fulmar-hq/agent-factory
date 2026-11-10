import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {TestEngine as Engine,config,ticket,admission} from './fixtures';
import {GitHubUnavailable,retryAtFor,githubBudget,githubHttpCounts} from '../adapters/github-budget';
import {githubHealth} from '../launcher/github-health';
import {recordWorkerFailure} from '../launcher/worker';
import {recoverWorkers} from '../launcher/wake';
import {tick} from '../launcher/tick';
import * as github from '../adapters/github';

test('a complete tick with failed GitHub read reports degraded unknown ready and retains running custody',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-outage-')),c=config(),now=Date.now();
 writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));
 const s=new Store(join(dir,'controller.sqlite')),e=new Engine(s,c);e.pause(false,'owner');
 const x=e.admit({...ticket(),estimateSeconds:3600},{...admission(),now,meter:{...admission().meter,observedAt:now,windows:admission().meter.windows.map(w=>({...w,resetsAt:now+3600000}))},qualification:{...admission().qualification,expiresAt:now+3600000}});e.claimStart(x.id);
 s.db.query("UPDATE sessions SET status='running',started=? WHERE id=?").run(now,x.id);
 s.set('heartbeat',{at:now,ready:21,status:'ok'});
 const claims=s.db.query('SELECT * FROM claims').all();
 const command=spyOn(github,'command').mockImplementation(async args=>{if(args[1]==='--version')return 'fictional-version';throw new GitHubUnavailable('API rate limit already exceeded',now+3600000);});
 try {
  const result=await tick(dir);
  expect(result).toMatchObject({status:'degraded',ready:null,lastKnownReady:21,claimed:0,retryAt:now+3600000});
  expect(e.sessions()[0]?.status).toBe('running');expect(s.db.query('SELECT * FROM claims').all()).toEqual(claims);
  expect(s.rows('events').filter((r:any)=>r.kind==='session-archive')).toEqual([]);
  expect(s.get('intake-round')).toBeNull();
 }finally{command.mockRestore();s.close();rmSync(dir,{recursive:true});}
});

test('finished native work stays finished when publication loses GitHub; legacy unknown is never auto-archived',()=>{
 const s=new Store(':memory:'),e=new Engine(s,config());e.pause(false,'owner');
 try {
  const x=e.admit(ticket(),admission());e.finish(x.id,true);
  recordWorkerFailure(e,x.id,new GitHubUnavailable('API rate limit already exceeded',Date.now()+60000));
  expect(e.sessions()[0]?.status).toBe('finished');expect(s.get(`publisher-pending:${x.id}`)).not.toBeNull();
  s.db.query("UPDATE sessions SET status='unknown',native_id='fictional-native',pid=NULL WHERE id=?").run(x.id);
  s.set(`cleanup-evidence:${x.id}`,{verified:true});recoverWorkers(e);
  expect(e.sessions()[0]?.status).toBe('unknown');expect(s.db.query('SELECT * FROM claims').all()).toHaveLength(1);
 }finally{s.close();}
});

test('reset-aware cooldown keeps network and rate failures bounded across ticks',()=>{
 const now=1000000;
 expect(retryAtFor('network timeout',now)).toBe(now+60000);
 const reset=now+3600000;
 expect(retryAtFor('API rate limit',now,{resources:{graphql:{remaining:0,reset:reset/1000},core:{remaining:20,reset:(reset+3600000)/1000}}})).toBe(reset+1000);
 const s=new Store(':memory:');try{
  s.set('github:example/demo',{error:null});s.set('github-backoff',{retryAt:reset,error:'quota'});
  expect(githubHealth(s,config(),now)).toMatchObject({status:'degraded',ready:null,retryAt:reset});
  expect(githubHealth(s,config(),reset)).toBeNull();
 }finally{s.close();}
});

test('shared cooldown survives new stores and debug accounting retains only request counts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-github-budget-')),now=1000000;
 try{
  githubBudget('failure',['gh','api','graphql'],'quota',now+3600000,now,dir);
  expect(()=>githubBudget('before',['gh','api','graphql'],undefined,undefined,now+1,dir)).toThrow('GitHub backoff');
  githubBudget('before',['gh','api','graphql'],undefined,undefined,now+3600000,dir);
  expect(githubHttpCounts('> GET /example HTTP/1.1\n> POST /graphql HTTP/2\nAuthorization: secret',JSON.stringify({data:{rateLimit:{cost:7}}}))).toEqual({requests:2,graphqlPoints:7});
  expect(githubHttpCounts('',JSON.stringify({data:{rateLimit:{cost:7}}}))).toEqual({requests:0,graphqlPoints:0});
 }finally{rmSync(dir,{recursive:true});}
});
