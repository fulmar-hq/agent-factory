import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {publisherSources,publisherBoundary,readPublisherProof} from '../launcher/publisher-evidence';
test('old signed delivery cannot qualify a changed publisher implementation or policy',()=>{
 const dir=mkdtempSync(join(tmpdir(),'publisher-boundary-')),source=join(dir,'source');for(const path of publisherSources){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),'fictional original code');}writeFileSync(join(dir,'config.yaml'),'fictional policy');
 const before=publisherBoundary(source,dir,'fictional Git'),now=Date.now(),pub={id:'fictional',repo:'example/demo',head:'a'.repeat(40),tree:'b'.repeat(40),executionReceipt:join(dir,'runs/delivery/fictional/initial/publisher/implementation.json'),testedTreeReceipt:''};mkdirSync(dirname(pub.executionReceipt),{recursive:true});writeFileSync(pub.executionReceipt,JSON.stringify({version:1,boundary:before,startedAt:now-1000,completedAt:now,authorityExpiresAt:now+1000,head:pub.head,tree:pub.tree}));
 expect(readPublisherProof(dir,pub,before,now).tree).toBe(pub.tree);writeFileSync(join(source,'adapters/delivery.ts'),'fictional changed publisher');expect(()=>readPublisherProof(dir,pub,publisherBoundary(source,dir,'fictional Git'),now)).toThrow('current implementation');writeFileSync(join(source,'adapters/delivery.ts'),'fictional original code');writeFileSync(join(dir,'config.yaml'),'fictional changed policy');expect(()=>readPublisherProof(dir,pub,publisherBoundary(source,dir,'fictional Git'),now)).toThrow('current implementation');
});
