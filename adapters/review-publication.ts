import {createHash} from 'node:crypto';
import type {Store} from '../tracking/store';
import {normalizeChallenge,type Challenge} from '../launcher/factory-maintenance';
import {command} from './github';
export type RetainedReview=Challenge&{repo?:string;depth?:'standard'|'deep';review:Challenge['review']&{installedGaps?:string[]}};
export function redactReviewText(value:unknown){return String(value??'').replace(/\/(?:Users|home)\/[^/\n]+/g,'~').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]').replace(/\b(?:AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,'[redacted credential]').replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [redacted]').replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[redacted]');}
// Native execution and publication are separate durable facts. An unknown POST
// is reconciled by complete exact-marker readback before another attempt.
export async function publishRetainedReview(s:Store,repo:string,baseRef:string,eventId:string,result:RetainedReview,execute=command):Promise<boolean> {
 result={...result,...normalizeChallenge(result)};

 const excerpt=(value:unknown,limit:number)=>{const text=redactReviewText(value);return text.length<=limit?text:text.slice(0,Math.floor(limit*0.7))+' … [excerpt] … '+text.slice(-Math.floor(limit*0.25));};
 const findings=Array.isArray(result.review.findings)?result.review.findings:[],gaps=Array.isArray(result.review.installedGaps)?result.review.installedGaps:[];
 const verdict=!result.ok||!result.native?.verified||!result.cleanup?.verified||result.review.verdict==='BLOCKED'?'BLOCKED':result.review.verdict==='PASS'&&findings.length===0&&Array.isArray(result.review.installedGaps)&&gaps.length===0?'PASS':findings.length?'DEFECT':'BLOCKED';
 const budget=Math.floor(54000/Math.max(1,findings.length+gaps.length));
 const details=findings.map((value,index)=>{const f=value as {severity:string;title:string;file:string;line:number;detail:string};return `${index+1}. [${excerpt(f.severity,8)}] ${excerpt(f.title,100)} (${excerpt(f.file,120)}:${f.line})\n${excerpt(f.detail,Math.max(250,budget-300))}`;});
 if(gaps.length)details.push((result.evidenceScope==='source-review'?'Required source-review evidence:':'Retained gap statements (source-review relevance is unclassified; reconcile before approval):')+'\n'+gaps.map((gap,index)=>`${index+1}. ${excerpt(gap,budget-20)}`).join('\n'));
 if(!Array.isArray(result.review.installedGaps))details.push('The retained result does not declare its required evidence gaps. Reconcile the original review evidence before approval.');
 const content=`Independent review ${verdict} at ${result.head}${result.depth?` (${result.depth})`:''}: ${verdict==='PASS'?'no actionable defect found.':findings.length?'actionable findings follow.':'review evidence needs reconciliation.'}\n${details.join('\n\n')}\nDefects return to the same ticket and PR. Hosted acceptance and release gates remain required.`;
 const publication=createHash('sha256').update(JSON.stringify({repo,pr:result.pr,head:result.head,eventId,content})).digest('hex');
 const key=`review-publication:${repo}:${result.pr}:${result.head}:${eventId}:${publication}`;
 if(result.baseRef!==baseRef||!/^[a-f0-9]{40}$/.test(result.baseHead??'')){s.event(`review-base-reconciliation:${publication}`,'review-base-reconciliation',{repo,pr:result.pr,head:result.head,eventId,reviewedBase:result.baseRef,reviewedBaseHead:result.baseHead,currentBase:baseRef},'Preserve original result; missing or changed reviewed base requires explicit evidence reconciliation');return false;}
 const marker=`<!-- factory-review:${publication} -->`,body=marker+'\n'+content;
 const record=(state:string,extra:Record<string,unknown>={})=>{s.set(key,{state,repo,pr:result.pr,head:result.head,eventId,marker,at:Date.now(),...extra});s.event(`review-publication:${crypto.randomUUID()}`,'review-publication',{state,repo,pr:result.pr,head:result.head,eventId,...extra},'Retain native result and publication intent; reconcile exact marker before retrying an unknown response');};
 try {
  if(result.review.head!==result.head)throw Error('retained review result head mismatch');
  const current=JSON.parse(await execute(['gh','api',`repos/${repo}/pulls/${result.pr}`]));
  if(current.head?.sha!==result.head||current.base?.ref!==baseRef||current.base?.sha!==result.baseHead||current.base?.repo?.full_name!==repo||current.head?.repo?.full_name!==repo||current.state!=='open'){record('superseded',{reason:'current PR head/base/state is different; original result retained'});return false;}
  if(s.get<{state:string}>(key)?.state==='published')return true;
  const login=JSON.parse(await execute(['gh','api','user'])).login;if(typeof login!=='string'||!login)throw Error('authenticated review author unavailable');
  const readback=async()=>{
   let found:number|undefined;const deadline=Date.now()+120000;
   for(let page=1;page<=20;page++) {
    if(Date.now()>=deadline)throw Error('review publication inventory deadline exceeded');
    const rows=JSON.parse(await execute(['gh','api',`repos/${repo}/pulls/${result.pr}/reviews?per_page=100&page=${page}`]));
    if(!Array.isArray(rows)||rows.length>100||rows.some(r=>!Number.isSafeInteger(r.id)||r.id<1||typeof r.body!=='string'||typeof r.commit_id!=='string'||typeof r.user?.login!=='string'||!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(r.state)))throw Error('review publication inventory unavailable');
    for(const r of rows)if(r.body===body&&r.commit_id===result.head&&r.user.login===login&&r.state==='COMMENTED')found=r.id;
    if(rows.length<100)return found;
   }
   throw Error('review publication inventory truncated');
  };
  const prior=await readback();if(prior){record('published',{review:prior});return true;}
  record('pending');
  await execute(['gh','api','--method','POST',`repos/${repo}/pulls/${result.pr}/reviews`,'--raw-field','event=COMMENT','--raw-field',`body=${body}`,'--raw-field',`commit_id=${result.head}`]);
  const posted=await readback();if(!posted)throw Error('review POST not yet confirmed by exact readback');record('published',{review:posted});return true;
 }catch(error){record('pending',{error:String(error)});return false;}
}
