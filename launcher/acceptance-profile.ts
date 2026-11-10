import {z} from 'zod';
import {join} from 'node:path';
import {type Config,optionalJSON,QualificationSchema} from './config';
import {usageGate} from './engine';
import type {Store} from '../tracking/store';
import {verifySubscription} from '../adapters/workers';
export const AcceptanceTicketSchema=z.object({version:z.literal(1),repo:z.literal('fulmar-hq/alido'),number:z.literal(1192),owner:z.literal('quality'),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),provider:z.literal('codex'),model:z.string().min(1),effort:z.enum(['medium','high']),source:z.string().min(1),expiresAt:z.number().int().positive(),excludedNatives:z.array(z.string().min(1)).min(1)}).strict();
export async function acceptanceProfile(c:Config,dir:string,day:string,validThrough:number,readJSON=optionalJSON){
 const raw=await readJSON(join(dir,'release-acceptance-ticket.json'));
 if(raw===null)return {role:c.owners.quality,ticket:undefined};
 if(c.model_override!=='per_ticket_wins_then_per_role')throw Error('per-ticket override policy is not enabled');
 const t=AcceptanceTicketSchema.parse(raw);
 if(t.day!==day||t.expiresAt<=validThrough)throw Error('acceptance ticket is expired or for another day');
 return {role:{harness:t.provider,model:t.model,effort:t.effort},ticket:t};
}
export async function admitAcceptance(c:Config,dir:string,s:Store,day:string,deadline:number,now=Date.now()){
 const effective=await acceptanceProfile(c,dir,day,deadline);
 if(!effective.role)throw Error('Quality profile missing');
 const r=effective.role,raw=await optionalJSON(join(dir,'qualifications.json')) as Record<string,unknown>|null;
 const q=QualificationSchema.parse(raw?.[`${r.harness}:${r.effort}`]??raw?.[r.harness]);
 if(q.model!==r.model||q.effort!==r.effort||q.expiresAt<=deadline||now>=deadline)throw Error('effective Quality profile unqualified through acceptance deadline');
 await verifySubscription(r.harness);
 const {localReadings,codexStatus}=await import('../adapters/usage');
 const readings=await localReadings();if(r.harness==='codex'){const fresh=await codexStatus();if(fresh)readings.codex=fresh;}usageGate(readings[r.harness],false,now,c,r.harness);
 if(s.get('paused')!==false)throw Error('factory paused');
 return effective;
}
export function assertIndependent(s:Store,native:string,excluded:string[]){
 if(!native||excluded.includes(native))throw Error('accepting native is a release writer or batch author');
 const release=s.get<{native?:string}>('owner-runtime:release');
 if(release?.native===native)throw Error('accepting native is release writer');
 // A fresh Quality session may not reuse any helper author session.
 if(s.db.query('SELECT id FROM sessions WHERE native_id=? LIMIT 1').get(native))throw Error('accepting native reused helper custody');
}
