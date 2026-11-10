import {afterEach,expect,test} from 'bun:test';
import {Store} from '../tracking/store';
import {pendingWakes,queueWake} from '../launcher/wake';

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();});

test('each priority class orders shuffled events oldest first with stable ID ties',()=>{
 const s=new Store(':memory:');stores.push(s);
 const kinds=['product-intake','failure-diagnosis','owner-decision','ticket-ready'];
 for(const [suffix,at] of [['new',300],['tie-z',200],['old',100],['tie-a',200]] as const)
  for(const kind of [...kinds].reverse())queueWake(s,{id:`${kind}:${suffix}`,owner:'fictional-owner',kind,payload:{}},at);
 expect(pendingWakes(s).map(w=>w.id)).toEqual(kinds.flatMap(kind=>['old','tie-a','tie-z','new'].map(suffix=>`${kind}:${suffix}`)));
});

test('priority precedes age and routine kinds share one class',()=>{
 const s=new Store(':memory:');stores.push(s);
 for(const [id,kind,at] of [
  ['routine-new','review-returned',40],['decision','owner-decision',300],
  ['routine-old','ci-finished',0],['diagnosis','failure-diagnosis',400],
  ['intake','product-intake',500],['routine-middle','qualification-renewal',20],
 ] as const)queueWake(s,{id,owner:'fictional-owner',kind,payload:{}},at);
 expect(pendingWakes(s).map(w=>w.id)).toEqual(['intake','diagnosis','decision','routine-old','routine-middle','routine-new']);
});

test('legacy missing and invalid timestamps follow known ages by ID without mutation',()=>{
 const s=new Store(':memory:');stores.push(s);
 const invalid=[undefined,null,'100',-1,1.5,{},[],true,Number.MAX_SAFE_INTEGER,1e100];
 for(const [index,at] of [...invalid.entries()].reverse())
  s.set(`owner-wake:legacy-${index}`,{id:`legacy-${index}`,owner:'fictional-owner',kind:'ticket-ready',payload:{},state:'queued',at});
 queueWake(s,{id:'known-new',owner:'fictional-owner',kind:'ticket-ready',payload:{}},900);
 queueWake(s,{id:'known-epoch',owner:'fictional-owner',kind:'ticket-ready',payload:{}},0);
 // Unknown age does not demote an event below its existing priority class.
 s.set('owner-wake:intake-legacy',{id:'intake-legacy',owner:'fictional-owner',kind:'product-intake',payload:{},state:'queued'});
 const before=s.db.query('SELECT * FROM kv ORDER BY key').all();
 const events=s.rows('events');
 const expected=['intake-legacy','known-epoch','known-new',...invalid.map((_,i)=>`legacy-${i}`)];
 expect(pendingWakes(s).map(w=>w.id)).toEqual(expected);
 expect(pendingWakes(s).map(w=>w.id)).toEqual(expected);
 expect(s.db.query('SELECT * FROM kv ORDER BY key').all()).toEqual(before);
 expect(s.rows('events')).toEqual(events);
});

test('only queued wake records participate',()=>{
 const s=new Store(':memory:');stores.push(s);
 for(const state of ['starting','running','done','expired','failed','archived',undefined])
  s.set(`owner-wake:excluded-${state}`,{id:`excluded-${state}`,owner:'fictional-owner',kind:'product-intake',payload:{},state,at:0});
 s.set('unrelated',{id:'unrelated',state:'queued',at:0});
 queueWake(s,{id:'queued',owner:'fictional-owner',kind:'ticket-ready',payload:{}},100);
 expect(pendingWakes(s).map(w=>w.id)).toEqual(['queued']);
});

test('restart-equivalent reconstruction in reverse row order retains ordering and queue time',()=>{
 const s=new Store(':memory:'),restored=new Store(':memory:');stores.push(s,restored);
 for(const [id,kind,at] of [
  ['z','ticket-ready',200],['b','failure-diagnosis',500],['a','ticket-ready',200],
  ['old','ticket-ready',100],['intake','product-intake',600],
 ] as const)queueWake(s,{id,owner:'fictional-owner',kind,payload:{}},at);
 s.set('owner-wake:legacy',{id:'legacy',owner:'fictional-owner',kind:'ticket-ready',payload:{},state:'queued'});
 const rows=s.db.query('SELECT key,value FROM kv ORDER BY rowid DESC').all() as {key:string;value:string}[];
 for(const row of rows)restored.db.query('INSERT OR REPLACE INTO kv VALUES(?,?)').run(row.key,row.value);
 for(const row of s.rows('events') as {id:string;kind:string;data:string;undo:string;at:number}[])
  restored.event(row.id,row.kind,JSON.parse(row.data),row.undo,row.at);
 const expected=['intake','b','old','a','z','legacy'];
 expect(pendingWakes(s).map(w=>w.id)).toEqual(expected);
 expect(pendingWakes(restored).map(w=>w.id)).toEqual(expected);
 expect(queueWake(restored,{id:'old',owner:'fictional-owner',kind:'ticket-ready',payload:{}},9999)).toBe(false);
 expect(restored.get<{at:number}>('owner-wake:old')?.at).toBe(100);
 expect(pendingWakes(restored)).toEqual(pendingWakes(s));
});

test('existing release priorities remain ahead of intake with oldest-first ties',()=>{
 const s=new Store(':memory:');stores.push(s);
 for(const [id,kind,at] of [
  ['intake','product-intake',0],['release','release-diagnosis',10],
  ['production','production-verified',20],['qa-z','qa-deployed',30],
  ['qa-new','qa-deployed',40],['qa-a','qa-deployed',30],
 ] as const)queueWake(s,{id,owner:'fictional-owner',kind,payload:{}},at);
 expect(pendingWakes(s).map(w=>w.id)).toEqual(['qa-a','qa-z','qa-new','production','release','intake']);
});
