import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {publisherTestedReceipt,executeCodexRenewal,codexRenewalBrief,verifyKnownNetworkTargets} from '../adapters/codex-renewal';

test('network readback probes the original literal endpoints despite a rotated DNS answer',async()=>{
 const network={githubIPv4:'192.0.2.1',exampleIPv4:'192.0.2.2'},connected:string[]=[];
 // The later answer is intentionally different. It cannot substitute a new
 // target for the IPs already bound into both hashed security probes.
 const laterAnswer='192.0.2.99';
 const proof=await verifyKnownNetworkTargets(network,async address=>{connected.push(address);if(address===laterAnswer)throw Error('unprobed replacement');},()=>123);
 expect(connected).toEqual(['192.0.2.1','192.0.2.2']);
 expect(proof).toEqual({observedAt:123,targets:[{host:'github.com',address:network.githubIPv4,port:443,reachable:true},{host:'example.com',address:network.exampleIPv4,port:443,reachable:true}]});
});

for(const unavailable of ['192.0.2.1','192.0.2.2'])test(`unreachable pinned endpoint ${unavailable} refuses readback`,async()=>{
 await expect(verifyKnownNetworkTargets({githubIPv4:'192.0.2.1',exampleIPv4:'192.0.2.2'},async address=>{if(address===unavailable)throw Error('ETIMEDOUT');})).rejects.toThrow(`known network target unreachable: ${unavailable.endsWith('.1')?'github.com':'example.com'} ${unavailable}:443: Error: ETIMEDOUT`);
});

test('network readback refuses a hostname in place of a literal pinned address',async()=>{
 let connected=false;await expect(verifyKnownNetworkTargets({githubIPv4:'github.com',exampleIPv4:'192.0.2.2'},async()=>{connected=true;})).rejects.toThrow();expect(connected).toBe(false);
});
test('legacy continuation publication resolves the matching trusted tested tree',()=>{
 const dir=mkdtempSync(join(tmpdir(),'renewal-publish-')),id='fictional',tree='a'.repeat(40),attempt='00000000-0000-4000-8000-000000000001',path=join(dir,'runs/delivery',id,attempt,'publisher/tested-tree.json');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify({tree,code:0}));
 expect(publisherTestedReceipt(dir,{id,tree})).toBe(realpathSync(path));expect(()=>publisherTestedReceipt(dir,{id,tree:'b'.repeat(40)})).toThrow('unavailable');
 expect(()=>publisherTestedReceipt(dir,{id,tree,testedTreeReceipt:join(dir,'nonexistent')})).toThrow('unavailable');
});
test('owned detached startup configuration failure releases known pre-native custody and retains failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'renewal-startup-')),id='c'.repeat(64),s=new Store(join(dir,'controller.sqlite'));writeFileSync(join(dir,'config.yaml'),'invalid: policy');
 try{s.set(`codex-renewal-attempt:${id}`,{id,state:'starting',qualificationSha256:'fictional',fingerprint:{}});s.set('codex-renewal-slot',{id,state:'starting'});s.set('launcher-maintenance-lease',{id,kind:'renewal',state:'active'});let alerts=0;
  const result=await executeCodexRenewal(dir,id,dir,()=>{alerts++;return true;});expect(result.state).toBe('failed');expect(alerts).toBe(1);expect(s.get('codex-renewal-slot')).toMatchObject({id,state:'released'});expect(s.get('launcher-maintenance-lease')).toMatchObject({id,state:'released'});expect(s.get(`codex-renewal-attempt:${id}`)).toMatchObject({state:'failed'});
 }finally{s.close();}
});


for(const kind of ['time','tokens'] as const)test(`${kind} brief contains the actual executable lifecycle command and wrapper`,()=>{
 const python='/Library/Developer/CommandLineTools/usr/bin/python3',brief=codexRenewalBrief(kind,python,`${python} /fictional/probe.py`);expect(brief).toContain(`Run ${python} lifecycle.py once`);expect(brief).toContain(`text(await tools.exec_command({"cmd":"${python} lifecycle.py"}));`);expect(brief).not.toContain('${');
});

test('live reader seals complete bytes actually visible, not a later emitter timestamp',async()=>{
 const {readLiveUsage}=await import('../adapters/codex-renewal'),{createHash}=await import('node:crypto'),dir=mkdtempSync(join(tmpdir(),'live-prefix-')),path=join(dir,'native.jsonl'),first=JSON.stringify({timestamp:new Date(100).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:2,output_tokens:1,cached_input_tokens:0,total_tokens:3}}}})+'\n';writeFileSync(path,first+'{"incomplete":');const captured=readLiveUsage(path,()=>200)!;expect(captured.usage.total_tokens).toBe(3);expect(captured.prefixBytes).toBe(Buffer.byteLength(first));expect(captured.prefixSha256).toBe(createHash('sha256').update(first).digest('hex'));
 const second=JSON.stringify({timestamp:new Date(150).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:4,output_tokens:1,cached_input_tokens:0,total_tokens:5}}}})+'\n';writeFileSync(path,first+second);expect(readLiveUsage(path,()=>201)?.usage.total_tokens).toBe(5);expect(captured.usage.total_tokens).toBe(3);
});
