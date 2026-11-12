import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {toronto} from './release';
const Freeze=z.object({version:z.literal(1),from:z.iso.datetime({offset:true}),until:z.iso.datetime({offset:true}),reason:z.string().min(1).max(500)}).strict();
export const dailyFreezeReason='Daily 17:30–22:35 America/Toronto source freeze; retain the exact Quality proof revision';
export function integrationFreeze(dir:string,now=Date.now()):string|null {
 let raw:string|undefined;
 try{raw=readFileSync(join(dir,'integration-freeze.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // Optional dated holds remain additive and fail closed when malformed. Their
 // expiry or archival cannot remove the standing daily release proof window.
 if(raw!==undefined){
  const f=Freeze.parse(JSON.parse(raw)),from=Date.parse(f.from),until=Date.parse(f.until);
  if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||until-from>24*3600000)throw Error('source integration freeze must be bounded to at most24hours');
  if(now>=from&&now<until)return f.reason;
 }
 const {minute}=toronto(now);
 return minute>=1050&&minute<1355?dailyFreezeReason:null;
}
