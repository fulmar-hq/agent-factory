import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './fixtures';
import {runOwner} from '../launcher/owner';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {ownerRuntimeKey,queueWake,pendingWakes,type Wake} from '../launcher/wake';
import {testDispatchWake as dispatchWake,testDispatchReleaseQuality as dispatchReleaseQuality} from './fixtures';
test('busy acceptance remains exclusively with pinned release source and later dispatches once',()=>{
 const s=new Store(':memory:');const w:Wake={id:'fictional-pinned',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}};
 let starts=0;try{
 s.set('owner-runtime:quality-acceptance',{workspace:tmpdir(),pid:123,identity:'fictional-old-owner'});queueWake(s,w);
 expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++},()=> 'fictional-old-owner')).toBe(false);
 expect(pendingWakes(s)).toEqual([]);expect(s.get<any>('owner-wake:'+w.id).state).toBe('waiting-release-runner');
 s.set('owner-runtime:quality-acceptance',{workspace:tmpdir()});
 expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++})).toBe(true);
 expect(starts).toBe(1);expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++})).toBe(false);expect(starts).toBe(1);
 }finally{s.close();}
});
test('a pinned expired wake cannot start or become a general runnable wake',()=>{
 const s=new Store(':memory:');const w:Wake={id:'fictional-expired',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()-1}};
 try{s.set('owner-runtime:quality-acceptance',{workspace:tmpdir()});queueWake(s,w);expect(dispatchReleaseQuality(s,w,'/fictional',()=>{throw Error('must not start')})).toBe(false);expect(pendingWakes(s)).toEqual([]);expect(s.get<any>('owner-wake:'+w.id).state).toBe('expired');}finally{s.close();}
});

test('ordinary Quality custody cannot occupy the independent acceptance runtime',()=>{
 const s=new Store(':memory:'),w:Wake={id:'fictional-independent',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}};
 const ordinary={workspace:tmpdir(),pid:123,identity:'fictional-ordinary',native:'fictional-claude-native'};
 let starts=0;try{
  s.set('owner-runtime:quality',ordinary);s.set('owner-runtime:quality-acceptance',{workspace:tmpdir()});queueWake(s,w);
  expect(ownerRuntimeKey(w)).toBe('owner-runtime:quality-acceptance');
  expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++},()=> 'fictional-ordinary')).toBe(true);
  expect(starts).toBe(1);expect(s.get('owner-runtime:quality')).toEqual(ordinary);
  expect(s.get<any>('owner-runtime:quality-acceptance').wake).toBe(w.id);
  const mail:Wake={id:'fictional-ordinary-mail',owner:'quality',kind:'ci-finished',payload:{}};queueWake(s,mail);
  expect(ownerRuntimeKey(mail)).toBe('owner-runtime:quality');
  expect(dispatchWake(s,mail,()=>{throw Error('must not replace busy ordinary owner')},()=> 'fictional-ordinary')).toBe(false);
 }finally{s.close();}
});
test('unknown acceptance custody parks only its own pinned wake until cleanup or expiry',()=>{
 for(const custody of [{workspace:tmpdir(),pid:123},{workspace:tmpdir(),pid:0},{workspace:tmpdir(),wake:'fictional-missing'},{workspace:tmpdir(),wake:'fictional-unknown'}]){
  const s=new Store(':memory:'),w:Wake={id:'fictional-wait',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}};
  try{
   s.set('owner-runtime:quality-acceptance',custody);s.set('owner-wake:fictional-unknown',{state:'blocked',cleanupVerified:false});queueWake(s,w);
   expect(dispatchReleaseQuality(s,w,'/fictional',()=>{throw Error('must not start unknown custody')})).toBe(false);
   expect(s.get<any>('owner-wake:'+w.id).state).toBe('waiting-release-runner');expect(pendingWakes(s)).toEqual([]);
   s.set('owner-wake:'+w.id,{...s.get<any>('owner-wake:'+w.id),payload:{deadline:Date.now()-1}});
   expect(dispatchReleaseQuality(s,w,'/fictional',()=>{throw Error('must not start expired wait')})).toBe(false);
   expect(s.get<any>('owner-wake:'+w.id).state).toBe('expired');
  }finally{s.close();}
 }
});
test('owner claim and no-child failure cleanup leave permanent Quality runtime unchanged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-acceptance-custody-')),workspace=join(dir,'workspace');mkdirSync(workspace);
 writeFileSync(join(dir,'config.yaml'),JSON.stringify(config()));
 const path=join(dir,'controller.sqlite'),s=new Store(path),ordinary={workspace,pid:123,identity:'fictional-ordinary',native:'fictional-ordinary-native'};
 const w:Wake={id:'fictional-claim-cleanup',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}};
 try{
  s.set('owner-runtime:quality',ordinary);s.set('owner-runtime:quality-acceptance',{workspace,native:'fictional-retained-acceptance'});queueWake(s,w);
  expect(dispatchReleaseQuality(s,w,dir,()=>{})).toBe(true);
  // No Quality role in this fictional config: refuse before native/model work,
  // exercising the actual claim, PID write and finally cleanup in runOwner.
  await runOwner(w.id,dir);
  expect(s.get('owner-runtime:quality')).toEqual(ordinary);
  expect(s.get<any>('owner-runtime:quality-acceptance')).toEqual({workspace,native:'fictional-retained-acceptance',wake:w.id});
  expect(s.get<any>('owner-wake:'+w.id)).toMatchObject({state:'blocked',cleanupVerified:true});
  expect((s.rows('events') as any[]).filter(e=>e.kind==='owner-native-start')).toHaveLength(0);
 }finally{s.close();rmSync(dir,{recursive:true});}
});
