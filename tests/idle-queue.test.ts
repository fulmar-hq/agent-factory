import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {config} from './fixtures';
import {observeIdleQueue,watchIdleQueue} from '../launcher/idle-queue';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'idle-queue-')),s=new Store(join(dir,'controller.sqlite')),c=config(),now=Date.now();
 c.owners.product={harness:'codex',model:'gpt-6.1-sol',effort:'high'};
 c.autonomy={intake_mode:'build',intake_owner:'product',idle_wake_minutes:10,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['AGENTS.md']},restart:{max_retries:1,causes_per_hour:3}};
 s.set('paused',false);s.set('heartbeat',{at:now,status:'ok',ready:0,claimed:0});s.set('readings',{codex:{observedAt:now,source:'native fixture',windows:[{used:.73,resetsAt:now+86400000},{used:.73,resetsAt:now+86400000}]}});
 s.event('last-builder','worker-cleanup',{verified:true},'retain',now-21*60000);writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));
 const mail=join(dir,'mail.sqlite'),db=new Database(mail);db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,wake_id TEXT);`);
 return {dir,s,c,now,mail,db};}
test('empty queue plus stopped builders at73% sends action once across restart, and actual wake is separate',()=>{const f=fixture();try{
 const a=watchIdleQueue(f.dir,f.mail,f.now);expect(a.alert).toBeTruthy();expect(a).toMatchObject({wake:null});
 expect(f.db.query('SELECT kind,recipient FROM messages').all()).toEqual([{kind:'action',recipient:'Coordinator'}]);
 f.db.query("UPDATE messages SET wake_state='woken',wake_id='actual-test-wake'").run();
 expect(watchIdleQueue(f.dir,f.mail,f.now+1)).toMatchObject({alert:a.alert,wake:'actual-test-wake'});
 expect(f.db.query('SELECT id FROM messages').all()).toHaveLength(1);
 // A maintenance review never masks a builder stall.
 f.s.event('review','factory-challenge-started',{},'retain',f.now);expect(observeIdleQueue(f.s.db,f.c,f.now).lastActivity).toBe(f.now-21*60000);
}finally{f.s.close();f.db.close();}});
test('twenty-minute boundary, fresh queue, pause, usage stop and unknown custody fail closed',()=>{const f=fixture();try{
 f.s.event('boundary','worker-cleanup',{verified:true},'retain',f.now-20*60000);
 expect(watchIdleQueue(f.dir,f.mail,f.now).alert).toBeNull();
 f.s.set('paused',true);expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);f.s.set('paused',false);
 f.s.set('heartbeat',{at:f.now,status:'error',ready:0});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now,status:'ok',ready:1});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now-300001,status:'ok',ready:0});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('heartbeat',{at:f.now,status:'ok',ready:0});f.s.set('readings',{codex:{observedAt:f.now,source:'native fixture',windows:[{used:.90,resetsAt:f.now+86400000},{used:.1,resetsAt:f.now+86400000}]}});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);
 f.s.set('readings',{codex:{observedAt:f.now,source:'native fixture',windows:[{used:.73,resetsAt:f.now+86400000},{used:.1,resetsAt:f.now+86400000}]}});
 f.s.db.query('INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)').run('dormant','example/demo#1','product','codex','waiting-browser','{}');
 expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(false);f.s.set('cleanup-evidence:dormant',{verified:true});expect(observeIdleQueue(f.s.db,f.c,f.now).eligible).toBe(true);
}finally{f.s.close();f.db.close();}});
