// A private factory directory in a temp folder for the idle watcher's tests:
// a real controller store, a config file and (unless a mail path is given) a
// hand-made mail table. It never touches the live factory or the live mail.
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../tracking/store';
import {config} from '../fixtures';

export const MINUTE=60000,HOUR=60*MINUTE;
export function idleFixture(now=Date.now(),mailPath?:string){
 const dir=mkdtempSync(join(tmpdir(),'idle-queue-')),s=new Store(join(dir,'controller.sqlite')),c=config();
 c.owners.product={harness:'codex',model:'gpt-6.1-sol',effort:'high'};
 c.autonomy={intake_mode:'build',intake_owner:'product',idle_wake_minutes:10,ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['AGENTS.md']},restart:{max_retries:1,causes_per_hour:3}};
 s.set('paused',false);s.set('heartbeat',{at:now,status:'ok',ready:0,claimed:0});s.set('readings',{codex:{observedAt:now,source:'native fixture',windows:[{used:.73,resetsAt:now+86400000},{used:.73,resetsAt:now+86400000}]}});
 for(const p of Object.values(c.projects))s.set(`github:${p.repo}`,{observedAt:now,count:0,truncated:false,error:null});
 s.event('last-builder','worker-cleanup',{verified:true},'retain',now-21*MINUTE);writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));
 const mail=mailPath??join(dir,'mail.sqlite'),db=new Database(mail);
 if(!mailPath)db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT,wake_id TEXT);`);
 const f={dir,s,c,now,mail,db,
  /** A fresh tick at `at`: heartbeat, complete inventory and a usage reading, as the tick writes them. */
  tick(at:number,heartbeat:Record<string,unknown>={ready:0,claimed:0},windows=[{used:.73,resetsAt:at+86400000},{used:.73,resetsAt:at+86400000}]){
   s.set('heartbeat',{at,status:'ok',...heartbeat});s.set('readings',{codex:{observedAt:at,source:'native fixture',windows}});
   for(const p of Object.values(c.projects))s.set(`github:${p.repo}`,{observedAt:at,count:0,truncated:false,error:null});
  },
  /** The watcher's own state file, opened read-only. */
  state:<T>(sql:string,...args:(string|number)[])=>{const state=new Database(join(dir,'health','idle-queue.sqlite'),{readonly:true});try{return state.query(sql).all(...args) as T[];}finally{state.close();}},
  close(){s.close();db.close();},
 };
 return f;
}
