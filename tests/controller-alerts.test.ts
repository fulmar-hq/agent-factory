import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {watchControllerAlerts,recordTickResult,flushControllerAlerts} from '../launcher/controller-alerts';
import {tickSummary} from '../launcher/tick';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'controller-alert-')),s=new Store(join(dir,'controller.sqlite')),mail=join(dir,'mail.sqlite'),db=new Database(mail),now=Date.now();
 db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,wake_id TEXT)');return {dir,s,mail,db,now};}
test('paused ready queue wakes Coordinator without usage permission, once per pause across restart',()=>{const f=fixture();try{
 f.s.set('paused',true);f.s.set('heartbeat',{at:f.now,status:'ok',ready:31});f.s.event('pause-1','pause',{},'retain',f.now-6*60000);
 expect(watchControllerAlerts(f.dir,f.mail,f.now)).toEqual({pausedReady:true});
 expect(f.db.query('SELECT kind,recipient,wake_state FROM messages').all()).toEqual([{kind:'action',recipient:'Coordinator',wake_state:'pending'}]);
 f.db.exec("UPDATE messages SET wake_state='woken',wake_id='actual-wake'");watchControllerAlerts(f.dir,f.mail,f.now+1);
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 const health=new Database(join(f.dir,'health/controller-alerts.sqlite'));expect(health.query('SELECT wake FROM incidents').get()).toEqual({wake:'actual-wake'});health.close();
 f.s.set('paused',false);expect(watchControllerAlerts(f.dir,f.mail,f.now+2)).toEqual({pausedReady:false});
}finally{f.s.close();f.db.close();}});
test('recent pause, empty/stale/unknown queue and live workers do not claim paused-ready incident',()=>{const f=fixture();try{
 f.s.set('paused',true);f.s.event('pause','pause',{},'retain',f.now-6*60000);
 for(const h of [{at:f.now,status:'ok',ready:0},{at:f.now-16*60000,status:'ok',ready:31},{at:f.now,status:'error',ready:31}]){f.s.set('heartbeat',h);expect(watchControllerAlerts(f.dir,f.mail,f.now).pausedReady).toBe(false);}
 f.s.set('heartbeat',{at:f.now,status:'ok',ready:31});f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('live','example/demo#1','product','codex','running','{}');
 expect(watchControllerAlerts(f.dir,f.mail,f.now).pausedReady).toBe(false);expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(0);
}finally{f.s.close();f.db.close();}});
test('tick error alert survives controller write lock, bridge outage, restart and later success',async()=>{const f=fixture();try{
 f.s.db.exec('BEGIN IMMEDIATE');
 const lines:string[]=[];
 await expect(tickSummary(async()=>{throw Error('SQLiteError: database is locked')},line=>lines.push(line),r=>recordTickResult(f.dir,f.mail,r))).rejects.toThrow('database is locked');
 expect(lines.map(l=>JSON.parse(l).status)).toEqual(['error']);
 expect(f.db.query('SELECT kind,recipient FROM messages').all()).toEqual([{kind:'action',recipient:'Coordinator'}]);
 recordTickResult(f.dir,f.mail,{at:f.now+1,status:'error'});expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 recordTickResult(f.dir,f.mail,{at:f.now+2,status:'ok'});
 expect(()=>recordTickResult(f.dir,join(f.dir,'absent.sqlite'),{at:f.now+3,status:'error'})).toThrow('bridge unavailable');
 flushControllerAlerts(f.dir,f.mail,f.now+4);expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(2);
}finally{f.s.db.exec('ROLLBACK');f.s.close();f.db.close();}});
