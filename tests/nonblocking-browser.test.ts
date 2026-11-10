import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestEngine as Engine,config,ticket,admission,now} from './fixtures';
import {Store} from '../tracking/store';
import {queueBrowser,collectBrowserRequest,browserJobs,resumeBrowser,isLocalPreview} from '../launcher/browser';
import {nightlyUiChecklist} from '../launcher/nightly-ui';
function fixture(){const s=new Store(':memory:'),e=new Engine(s,config());e.pause(false,'owner');const x=e.admit(ticket(),admission());s.db.query("UPDATE sessions SET status='finished',native_id='fictional' WHERE id=?").run(x.id);s.set(`cleanup-evidence:${x.id}`,{verified:true});return {s,e,x};}
const request={result:'BROWSER_NEEDED',url:'https://console.example.test/status',goal:'Read status',noCliApi:'Only the signed-in console provides this status',expectedEvidence:'Exact status text'};
test('detached real-site check never retains or recreates builder workspace or resumes author',()=>{const {s,e,x}=fixture();const j=queueBrowser(e,x.id,request,now);expect(j.detached).toBe(true);expect(e.sessions()[0].status).toBe('finished');expect(s.get(`browser-parent:${x.id}`)).toBeNull();const dir=mkdtempSync(join(tmpdir(),'detached-check-'));j.result={nonce:j.nonce,status:'done',evidence:'Status observed',tabId:1,tabClosed:true};resumeBrowser(e,j,dir,()=>{throw Error('must not resume')});expect(existsSync(join(dir,'workspaces'))).toBe(false);s.close();});
test('local preview requests become nightly evidence without browser dispatch or parent wait',()=>{const {s,e,x}=fixture();const w=mkdtempSync(join(tmpdir(),'nightly-ui-'));mkdirSync(join(w,'.factory-tmp'));writeFileSync(join(w,'.factory-tmp/browser-needed.json'),JSON.stringify({...request,url:'http://127.0.0.1:3103'}));collectBrowserRequest(e,x.id,w,now);expect(e.sessions()[0].status).toBe('finished');expect(browserJobs(s)).toHaveLength(0);expect(s.db.query("SELECT key FROM kv WHERE key LIKE 'nightly-ui:%'").all()).toHaveLength(1);expect(()=>queueBrowser(e,x.id,{...request,url:'http://localhost:3103'})).toThrow('nightly');s.close();});
test('local aliases and unspecified addresses defer through the actual collection path',()=>{
 for(const host of ['localhost.','ui.localhost.','[::ffff:127.0.0.1]','[0:0:0:0:0:ffff:127.255.254.253]','[::ffff:7f00:1]','[::ffff:7fff:ffff]','[::]','[0:0:0:0:0:0:0:0]','[::ffff:0:0]','[0:0:0:0:0:ffff:0.0.0.0]']) {
  const {s,e,x}=fixture(),w=mkdtempSync(join(tmpdir(),'nightly-loopback-')),url=`http://${host}:3103/`;
  try {
   mkdirSync(join(w,'.factory-tmp'));writeFileSync(join(w,'.factory-tmp/browser-needed.json'),JSON.stringify({...request,url}));
   expect(collectBrowserRequest(e,x.id,w,now)).toBeUndefined();
   expect(e.sessions()[0].status).toBe('finished');expect(s.get(`browser-parent:${x.id}`)).toBeNull();
   expect(browserJobs(s)).toHaveLength(0);
   const rows=s.db.query("SELECT value FROM kv WHERE key LIKE 'nightly-ui:%'").all() as {value:string}[];
   expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.value)).toMatchObject({parent:x.id,state:'pending',request:{url}});
   expect(()=>queueBrowser(e,x.id,{...request,url},now)).toThrow('nightly');
   expect(browserJobs(s)).toHaveLength(0);
   expect(existsSync(join(w,'.factory-tmp/browser-needed.json'))).toBe(false);
  } finally {s.close();}
 }
});
test('remote rooted DNS and non-loopback mapped IPs retain their real-site browser route',()=>{
 for(const host of ['localhost.example.test.','127.example.test.','127.0.0.1.example.test','[::ffff:192.0.2.1]','[::ffff:128.0.0.1]','[::fffe:7f00:1]']) {
  const {s,e,x}=fixture(),url=`http://${host}:3103/`;
  try {expect(isLocalPreview(url)).toBe(false);expect(queueBrowser(e,x.id,{...request,url},now).state).toBe('queued');expect(browserJobs(s)).toHaveLength(1);}
  finally {s.close();}
 }
});
test('loopback forms cannot occupy the signed-in queue',()=>{for(const host of ['localhost','ui.localhost','127.0.0.1','127.2.3.4','[::1]','0.0.0.0','2130706433'])expect(isLocalPreview(`http://${host}:3103/`)).toBe(true);expect(isLocalPreview(request.url)).toBe(false);});
test('nightly checklist binds pending requests to published sources in frozen batch',()=>{const s=new Store(':memory:');for(const [id,pr] of [['a',12],['b',13]] as const){s.set(`nightly-ui:${id}`,{parent:id,repo:'fulmar-hq/alido',issue:pr,request,state:'pending'});s.event(id,'launcher-publish',{id,repo:'fulmar-hq/alido',url:`https://github.com/fulmar-hq/alido/pull/${pr}`},'retain');}const checks=nightlyUiChecklist(s,{sources:[{number:12}]} as any);expect(checks.map(x=>x.issue)).toEqual([12]);expect(checks[0].publication.url).toBe('https://github.com/fulmar-hq/alido/pull/12');s.close();});

