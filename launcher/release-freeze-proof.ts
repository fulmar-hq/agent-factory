import type {Store} from '../tracking/store';
import {toronto} from './release';
import {integrationFreeze} from './integration-freeze';
import {releaseAction} from './release-actions';
import {queueWake} from './wake';
export async function requestFreezeProof(s:Store,dir:string,source:()=>Promise<string>,now=Date.now(),send=releaseAction){
 const {day,minute}=toronto(now),key=`release-freeze-proof-request:${day}`;
 if(minute<1050||minute>=1140)return {queued:false};
 if(!integrationFreeze(dir,now))throw Error('Quality proof request requires active installation freeze');
 let payload=s.get<{source:string;summary:string;body:string}>(key);
 if(!payload){
  const revision=(await source()).trim();if(!/^[a-f0-9]{40}$/.test(revision))throw Error('installed factory revision unavailable');
  payload={source:revision,summary:`Quality: prove the frozen release path by ${day} 18:30 Eastern.`,body:`The daily 17:30–22:35 America/Toronto installation freeze has started. Prove the hosted HTTP and trusted acceptance receipt path for exact installed factory source ${revision}, with the current configured acceptance model/effort and original evidence valid through 22:30 tonight. Retain the qualified release-quality-path.json receipt. No source install, activation, real-person send or gate exception is authorized.`};
  s.set(key,payload);
 }
 const id=`release-freeze-proof:${day}`;
 send(id,'Quality',payload.summary,payload.body,now);
 queueWake(s,{id:`mail:${id}`,owner:'quality',kind:'release-path-proof-request',payload:{mailId:id,...payload}},now);
 s.event(id,'release-freeze-proof-request',{day,...payload},'Retain exact-source proof request and native custody; never install during the standing freeze',now);
 return {queued:true,source:payload.source};
}
