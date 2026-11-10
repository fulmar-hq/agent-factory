import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {observeDisk,requireDiskCapacity,type DiskReading} from '../launcher/disk';
import {diskCapacityAlert} from '../launcher/alerts';
import {config,ticket,admission} from './fixtures';

const reading=(freeGiB:number,at=1):DiskReading=>({at,path:'fictional',freeGiB,usedFraction:0.9});
test('30 GiB floor admits boundary and refuses unknown and invalid readings',()=>{
 expect(requireDiskCapacity(()=>reading(30)).freeGiB).toBe(30);
 for(const r of [reading(29.999),reading(NaN),{at:1,path:'fictional',error:'unavailable'}])expect(()=>requireDiskCapacity(()=>r)).toThrow('disk admission');
});
test('low capacity cannot create a session, debit, or claim; fresh start refuses a later drop',()=>{
 const s=new Store(':memory:'),e=new Engine(s,config());e.pause(false,'owner');
 try {
  e.diskProbe=()=>reading(29);
  expect(()=>e.admit(ticket(),admission())).toThrow('disk admission');
  expect(e.sessions()).toHaveLength(0);expect(s.rows('debits')).toHaveLength(0);expect(s.db.query('select * from claims').all()).toHaveLength(0);
  e.diskProbe=()=>reading(30);const x=e.admit(ticket(),admission());
  e.diskProbe=()=>reading(29);expect(()=>e.claimStart(x.id)).toThrow('disk admission');
  expect(e.sessions()[0].status).toBe('reserved');
 }finally{s.close();}
});
test('disk falling between atomic reservation and start rolls back and never spawns',()=>{
 const s=new Store(':memory:'),e=new Engine(s,config());e.pause(false,'owner');let spawned=0;
 let probes=0;e.diskProbe=()=>reading(++probes===1?30:29);
 try {
  expect(()=>s.atomic(()=>{
   const x=e.admit(ticket(),admission());e.claimStart(x.id);spawned++;
  })).toThrow('disk admission');
  expect(spawned).toBe(0);expect(e.sessions()).toHaveLength(0);expect(s.rows('debits')).toHaveLength(0);
 }finally{s.close();}
});
test('critical/unknown alarms retry existing bridge once per episode and rearm after recovery',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'factory-disk-alarm-')),'mail.sqlite'),db=new Database(path),s=new Store(':memory:');
 db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)`);
 const observe=(r:DiskReading)=>observeDisk(s,r,()=>{});
 try {
  observe(reading(29));diskCapacityAlert(s,1,path+'-missing');
  expect(s.rows('events').some((r:any)=>r.kind==='disk-alert-failure')).toBe(true);
  diskCapacityAlert(s,2,path);observe(reading(28,3));diskCapacityAlert(s,3,path);
  expect(db.query('select * from messages').all()).toHaveLength(1);
  // Crash after insertion before local receipt.
  s.set('alert:disk-capacity:1:critical',null);diskCapacityAlert(s,4,path);
  expect(db.query('select * from messages').all()).toHaveLength(1);
  observe(reading(30,5));diskCapacityAlert(s,5,path);
  observe(reading(29,6));diskCapacityAlert(s,6,path);
  observe({at:7,path:'fictional',error:'unavailable'});diskCapacityAlert(s,7,path);
  expect(db.query('select * from messages').all()).toHaveLength(3);
  expect(s.get('paused')).toBe(true);
 }finally{s.close();db.close();}
});
