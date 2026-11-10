import {expect,test} from 'bun:test';
import {AlidoReleasePort,type ReleaseContext,type LocalReleaseEffects} from '../adapters/release';
const revision='a'.repeat(40),tree='b'.repeat(40),source='c'.repeat(40);
const c:ReleaseContext={day:'2026-11-09',revision,tree,holdId:'fixture-hold',deadline:2000};
const workflow=Buffer.from('# factory-release-contract: tree-deadline-v1\non:\n  workflow_dispatch:').toString('base64');
test('missing protected workflow and expired context produce no remote effects',async()=>{
 const calls:string[][]=[];
 const execute=async(args:string[])=>{calls.push(args);return JSON.stringify(args.some(x=>x.includes('git/ref'))?{object:{sha:revision}}:args.some(x=>x.includes('git/commits'))?{tree:{sha:tree}}:{content:Buffer.from('on:\n  workflow_dispatch:').toString('base64')});};
 await expect(new AlidoReleasePort(execute,()=>1000).perform('qa',c)).rejects.toThrow('not delivered');
 expect(calls.every(x=>!x.includes('POST'))).toBe(true);
 await expect(new AlidoReleasePort(execute,()=>2000).perform('qa',c)).rejects.toThrow('expired');
 expect(calls).toHaveLength(3);
});
test('remote readback dispatch binds protected main source and context; absent outcome never replays',async()=>{
 const calls:string[][]=[];
 const execute=async(args:string[])=>{calls.push(args);const path=args[4]??'';
 if(path.includes('git/ref'))return JSON.stringify({object:{sha:source}});
 if(path.includes('contents/'))return JSON.stringify({content:workflow});
 if(path.includes('/runs?'))return JSON.stringify({workflow_runs:[]});
 return '';};
 const port=new AlidoReleasePort(execute,()=>1000),handle=await port.perform('readback',c);
 expect(calls[2]).toContain('ref=main');expect(calls[2]).toContain(`inputs[executor_source]=${source}`);expect(calls[2]).toContain(`inputs[tree]=${tree}`);
 expect(await port.observe('readback',c,handle)).toMatchObject({state:'pending'});
 expect(calls.filter(x=>x.includes('POST'))).toHaveLength(1);
});
test('trusted launcher performs GH mutations locally while remote workflow remains read-only',async()=>{
 const calls:string[][]=[],localCalls:unknown[]=[];
 const execute=async(args:string[])=>{calls.push(args);return JSON.stringify(args[4]?.includes('git/ref')?{object:{sha:revision}}:args[4]?.includes('git/commits')?{tree:{sha:tree}}:{content:workflow});};
 const local:LocalReleaseEffects={start:async(...args)=>{localCalls.push(args);return {local:true,key:'fixture'};},observe:async()=>({state:'pending',evidence:{}})};
 const port=new AlidoReleasePort(execute,()=>1000,local);
 expect(await port.perform('qa',c)).toMatchObject({local:true});expect(localCalls).toHaveLength(1);
 expect(calls.every(x=>!x.includes('POST'))).toBe(true);
 expect(await port.observe('qa',c,{local:true})).toMatchObject({state:'pending'});
});
test('remote success requires exact native readback proof and rejects rerun or wrong tree',async()=>{
 let attempt=1,receiptTree=tree,completedAt=1500;
 const execute=async(args:string[])=>args[1]==='run'?`job\tstep\tFACTORY_RELEASE_RECEIPT ${JSON.stringify({version:1,key:'d'.repeat(64),step:'readback',day:c.day,revision,tree:receiptTree,status:'success',completedAt,artifact:'repo@sha256:'+'f'.repeat(64),main:source,deployRun:7,readback:{command:'fixture-command',containers:{'alido-web':{source,running:true,health:'healthy',restarts:0},'alido-worker':{source,running:true,health:'healthy',restarts:0}}}})}`:JSON.stringify({workflow_runs:[{id:7,display_title:`factory-release ${'d'.repeat(64)}`,head_sha:source,event:'workflow_dispatch',path:'.github/workflows/factory-release.yml',run_attempt:attempt,status:'completed',conclusion:'success'}]});
 const port=new AlidoReleasePort(execute,()=>1700),handle={dispatchedAt:1000,key:'d'.repeat(64),source,workflow:'factory-release.yml'};
 expect(await port.observe('readback',c,handle)).toMatchObject({state:'success'});
 receiptTree='e'.repeat(40);expect(await port.observe('readback',c,handle)).toMatchObject({state:'failure'});
 receiptTree=tree;attempt=2;expect(await port.observe('readback',c,handle)).toMatchObject({state:'failure'});
 attempt=1;completedAt=999;expect(await port.observe('readback',c,handle)).toMatchObject({state:'failure'});
});
test('scheduled Main verification is not a release overlap; queued push and deployments remain overlaps',async()=>{
 let run={id:7,status:'queued',event:'schedule',path:'.github/workflows/ci.yml',head_branch:'main'};
 const execute=async(args:string[])=>{
  const p=args[4]??'';
  return JSON.stringify(p.includes('git/ref')?{object:{sha:revision}}:p.includes('git/commits')?{tree:{sha:tree}}:p.includes('variables/')?{value:JSON.stringify({id:'fixture',held:false})}:p.includes('pulls?')?[]:{workflow_runs:p.includes('status=queued')?[run]:[]});
 };
 const port=new AlidoReleasePort(execute);
 expect((await port.snapshot()).overlap).toBe(false);
 run={...run,event:'push'};expect((await port.snapshot()).overlap).toBe(true);
 run={...run,event:'workflow_run',path:'.github/workflows/deploy.yml'};expect((await port.snapshot()).overlap).toBe(true);
 run={...run,event:'workflow_dispatch',path:'.github/workflows/factory-release.yml'};expect((await port.snapshot()).overlap).toBe(true);
});
