import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectReleaseReadiness,originalSessionExpiry,releaseDiskReading,releasePreflightAlert,type ReleaseReadiness} from '../launcher/release-readiness';
import {Store} from '../tracking/store';
import {config,qualification,meter} from './fixtures';

const now=Date.parse('2026-11-12T19:00:00-05:00'),through=Date.parse('2026-11-12T22:30:00-05:00');
const carrier={day:'2026-11-12',base:'a'.repeat(40),revision:'b'.repeat(40),tree:'c'.repeat(40),pr:7,ref:'fix/fictional-batch',holdId:'fictional-off'};
const factorySource='d'.repeat(40);
const auth={version:1,kind:'original-password-mfa-session',signedInAt:'2026-11-11T23:30:00-05:00',expiresAt:'2026-11-12T23:30:00-05:00',receipt:'fictional original sign-in provenance'};
const hold={version:1,id:carrier.holdId,held:false,legacy_issue:null,reason:'Fictional open batch',by:'fixture',at:'2026-11-12T23:00:00Z'};
function environment(){
 const c=config();c.owners={release:{harness:'codex',model:'gpt-6.1-sol',effort:'medium'},quality:{harness:'claude',model:'opus-5.5',effort:'medium'}};
 const s=new Store(':memory:');s.set('paused',false);s.set('owner-runtime:quality',{workspace:tmpdir()});
 const q={...qualification(),expiresAt:through+1};
 const files:Record<string,unknown>={'release-auth-session.json':auth,'qualifications.json':{codex:q,claude:{...q,model:'opus-5.5'}},'release-quality-path.json':{version:1,qualified:true,provider:'claude',model:'opus-5.5',effort:'medium',expiresAt:through+1,source:factorySource,evidence:'fictional hosted browser and trusted receipt proof',hostedHttp:true,receiptIngestion:true},'readings.json':{codex:{...meter(),observedAt:now,windows:[{used:0.2,resetsAt:through+1},{used:0.3,resetsAt:through+1}]},claude:{...meter(),observedAt:now,windows:[{used:0.2,resetsAt:through+1},{used:0.3,resetsAt:through+1}]}}};
 const remotes:Record<string,unknown>={
  'actions/variables/QA_HOLD':{value:JSON.stringify(hold)},
  'issues/1192':{labels:[]},
  'pulls/7':{state:'open',draft:false,head:{sha:carrier.revision,ref:carrier.ref,repo:{full_name:'fulmar-hq/alido'}},base:{ref:'QA',repo:{full_name:'fulmar-hq/alido'}},mergeable:true,mergeable_state:'clean'},
  'git/ref/heads/QA':{object:{sha:carrier.base}},
  [`git/commits/${carrier.revision}`]:{tree:{sha:carrier.tree}},
  [`commits/${carrier.revision}/check-runs?per_page=100`]:{total_count:3,check_runs:['Verify','Secret scan','Release hold'].map((name,id)=>({id,name,app:{slug:'github-actions'},head_sha:carrier.revision,status:'completed',conclusion:'success'}))},
 };
 const execute=async(args:string[])=>{expect(args.slice(0,4)).toEqual(['gh','api','--method','GET']);const key=args[4].split('repos/fulmar-hq/alido/')[1];if(!(key in remotes))throw Error('unknown fictional source');return JSON.stringify(remotes[key]);};
 const options={dir:'/fictional',config:c,store:s,brake:null,billingRefusal:null,billingEvidence:{observedAt:now,receipt:'fictional fresh gross billing'},factorySource,carrier,now,execute,readJSON:async(path:string)=>files[path.split('/').at(-1)!]??null,disk:()=>({freeGiB:70,usedFraction:0.7})};
 return {s,c,files,remotes,options};
}

test('original sign-in must cover the full margin and cannot be replaced by refreshed credentials',()=>{
 expect(originalSessionExpiry(auth,now,through).expiresAt).toBeGreaterThan(through);
 for(const raw of [{expiresAt:auth.expiresAt}, {...auth,expiresAt:'2026-11-12T22:30:00-05:00'}, {...auth,expiresAt:'2026-11-12T22:29:59-05:00'}, {...auth,expiresAt:'2026-11-13T23:30:00-05:00'}, {...auth,receipt:''}])expect(()=>originalSessionExpiry(raw,now,through)).toThrow();
});

test('complete current inputs pass with only read-only GitHub requests',async()=>{
 const e=environment();try{const r=await collectReleaseReadiness(e.options);expect(r.ready).toBe(true);expect(r.missing).toEqual([]);expect(r.validThrough).toBe(through);}finally{e.s.close();}
});

