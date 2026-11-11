import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
const sha=z.string().regex(/^[a-f0-9]{40}$/);
export const ReleaseBatchSchema=z.object({
 version:z.literal(1),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),base:sha,revision:sha,tree:sha,
 pr:z.number().int().positive(),ref:z.string().regex(/^(feat|fix)\/[A-Za-z0-9._/-]+$/),holdId:z.string().min(1),
 sources:z.array(z.object({number:z.number().int().positive(),head:sha,ref:z.string().min(1),title:z.string().min(1)}).strict()).min(1).max(200),
 overlaps:z.array(z.object({path:z.string().min(1),order:z.array(z.number().int().positive()).min(2)}).strict()),
 review:z.string().min(1),
}).strict().superRefine((b,c)=>{
 if(new Set(b.sources.map(s=>s.number)).size!==b.sources.length)c.addIssue({code:'custom',message:'Duplicate batch sources'});
 const order=new Map(b.sources.map((s,i)=>[s.number,i]));
 for(const group of b.overlaps)if(group.order.some((n,i)=>!order.has(n)||(i>0&&order.get(n)!<=order.get(group.order[i-1])!)))c.addIssue({code:'custom',message:'Invalid overlap order'});
});
export type ReleaseBatch=z.infer<typeof ReleaseBatchSchema>;
export const batchDigest=(batch:ReleaseBatch)=>createHash('sha256').update(JSON.stringify(ReleaseBatchSchema.parse(batch))).digest('hex');
export function readReleaseBatch(dir:string,day:string){
 const batch=ReleaseBatchSchema.parse(JSON.parse(readFileSync(join(dir,'release-batch.json'),'utf8')));
 if(batch.day!==day)throw Error('Current-day reviewed release batch missing');
 return batch;
}
export function carrierIdentity(batch:ReleaseBatch,pull:any){
 if(pull?.number!==batch.pr||pull?.head?.sha!==batch.revision||pull?.head?.ref!==batch.ref||pull?.head?.repo?.full_name!=='fulmar-hq/alido'||pull?.base?.ref!=='QA'||pull?.draft!==false||!String(pull?.body).includes(`factory-batch-sha256:${batchDigest(batch)}`))throw Error('Reviewed carrier identity changed');
}
