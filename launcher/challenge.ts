import {toronto} from './release';
import {z} from 'zod';
import {join} from 'node:path';
import {openSync,readFileSync,fstatSync,closeSync,constants} from 'node:fs';
import {type Config} from './config';
import {Store} from '../tracking/store';
import {command} from '../adapters/github';
import {queueWake} from './wake';
import {autonomyEffects} from './autonomy';
const sha=z.string().regex(/^[a-f0-9]{40}$/);
export const ChallengeTarget=z.object({repo:z.enum(['fulmar-hq/alido','fulmar-hq/agent-factory']),pr:z.number().int().positive(),head:sha,base:sha,branch:z.enum(['QA','main']),url:z.string().url()}).strict();
export const Verdict=z.object({head:sha,verdict:z.enum(['PASS','CHANGES_REQUESTED']),evidence:z.string().min(20).max(20000)}).strict();
const undo='Retain review, native logs, merge claim and branches. Undo merged source with a signed revert.';
// Preserve the existing 19:00 preflight through 22:00 release deadline.
export function daytimeMerges(now:number){const {minute}=toronto(now);return minute<1140 || minute>=1320;}
// A fresh base read alone has a race. The server must reject an unchanged
// source head if another actor advances the destination before merge.
export async function strictMergeProtection(repo:string,branch:string,execute=command) {
 try {
  const p=JSON.parse(await execute(['gh','api',`repos/${repo}/branches/${branch}/protection`]));
  if(p.enforce_admins?.enabled===true && p.required_status_checks?.strict===true && Array.isArray(p.required_status_checks.contexts) && p.required_status_checks.contexts.length>0)return true;
 }catch{/* A ruleset may protect a branch without classic protection. */}
 try {
  const rules=JSON.parse(await execute(['gh','api',`repos/${repo}/rules/branches/${branch}`]));
  if(!Array.isArray(rules) || rules.length>=100)return false;
  for(const r of rules)if(r.type==='required_status_checks' && r.parameters?.strict_required_status_checks_policy===true && r.ruleset_source_type==='Repository' && Number.isSafeInteger(r.ruleset_id)) {
   const p=JSON.parse(await execute(['gh','api',`repos/${repo}/rulesets/${r.ruleset_id}`]));
   if(p.enforcement==='active' && p.current_user_can_bypass==='never' && p.rules?.some((x:any)=>x.type==='required_status_checks' && x.parameters?.strict_required_status_checks_policy===true && x.parameters.required_status_checks?.length>0))return true;
  }
 }catch{/* Unknown server protection refuses mutation. */}
 return false;
}
export function greenChecks(checks:{bucket:string}[]) {return checks.length>0 && checks.every(c=>c.bucket==='pass');}
export async function challengeAndMerge(s:Store,c:Config,execute=command,now=Date.now()) {
 if(!c.usage_push || s.get('paused')!==false || c.owners.release?.harness!=='codex')return;
 await autonomyEffects(s,async()=>{
  const publications=(s.db.query("SELECT data FROM events WHERE kind IN ('launcher-publish','worker-delivery')").all() as {data:string}[]).map(r=>JSON.parse(r.data));
  for(const project of Object.values(c.projects)) {
   if(!['fulmar-hq/alido','fulmar-hq/agent-factory'].includes(project.repo))continue;
   let prs;try {prs=JSON.parse(await execute(['gh','pr','list','--repo',project.repo,'--state','open','--limit','100','--json','number,url,headRefOid,baseRefOid,baseRefName,isDraft,reviewDecision,headRefName']));
   if(!Array.isArray(prs) || prs.length>=100)throw Error('challenger PR inventory missing/truncated');
   }catch(error){s.event(`challenger-inventory:${project.repo}:${now}`,'challenger-inventory-refusal',{repo:project.repo,error:String(error)},undo,now);continue;}
   for(const pr of prs) {
    if(!publications.some(p=>p.url===pr.url))continue;
    const parsed=ChallengeTarget.safeParse({repo:project.repo,pr:pr.number,head:pr.headRefOid,base:pr.baseRefOid,branch:pr.baseRefName,url:pr.url});
    if(!parsed.success || pr.isDraft || (project.repo==='fulmar-hq/alido' ? pr.baseRefName!=='QA' : pr.baseRefName!=='main'))continue;
    const target=parsed.data,id=`challenger:${project.repo}:${pr.number}:${target.head}:${target.base}`;
    queueWake(s,{id,owner:'release',kind:'challenger-review',payload:target},now);
    const w=s.get<{state:string;native?:string;payload?:unknown;cleanupVerified?:boolean;scratch?:string}>(`owner-wake:${id}`);
    if(w?.state!=='done' || !w.cleanupVerified || !w.native || !w.scratch)continue;
    try {
     const reviewed=ChallengeTarget.parse(w.payload);if(reviewed.head!==target.head || reviewed.base!==target.base)continue;
     const fd=openSync(join(w.scratch,'challenge.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
     let verdict:z.infer<typeof Verdict>;
     try{const st=fstatSync(fd);if(!st.isFile() || st.size>128*1024)throw Error('invalid challenger artifact');verdict=Verdict.parse(JSON.parse(readFileSync(fd,'utf8')));}finally{closeSync(fd);}
     if(verdict.head!==target.head)throw Error('challenger head differs');
     const marker=`<!-- ${id} -->`;
     const comments=JSON.parse(await execute(['gh','api',`repos/${project.repo}/issues/${pr.number}/comments?per_page=100`]));
     if(!Array.isArray(comments) || comments.length>=100)throw Error('challenger comment readback truncated');
     const body=`${marker}\nCodex challenger: ${verdict.verdict}\nHead: ${target.head}\nBase: ${target.base}\nNative: ${w.native}\n\n${verdict.evidence}`;
     if(!comments.some(x=>x.body===body)){
      if(!s.event(`challenge-post:${id}`,'challenger-post-claimed',{target,native:w.native},undo,now))continue;
      await execute(['gh','api',`repos/${project.repo}/issues/${pr.number}/comments`,'--method','POST','-f',`body=${body}`]);
     }
     s.set(`challenge:${id}`,{...verdict,native:w.native,posted:true});
     if(verdict.verdict!=='PASS' || pr.reviewDecision==='CHANGES_REQUESTED')continue;
     const checks=JSON.parse(await execute(['gh','pr','checks',String(pr.number),'--repo',project.repo,'--required','--json','bucket']));
     if(!greenChecks(checks))continue;
     if(project.repo==='fulmar-hq/alido'){
      if(!daytimeMerges(Date.now()))continue;
      const hold=JSON.parse(JSON.parse(await execute(['gh','api',`repos/${project.repo}/actions/variables/QA_HOLD`])).value);
      if(hold.held!==false || typeof hold.id!=='string')continue;
      const promotions=JSON.parse(await execute(['gh','pr','list','--repo',project.repo,'--base','main','--head','QA','--state','open','--json','number']));
      if(!Array.isArray(promotions) || promotions.length)continue;
     }
     if(!await strictMergeProtection(project.repo,target.branch,execute))throw Error('strict server-side merge protection unverified');
     const current=JSON.parse(await execute(['gh','pr','view',String(pr.number),'--repo',project.repo,'--json','headRefOid,baseRefOid,baseRefName,state,isDraft,reviewDecision']));
     if(current.headRefOid!==target.head || current.baseRefOid!==target.base || current.baseRefName!==target.branch || current.state!=='OPEN' || current.isDraft || current.reviewDecision==='CHANGES_REQUESTED' || s.get('paused')!==false)continue;
     if(project.repo==='fulmar-hq/alido' && !daytimeMerges(Date.now()))continue;
     if(!s.event(`continuous-merge:${id}`,'release-merge-claimed',{...target,actor:'release',native:w.native},undo,now))continue;
     await execute(['gh','pr','merge',String(pr.number),'--repo',project.repo,'--squash','--match-head-commit',target.head]);
     s.event(`continuous-merged:${id}`,'release-merged',target,undo,now);
    }catch(error){s.event(`challenge-refusal:${id}:${String(error)}`,'challenger-refusal',{target,error:String(error)},undo,now);}
   }
  }
 });
}
