import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from './fixtures';
import {Store} from '../tracking/store';
import {runFactoryChallenge,preparationFailure} from '../adapters/factory-challenge';
import {maintenancePort} from '../scripts/maintain-factory';
import {acceptedChallenge,type FactoryPull} from '../launcher/factory-maintenance';
import type {RetainedReview} from '../adapters/review-publication';
const head='a'.repeat(40),p:FactoryPull={number:7,head,tree:'',createdAt:'',draft:false,state:'OPEN',mergeState:'CLEAN',verify:true};
function fixture(factory=false,change?:(result:RetainedReview)=>void){
 const s=new Store(':memory:'),repo=factory?'fulmar-hq/agent-factory':'example/demo',eventId='trusted-native-review',result:RetainedReview={repo,pr:7,head,baseRef:factory?'main':'QA',baseHead:'b'.repeat(40),workspace:'/fictional',startedAt:1,ok:true,native:{id:'independent-native',path:'/fictional/receipt',verified:true,models:['gpt-6.1-sol'],efforts:['medium']},cleanup:{verified:true},review:{head,verdict:'PASS',findings:[],installedGaps:[]}};
 change?.(result);
 s.event(eventId,factory?'codex-challenge':'code-review-verdict',result,'fictional native receipt');s.set(factory?`factory-challenge:7:${head}`:`code-review:${repo}:7:${head}`,{state:'blocked',error:'old transient publication failure'});
 const remote:any[]=[],calls:string[][]=[];let posts=0,uncertain=true,moved=false,failBeforePost=false,malformed=false,currentBase=factory?'main':'QA';
 const execute=async(args:string[])=>{calls.push(args);const path=args.find(a=>a.startsWith('repos/'));if(args.includes('POST')){posts++;if(failBeforePost){failBeforePost=false;throw Error('network unavailable before server accepted POST');}const body=args.find(a=>a.startsWith('body='))!.slice(5);remote.push({id:17,body,commit_id:head,user:{login:'fictional-owner'},state:'COMMENTED'});if(uncertain)throw Error('connection lost after accepted POST');return '{}';}if(args.includes('user'))return JSON.stringify({login:'fictional-owner'});if(path?.includes('/reviews?'))return JSON.stringify(malformed?{incomplete:true}:remote);if(path===`repos/${repo}/pulls/7`)return JSON.stringify({head:{sha:moved?'b'.repeat(40):head,repo:{full_name:repo}},base:{ref:currentBase,sha:'b'.repeat(40),repo:{full_name:repo}},state:'open'});throw Error('unexpected fixture command '+args.join(' '));};
 const run=()=>runFactoryChallenge(s,p,'/not-a-real-installation','/not-a-workspace',()=>{throw Error('native review must never rerun');},factory?undefined:{repo,baseRef:'QA',depth:'standard',authorNatives:[]},{execute});
 return {s,repo,remote,calls,run,posts:()=>posts,move:()=>{moved=true;},retarget:()=>{currentBase=currentBase==='QA'?'main':'QA';},certain:()=>{uncertain=false;},failBeforePost:()=>{failBeforePost=true;},malformed:(value:boolean)=>{malformed=value;}};
}
test('the actual adapter reconciles an accepted-but-unknown review POST without rerunning or double posting',async()=>{
 const f=fixture();try{expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(1);expect(f.s.get(`code-review:${f.repo}:7:${head}`)).toMatchObject({state:'done'});expect(await f.run()).toMatchObject({head,ok:true});expect(f.posts()).toBe(1);expect(f.remote[0].body).toContain('factory-review:');expect(await f.run()).toMatchObject({head});expect(f.posts()).toBe(1);}finally{f.s.close();}
});
test('factory maintenance cannot use an accepted native result until its original PR verdict is published',async()=>{
 const f=fixture(true);let claimed=0;try{
  // Use the actual retained-result adapter via the normal maintenance wrapper.
  const actual=maintenancePort(f.s,async()=>f.run());expect(await actual.challenge(p)).toBeUndefined();expect(f.posts()).toBe(1);expect(await actual.challenge(p)).toMatchObject({head,ok:true});expect(f.posts()).toBe(1);expect(claimed).toBe(0);
 }finally{f.s.close();}
});
test('changed heads retain the original native result without posting a verdict to the new source',async()=>{
 const f=fixture();try{f.move();expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(0);expect(f.s.db.query("SELECT id FROM events WHERE kind='code-review-verdict'").all()).toHaveLength(1);}finally{f.s.close();}
});

