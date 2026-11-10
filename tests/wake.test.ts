import {githubPage} from './fixtures';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {config,ticket,admission,qualification} from './fixtures';
import {queueWake,pendingWakes,dispatchWake,localWakes,githubWakes,recoverWorkers} from '../launcher/wake';
import {ownerSpec,runOwner} from '../launcher/owner';
import {claimSupervisor,superviseSession} from '../launcher/worker';

test('ready, returned review, completed CI, release window and renewal deduplicate stable events',async()=>{
 const s=new Store(':memory:'),c=config();c.owners.release=c.owners.builder;
 const now=Date.parse('2026-11-07T20:00:00-05:00');
 for(let i=0;i<2;i++)localWakes(s,c,[ticket()],{codex:{...qualification(),expiresAt:now+3600000}},now);
 expect(pendingWakes(s).filter(w=>w.kind==='ticket-ready')).toHaveLength(1);
 expect(pendingWakes(s).filter(w=>w.kind==='qualification-renewal')).toHaveLength(2);
 expect(pendingWakes(s).filter(w=>w.kind==='release-window')).toHaveLength(1);
 let reviews:any[]=[],checks:any[]=[];
 const execute=async()=>githubPage('pullRequests',[{number:2,url:'https://github.com/example/demo/pull/2',headRefOid:'a'.repeat(40),reviews,statusCheckRollup:checks}]);
 await githubWakes(s,c,execute,now); // Historical baseline causes no model call.
 reviews=[{id:'review-1',state:'CHANGES_REQUESTED',submittedAt:new Date(now).toISOString()}];checks=[{status:'COMPLETED',conclusion:'SUCCESS',detailsUrl:'https://github.com/example/demo/actions/runs/1/job/2'}];
 await githubWakes(s,c,execute,now);await githubWakes(s,c,execute,now+60000);
 expect(pendingWakes(s).filter(w=>w.kind==='review-returned')).toHaveLength(1);expect(pendingWakes(s).filter(w=>w.kind==='ci-finished')).toHaveLength(1);s.close();
});
test('owner resume is read-only and never inherits a signing socket or credentials',()=>{
 const id='01a1b95a-4ba6-76c0-9abb-1a4fef0ef869',spec=ownerSpec(ticket(),'/fictional-source','/fictional-scratch',id);
 expect(spec.argv.slice(spec.argv.indexOf('resume'),spec.argv.indexOf('resume')+2)).toEqual(['resume',id]);
 expect(spec.argv.find(a=>a.startsWith('permissions.factory.filesystem='))).toContain('\":workspace_roots\"=\"read\"');
 expect(spec.argv.find(a=>a.startsWith('permissions.factory.filesystem='))).toContain('\"/fictional-scratch\"=\"write\"');
 expect(spec.env.SSH_AUTH_SOCK).toBeUndefined();expect(Object.keys(spec.env).some(k=>/TOKEN|AWS|API_KEY/.test(k))).toBe(false);
});
test('uncertain wake spawn is retained and cannot be replayed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-wake-')),s=new Store(':memory:');s.set('owner-runtime:builder',{workspace:dir});const w={id:'one',owner:'builder',kind:'ticket-ready',payload:{}};queueWake(s,w);
 expect(dispatchWake(s,w,()=>{throw Error('uncertain spawn');})).toBe(true);let retries=0;expect(dispatchWake(s,w,()=>{retries++;})).toBe(false);expect(retries).toBe(0);s.close();
});
test('kill a real fixture worker, replay recovery twice: one owner resume and released slot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-recovery-')),work=join(dir,'workspace'),bin=join(dir,'bin');mkdirSync(work);mkdirSync(bin);mkdirSync(join(dir,'owners'));
 writeFileSync(join(dir,'owners/builder.md'),'Fictional owner. Review evidence only.');writeFileSync(join(dir,'config.yaml'),JSON.stringify(config()));
 const day=join(dir,'.codex/sessions',new Date().toISOString().slice(0,10).replaceAll('-','/'));mkdirSync(day,{recursive:true});
 const uuid=(suffix:string)=>{const hex=Date.now().toString(16).padStart(12,'0');return `${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${suffix.padStart(12,'0')}`;};
 const workerId=uuid('1'),ownerId=uuid('2'),ownerPath=join(day,`rollout-${ownerId}.jsonl`);
 const row=(x:unknown)=>JSON.stringify(x)+'\n';const receipt=(id:string)=>row({type:'session_meta',payload:{id,cwd:work}})+row({type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'medium'}});
 writeFileSync(join(day,`rollout-${workerId}.jsonl`),receipt(workerId));writeFileSync(ownerPath,receipt(ownerId).replace("gpt-6.1-sol","historical-owner-model"));
 writeFileSync(join(bin,'codex'),`#!/bin/sh
case "$*" in
 *factory-kill-fixture*)
 echo $$ > '${dir}/worker.pid'
 echo '{"type":"thread.started","thread_id":"${workerId}"}'
 while :; do sleep 0.05; done;;
 *)
 echo resumed >> '${dir}/resume-count'
 echo "$*" >> '${dir}/resumes'
 echo '{"type":"thread.started","thread_id":"${ownerId}"}'
 echo '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"medium"}}' >> '${ownerPath}'
 echo '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":12}}}}' >> '${ownerPath}'
 echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}';;
esac
`,{mode:0o700});
 const oldPath=process.env.PATH,oldHome=process.env.HOME;process.env.PATH=bin+':'+oldPath;process.env.HOME=dir;
 const s=new Store(join(dir,'controller.sqlite')),e=new Engine(s,config());e.pause(false,'owner');
 try {
  const t={...ticket(),model:'gpt-6.1-sol',effort:'medium' as const,outcome:'factory-kill-fixture'},x=e.admit(t,admission());e.claimStart(x.id);claimSupervisor(e,x.id);
  const running=superviseSession(e,x.id,t,work,join(dir,'worker.jsonl'));
  for(let i=0;i<200;i++){if(await Bun.file(join(dir,'worker.pid')).exists())break;await Bun.sleep(10);}
  process.kill(Number(readFileSync(join(dir,'worker.pid'),'utf8')),'SIGKILL');await running;
  expect(e.sessions()[0].status).toBe('unknown');expect(s.get<{verified:boolean}>(`cleanup-evidence:${x.id}`)?.verified).toBe(true);
  recoverWorkers(e);recoverWorkers(e);expect(e.active()).toHaveLength(0);expect(e.sessions()[0].status).toBe('archived');
  s.set('owner-runtime:builder',{native:ownerId,workspace:work});const w=pendingWakes(s)[0];let resumes=0;const jobs:Promise<void>[]=[];
  const spawn=(id:string)=>{resumes++;jobs.push(runOwner(id,dir));};expect(dispatchWake(s,w,spawn)).toBe(true);
  for(let i=0;i<2;i++){expect(queueWake(s,w)).toBe(false);expect(dispatchWake(s,w,spawn)).toBe(false);}
  await Promise.all(jobs);expect(resumes).toBe(1);expect(readFileSync(join(dir,'resume-count'),'utf8').trim().split('\n')).toHaveLength(1);expect(readFileSync(join(dir,'resumes'),'utf8')).toContain(`resume ${ownerId}`);
  expect(s.get<{state:string}>(`owner-wake:${w.id}`)?.state).toBe('done');expect(e.active()).toHaveLength(0);expect(e.sessions()[0].native_id).toBe(workerId);expect(s.rows('debits')).toHaveLength(1);
 }finally{process.env.PATH=oldPath;process.env.HOME=oldHome;s.close();}
},10000);