test('billing failure cannot hide expired Quality qualification, disk shortage, hold and changed carrier',async()=>{
 const e=environment();try{
  (e.files['qualifications.json'] as any).claude.expiresAt=through-1;
  e.remotes['issues/1192']={labels:[{name:'qa-hold'}]};
  (e.remotes['pulls/7'] as any).head.sha='d'.repeat(40);
  const r=await collectReleaseReadiness({...e.options,brake:'billing refresh failed',disk:()=>({freeGiB:59.9,usedFraction:0.7})});
  expect(r.ready).toBe(false);expect(r.missing.map(x=>x.input)).toEqual(expect.arrayContaining(['billing and factory state','quality qualification','disk space','release holds','PR checks']));
 }finally{e.s.close();}
});

test('wrong app, incomplete inventory, stale usage and unresolved Quality custody refuse',async()=>{
 const e=environment();try{
  const key=`commits/${carrier.revision}/check-runs?per_page=100`;
  (e.remotes[key] as any).check_runs[0].app.slug='fictional-app';
  (e.files['readings.json'] as any).claude.observedAt=now-16*60000;
  e.s.set('owner-runtime:quality',{workspace:tmpdir(),wake:'fictional-uncertain'});e.s.set('owner-wake:fictional-uncertain',{state:'starting'});
  const r=await collectReleaseReadiness(e.options);expect(r.missing.map(x=>x.input)).toEqual(expect.arrayContaining(['PR checks','quality usage','Quality runner']));
  (e.remotes[key] as any).check_runs[0].app.slug='github-actions';(e.remotes[key] as any).total_count=4;
  expect((await collectReleaseReadiness(e.options)).missing.some(x=>x.input==='PR checks')).toBe(true);
 }finally{e.s.close();}
});

test('canonical and legacy hold labels and unknown usage cannot pass readiness',async()=>{
 const e=environment();try{
  for(const label of ['QA hold','qa-hold']){
   e.remotes['issues/1192']={labels:[{name:label}]};
   expect((await collectReleaseReadiness(e.options)).missing.some(x=>x.input==='release holds')).toBe(true);
  }
  e.remotes['issues/1192']={labels:[]};
  e.remotes['actions/variables/QA_HOLD']={value:JSON.stringify({...hold,legacy_issue:9})};
  e.remotes['issues/9']={labels:[{name:'QA hold'}]};
  delete (e.files['readings.json'] as any).claude;
  const r=await collectReleaseReadiness(e.options);
  expect(r.missing.map(x=>x.input)).toEqual(expect.arrayContaining(['release holds','quality usage']));
 }finally{e.s.close();}
});

test('Quality running or unknown custody refuses; known exited and reused PIDs follow dispatchWake',async()=>{
 const e=environment();try{
  e.s.set('owner-runtime:quality',{workspace:tmpdir(),pid:1234,identity:'fictional-prior-start'});
  expect((await collectReleaseReadiness({...e.options,identity:()=> 'fictional-prior-start'})).missing.some(x=>x.input==='Quality runner')).toBe(true);
  expect((await collectReleaseReadiness({...e.options,identity:()=>{throw Error('fictional process-table denial');}})).missing.some(x=>x.input==='Quality runner')).toBe(true);
  expect((await collectReleaseReadiness({...e.options,identity:()=>null})).ready).toBe(true);
  const reused=await collectReleaseReadiness({...e.options,identity:()=> 'fictional-other-start'});
  expect(reused.ready).toBe(true);
  e.s.set('owner-runtime:quality',{workspace:tmpdir(),pid:1234});
  expect((await collectReleaseReadiness({...e.options,identity:()=> 'fictional-prior-start'})).missing.some(x=>x.input==='Quality runner')).toBe(true);
 }finally{e.s.close();}
});

test('disk uses native df capacity and preserves the advisory warning without inventing an 80% stop',async()=>{
 const e=environment();try{
  const disk=await releaseDiskReading(async(args)=>{
   expect(args).toEqual(['/bin/df','-kP','/System/Volumes/Data']);
   return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fixture 1000000000 700000000 120000000 82% /System/Volumes/Data\n';
  },'/System/Volumes/Data');
  expect(disk.usedFraction).toBe(0.82);expect(disk.freeGiB).toBeCloseTo(120000000/2**20);
  const r=await collectReleaseReadiness({...e.options,disk:()=>disk});
  expect(r.ready).toBe(true);expect(r.evidence['disk space']).toMatchObject({warning:true,source:'df -kP'});
  await expect(releaseDiskReading(async()=> 'unavailable','/System/Volumes/Data')).rejects.toThrow();
 }finally{e.s.close();}
});

