import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {requestFreezeProof} from '../launcher/release-freeze-proof';
const at=(time:string)=>Date.parse('2026-11-12T'+time+':00-05:00');
test('freeze automatically requests exact installed-source proof once, retains payload on retry, and never requests early/late',async()=>{
 const s=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'freeze-proof-')),mails=new Map<string,string>();let reads=0;
 const source=async()=>{reads++;return 'a'.repeat(40);},send=(id:string,to:string,summary:string,body:string)=>{const content=JSON.stringify([to,summary,body]);expect(mails.get(id)??content).toBe(content);mails.set(id,content);return {id,queued:true};};
 try{expect((await requestFreezeProof(s,dir,source,at('17:29'),send)).queued).toBe(false);await requestFreezeProof(s,dir,source,at('17:30'),send);await requestFreezeProof(s,dir,async()=>{throw Error('must retain frozen source');},at('17:40'),send);expect(reads).toBe(1);expect(mails.size).toBe(1);expect([...mails.values()][0]).toContain('a'.repeat(40));expect([...mails.values()][0]).toContain('22:30');expect((await requestFreezeProof(s,dir,source,at('19:00'),send)).queued).toBe(false);expect(s.get('owner-wake:mail:release-freeze-proof:2026-11-12')).toMatchObject({owner:'quality',state:'queued'});expect(s.db.query("SELECT count(*) AS n FROM kv WHERE key LIKE 'executor:%'").get()).toEqual({n:0});}finally{s.close();}
});
test('failed mail retries the original source and does not claim delivery or dispatch a model',async()=>{
 const s=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'proof-retry-'));
 try{await expect(requestFreezeProof(s,dir,async()=>'a'.repeat(40),at('17:30'),()=>{throw Error('outbox unavailable');})).rejects.toThrow('outbox');expect(s.get('owner-wake:mail:release-freeze-proof:2026-11-12')).toBeNull();let mailed='';await requestFreezeProof(s,dir,async()=>'b'.repeat(40),at('17:31'),(id,to,summary,body)=>{mailed=body;return {id,queued:true};});expect(mailed).toContain('a'.repeat(40));}finally{s.close();}
});
