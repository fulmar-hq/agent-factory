import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {TestEngine as Engine,config,ticket,admission,githubPage} from './fixtures';
import {GitHubUnavailable,retryAtFor,githubBudget,githubHttpCounts,githubContext,githubDiagnostic} from '../adapters/github-budget';
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

test('the actual gh connectivity diagnostic is classified before debug sanitizing and backs off across calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-gh-offline-')),bin=join(dir,'bin'),calls=join(dir,'calls'),old=process.env.PATH;
 mkdirSync(bin);writeFileSync(join(bin,'gh'),`#!/bin/sh\necho call >> '${calls}'\necho 'error connecting to api.github.com' >&2\necho 'check your internet connection or https://www.githubstatus.com' >&2\nexit 1\n`,{mode:0o700});process.env.PATH=bin;
 try{
  await githubContext.run(dir,async()=>{
   await expect(github.command(['gh','api','repos/example/demo/issues'])).rejects.toBeInstanceOf(GitHubUnavailable);
   await expect(github.command(['gh','api','repos/example/demo/issues'])).rejects.toThrow('GitHub backoff');
  });
  expect(readFileSync(calls,'utf8').trim().split('\n')).toHaveLength(1);
  const s=new Store(join(dir,'controller.sqlite'));try{expect(s.get<any>('github-backoff').retryAt).toBeGreaterThan(Date.now());}finally{s.close();}
 }finally{process.env.PATH=old;rmSync(dir,{recursive:true});}
});

test('merge diagnostics retain the actual failure without raw headers or body',()=>{
 const raw='* Request at fictional time\n> Authorization: token fictional-secret\n> PUT /repos/example/demo/pulls/1 HTTP/1.1\n{"fictionalBody":"private"}\ngh: HTTP 503 service unavailable';
 expect(githubDiagnostic(raw)).toBe('gh: HTTP 503 service unavailable');
 expect(githubDiagnostic('error connecting to api.github.com\ncheck your internet connection')).toContain('error connecting');
});

test('a full tick with occupied capacity does not reread every queued issue or call a model',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-full-capacity-')),c=config(),now=Date.now();writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));
 const s=new Store(join(dir,'controller.sqlite')),e=new Engine(s,c);e.pause(false,'owner');
 const a={...admission(),now,meter:{...admission().meter,observedAt:now,windows:admission().meter.windows.map(w=>({...w,resetsAt:now+3600000}))},qualification:{...admission().qualification,expiresAt:now+3600000}};
 e.admit(ticket(1),a);e.admit(ticket(2),a);
 const t=ticket(3),i={number:3,title:t.title,body:'```factory\n'+JSON.stringify(t)+'\n```',url:'https://github.com/example/demo/issues/3',state:'OPEN',updatedAt:'2026-11-10',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};i.labels.push({name:github.intakeLabel('example/demo',i)});
 let validationReads=0;const command=spyOn(github,'command').mockImplementation(async args=>{
  if(args[1]==='--version')return 'fictional-version';if(args[0]==='sysctl')return '1';
  if(args.includes('--paginate'))return JSON.stringify([[{...i,state:'open',html_url:i.url,updated_at:i.updatedAt,closed_at:null}]]);
  if(args.includes('graphql'))return githubPage('pullRequests',[]);
  validationReads++;throw Error('full capacity must not run per-ticket GitHub/native commands');
 });
 try{expect(await tick(dir)).toMatchObject({status:'ok',ready:1,claimed:0});expect(validationReads).toBe(0);expect(e.sessions()).toHaveLength(2);}
 finally{command.mockRestore();s.close();rmSync(dir,{recursive:true});}
});

for(const phase of ['owner-poll','final-intake'] as const)test(`a full tick keeps late ${phase} GitHub failure degraded and never supplies or dispatches`,async()=>{
 const autonomy=await import('../launcher/autonomy'),wake=await import('../launcher/wake'),workers=await import('../adapters/workers');
 const dir=mkdtempSync(join(tmpdir(),'factory-late-gh-')),c=config(),now=Date.now(),retryAt=now+3600000;
 writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));writeFileSync(join(dir,'repositories.json'),JSON.stringify({'example/demo':dir}));
 const s=new Store(join(dir,'controller.sqlite')),e=new Engine(s,c);e.pause(false,'owner');
 const original=e.admit({...ticket(99),estimateSeconds:3600},{...admission(),now,meter:{...admission().meter,observedAt:now,windows:admission().meter.windows.map(w=>({...w,resetsAt:now+3600000}))},qualification:{...admission().qualification,expiresAt:now+3600000}});
 e.claimStart(original.id);s.db.query("UPDATE sessions SET status='running',started=? WHERE id=?").run(now,original.id);
 const claims=s.db.query('SELECT * FROM claims').all();s.set('heartbeat',{at:now,ready:21,status:'ok'});
 wake.queueWake(s,{id:'retained-before-outage',owner:'builder',kind:'ticket-ready',payload:{}},now);
 const t=ticket(3),issue={number:3,title:t.title,body:'```factory\n'+JSON.stringify(t)+'\n```',url:'https://github.com/example/demo/issues/3',state:'OPEN',updatedAt:'2026-11-10',labels:[{name:'kind:unknown'},{name:'area:unknown'},{name:'state:ready'}]};
 issue.labels.push({name:github.intakeLabel('example/demo',issue)});
 let finalReads=0,prReads=0;
 const command=spyOn(github,'command').mockImplementation(async args=>{
  if(args[1]==='--version')return 'fictional-version';if(args[0]==='sysctl')return '1';
  if(args.includes('--paginate'))return JSON.stringify([[{...issue,state:'open',html_url:issue.url,updated_at:issue.updatedAt,closed_at:null}]]);
  if(args.includes('graphql')){prReads++;if(phase==='owner-poll')throw new GitHubUnavailable('late PR poll rate limit',retryAt);return githubPage('pullRequests',[]);}
  if(args[1]==='issue'&&args[2]==='view'){finalReads++;throw new GitHubUnavailable('late final intake rate limit',retryAt);}
  throw Error('unexpected synthetic command '+args.slice(0,4).join(' '));
 });
 const subscription=spyOn(workers,'verifySubscription').mockResolvedValue(undefined),supply=spyOn(autonomy,'supply'),dispatch=spyOn(wake,'dispatchWake').mockReturnValue(false);
 try{
  const result=await tick(dir);
  expect(result).toMatchObject({status:'degraded',ready:null,lastKnownReady:21,claimed:0,retryAt});
  expect(s.get('heartbeat')).toMatchObject({status:'degraded',ready:null,lastKnownReady:21,retryAt});
  expect(prReads).toBe(1);expect(finalReads).toBe(phase==='final-intake'?1:0);
  expect(supply).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  expect(e.sessions()).toHaveLength(1);expect(e.sessions()[0]?.status).toBe('running');expect(s.db.query('SELECT * FROM claims').all()).toEqual(claims);
  expect(s.get<any>('owner-wake:retained-before-outage').state).toBe('queued');expect(s.get('intake-round')).toBeNull();
  expect(s.get('last-successful-heartbeat')).toBeNull();
  expect(s.rows('events').filter((r:any)=>r.kind==='session-archive')).toHaveLength(0);
 }finally{dispatch.mockRestore();supply.mockRestore();subscription.mockRestore();command.mockRestore();s.close();rmSync(dir,{recursive:true});}
});
