import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {publisherTestedReceipt,executeCodexRenewal} from '../adapters/codex-renewal';
test('legacy continuation publication resolves the matching trusted tested tree',()=>{
 const dir=mkdtempSync(join(tmpdir(),'renewal-publish-')),id='fictional',tree='a'.repeat(40),attempt='00000000-0000-4000-8000-000000000001',path=join(dir,'runs/delivery',id,attempt,'publisher/tested-tree.json');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify({tree,code:0}));
 expect(publisherTestedReceipt(dir,{id,tree})).toBe(path);expect(()=>publisherTestedReceipt(dir,{id,tree:'b'.repeat(40)})).toThrow('unavailable');
 expect(()=>publisherTestedReceipt(dir,{id,tree,testedTreeReceipt:join(dir,'nonexistent')})).toThrow('unavailable');
});
test('owned detached startup configuration failure releases known pre-native custody and retains failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'renewal-startup-')),id='c'.repeat(64),s=new Store(join(dir,'controller.sqlite'));writeFileSync(join(dir,'config.yaml'),'invalid: policy');
 try{s.set(`codex-renewal-attempt:${id}`,{id,state:'starting',qualificationSha256:'fictional',fingerprint:{}});s.set('codex-renewal-slot',{id,state:'starting'});s.set('launcher-maintenance-lease',{id,kind:'renewal',state:'active'});let alerts=0;
  const result=await executeCodexRenewal(dir,id,dir,()=>{alerts++;return true;});expect(result.state).toBe('failed');expect(alerts).toBe(1);expect(s.get('codex-renewal-slot')).toMatchObject({id,state:'released'});expect(s.get('launcher-maintenance-lease')).toMatchObject({id,state:'released'});expect(s.get(`codex-renewal-attempt:${id}`)).toMatchObject({state:'failed'});
 }finally{s.close();}
});
