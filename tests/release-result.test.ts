import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {releaseWindowResult,readQaServerStates,type QaServerStates} from '../launcher/release-result';
const day='2026-11-12',now=Date.parse(`${day}T22:00:00-05:00`);
const context={day,revision:'a'.repeat(40),tree:'b'.repeat(40),holdId:'fictional',deadline:now};
const artifact='example.test/fictional@sha256:'+'c'.repeat(64),main='d'.repeat(40);
const stopped:QaServerStates={observedAt:now,ec2:'stopped',rds:'stopped',evidence:'fictional exact resource observation'};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'factory-result-')),path=join(dir,'mail.sqlite'),db=new Database(path),s=new Store(':memory:');
 db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)');s.set('paused',false);
 return {s,db,path,options:{now,path,observeServers:async()=>stopped},close:()=>{s.close();db.close();rmSync(dir,{recursive:true});}};
}
function delivered(s:Store){
 s.set(`executor:${day}:qa`,{state:'success',context,evidence:{artifact,completedAt:now-60000}});
 s.set(`executor:${day}:acceptance`,{day,revision:context.revision,tree:context.tree,artifact,verdict:'ACCEPT',native:'fictional-independent-native',at:now-30000});
 for(const step of ['promote','readback'])s.set(`executor:${day}:${step}`,{state:'success',context,evidence:{artifact,main}});
}
const rows=(db:Database)=>db.query('SELECT * FROM messages').all() as Record<string,unknown>[];

test('before22:00 never reads AWS or queues a result, even after a successful deployment',async()=>{
 const f=fixture();try{delivered(f.s);expect(await releaseWindowResult(f.s,{...f.options,now:now-1,observeServers:async()=>{throw Error('must not observe');}})).toEqual({queued:false});expect(rows(f.db)).toHaveLength(0);}finally{f.close();}
});
test('verified promotion and exact accepted readback send a plain shipped result with fresh stopped proof',async()=>{
 const f=fixture();try{delivered(f.s);expect(await releaseWindowResult(f.s,f.options)).toMatchObject({queued:true,shipped:true,stopped:true});expect(rows(f.db)[0]).toMatchObject({summary:'Shipped. QA servers stopped: yes.',body:'',recipient:'Vincent',recipient_app:'telegram',kind:'handoff',reply:'none',wake_state:'pending'});}finally{f.close();}
});
test('a successful readback for a different tree or main cannot report shipped',async()=>{
 for(const changed of [{context:{...context,tree:'f'.repeat(40)},evidence:{artifact,main}},{context,evidence:{artifact,main:'f'.repeat(40)}}]){
  const f=fixture();try{delivered(f.s);f.s.set(`executor:${day}:readback`,{state:'success',...changed});expect(await releaseWindowResult(f.s,f.options)).toMatchObject({shipped:false});expect(String(rows(f.db)[0].summary)).toStartWith('Not shipped');}finally{f.close();}
 }
});
test('missing native or artifact proof and late acceptance cannot report shipped',async()=>{
 for(const change of [{native:''},{artifact:''},{at:now},{at:now-90000}]){
  const f=fixture();try{delivered(f.s);f.s.set(`executor:${day}:acceptance`,{...f.s.get<object>(`executor:${day}:acceptance`),...change});expect(await releaseWindowResult(f.s,f.options)).toMatchObject({shipped:false});}finally{f.close();}
 }
});
test('readback is required, rejected or missing independent acceptance gives an honest reason',async()=>{
 for(const verdict of ['REJECT',null]){
  const f=fixture();try{
   f.s.set(`executor:${day}:qa`,{state:'success',context,evidence:{artifact}});
   if(verdict)f.s.set(`executor:${day}:acceptance`,{verdict});
   await releaseWindowResult(f.s,f.options);
   expect(String(rows(f.db)[0].summary)).toContain(verdict?'independent tester rejected':'independent acceptance was missing or late');
  }finally{f.close();}
 }
});
test('missed windows and missing readiness inputs report not shipped without requiring a night record',async()=>{
 for(const missing of [null,[{input:'quality qualification'}],[{input:'AWS sign-in'}],[{input:'PR checks'}]]){
  const f=fixture();try{if(missing)f.s.set(`release-preflight-report:${day}`,{ready:false,missing});expect(await releaseWindowResult(f.s,f.options)).toMatchObject({shipped:false});expect(String(rows(f.db)[0].summary)).toStartWith('Not shipped because');expect(String(rows(f.db)[0].summary)).not.toMatch(/#|gpt|opus/);}finally{f.close();}
 }
});
test('running, stopping, stale or unavailable server observations never become stopped yes',async()=>{
 const observations=[async()=>({...stopped,ec2:'running'}),async()=>({...stopped,rds:'stopping'}),async()=>({...stopped,observedAt:now-60001}),async()=>({...stopped,observedAt:now+30001}),async()=>({...stopped,evidence:''}),async()=>{throw Error('fictional AWS read failure');}];
 for(const observeServers of observations){const f=fixture();try{delivered(f.s);expect(await releaseWindowResult(f.s,{...f.options,observeServers})).toMatchObject({queued:true,shipped:true,stopped:false});expect(String(rows(f.db)[0].summary)+' '+String(rows(f.db)[0].body)).toContain('QA servers stopped: no');}finally{f.close();}}
});
test('stable bridge ID deduplicates repeat calls and a crash before the controller receipt',async()=>{
 const f=fixture();try{
  await releaseWindowResult(f.s,f.options);
  expect(await releaseWindowResult(f.s,{...f.options,observeServers:async()=>{throw Error('must not read twice');}})).toEqual({queued:false});
  const restarted=new Store(':memory:');try{await releaseWindowResult(restarted,{...f.options,now:now+1000});expect(rows(f.db)).toHaveLength(1);}finally{restarted.close();}
 }finally{f.close();}
});
test('bridge failure retains no success and a later invocation retries the same daily result',async()=>{
 const f=fixture();try{
  await expect(releaseWindowResult(f.s,{...f.options,path:join(f.path,'missing')})).rejects.toThrow('existing Alido Mail');
  expect(f.s.get(`release-window-result:${day}`)).toBeNull();
  await releaseWindowResult(f.s,f.options);expect(rows(f.db)).toHaveLength(1);
 }finally{f.close();}
});
test('QA observer only describes exact private targets and rejects missing or mismatched resources',async()=>{
 const target={profile:'fictional',region:'example-1',instance:'i-123abc',database:'fictional-db'};
 const calls:string[][]=[];
 const execute=async(args:string[])=>{calls.push(args);expect(args[1]).toBeOneOf(['ec2','rds']);expect(args[2]).toBeOneOf(['describe-instances','describe-db-instances']);return JSON.stringify([[args[1]==='ec2'?target.instance:target.database,'stopped']]);};
 expect(await readQaServerStates(target,execute)).toMatchObject({ec2:'stopped',rds:'stopped'});expect(calls).toHaveLength(2);
 expect(calls[0]).toContain('--instance-ids');expect(calls[1]).toContain('--db-instance-identifier');
 for(const output of ['[]','[["wrong-target","stopped"]]','[["i-123abc","stopped"],["extra","stopped"]]'])await expect(readQaServerStates(target,async()=>output)).rejects.toThrow('Exact QA server');
});
