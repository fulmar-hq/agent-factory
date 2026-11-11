import {Database} from 'bun:sqlite';
import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {config} from './fixtures';
import {watchReleasePause,pauseOwner} from '../launcher/release-pause';
const at=(time:string)=>Date.parse('2026-11-11T'+time+':00-05:00');
function setup(){const dir=mkdtempSync(join(tmpdir(),'release-pause-')),s=new Store(':memory:');const batch={version:1,day:'2026-11-11',base:'a'.repeat(40),revision:'b'.repeat(40),tree:'c'.repeat(40),pr:10,ref:'fix/fixture',holdId:'fixture',sources:[{number:1,head:'d'.repeat(40),ref:'fix/source',title:'Fixture'}],overlaps:[],review:'fictional accepted batch'};writeFileSync(join(dir,'release-batch.json'),JSON.stringify(batch));s.set('paused',true);s.event('pause-1','pause',{owner:'Platform'},'fixture',at('16:00'));return {dir,s,batch};}
test('earlier active pause alerts at freeze start; repeated observations retain one action per owner/episode',()=>{
 const {dir,s}=setup(),mails=new Map<string,string>(),send=(id:string,to:string,summary:string,body:string)=>{mails.set(id,to);expect(body).toContain('do not automatically lift');return {id,queued:true};};
 try{expect(watchReleasePause(s,dir,at('17:29'),send).queued).toBe(false);watchReleasePause(s,dir,at('17:30'),send);watchReleasePause(s,dir,at('20:45'),send);expect([...mails.values()].sort()).toEqual(['Coordinator','Platform']);expect(s.get('paused')).toBe(true);
 s.event('resume-1','resume',{},'fixture',at('20:45')+30000);s.event('pause-2','pause',{owner:'Release'},'fixture',at('20:46'));watchReleasePause(s,dir,at('20:46'),send);expect([...mails.values()].sort()).toEqual(['Coordinator','Coordinator','Platform','Release']);
 expect(watchReleasePause(s,dir,at('22:35'),send).queued).toBe(false);s.set('paused',false);expect(watchReleasePause(s,dir,at('21:30'),send).queued).toBe(false);
 }finally{s.close();}
});
test('no accepted current batch means no pause action; malformed/old packets never manufacture acceptance',()=>{
 const {dir,s,batch}=setup(),send=()=>{throw Error('must not send');};try{for(const packet of [{}, {...batch,day:'2026-11-10'}]){writeFileSync(join(dir,'release-batch.json'),JSON.stringify(packet));expect(watchReleasePause(s,dir,at('20:45'),send).queued).toBe(false);}}finally{s.close();}
});
test('authenticated pause persists attributable role; generic controls retain Coordinator accountability without invented identity',()=>{
 const s=new Store(':memory:'),e=new Engine(s,config());s.set('paused',false);try{e.pause(true,'owner','Quality');expect(s.get('paused')).toBe(true);expect(s.db.query("SELECT json_extract(data,'$.owner') AS owner FROM events WHERE kind='pause'").get()).toEqual({owner:'Quality'});expect(()=>e.pause(false,'helper')).toThrow('owner only');expect(s.get('paused')).toBe(true);expect(pauseOwner(undefined)).toBe('Coordinator');expect(()=>pauseOwner('someone')).toThrow('pause owner');}finally{s.close();}
});

test('the authenticated Engine pause entry point immediately queues both role actions without a reconcile tick',()=>{
 const f=setup();f.s.close();const s=new Store(join(f.dir,'controller.sqlite')),mail=join(f.dir,'mail.sqlite'),db=new Database(mail),priorMail=process.env.FACTORY_MAIL_DB;
 db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)');
 s.set('paused',false);const clock=spyOn(Date,'now').mockReturnValue(at('20:45'));process.env.FACTORY_MAIL_DB=mail;
 try{new Engine(s,config()).pause(true,'owner','Platform');expect(s.get('paused')).toBe(true);expect(db.query('SELECT recipient,kind FROM messages ORDER BY recipient').all()).toEqual([{recipient:'Coordinator',kind:'action'},{recipient:'Platform',kind:'action'}]);expect(s.get('owner-wake:mail:'+String((db.query("SELECT id FROM messages WHERE recipient='Platform'").get() as any).id))).toMatchObject({owner:'platform',state:'queued'});}finally{clock.mockRestore();if(priorMail===undefined)delete process.env.FACTORY_MAIL_DB;else process.env.FACTORY_MAIL_DB=priorMail;db.close();s.close();}
});

test('repeated authenticated true requests preserve the uninterrupted episode and its pausing role',()=>{
 const {dir,s}=setup(),e=new Engine(s,config()),sent=new Set<string>(),send=(id:string)=>{sent.add(id);return {id,queued:true};},clock=spyOn(Date,'now').mockReturnValue(at('20:45'));
 try{watchReleasePause(s,dir,at('20:45'),send);e.pause(true,'owner','Quality');watchReleasePause(s,dir,at('20:45')+1000,send);expect(sent.size).toBe(2);expect(s.db.query("SELECT count(*) AS n FROM events WHERE kind='pause'").get()).toEqual({n:2});}finally{clock.mockRestore();s.close();}
});
test('pending recipients retry after resume and after a later pause without replaying queued actions',()=>{
 for(const nextPause of [false,true]){
  const {dir,s}=setup(),sent=new Map<string,string>();let fail=true;
  const send=(id:string,to:any)=>{if(to==='Platform'&&fail)throw Error('temporary mail failure');sent.set(id,to);return {id,queued:true};};
  try{expect(watchReleasePause(s,dir,at('20:45'),send).pending).toBe(1);s.set('paused',false);s.event('resumed','resume',{},'fixture',at('20:45')+10000);
   if(nextPause){s.set('paused',true);s.event('new-quality','pause',{owner:'Quality'},'fixture',at('20:45')+20000);}
   fail=false;expect(watchReleasePause(s,dir,at('20:45')+30000,send).pending).toBe(0);expect([...sent.values()]).toContain('Platform');expect(sent.size).toBe(nextPause?4:2);watchReleasePause(s,dir,at('22:35'),()=>{throw Error('completed action replay');});
  }finally{s.close();}
 }
});
