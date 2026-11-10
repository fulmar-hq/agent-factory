import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import type {Store} from '../tracking/store';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const publisherSources=['adapters/delivery.ts','adapters/github.ts','adapters/native.ts','adapters/workers.ts','launcher/child.ts','launcher/process.ts','launcher/worker.ts','launcher/worker-entry.ts','launcher/publisher-evidence.ts','launcher/config.ts'];
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const boundarySchema=z.object({version:z.literal(1),hashes:z.record(z.string(),sha),policy:sha,bun:z.literal('1.3.14'),git:z.string().min(1)}).strict();
export type PublisherBoundary=z.infer<typeof boundarySchema>;
export function publisherBoundary(checkout:string,dir:string,git=execFileSync('git',['--version'],{encoding:'utf8',timeout:3000}).trim()):PublisherBoundary{
 return boundarySchema.parse({version:1,hashes:Object.fromEntries(publisherSources.map(path=>[path,hash(readFileSync(join(checkout,path),'utf8'))])),policy:hash(readFileSync(join(dir,'config.yaml'),'utf8')),bun:Bun.version,git});
}
export function samePublisherBoundary(a:unknown,b:unknown){return JSON.stringify(boundarySchema.parse(a))===JSON.stringify(boundarySchema.parse(b));}
const proofSchema=z.object({version:z.literal(1),boundary:boundarySchema,startedAt:z.number().int().positive(),completedAt:z.number().int().positive(),authorityExpiresAt:z.number().int().positive(),head:z.string().regex(/^[a-f0-9]{40}$/),tree:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
export type PublisherPublication={id:string;repo:string;head:string;tree:string;executionReceipt:string;testedTreeReceipt:string};
export function readPublisherProof(dir:string,pub:PublisherPublication,expected:PublisherBoundary,now=Date.now()){
 const archive=realpathSync(join(dir,'runs/delivery',pub.id)),path=realpathSync(pub.executionReceipt);
 if(!path.startsWith(archive+'/')||!path.endsWith('/publisher/implementation.json'))throw Error('publisher execution receipt escaped trusted archive');
 const proof=proofSchema.parse(JSON.parse(readFileSync(path,'utf8')));
 if(!samePublisherBoundary(proof.boundary,expected)||proof.head!==pub.head||proof.tree!==pub.tree||proof.startedAt>proof.completedAt||proof.completedAt>=proof.authorityExpiresAt||proof.completedAt>now||proof.completedAt+86400000<=now)throw Error('publisher execution does not qualify the current implementation');
 return proof;
}
export function currentPublisherProof(s:Pick<Store,'db'>,dir:string,expected:PublisherBoundary,now=Date.now()){
 const row=s.db.query("SELECT data FROM events WHERE kind='launcher-publish' ORDER BY at DESC,rowid DESC LIMIT 1").get() as {data:string}|null;if(!row)return;
 try{const pub=JSON.parse(row.data) as PublisherPublication;return {pub,proof:readPublisherProof(dir,pub,expected,now)};}catch{return;}
}
