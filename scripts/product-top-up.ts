#!/usr/bin/env bun
import {join} from 'node:path';
import {root,configAt,type Ticket} from '../launcher/config';
import {Store} from '../tracking/store';
import {Engine,usageGate} from '../launcher/engine';
import {issueTicket} from '../adapters/github';
import {supply,autonomyEffects} from '../launcher/autonomy';
import {pendingWakes,dispatchWake,spawnOwner} from '../launcher/wake';

// Independent schedule for the existing product-only intake lane. Results,
// policy approval and builder admission remain with the ordinary tick.
const c=await configAt(join(root,'config.yaml')),s=new Store(join(root,'controller.sqlite')),now=Date.now();
try{
 if(c.autonomy?.intake_mode!=='build')throw Error('product top-up requires build intake policy');
 if(s.get('paused')!==false)throw Error('factory paused');
 const provider=c.owners[c.autonomy.intake_owner]?.harness;
 if(!provider)throw Error('intake provider unavailable');
 usageGate(s.get<Record<string,unknown>>('readings')?.[provider],true,now,c,provider);
 const e=new Engine(s,c),ready:Ticket[]=[];
 for(const row of s.rows('tickets') as {id:string;snapshot:string}[]){
  const repo=row.id.slice(0,row.id.lastIndexOf('#'));
  if(!Object.values(c.projects).some(p=>p.repo===repo))continue;
  const t=issueTicket(repo,JSON.parse(row.snapshot));if(t)ready.push(t);
 }
 await autonomyEffects(s,async()=>supply(e,ready,now));
 const dispatched=[];
 for(const w of pendingWakes(s).filter(w=>w.owner===c.autonomy!.intake_owner&&w.kind==='product-intake'))if(dispatchWake(s,w,id=>spawnOwner(id,root)))dispatched.push(w.id);
 console.log(JSON.stringify({at:now,status:'ok',kind:'product-only-top-up',dispatched,round:s.get('intake-round')}));
}finally{s.close();}
