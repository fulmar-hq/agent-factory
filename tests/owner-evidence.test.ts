import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,readdirSync,statSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {TestEngine as Engine,config,ticket,testDispatchWake as dispatchWake} from './fixtures';
import {queueWake,type Wake} from '../launcher/wake';
import {runOwner,ownerSpec} from '../launcher/owner';
import {LAUNCH_ARGUMENT_BYTES,INLINE_EVENT_BYTES,EVIDENCE_BYTES,launchBytes,boundLaunch,eventForPrompt,copyEvidence} from '../launcher/owner-evidence';

// A private factory folder in a temp dir with a stand-in codex that records its
// launch arguments and completes one verified turn. Nothing here reads live state.
function stage() {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'factory-owner-evidence-'))),work=join(dir,'workspace'),bin=join(dir,'bin');
 for(const p of [work,bin,join(dir,'owners')])mkdirSync(p);
 writeFileSync(join(dir,'owners/builder.md'),'Fictional owner. Review evidence only.');writeFileSync(join(dir,'config.yaml'),JSON.stringify(config()));
 const hex=Date.now().toString(16).padStart(12,'0'),native=`${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-000000000001`;
 const day=join(dir,'.codex/sessions',new Date().toISOString().slice(0,10).replaceAll('-','/'));mkdirSync(day,{recursive:true});
 writeFileSync(join(day,`rollout-${native}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:native,cwd:work}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'medium'}})+'\n');
 writeFileSync(join(bin,'codex'),`#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a"; done > '${dir}/argv'
echo '{"type":"thread.started","thread_id":"${native}"}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`,{mode:0o700});
 const s=new Store(join(dir,'controller.sqlite'));new Engine(s,config()).pause(false,'owner');s.set('owner-runtime:builder',{workspace:work});
 return {dir,work,s,argv:()=>readFileSync(join(dir,'argv'),'utf8').split('\0').slice(0,-1)};
}
async function wakeOwner(x:ReturnType<typeof stage>,w:Wake) {
 const oldPath=process.env.PATH,oldHome=process.env.HOME;process.env.PATH=join(x.dir,'bin')+':'+oldPath;process.env.HOME=x.dir;
 try {
  queueWake(x.s,w);const jobs:Promise<void>[]=[];expect(dispatchWake(x.s,w,id=>{jobs.push(runOwner(id,x.dir));})).toBe(true);await Promise.all(jobs);
  return x.s.get<Wake & {state:string;error?:string;scratch?:string}>(`owner-wake:${w.id}`)!;
 } finally {process.env.PATH=oldPath;process.env.HOME=oldHome;}
}
const session='5e55'.repeat(16);
// Every path under the private folder that a text names.
const privatePaths=(dir:string,text:string)=>[...new Set(text.match(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[^\\s"\'\\\\,;:()\\[\\]{}<>]+','g')) ?? [])].map(p=>p.replace(/\.+$/,''));
const folderBytes=(dir:string):number=>readdirSync(dir).reduce((n,name)=>{const p=join(dir,name),st=statSync(p);return n+(st.isDirectory() ? folderBytes(p) : st.size);},0);

test('the recorded oversized wake that failed with E2BIG now launches',async()=>{
 const recorded=JSON.parse(readFileSync(join(import.meta.dir,'fixtures/owner-wake-e2big/recorded.json'),'utf8'));
 const {existing,occupied,briefBytes,...scalars}=recorded.payload;
 const each=Math.floor(existing.bytes/existing.count);
 const payload={...scalars,brief:'b'.repeat(briefBytes),existing:Array.from({length:existing.count},(_,n)=>({id:`example/demo#${n+1}`,title:'Synthetic backlog item',scope:'s'.repeat(each)})),occupied:Array.from({length:occupied.count},(_,n)=>({ticket:`example/demo#${n+1}`,paths:[`src/task-${n}.ts`]}))};
 const w={id:recorded.id,owner:'builder',kind:recorded.kind,payload};
 expect(JSON.stringify(w).length).toBeGreaterThan(8_000_000);
 const x=stage();
 try {
  const done=await wakeOwner(x,w);
  expect(done.error).toBeUndefined();expect(done.state).toBe('done');
  const argv=x.argv(),prompt=argv.at(-1)!,saved=join(done.scratch!,'event.json');
  expect(launchBytes(argv)).toBeLessThanOrEqual(LAUNCH_ARGUMENT_BYTES);
  // The instructions stay in the prompt; only the bulky event moved to a readable file.
  expect(prompt).toContain(saved);expect(prompt).toContain(join(done.scratch!,'intake.json'));expect(prompt).toContain('payload.existing');
  expect(JSON.parse(readFileSync(saved,'utf8'))).toMatchObject(w);
 } finally {x.s.close();}
},30000);

test('launch arguments stay under the fixed cap with a 600 KB prompt',()=>{
 // Raising the cap is a deliberate change to this number, not a side effect.
 expect(LAUNCH_ARGUMENT_BYTES).toBe(512*1024);expect(INLINE_EVENT_BYTES).toBeLessThan(LAUNCH_ARGUMENT_BYTES);
 for(const provider of ['codex','claude'] as const) {
  const scratch=mkdtempSync(join(tmpdir(),'factory-owner-launch-'));
  // A 600 KB event is read from a file, so the prompt that names it stays small.
  const event=eventForPrompt(scratch,{id:'big',owner:'builder',kind:'product-intake',payload:{existing:'e'.repeat(600*1024)}});
  expect(Buffer.byteLength(event)).toBeLessThan(2048);expect(statSync(join(scratch,'event.json')).size).toBeGreaterThan(600*1024);
  const small=ownerSpec({...ticket(),provider,outcome:`Review this event.\nEvent:\n${event}`},'/fictional-source',scratch);
  expect(boundLaunch(small,scratch)).toBe(small);expect(launchBytes(small.argv)).toBeLessThan(16*1024);expect(existsSync(join(scratch,'prompt.md'))).toBe(false);
  // 600 KB that cannot be split off (instructions themselves) is still launched: by file.
  const large=ownerSpec({...ticket(),provider,outcome:'i'.repeat(600*1024)},'/fictional-source',scratch),bounded=boundLaunch(large,scratch);
  expect(launchBytes(large.argv)).toBeGreaterThan(LAUNCH_ARGUMENT_BYTES);expect(launchBytes(bounded.argv)).toBeLessThan(16*1024);
  expect(bounded.argv.slice(0,-1)).toEqual(large.argv.slice(0,-1));expect(bounded.argv.at(-1)).toContain(join(scratch,'prompt.md'));
  expect(readFileSync(join(scratch,'prompt.md'),'utf8')).toBe(large.argv.at(-1)!);
 }
});

test('a diagnosis wake can open every file named in its prompt',async()=>{
 const x=stage(),receipt=join(x.dir,'runs/delivery',session,'initial/publisher/tested-tree.json');
 try {
  mkdirSync(join(receipt,'..'),{recursive:true});writeFileSync(receipt,JSON.stringify({tree:'a'.repeat(40),command:'bun test',code:1,out:'',err:'synthetic assertion failed'}));
  writeFileSync(join(x.dir,`worker-${session}.jsonl`),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic final report: tests failed.'}})+'\n');
  const error=`Error: exact tested tree required; inspect ${receipt}`;
  x.s.event(`failure:${session}`,'worker-failure',{id:session,error},'none');x.s.event(`exit:${session}`,'worker-exit',{id:session,ok:true},'none');
  // An owner record longer than the prompt keeps: the middle used to be unreachable.
  writeFileSync(join(x.dir,'owners/builder.md'),'Head of record.\n'+'old receipt\n'.repeat(3000)+'MIDDLE-LESSON verify in the real job environment\n'+'new receipt\n'.repeat(5000));
  const w={id:`diagnose:${session}`,owner:'builder',kind:'failure-diagnosis',payload:{session,ticket:'example/demo#1',repo:'example/demo',provider:'codex',cause:'test',at:Date.now(),brief:ticket(),reason:JSON.stringify({failure:{id:session,error},stop:null}),deadline:Date.now()+3600000}};
  const done=await wakeOwner(x,w);
  expect(done.error).toBeUndefined();expect(done.state).toBe('done');
  const argv=x.argv(),prompt=argv.at(-1)!,scratch=done.scratch!;
  // What the launched sandbox policy lets command tools read: the source checkout and this wake's scratch.
  const policy=argv.find(a=>a.startsWith('permissions.factory.filesystem='))!;
  const granted=[argv[argv.indexOf('-C')+1],...[...policy.matchAll(/"(\/[^"]+)"="(?:read|write)"/g)].map(m=>m[1])];
  expect(granted).toContain(scratch);expect(granted.some(g=>receipt.startsWith(g+'/'))).toBe(false);
  const named=privatePaths(x.dir,prompt);
  expect(named.length).toBeGreaterThanOrEqual(5);
  for(const path of named) {
   expect(granted.some(g=>path===g || path.startsWith(g+'/'))).toBe(true);
   if(path===join(scratch,'retry.json'))continue; // the result this wake is asked to write
   if(statSync(path).isDirectory())readdirSync(path);else expect(readFileSync(path).length).toBeGreaterThan(0);
  }
  // The private original is no longer what the event points at; its copy is.
  expect(prompt).not.toContain(receipt);
  const copy=join(scratch,'evidence/1-tested-tree.json');
  expect(prompt).toContain(`inspect ${copy}`);expect(readFileSync(copy,'utf8')).toBe(readFileSync(receipt,'utf8'));
  expect(readFileSync(join(scratch,'evidence/events-1.jsonl'),'utf8')).toContain('"kind":"worker-failure"');
  expect(readFileSync(join(scratch,'evidence/worker-log-1.jsonl'),'utf8')).toContain('Synthetic final report');
  expect(prompt).not.toContain('MIDDLE-LESSON');expect(prompt).toContain(join(scratch,'owner-record.md'));
  expect(readFileSync(join(scratch,'owner-record.md'),'utf8')).toContain('MIDDLE-LESSON');
 } finally {x.s.close();}
},30000);

test('the evidence copy never exceeds 2 MB and never includes a credential file',()=>{
 expect(EVIDENCE_BYTES).toBe(2*1024*1024);
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'factory-owner-bundle-'))),run=join(dir,'runs/delivery',session);mkdirSync(run,{recursive:true});
 const scratch=(name:string)=>{const p=join(dir,'runs/owner-wakes',name);mkdirSync(p,{recursive:true});return p;};
 const s=new Store(':memory:'),secret='FIXTURE-SECRET';
 // Shapes are assembled here so no real-looking credential is stored in the repository.
 const key='-----BEGIN OPENSSH PRIVATE'+' KEY-----\n'+secret,token='gh'+'p_'+'a'.repeat(36);
 const put=(path:string,content:string)=>{writeFileSync(path,content);return path;};
 const refused={
  'hidden or credential-like name':[put(join(run,'credentials.json'),secret),put(join(run,'.env.json'),secret),put(join(run,'signing.pem'),secret)],
  'credential-like content':[put(join(run,'receipt.json'),key),put(join(run,'publish.log'),`pushed with ${token} ${secret}`)],
  'outside the retained run folders':[put(join(dir,'owner-token'),secret),put(join(dir,'config.yaml'),secret)],
  'links outside the retained run folders':[join(run,'link.json')],
  'not a text evidence file':[put(join(run,'delivery.bundle'),secret)],
  'missing':[join(run,'never-written.json')],
 };
 symlinkSync(join(dir,'owner-token'),join(run,'link.json'));
 const receipt=put(join(run,'tested-tree.json'),'{"code":1}');
 const large=Array.from({length:12},(_,n)=>put(join(run,`output-${n}.json`),String(n%10).repeat(600*1024)));
 writeFileSync(join(dir,`worker-${session}.jsonl`),'first line\n'+'x'.repeat(3*1024*1024)+'\nfinal report\n');
 s.event(`failure:${session}`,'worker-failure',{id:session,error:'synthetic'},'none');s.event(`note:${session}`,'worker-note',{id:session,text:`leaked ${token} ${secret}`},'none');
 const clean=(made:ReturnType<typeof copyEvidence>,out:string)=>{
  expect(folderBytes(out)).toBeLessThanOrEqual(EVIDENCE_BYTES);
  for(const name of readdirSync(out)){const text=readFileSync(join(out,name),'utf8');expect(text).not.toContain(secret);expect(text).not.toContain(token);}
  expect(made.prompt).not.toContain(secret);expect(made.prompt).not.toContain(token);
  const manifest=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
  expect(manifest.files.map((f:{file:string})=>f.file).sort()).toEqual(readdirSync(out).filter(n=>n!=='manifest.json').map(n=>join(out,n)).sort());
 };
 // Credentials: every refused file is listed with its reason and none of its content is copied.
 const one=scratch('one'),first=copyEvidence(s,dir,one,{session,reason:`inspect ${[receipt,...Object.values(refused).flat()].join(' then ')}.`});
 clean(first,join(one,'evidence'));
 for(const [reason,paths] of Object.entries(refused))for(const path of paths)expect(first.notCopied).toContainEqual({path,reason});
 expect(first.files.filter(f=>f.from.startsWith(dir)).map(f=>[f.from,f.file])).toEqual([[receipt,join(one,'evidence/1-tested-tree.json')]]);
 // Only the copied path is repointed; a longer path that merely starts with it is left alone.
 expect(first.repoint(`see ${receipt}. and ${receipt}.bak`)).toBe(`see ${join(one,'evidence/1-tested-tree.json')}. and ${receipt}.bak`);
 expect(readFileSync(join(one,'evidence/events-1.jsonl'),'utf8').trim().split('\n')).toHaveLength(1);
 // Size: long files are shortened with start and end kept; once the cap is reached the rest are listed, not copied.
 const two=scratch('two'),second=copyEvidence(s,dir,two,{session,reason:`inspect ${[receipt,...large].join(' then ')}.`}),out=join(two,'evidence');
 clean(second,out);expect(folderBytes(out)).toBeGreaterThan(EVIDENCE_BYTES*0.8);
 const log=readFileSync(join(out,'worker-log-1.jsonl'),'utf8');expect(log.startsWith('first line')).toBe(true);expect(log.endsWith('final report\n')).toBe(true);expect(log).toContain('bytes left out of this copy');
 expect(second.notCopied.filter(x=>x.reason==='evidence size cap reached').length).toBeGreaterThan(0);
 s.close();
});

test('an owner decision gets the failed session evidence; an event that names nothing gets no folder',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'factory-owner-decision-'))),one=join(dir,'one'),two=join(dir,'two');mkdirSync(one);mkdirSync(two);
 const s=new Store(':memory:');s.event(`failure:${session}`,'worker-failure',{id:session,error:'synthetic'},'none');
 const result=join(dir,'runs/owner-wakes/diagnose_earlier/retry.json');
 const made=copyEvidence(s,dir,one,{id:`result:diagnose:${session}`,question:'Owner result could not be applied',evidence:{wake:`diagnose:${session}`,error:`Error: ENOENT: no such file or directory, open '${result}'`},default:'not approved'});
 expect(made.files.map(f=>f.file)).toEqual([join(one,'evidence/events-1.jsonl')]);
 expect(made.notCopied).toContainEqual({path:result,reason:'missing'});expect(made.prompt).toContain(`- ${result}: missing`);
 expect(copyEvidence(s,dir,two,{id:'refill',question:'Ready buffer low',evidence:{ready:1,round:'r',target:3},default:'not approved'}).prompt).toBe('');
 expect(existsSync(join(two,'evidence'))).toBe(false);
 s.close();
});
