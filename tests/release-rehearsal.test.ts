import {test,expect} from 'bun:test';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {config} from './fixtures';
import {toronto} from '../launcher/release';
import {Store} from '../tracking/store';
import {recordRehearsal,gapOwner} from '../launcher/release-rehearsal';
import {releaseAction} from '../launcher/release-actions';
const at=Date.parse('2026-11-11T14:00:00-05:00');
const report={day:'2026-11-11',at,validThrough:at+1,ready:false,missing:[{input:'fresh billing',reason:'billing reading stale'},{input:'AWS sign-in',reason:'expired'},{input:'hosted acceptance path',reason:'wrong source'},{input:'PR checks',reason:'missing batch'}],evidence:{}};
test('dry rehearsal routes all gaps, retains clean logs, and deduplicates immutable action identities',()=>{
 const s=new Store(':memory:'),sent=new Map<string,string>();
 const send=(id:string,to:string,summary:string,body:string)=>{const content=JSON.stringify([to,summary,body]);expect(sent.get(id)??content).toBe(content);sent.set(id,content);return {id,queued:true};};
 try{recordRehearsal(s,report,'14:00',send);expect(sent.size).toBe(4);expect([...sent.values()].join()).toContain('18:30');
 recordRehearsal(s,{...report,at:at+1,missing:report.missing.map(m=>({...m,reason:'changed failure'}))},'17:40',send);expect(sent.size).toBe(4);
 recordRehearsal(s,{...report,at:at+2,ready:true,missing:[]},'17:40',send);expect(sent.size).toBe(4);
 expect(s.db.query("SELECT count(*) AS n FROM events WHERE kind='release-rehearsal'").get()).toEqual({n:3});
 expect(gapOwner('fresh billing','expired AWS sign-in')).toBe('Coordinator');
 }finally{s.close();}
});
test('action mail uses existing outbox once and refuses conflicting readback or a replacement store',()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-actions-')),path=join(dir,'mail.sqlite'),db=new Database(path);
 db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)');
 try{releaseAction('gap','Platform','Missing billing','Due 18:30',at,path);releaseAction('gap','Platform','Missing billing','Due 18:30',at+1,path);expect(db.query('SELECT count(*) AS n FROM messages').get()).toEqual({n:1});expect(()=>releaseAction('gap','Release','Other','Due 18:30',at,path)).toThrow('conflict');expect(()=>releaseAction('other','Release','Missing','Due',at,join(dir,'absent'))).toThrow('unavailable');}finally{db.close();}
});

test('real rehearsal entry point refreshes billing once, logs gaps and never invokes release effects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rehearsal-entry-')),bin=join(dir,'bin'),mail=join(dir,'mail.sqlite'),now=Date.now();mkdirSync(bin);
 const c=config();writeFileSync(join(dir,'config.yaml'),JSON.stringify(c));
 writeFileSync(join(dir,'release-auth-session.json'),JSON.stringify({version:1,kind:'original-password-mfa-session',signedInAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+23*3600000).toISOString(),receipt:'synthetic original session'}));
 writeFileSync(join(dir,'release-billing-source.json'),JSON.stringify({profile:'fixture',accountId:'123456789012',budgetName:'fixture'}));
 const budget={BudgetType:'COST',TimeUnit:'MONTHLY',BudgetLimit:{Amount:'75',Unit:'USD'},CostTypes:{IncludeTax:true,IncludeSubscription:true,IncludeRefund:false,IncludeCredit:false},TimePeriod:{Start:toronto(now).day.slice(0,7)+'-01T00:00:00Z'},LastUpdatedTime:new Date(now).toISOString(),CalculatedSpend:{ActualSpend:{Amount:'1',Unit:'USD'},ForecastedSpend:{Amount:'5',Unit:'USD'}}};
 const log=join(dir,'commands');
 writeFileSync(join(bin,'aws'),`#!/bin/sh
printf '%s\n' "$*" >> '${log}'
case "$*" in 'budgets describe-budget '*) printf '%s' '${JSON.stringify({Budget:budget})}';; *) exit 90;; esac
`,{mode:0o700});
 writeFileSync(join(bin,'gh'),`#!/bin/sh
printf '%s\n' "$*" >> '${log}'
case "$*" in 'api --method GET '*) printf '{}';; *) exit 91;; esac
`,{mode:0o700});
 const db=new Database(mail);db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)');db.close();
 const s=new Store(join(dir,'controller.sqlite'));s.set('paused',false);s.close();
 const run=Bun.spawn([process.execPath,new URL('../scripts/release.ts',import.meta.url).pathname,'rehearsal','14:00'],{env:{HOME:dir,PATH:bin+':/usr/bin:/bin',FACTORY_PRIVATE_DIR:dir,FACTORY_MAIL_DB:mail},stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);expect({code,err}).toEqual({code:0,err:''});
 expect(JSON.parse(out).effects).toBe(false);expect(JSON.parse(out).readiness.ready).toBe(false);
 const calls=readFileSync(log,'utf8').trim().split('\n');expect(calls.filter(x=>x.startsWith('budgets describe-budget'))).toHaveLength(1);expect(calls.every(x=>x.startsWith('budgets describe-budget')||x.startsWith('api --method GET'))).toBe(true);
 const check=new Store(join(dir,'controller.sqlite'));try{expect(check.db.query("SELECT count(*) AS n FROM kv WHERE key LIKE 'executor:%'").get()).toEqual({n:0});expect(check.db.query('SELECT count(*) AS n FROM debits').get()).toEqual({n:0});expect(check.get('release-rehearsal:'+toronto(now).day+':14:00')).not.toBeNull();}finally{check.close();}
 const imported=JSON.parse(readFileSync(join(dir,'release-billing.json'),'utf8'));expect(imported.observedAt).toBe(now);
},20000);
