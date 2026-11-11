import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertReleaseInstallQuiescent} from '../launcher/release-install-quiescence';
test('installation requires actual pause, stopped workers, terminal effects and safe hours',()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-quiescent-')),db=new Database(join(dir,'controller.sqlite'));db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sessions(id TEXT,status TEXT,pid INTEGER);');
 const now=Date.parse('2026-11-11T00:30:00-05:00'),set=(v:unknown)=>db.query("INSERT OR REPLACE INTO kv VALUES('paused',?)").run(JSON.stringify(v));
 try{
 expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('pause admissions');set(false);expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('pause admissions');set(true);expect(()=>assertReleaseInstallQuiescent(dir,now)).not.toThrow();
 db.query('INSERT INTO sessions VALUES(?,?,?)').run('worker','unknown',null);expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('worker custody');db.exec('DELETE FROM sessions');
 for(const state of ['claimed','running','unknown',null]){db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify({state}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('retained release effect');}
 db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify({state:'failure',handle:{run:1},context:{deadline:now-1}}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('retained release effect');
 db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify({state:'failure',evidence:{reason:'inventory unknown',run:1}}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('retained release effect');
 for(const effect of [{state:'success'},{state:'failure',evidence:{run:123,conclusion:'failure'}}]){db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run('executor:2026-11-10:qa',JSON.stringify(effect));expect(()=>assertReleaseInstallQuiescent(dir,now)).not.toThrow();}
 db.query('INSERT INTO sessions VALUES(?,?,?)').run('worker','paused',123);db.query('INSERT INTO kv VALUES(?,?)').run('cleanup-evidence:worker',JSON.stringify({verified:false}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('worker custody');
 db.exec('UPDATE sessions SET pid=NULL');expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('worker custody');db.query('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify({verified:true}),'cleanup-evidence:worker');expect(()=>assertReleaseInstallQuiescent(dir,now)).not.toThrow();
 for(const time of ['17:30','19:00','20:00','21:30','22:34'])expect(()=>assertReleaseInstallQuiescent(dir,Date.parse(`2026-11-11T${time}:00-05:00`))).toThrow('proof/release window');
 writeFileSync(join(dir,'integration-freeze.json'),JSON.stringify({version:1,from:'2026-11-11T00:00:00-05:00',until:'2026-11-11T01:00:00-05:00',reason:'explicit proof hold'}));expect(()=>assertReleaseInstallQuiescent(dir,now)).toThrow('proof/release window');
 }finally{db.close();}
});
