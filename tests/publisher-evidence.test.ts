import {createHash} from 'node:crypto';
import {qualification} from './fixtures';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {publisherSources,publisherBoundary,readPublisherProof,publisherQualificationVerified} from '../launcher/publisher-evidence';
test('old signed delivery cannot qualify a changed publisher implementation or policy',()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-boundary-')),source=join(dir,'source');for(const path of publisherSources){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),'fictional original code');}writeFileSync(join(dir,'config.yaml'),'fictional policy');
 const before=publisherBoundary(source,dir,'fictional Git'),now=Date.now(),pub={id:'fictional',repo:'example/demo',head:'a'.repeat(40),tree:'b'.repeat(40),executionReceipt:join(dir,'runs/delivery/fictional/initial/publisher/implementation.json'),testedTreeReceipt:''};mkdirSync(dirname(pub.executionReceipt),{recursive:true});writeFileSync(pub.executionReceipt,JSON.stringify({version:1,boundary:before,startedAt:now-1000,completedAt:now,authorityExpiresAt:now+1000,head:pub.head,tree:pub.tree}));
 expect(readPublisherProof(dir,pub,before,now).tree).toBe(pub.tree);writeFileSync(join(source,'adapters/delivery.ts'),'fictional changed publisher');expect(()=>readPublisherProof(dir,pub,publisherBoundary(source,dir,'fictional Git'),now)).toThrow('current implementation');writeFileSync(join(source,'adapters/delivery.ts'),'fictional original code');writeFileSync(join(dir,'config.yaml'),'fictional changed policy');expect(()=>readPublisherProof(dir,pub,publisherBoundary(source,dir,'fictional Git'),now)).toThrow('current implementation');
});


test('publisher expiry evidence stays bound to current Codex records across an unrelated provider update',()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-qualification-')),source=join(dir,'source'),run=join(dir,'runs/qualified'),report=join(run,'report.md'),now=Date.now();for(const path of publisherSources){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),'fictional code');}writeFileSync(join(dir,'config.yaml'),'fictional policy');mkdirSync(run,{recursive:true});writeFileSync(report,'fictional qualification report');
 const boundary=publisherBoundary(source,dir,'fictional Git'),q={codex:{...qualification(),effort:'high',evidence:report},'codex:high':{...qualification(),effort:'high',evidence:report},'codex:medium':{...qualification(),evidence:report},claude:{preserved:'original'}},bindings=Object.fromEntries(['codex','codex:medium','codex:high'].map(key=>[key,createHash('sha256').update(JSON.stringify(q[key as keyof typeof q])).digest('hex')]));writeFileSync(join(run,'prepared.json'),JSON.stringify({bindings}));
 const head='a'.repeat(40),tree='b'.repeat(40),authority={version:2,expiresAt:now+3600000,evidence:report},readback={publisherExpiresAt:authority.expiresAt,publisherProof:{version:1,boundary,startedAt:now-1000,completedAt:now,authorityExpiresAt:now+1000,head,tree},pub:{head,tree},tested:{code:0,tree},verification:{verified:true,reason:'valid'}};writeFileSync(join(run,'publisher-readback.json'),JSON.stringify(readback));
 expect(publisherQualificationVerified(dir,authority,JSON.stringify(q),boundary)).toBe(true);q.claude={preserved:'legitimate update'};expect(publisherQualificationVerified(dir,authority,JSON.stringify(q),boundary)).toBe(true);readback.verification.verified=false;writeFileSync(join(run,'publisher-readback.json'),JSON.stringify(readback));expect(publisherQualificationVerified(dir,authority,JSON.stringify(q),boundary)).toBe(false);
});


test('changing only the trusted dependency helper invalidates publisher proof',()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-helper-boundary-')),source=join(dir,'source'),helper='launcher/cache-provenance.ts';
 for(const path of publisherSources){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),'fictional original code');}writeFileSync(join(dir,'config.yaml'),'fictional policy');
 const before=publisherBoundary(source,dir,'fictional Git'),now=Date.now(),pub={id:'fictional',repo:'example/demo',head:'a'.repeat(40),tree:'b'.repeat(40),executionReceipt:join(dir,'runs/delivery/fictional/initial/publisher/implementation.json'),testedTreeReceipt:''};
 mkdirSync(dirname(pub.executionReceipt),{recursive:true});writeFileSync(pub.executionReceipt,JSON.stringify({version:1,boundary:before,startedAt:now-1000,completedAt:now,authorityExpiresAt:now+1000,head:pub.head,tree:pub.tree}));
 expect(readPublisherProof(dir,pub,before,now).tree).toBe(pub.tree);
 writeFileSync(join(source,helper),'fictional changed dependency helper');
 const after=publisherBoundary(source,dir,'fictional Git');expect(after.hashes[helper]).not.toBe(before.hashes[helper]);
 expect(Object.fromEntries(Object.entries(after.hashes).filter(([path])=>path!==helper))).toEqual(Object.fromEntries(Object.entries(before.hashes).filter(([path])=>path!==helper)));
 expect(()=>readPublisherProof(dir,pub,after,now)).toThrow('current implementation');
});
