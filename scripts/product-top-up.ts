#!/usr/bin/env bun
import {join} from 'node:path';
import {root,configAt,type Ticket,type Config} from '../launcher/config';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from '../tracking/store';
import {Engine,usageGate} from '../launcher/engine';
import {issueTicket} from '../adapters/github';
import {supply,autonomyEffects} from '../launcher/autonomy';
import {pendingWakes,dispatchWake,spawnOwner} from '../launcher/wake';

// Independent schedule for the existing product-only intake lane. Results,
// policy approval and builder admission remain with the ordinary tick.
export function readyForTopUp(s:Store,c:Config,now:number){
 const ready:Ticket[]=[];
 for(const row of s.rows('tickets') as {id:string;snapshot:string}[]){
  const repo=row.id.slice(0,row.id.lastIndexOf('#'));
  if(!Object.values(c.projects).some(p=>p.repo===repo))continue;
  try{const t=issueTicket(repo,JSON.parse(row.snapshot));if(t)ready.push(t);}
  catch(error){s.event(`top-up-invalid:${row.id}:${createHash('sha256').update(row.snapshot).digest('hex')}`,'top-up-snapshot-refusal',{ticket:row.id,reason:String(error)},'Retain the invalid draft; normal reconciliation and owner correction remain required',now);}
 }return ready;
}
export async function productTopUp(){
 const policy=Bun.YAML.parse(readFileSync(join(root,'config.yaml'),'utf8')) as {refill?:{rule?:string}};
 if(policy.refill?.rule!=='product tasks only from the real backlog; never review or acceptance tickets')throw Error('reviewed product-only refill policy must be installed');
 const c=await configAt(join(root,'config.yaml')),s=new Store(join(root,'controller.sqlite')),now=Date.now();
 try{
 if(!('refill' in c)||!c.refill)throw Error('installed source does not enable product-only refill');
 if(c.autonomy?.intake_mode!=='build')throw Error('product top-up requires build intake policy');
 if(s.get('paused')!==false)throw Error('factory paused');
 const provider=c.owners[c.autonomy.intake_owner]?.harness;
 if(!provider)throw Error('intake provider unavailable');
 usageGate(s.get<Record<string,unknown>>('readings')?.[provider],true,now,c,provider);
 const e=new Engine(s,c),ready=readyForTopUp(s,c,now);
 await autonomyEffects(s,async()=>supply(e,ready,now));
 const dispatched=[];
 for(const w of pendingWakes(s).filter(w=>w.owner===c.autonomy!.intake_owner&&w.kind==='product-intake'))if(dispatchWake(s,w,id=>spawnOwner(id,root)))dispatched.push(w.id);
 console.log(JSON.stringify({at:now,status:'ok',kind:'product-only-top-up',dispatched,round:s.get('intake-round')}));
 }finally{s.close();}
}
if(import.meta.main)await productTopUp();