test('normal native usage readings satisfy preflight without requiring a separate readings file',async()=>{
 const e=environment();try{
  const readings=e.files['readings.json'] as {codex:ReturnType<typeof meter>;claude:ReturnType<typeof meter>};
  delete e.files['readings.json'];
  expect((await collectReleaseReadiness({...e.options,readings})).ready).toBe(true);
  expect((await collectReleaseReadiness(e.options)).missing.some(x=>x.input==='quality usage')).toBe(true);
 }finally{e.s.close();}
});

test('pause and STOP cannot conceal a failed or absent independent fresh billing read',async()=>{
 const e=environment();try{
  e.s.set('paused',true);e.s.set('aws-stop-latched',true);
  for(const billingRefusal of ['fictional Budgets read failed',undefined]){
   const r=await collectReleaseReadiness({...e.options,brake:'AWS stop latched',billingRefusal});
   expect(r.missing.map(x=>x.input)).toEqual(expect.arrayContaining(['fresh billing','factory state','billing and factory state']));
  }
 }finally{e.s.close();}
});

test('qualified CLI owner alone cannot satisfy a missing or mismatched hosted acceptance path',async()=>{
 const e=environment();try{
  const proof=e.files['release-quality-path.json'];
  for(const invalid of [null,{...(proof as object),hostedHttp:false},{...(proof as object),receiptIngestion:false},{...(proof as object),source:'e'.repeat(40)},{...(proof as object),provider:'codex'},{...(proof as object),expiresAt:through}]){
   e.files['release-quality-path.json']=invalid;
   const r=await collectReleaseReadiness(e.options);
   expect(r.ready).toBe(false);expect(r.missing.some(x=>x.input==='hosted acceptance path')).toBe(true);
   expect(r.missing.some(x=>x.input==='quality qualification')).toBe(false);
  }
  e.files['release-quality-path.json']=proof;
  expect((await collectReleaseReadiness({...e.options,factorySource:undefined})).missing.some(x=>x.input==='hosted acceptance path')).toBe(true);
 }finally{e.s.close();}
});

test('19:00 alert uses existing isolated outbox once per day, including crash/restart, and never alerts on success',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-preflight-')),path=join(dir,'mail.sqlite'),db=new Database(path),s=new Store(':memory:');
 db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)');
 const r:ReleaseReadiness={day:carrier.day,at:now,validThrough:through,ready:false,missing:[{input:'quality qualification',reason:'fictional expiry'}],evidence:{}};
 try{
  expect(releasePreflightAlert(s,{...r,ready:true,missing:[]},now,path)).toEqual({queued:false});
  expect(()=>releasePreflightAlert(s,r,now-60000,path)).toThrow('only admitted at 19:00');
  // A slow scheduled read crossing 19:01 must still deliver the one alert.
  const completed=now+61000;
  releasePreflightAlert(s,r,completed,path);releasePreflightAlert(s,r,completed,path);
  const restarted=new Store(':memory:');try{releasePreflightAlert(restarted,r,completed+1000,path);}finally{restarted.close();}
  expect(()=>releasePreflightAlert(s,{...r,at:completed},completed,path)).toThrow('only admitted at 19:00');
  expect(()=>releasePreflightAlert(s,r,now+50*60000,path)).toThrow('before 19:50');
  const rows=db.query('SELECT * FROM messages').all() as Record<string,unknown>[];
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({created_at:completed,recipient:'Vincent',recipient_app:'telegram',kind:'blocker',body:'',wake_state:'pending'});expect(String(rows[0].summary)).not.toContain('#');
  expect(()=>releasePreflightAlert(new Store(':memory:'),r,now,join(dir,'missing.sqlite'))).toThrow('existing Alido Mail');
 }finally{s.close();db.close();rmSync(dir,{recursive:true});}
});


test('readiness gates the effective ticket profile while Claude remains expired',async()=>{
 const e=environment();try{
  e.c.model_override='per_ticket_wins_then_per_role';
  e.files['release-acceptance-ticket.json']={version:1,repo:'fulmar-hq/alido',number:1192,owner:'quality',day:carrier.day,provider:'codex',model:'gpt-6.1-sol',effort:'medium',source:'fictional owner decision',expiresAt:through+1,excludedNatives:['fictional-writer']};
  (e.files['qualifications.json'] as any).claude.expiresAt=through-1;
  delete (e.files['readings.json'] as any).claude;
  e.files['release-quality-path.json']={...(e.files['release-quality-path.json'] as object),provider:'codex',model:'gpt-6.1-sol',effort:'medium'};
  const r=await collectReleaseReadiness(e.options);expect(r.ready).toBe(true);
  expect((r.evidence['owner qualification'] as any).quality.provider).toBe('codex');
  (e.files['qualifications.json'] as any).codex.expiresAt=through;
  expect((await collectReleaseReadiness(e.options)).missing.some(x=>x.input==='quality qualification')).toBe(true);
 }finally{e.s.close();}
});
