import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import type {Engine} from './engine';
import {mailPath} from './alerts';

const undo='Retain idle episodes, alerts and custody; undo behavior with a signed revert';
export type SupplyObservation={claimed:number;refusals:{ticket:string;reason:string}[]};
export type SupplyIdle={id:string;since:number;wake?:string;alertId?:string};

// Called after real admission attempts. A labelled but refused ticket is not
// claimable supply. Never relax admission to recover an idle installation.
export function observeSupplyIdle(e:Engine,claimable:number,now:number,observation:SupplyObservation,path=mailPath()) {
 const slots=e.slots();
 if(!e.c.autonomy || e.s.get('paused')!==false || !slots.free || claimable>0 || observation.claimed>0){
  if(e.s.get('supply-idle'))e.s.set('supply-idle',null);
  return null;
 }
 let idle=e.s.get<SupplyIdle>('supply-idle');
 if(!idle){
  idle={id:crypto.randomUUID(),since:now};e.s.set('supply-idle',idle);
  e.s.event(`supply-idle:${idle.id}`,'supply-idle-started',{...idle,free:slots.free},undo,now);
 }
 if(now-idle.since>=7200000){
  const id=`supply-idle-alert:${idle.id}`;
  if(!e.s.get(id))try {
   // Share the existing zero-claim watchdog's outbox identity during rollout.
   // Freeze it before the bridge write so a crash cannot change the retry ID.
   if(!idle.alertId){
    const incident=e.s.get<{id:string;state:string;since:number}>('watchdog-stall');
    const progress=e.s.get<{since:number;free:boolean;claimed:number}>('claim-progress');
    // The watchdog samples the end of this tick, a few milliseconds later.
    const alertId=incident?.state==='open' && incident.since<=idle.since+120000 ? incident.id
     : progress?.free && progress.claimed===0 && progress.since<=idle.since+120000 ? `claim-stall:${progress.since}` : id;
    idle={...idle,alertId};e.s.set('supply-idle',idle);
   }
   if(!existsSync(path))throw Error('existing Telegram bridge store unavailable');
   const summary='Factory has had free capacity and nothing claimable for 2 hours. Intake recovery is retrying; Product needs attention.';
   const bridgeId=idle.alertId ?? id;
   const db=new Database(path,{readwrite:true,strict:true});
   try {
    db.exec('PRAGMA busy_timeout=10000');
    db.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state)
     VALUES(?,?,?,'Factory Desk','codex','factory-launcher','Vincent','telegram','fyi','none',?,'',?,0,?,'unread','pending')`)
     .run(bridgeId,bridgeId,now,summary,bridgeId,createHash('sha256').update(summary).digest('hex'));
   }finally{db.close();}
   e.s.set(id,{queuedAt:now});e.s.event(id,'supply-idle-alert',{...idle,summary},undo,now);
  }catch(error){e.s.event(`alert-failure:${id}`,'supply-idle-alert-failure',{error:String(error)},'Restore the existing bridge; retry the same stable alert ID',now);}
 }
 return idle;
}
