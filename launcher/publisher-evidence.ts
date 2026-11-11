import {readCodexRenewalReceipt} from './codex-renewal-evidence';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {QualificationSchema} from './config';
import type {Store} from '../tracking/store';
const receiptJSON=(path:string):unknown=>JSON.parse(new TextDecoder().decode(readCodexRenewalReceipt(path)));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const publisherSources=['adapters/delivery.ts','adapters/github.ts','adapters/native.ts','adapters/workers.ts','launcher/child.ts','launcher/process.ts','launcher/worker.ts','launcher/cache-provenance.ts','launcher/worker-entry.ts','launcher/publisher-evidence.ts','launcher/config.ts','scripts/cache-retention.py'];
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
 const proof=proofSchema.parse(receiptJSON(pub.executionReceipt));
 if(!samePublisherBoundary(proof.boundary,expected)||proof.head!==pub.head||proof.tree!==pub.tree||proof.startedAt>proof.completedAt||proof.completedAt>=proof.authorityExpiresAt||proof.completedAt>now||proof.completedAt+86400000<=now)throw Error('publisher execution does not qualify the current implementation');
 return proof;
}
export function currentPublisherProof(s:Pick<Store,'db'>,dir:string,expected:PublisherBoundary,now=Date.now()){
 const row=s.db.query("SELECT data FROM events WHERE kind='launcher-publish' ORDER BY at DESC,rowid DESC LIMIT 1").get() as {data:string}|null;if(!row)return;
 try{const pub=JSON.parse(row.data) as PublisherPublication;return {pub,proof:readPublisherProof(dir,pub,expected,now)};}catch{return;}
}


export function publisherQualificationVerified(dir:string,authority:unknown,qualificationBytes:string,expected:PublisherBoundary){
 try{
  const a=z.object({version:z.literal(2),expiresAt:z.number().int().positive(),evidence:z.string()}).parse(authority),run=realpathSync(join(a.evidence,'..'));
  if(!run.startsWith(realpathSync(join(dir,'runs'))+'/')||!a.evidence.endsWith('/report.md'))return false;readCodexRenewalReceipt(a.evidence);
  const prepared=z.object({bindings:z.record(z.string(),sha)}).parse(receiptJSON(join(run,'prepared.json'))),q=JSON.parse(qualificationBytes);
  for(const key of ['codex','codex:medium','codex:high'])if(prepared.bindings[key]!==hash(JSON.stringify(QualificationSchema.parse(q[key]))))return false;
  const r=z.object({publisherExpiresAt:z.number(),publisherProof:proofSchema,pub:z.object({head:z.string(),tree:z.string()}),tested:z.object({code:z.literal(0),tree:z.string()}),verification:z.object({verified:z.literal(true),reason:z.literal('valid')})}).parse(receiptJSON(join(run,'publisher-readback.json'))),p=r.publisherProof;
  return samePublisherBoundary(p.boundary,expected)&&a.expiresAt===r.publisherExpiresAt&&a.expiresAt<=p.completedAt+86400000&&p.startedAt<=p.completedAt&&p.completedAt<p.authorityExpiresAt&&p.head===r.pub.head&&p.tree===r.pub.tree&&p.tree===r.tested.tree;
 }catch{return false;}
}
