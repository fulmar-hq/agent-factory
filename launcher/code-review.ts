import {z} from 'zod';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Config} from './config';
import type {Store} from '../tracking/store';
import type {BoardPull,PullSnapshot} from '../board/pulls';
import type {FactoryPull,Challenge} from './factory-maintenance';
import type {ReviewTarget} from '../adapters/factory-challenge';
export const deepRisk=/(?:tenant|consent|opt.?out|send|dispatch|booking|permission|authoriz|billing|payment|money|wallet|migration|drizzle|row.level|\brls\b)/i;
export const reviewDepth=(files:{filename:string;patch?:string}[])=>files.some(f=>deepRisk.test(f.filename+'\n'+(f.patch??'')))?'deep':'standard';
export function reviewChecksGreen(p:BoardPull,repo:string) {
 const checks=p.statusCheckRollup.filter(c=>!/release[ -]hold/i.test(c.name??''));
 const success=(c:BoardPull['statusCheckRollup'][number])=>(c.conclusion??c.state)==='SUCCESS'&&(c.status===undefined||c.status==='COMPLETED');
 return checks.some(c=>c.name==='Verify'&&success(c)) && (repo!=='fulmar-hq/alido'||checks.some(c=>/^Secret scan$/i.test(c.name??'')&&success(c))) && checks.every(c=>success(c)||c.status==='COMPLETED'&&['SKIPPED','NEUTRAL'].includes(c.conclusion??''));
}
const HistoricalReview=z.object({issue:z.number().int().positive().optional(),repo:z.string().regex(/^[\w.-]+\/[\w.-]+$/),pr:z.number().int().positive(),head:z.string().regex(/^[a-f0-9]{40}$/),session:z.string().min(1),native:z.string().min(1),verdict:z.enum(['PASS','CHANGES_REQUESTED','BLOCKED']),verdictUrl:z.string().url(),evidence:z.string().min(20).max(12000)}).strict();
// Explicit trusted migration input only. Never manufacture a native review,
// qualification or PASS: require retained successful independent worker custody.
export function importHistoricalReviews(s:Store,c:Config,dir:string) {
 const path=join(dir,'historical-review-receipts.json');
 if(!existsSync(path))return false;
 const raw=readFileSync(path,'utf8');if(raw.length>2*1024*1024)throw Error('historical review migration exceeds bound');
 const packet=z.object({complete:z.literal(true),reviews:z.array(HistoricalReview).max(500)}).strict().parse(JSON.parse(raw));
 for(const r of packet.reviews) {
  if(!Object.values(c.projects).some(p=>p.repo===r.repo)||!r.verdictUrl.startsWith(`https://github.com/${r.repo}/pull/${r.pr}#`)||!r.evidence.includes(r.head))throw Error('historical exact-head source provenance missing');
  const session=s.db.query('SELECT native_id,status,brief FROM sessions WHERE id=?').get(r.session) as {native_id:string|null;status:string;brief:string}|null;
  if(!session||session.native_id!==r.native||!['finished','archived'].includes(session.status)||!s.db.query("SELECT id FROM events WHERE kind='worker-exit' AND json_extract(data,'$.id')=? AND json_extract(data,'$.ok')=1").get(r.session)||s.get<{verified:boolean}>(`cleanup-evidence:${r.session}`)?.verified!==true)throw Error('historical independent native custody unverified');
  const author=s.db.query("SELECT sessions.native_id FROM sessions JOIN events ON json_extract(events.data,'$.id')=sessions.id WHERE events.kind IN ('launcher-publish','worker-delivery') AND json_extract(events.data,'$.url')=? AND sessions.native_id=?").get(`https://github.com/${r.repo}/pull/${r.pr}`,r.native);if(author)throw Error('historical reviewer wrote the target change');
  const brief=JSON.parse(session.brief) as {title?:string;kind?:string;repo?:string};
  if(brief.repo!==r.repo||!(/^(?:Challenge|Accept|Review)\b/i.test(brief.title??'')||['review','challenge','acceptance'].includes(brief.kind??'')))throw Error('historical worker was not a same-repository independent review');
 }
 const rank={PASS:0,BLOCKED:1,CHANGES_REQUESTED:2};
 s.atomic(()=>{for(const r of packet.reviews){const key=`code-review:${r.repo}:${r.pr}:${r.head}`,prior=s.get<{historical?:boolean;verdict?:keyof typeof rank}>(key);
  s.event(`historical-${key}:${r.session}:${r.verdict}`,'historical-review-import',r,'Retain original native, report and PR verdict; withdraw an invalid receipt with a reviewed append-only correction');
  if(!prior||prior.historical&&rank[r.verdict]>rank[prior.verdict??'PASS'])s.set(key,{state:'done',historical:true,...r});
 }s.set('historical-review-migration',{complete:true,count:packet.reviews.length});});
 return true;
}
export interface CodeReviewPort {
 pulls(repo:string):Promise<BoardPull[]>;
 files(repo:string,number:number):Promise<{filename:string;patch?:string}[]>;
 review(pull:FactoryPull,checkout:string,target:ReviewTarget,onClaimed:()=>void):Promise<Challenge|undefined>;
}
// This executor never creates issues or merges. The existing maintenance lease,
// independent native review and builder-slot/qualification/usage gates remain.
export async function reviewProductChanges(s:Store,c:Config,dir:string,repositories:Record<string,string>,port:CodeReviewPort,now=Date.now()) {
 if(!c.review_process)return;
 const imported=importHistoricalReviews(s,c,dir);
 if(c.review_process.historical_receipts==='pending'&&!imported)return;
 const protectedPRs=new Set<number>();
 const batchPath=join(dir,'release-batch.json');
 if(existsSync(batchPath)) {
  const batch=JSON.parse(readFileSync(batchPath,'utf8'));
  if(!Number.isSafeInteger(batch.pr)||!Array.isArray(batch.sources)||batch.sources.some((p:{number?:number})=>!Number.isSafeInteger(p.number)))throw Error('release batch protection unavailable; review sweep refused');
  protectedPRs.add(batch.pr);for(const p of batch.sources)protectedPRs.add(p.number);
 }
 let claimed=false;
 for(const project of Object.values(c.projects)) {
  // Factory PRs already use this same independent exact-head executor in the
  // protected factory maintenance lane; never give them a second review.
  if(project.repo==='fulmar-hq/agent-factory'||!repositories[project.repo])continue;
  const snapshot=s.get<PullSnapshot>(`board-pulls:${project.repo}`);
  const pulls=snapshot&&!snapshot.error&&snapshot.at<=now&&now-snapshot.at<120000?snapshot.pulls:await port.pulls(project.repo);
  for(const p of [...pulls].sort((a,b)=>a.number-b.number)) {
   if(claimed)return;
   if(project.repo==='fulmar-hq/alido'&&protectedPRs.has(p.number))continue;
   if(!reviewChecksGreen(p,project.repo)||s.get(`code-review:${project.repo}:${p.number}:${p.headRefOid}`))continue;
   const files=await port.files(project.repo,p.number);
   if(!files.length)continue;
   // Closed legacy report-only PRs are reconciled separately. Never review the
   // report as if it were the underlying product change.
   if(files.every(f=>/^docs\/work\/.*-challenge\.md$/.test(f.filename)))continue;
   const authorNatives=(s.db.query("SELECT sessions.native_id FROM sessions JOIN events ON json_extract(events.data,'$.id')=sessions.id WHERE events.kind IN ('launcher-publish','worker-delivery') AND json_extract(events.data,'$.url')=?").all(p.url) as {native_id:string|null}[]).flatMap(x=>x.native_id?[x.native_id]:[]);
   const depth=reviewDepth(files),target:ReviewTarget={repo:project.repo,baseRef:'QA',depth,authorNatives};
   await port.review({number:p.number,head:p.headRefOid,tree:'',createdAt:'',draft:false,state:'OPEN',mergeState:'UNKNOWN',verify:true},repositories[project.repo],target,()=>{claimed=true;});
  }
 }
}