test('the real adapter refuses a fork before allocating native or exact-head custody',async()=>{
 const s=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'fork-review-protocol-'));let claimed=0,calls=0;
 try {
  writeFileSync(join(dir,'config.yaml'),JSON.stringify(config()));
  const execute=async()=>{calls++;return JSON.stringify({head:{sha:head,repo:{full_name:'untrusted/fork'}},base:{ref:'main',repo:{full_name:'example/demo'}},state:'open'});};
  await expect(runFactoryChallenge(s,p,dir,'/not-a-workspace',()=>{claimed++;},{repo:'example/demo',baseRef:'main',depth:'standard',authorNatives:[]},{execute})).rejects.toThrow('identity changed before claim');
  expect(calls).toBe(1);expect(claimed).toBe(0);expect(s.get(`code-review:example/demo:7:${head}`)).toBeNull();expect(s.get('factory-challenge-slot')).toBeNull();
 }finally{s.close();}
});

test('a failed publication before acceptance retries only delivery using the same retained result',async()=>{
 const f=fixture();try{f.certain();f.failBeforePost();expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(1);expect(f.remote).toHaveLength(0);expect(await f.run()).toMatchObject({ok:true});expect(f.posts()).toBe(2);expect(f.remote).toHaveLength(1);expect(f.s.db.query("SELECT id FROM events WHERE kind='code-review-verdict'").all()).toHaveLength(1);}finally{f.s.close();}
});
test('malformed remote review evidence cannot authorize another POST or manufacture delivery',async()=>{
 const f=fixture();try{f.malformed(true);expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(0);f.malformed(false);expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(1);f.malformed(true);expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(1);f.malformed(false);expect(await f.run()).toMatchObject({ok:true});expect(f.posts()).toBe(1);}finally{f.s.close();}
});

test('only proven pre-native transport failures remain preparation retries under the original reset',()=>{
 const error=Object.assign(Error('GitHubUnavailable: rate limit'),{retryAt:120000});expect(preparationFailure(error,false,1)).toEqual({state:'preparation-pending',retryAt:120000});expect(preparationFailure(error,true,1)).toEqual({state:'blocked'});expect(preparationFailure(Error('source invalid'),false,1)).toEqual({state:'blocked'});
});

test('retained pre-native GitHub backoff cannot allocate another preparation early',async()=>{
 const s=new Store(':memory:');let calls=0;
 try{s.set(`factory-challenge:7:${head}`,{state:'preparation-pending',retryAt:Date.now()+3600000});expect(await runFactoryChallenge(s,p,'/not-an-installation','/not-a-workspace',()=>{calls++;})).toBeUndefined();expect(calls).toBe(0);expect(s.get('factory-challenge-slot')).toBeNull();}finally{s.close();}
});

test('the real adapter refuses an unverified new claim before any installation or native effect',async()=>{
 const s=new Store(':memory:');try{await expect(runFactoryChallenge(s,{...p,verify:false},'/not-an-installation')).rejects.toThrow('green checks');expect(s.get('factory-challenge-slot')).toBeNull();}finally{s.close();}
});

