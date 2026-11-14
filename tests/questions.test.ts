import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {TestEngine as Engine} from './fixtures';
import {resolveQuestions,boardQuestions} from '../launcher/questions';
import {expireDecisions} from '../launcher/questions';
import {config,ticket,admission,now} from './fixtures';

function setup(){const s=new Store(':memory:'),e=new Engine(s,config());e.pause(false,'owner');return e;}
function question(s:Store,id:string,to='vincent',answer:string|null=null){s.db.query('INSERT INTO questions(id,text,answer,at,addressed_to) VALUES(?,?,?,?,?)').run(id,'Synthetic question',answer,now,to);}

test('additive legacy migration retains unanswered and answered evidence across restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-question-')),path=join(dir,'state.sqlite');
 try{
  const db=new Database(path);db.exec("CREATE TABLE questions(id TEXT PRIMARY KEY,text TEXT NOT NULL,answer TEXT,at INTEGER NOT NULL); INSERT INTO questions VALUES('autonomy:old','old',NULL,1),('overrun:old','budget',NULL,2),('answered','kept','yes',3)");db.close();
  let s=new Store(path);expect(s.rows('questions')).toHaveLength(3);expect(boardQuestions(s).questions.map(q=>q.id)).toEqual(['overrun:old']);expect(boardQuestions(s).ownerQuestions[0].id).toBe('autonomy:old');s.close();
  s=new Store(path);expect(s.rows('questions')).toHaveLength(3);expect((s.rows('questions') as {answer:string|null}[])[2].answer).toBe('yes');s.close();
 }finally{rmSync(dir,{recursive:true});}
});

test('finished and archived overruns resolve once; missing and unresolved custody stay open',()=>{
 const e=setup();try{
  const x=e.admit(ticket(),admission()),y=e.admit(ticket(2),admission());
  question(e.s,`overrun:${x.id}`);question(e.s,`overrun:${y.id}`);question(e.s,'overrun:missing');question(e.s,'other');question(e.s,'answered','vincent','keep');
  e.finish(x.id,true);e.finish(y.id,false);e.archive(y.id,'synthetic custody','owner');
  expect(resolveQuestions(e,now+1)).toBe(2);expect(resolveQuestions(e,now+2)).toBe(0);
  expect(boardQuestions(e.s).questions.map(q=>q.id)).toEqual(['overrun:missing','other']);
  expect(boardQuestions(e.s).resolvedQuestions.map(q=>q.resolved_by).sort()).toEqual(['auto: session archived','auto: session finished']);
  expect(e.s.rows('questions')).toHaveLength(5);expect(e.s.rows('events').filter((r:any)=>r.kind==='question-auto-resolved')).toHaveLength(2);
 }finally{e.s.close();}
});

test('bounded continuation resolves original pause and another overrun reopens it',()=>{
 const e=setup();try{
  const x=e.admit(ticket(),admission());e.claimStart(x.id,now);e.register(x.id,1,'synthetic-native');
  e.account(x.id,50,2100,now);e.s.db.query('UPDATE sessions SET pid=NULL WHERE id=?').run(x.id);
  expect(resolveQuestions(e,now)).toBe(0);
  e.s.set('token-calibration:codex',2000);e.s.set(`cleanup-evidence:${x.id}`,{verified:true});e.s.event(`cleanup:${x.id}`,'cleanup',{verified:true},'retain');
  e.continueSession(x.id,'synthetic bounded extension',()=>{});
  expect(resolveQuestions(e,Date.now())).toBe(1);
  expect(boardQuestions(e.s).questions).toHaveLength(0);
  e.account(x.id,50,4100,Date.now());expect(boardQuestions(e.s).questions).toHaveLength(1);
  expect(resolveQuestions(e)).toBe(0);
 }finally{e.s.close();}
});

test('only explicit decision terminal states close owner questions; defaults apply before reconciliation',()=>{
 const e=setup();try{
  for(const state of ['open','defaulted','decided','owner-decided','unknown']){question(e.s,`autonomy:${state}`,'owner');e.s.set(`autonomy-decision:${state}`,{id:state,state,deadline:now+100,default:'not approved',outcome:'not approved'});}
  question(e.s,'autonomy:missing','owner');
  expect(resolveQuestions(e,now)).toBe(3);expect(boardQuestions(e.s).questions).toHaveLength(0);expect(boardQuestions(e.s).ownerQuestions).toHaveLength(3);
  expireDecisions(e.s,now+101);expect(resolveQuestions(e,now+101)).toBe(1);expect(resolveQuestions(e,now+102)).toBe(0);
 }finally{e.s.close();}
});
