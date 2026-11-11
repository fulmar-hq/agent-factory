import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertReleaseInstallQuiescent} from '../launcher/release-install-quiescence';
test('installation requires actual pause, stopped workers, terminal effects and safe hours',()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-quiescent-')),db=new Database(join(dir,'controller.sqlite'));db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sessions(status TEXT);');
 const now=Date.parse('2026-11-11T00:30:00-05:00'),set=(v:unknown)=>db.query("INSERT OR REPLACE INTO kv VALUES('paused',?)").run(JSON.stringify(v));
 try{
 expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('pause admissions');set(false);expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('pause admissions');set(true);expect(()=>assertReleaseInstallQuiescent(dir,now)).not.toThrow();
 db.query('INSERT INTO sessions VALUES(?)').run('unknown');expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('worker custody');db.exec('DELETE FROM sessions');
 for(const state of ['claimed','running','unknown',null]){db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify({state}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('retained release effect');}
 for(const state of ['success','failure']){db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify({state}));expect(()=>assertReleaseInstallQuiescent(dir,now)).not.toThrow();}
 for(const time of ['17:30','19:00','20:00','21:30','22:34'])expect(()=>assertReleaseInstallQuiescent(dir,Date.parse(`2026-11-11T${time}:00-05:00`))).toThrow('proof/release window');
 writeFileSync(join(dir,'integration-freeze.json'),JSON.stringify({version:1,from:'2026-11-11T00:00:00-05:00',until:'2026-11-11T01:00:00-05:00',reason:'explicit proof hold'}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('proof/release window');
 }finally{db.close();}
});
