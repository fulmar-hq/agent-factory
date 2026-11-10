import {createHash} from 'node:crypto';
import type {Store} from '../tracking/store';
import type {Challenge} from '../launcher/factory-maintenance';
import {command} from './github';
export type RetainedReview=Challenge&{repo?:string;depth?:'standard'|'deep';review:Challenge['review']&{installedGaps?:string[]}};
// Native execution and publication are separate durable facts. An unknown POST
// is reconciled by complete exact-marker readback before another attempt.
export async function publishRetainedReview(s:Store,repo:string,baseRef:string,eventId:string,result:RetainedReview,execute=command):Promise<boolean> {
 const key=`review-publication:${repo}:${result.pr}:${result.head}:${eventId}`;
 if(s.get<{state:string}>(key)?.state==='published')return true;
 const marker=`<!-- factory-review:${createHash('sha256').update(JSON.stringify({repo,pr:result.pr,head:result.head,eventId})).digest('hex')} -->`;
 const verdict=!result.ok||!result.native?.verified||!result.cleanup?.verified||result.review.verdict==='BLOCKED'?'BLOCKED':result.review.verdict==='PASS'&&result.review.findings.length===0&&Array.isArray(result.review.installedGaps)&&result.review.installedGaps.length===0?'PASS':result.review.findings.length?'DEFECT':'BLOCKED';
 const body=`${marker}\nIndependent review ${verdict} at ${result.head}${result.depth?` (${result.depth})`:''}: ${result.review.findings.length?result.review.findings.map(value=>{const f=value as {title:string;file:string;line:number};return `${f.title} (${f.file}:${f.line})`;}).join('; ').slice(0,2500):verdict==='PASS'?'no actionable defect found.':'required review evidence incomplete.'}\nDefects return to the same ticket and PR. Hosted acceptance and release gates remain required.`;
 const record=(state:string,extra:Record<string,unknown>={})=>{s.set(key,{state,repo,pr:result.pr,head:result.head,eventId,marker,at:Date.now(),...extra});s.event(`review-publication:${crypto.randomUUID()}`,'review-publication',{state,repo,pr:result.pr,head:result.head,eventId,...extra},'Retain native result and publication intent; reconcile exact marker before retrying an unknown response');};
 try {
  if(result.review.head!==result.head)throw Error('retained review result head mismatch');
  const current=JSON.parse(await execute(['gh','api',`repos/${repo}/pulls/${result.pr}`]));
  if(current.head?.sha!==result.head||current.base?.ref!==baseRef||current.base?.repo?.full_name!==repo||current.head?.repo?.full_name!==repo||current.state!=='open'){record('superseded',{reason:'current PR head/base/state is different; original result retained'});return false;}
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
