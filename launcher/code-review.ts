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
export interface CodeReviewPort {
 pulls(repo:string):Promise<BoardPull[]>;
 files(repo:string,number:number):Promise<{filename:string;patch?:string}[]>;
 review(pull:FactoryPull,checkout:string,target:ReviewTarget,onClaimed:()=>void):Promise<Challenge|undefined>;
}
// This executor never creates issues or merges. The existing maintenance lease,
// independent native review and builder-slot/qualification/usage gates remain.
export async function reviewProductChanges(s:Store,c:Config,dir:string,repositories:Record<string,string>,port:CodeReviewPort,now=Date.now()) {
 if(!c.review_process)return;
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
