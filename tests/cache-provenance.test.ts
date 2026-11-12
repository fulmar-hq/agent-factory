import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {publisherDependencyRecorder} from '../launcher/cache-provenance';

test('publisher inventories bind once to exact finished session checkout in both areas',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'factory-provenance-'))),s=new Store(':memory:');
 s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('a','fictional/site#1','product','codex','finished','{}');
 const record=publisherDependencyRecorder(s,root,'a'),fingerprint='a'.repeat(64),manifest={version:1,fingerprint,entries:{'fixture.js':{kind:'file',sha256:'b'.repeat(64),executable:false}}};
 for(const area of ['delivery','browser-drain']){
  const path=join(root,'runs',area,'a','attempt','publish-fixture');mkdirSync(path,{recursive:true});record(path,manifest,fingerprint);
  expect(()=>record(path,manifest,fingerprint)).toThrow('already recorded');
 }
 expect((s.db.query("SELECT key FROM kv WHERE key LIKE 'dependency-cache-manifest:%'").all()).length).toBe(1);
 const other=join(root,'runs/delivery/b/publish-fixture');mkdirSync(other,{recursive:true});expect(()=>record(other,manifest,fingerprint)).toThrow('outside session');
 const path=join(root,'runs/delivery/a/second');mkdirSync(path);expect(()=>record(path,{...manifest,fingerprint:'c'.repeat(64)},fingerprint)).toThrow('invalid');
 const linked=join(root,'runs/delivery/a/linked');symlinkSync(path,linked);expect(()=>record(linked,manifest,fingerprint)).toThrow('outside session');
 s.db.query("UPDATE sessions SET status='running'").run();expect(()=>record(path,manifest,fingerprint)).toThrow('not finished');s.close();
});