test('legacy PASS with unclassified deployment gaps remains blocked in the real adapter and factory acceptance',async()=>{
 const gap='Deployment and Production confirmation were not run.';const f=fixture(true,result=>{result.review.installedGaps=[gap];});f.certain();
 try {
  const port=maintenancePort(f.s,async()=>f.run()),result=await port.challenge(p);expect(result?.review.verdict).toBe('BLOCKED');expect(acceptedChallenge(result,p)).toBe(false);
  const original=JSON.parse((f.s.db.query("SELECT data FROM events WHERE kind='codex-challenge'").get() as {data:string}).data);expect(original.review.verdict).toBe('PASS');expect(original.review.installedGaps).toEqual([gap]);expect(acceptedChallenge(original,p)).toBe(false);
  expect(f.s.db.query("SELECT id FROM events WHERE kind='review-evidence-reconciliation'").all()).toHaveLength(1);
  expect(f.remote[0].body).toContain('source-review relevance is unclassified');expect(f.remote[0].body).toContain(gap);expect(f.remote[0].body).not.toContain('Required source-review evidence:');
 }finally{f.s.close();}
});
test('absent evidence declarations cannot turn a retained PASS into factory approval',async()=>{
 const f=fixture(true,result=>{delete result.review.installedGaps;});f.certain();try{const result=await f.run();expect(result?.review.verdict).toBe('BLOCKED');expect(acceptedChallenge(result,p)).toBe(false);expect(f.remote[0].body).toContain('does not declare its required evidence gaps');}finally{f.s.close();}
});
test('original-PR verdicts retain severity, actionable reproduction and required evidence without private identifiers',async()=>{
 const detail='Reproduce by selecting Save twice before the first response; the second request bypasses the consent guard. Probe path /Users/vincent/.alido-private/probe and contact private@example.invalid. TEST_API_KEY=private-credential-material;';
 const f=fixture(false,result=>{result.evidenceScope='source-review';result.review.verdict='CHANGES_REQUESTED';result.review.findings=[{severity:'P1',title:'Fence concurrent saves',file:'src/save.ts',line:42,detail}];result.review.installedGaps=['Run the dedicated consent concurrency regression with the synthetic tenant fixture.'];});f.certain();
 try{expect((await f.run())?.review.verdict).toBe('CHANGES_REQUESTED');const body=f.remote[0].body;expect(body).toContain('[P1]');expect(body).toContain('src/save.ts:42');expect(body).toContain('selecting Save twice before the first response');expect(body).toContain('dedicated consent concurrency regression');expect(body).not.toContain('/Users/vincent');expect(body).not.toContain('private@example.invalid');expect(body).not.toContain('private-credential-material');}finally{f.s.close();}
});

test('standalone synthetic GitHub tokens are centrally redacted from finding details and evidence gaps',async()=>{
 const classic='ghp_'+'A'.repeat(36),fine='github_pat_'+'B'.repeat(22)+'_'+'C'.repeat(59);
 const f=fixture(false,result=>{result.evidenceScope='source-review';result.review.verdict='CHANGES_REQUESTED';result.review.findings=[{severity:'P1',title:'Synthetic credential handling',file:'src/synthetic.ts',line:1,detail:`Synthetic reproduction ${classic} and ${fine}.`}];result.review.installedGaps=[`Synthetic evidence ${classic} and ${fine}.`];});f.certain();
 try{await f.run();const body=f.remote[0].body;expect(body).not.toContain(classic);expect(body).not.toContain(fine);expect(body).not.toContain('ghp_');expect(body).not.toContain('github_pat_');expect(body.match(/\[redacted credential\]/g)).toHaveLength(4);expect(body).toContain('Synthetic reproduction');expect(body).toContain('Synthetic evidence');}finally{f.s.close();}
});

test('retained reviews cannot be republished against a different or missing reviewed base',async()=>{
 const f=fixture(false,result=>{result.baseRef='main';});f.certain();try{expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(0);expect(f.s.db.query("SELECT id FROM events WHERE kind='review-base-reconciliation'").all()).toHaveLength(1);}finally{f.s.close();}
 const missing=fixture(true,result=>{delete result.baseRef;delete result.baseHead;});missing.certain();try{expect(await missing.run()).toBeUndefined();expect(missing.posts()).toBe(0);}finally{missing.s.close();}
});

test('a previously published PASS is not reusable after the PR base changes',async()=>{
 const f=fixture();f.certain();try{expect((await f.run())?.review.verdict).toBe('PASS');expect(f.posts()).toBe(1);f.retarget();expect(await f.run()).toBeUndefined();expect(f.posts()).toBe(1);}finally{f.s.close();}
});