test('Quality packet keeps its retained batch when the current same-day file changes or disappears',async()=>{
 const {qualityEvidencePacket}=await import('../launcher/owner');
 const {unlinkSync}=await import('node:fs');
 const s=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'frozen-nightly-packet-'));
 const batch={version:1 as const,day:'2026-11-10',base:'d'.repeat(40),revision:'a'.repeat(40),tree:'b'.repeat(40),pr:7,ref:'feat/fictional-batch',holdId:'original-hold',sources:[{number:12,head:'e'.repeat(40),ref:'feat/source',title:'Fictional source'}],overlaps:[],review:'Fictional independent review'};
 // Successful QA may have a new merge revision with exactly the frozen tree.
 const context={day:batch.day,revision:'c'.repeat(40),tree:batch.tree,holdId:'qa-hold',artifact:'fictional@sha256:'+'f'.repeat(64),batch};
 s.set(`executor:${batch.day}:qa`,{state:'success',context,evidence:{artifact:context.artifact}});
 for(const [id,pr] of [['a',12],['b',13]] as const){s.set(`nightly-ui:${id}`,{parent:id,repo:'fulmar-hq/alido',issue:pr,request,state:'pending'});s.event(id,'launcher-publish',{id,repo:'fulmar-hq/alido',url:`https://github.com/fulmar-hq/alido/pull/${pr}`},'retain');}
 const current=join(dir,'release-batch.json');writeFileSync(current,JSON.stringify(batch));
 try{
  writeFileSync(current,JSON.stringify({...batch,sources:[{...batch.sources[0],number:13}]}));
  expect(qualityEvidencePacket(s,context).nightlyUi.checks.map(x=>x.issue)).toEqual([12]);
  unlinkSync(current);
  expect(qualityEvidencePacket(s,context).nightlyUi.checks.map(x=>x.issue)).toEqual([12]);
  for(const changed of [{...context,batch:undefined},{...context,batch:{...batch,day:'2026-11-11'}},{...context,batch:{...batch,tree:'f'.repeat(40)}},{...context,batch:{...batch,sources:[{...batch.sources[0],number:13}]}},{...context,revision:'e'.repeat(40)},{...context,artifact:'different-artifact'}])expect(()=>qualityEvidencePacket(s,changed)).toThrow();
 }finally{s.close();}
});
