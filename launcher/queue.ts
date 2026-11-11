import {unavailable} from '../adapters/github-budget';
import {Engine} from './engine';
import {processIdentity} from './process';
import type {Ticket} from './config';
import {command,intakeLabel,type Issue} from '../adapters/github';

// Queue accounting shares the retained-custody gate with admission. Remote PR,
// resource, usage and qualification checks still run immediately before launch.
export function claimableReady(e:Engine,ready:Ticket[]) {
 return ready.filter(t=>{try{e.retryPrior(t);return true;}catch{return false;}});
}

// Level-triggered recovery covers interruption between publication and labels.
// A fresh digest or an owner-returned review is never overwritten by old work.
export async function reviewPublished(e:Engine,execute=command,identity=processIdentity) {
 const {autonomyEffects}=await import('./autonomy');
 return await autonomyEffects(e.s,()=>reconcilePublished(e,execute),identity) ?? 0;
}
async function reconcilePublished(e:Engine,execute:typeof command) {
 let changed=0;
 for(const x of e.sessions()) {
  if(x.status!=='finished' || !x.approval_digest || e.s.get(`review-returned:${x.id}:${x.approval_digest}`))continue;
  const receipt=e.s.db.query("SELECT data FROM events WHERE kind IN ('launcher-publish','worker-delivery') AND json_extract(data,'$.id')=? ORDER BY at DESC LIMIT 1").get(x.id) as {data:string}|null;
  if(!receipt)continue;
  const t=JSON.parse(x.brief) as Ticket;
  const row=e.s.db.query('SELECT snapshot FROM tickets WHERE id=?').get(x.ticket) as {snapshot:string}|null;
  if(row){const snapshot=JSON.parse(row.snapshot) as Issue;if(!snapshot.labels.some(l=>['state:ready','state:building','state:review'].includes(l.name)))continue;
   if(snapshot.labels.some(l=>l.name==='state:review')){
    const url=(JSON.parse(receipt.data) as {url?:string}).url;
    const pr=url?e.s.get<{at:number;review?:string}>(`board-pr:${url}`):null;
    if(pr?.review==='CHANGES_REQUESTED')e.s.set(`review-returned:${x.id}:${x.approval_digest}`,{pr:url,at:Date.now()});
    // Already reviewing work belongs to the shared inventory even when an
    // open-only read has no entry for its now-closed PR. Never rescan per worker.
    continue;
   }
  }
  try {
   const i=JSON.parse(await execute(['gh','issue','view',String(t.number),'--repo',t.repo,'--json','number,title,body,url,updatedAt,state,labels'])) as Issue;
   if(i.number!==t.number || i.state!=='OPEN' || intakeLabel(t.repo,i)!==x.approval_digest)continue;
   const states=i.labels.filter(l=>l.name.startsWith('state:'));
   if(states.length!==1 || !['state:ready','state:building','state:review'].includes(states[0].name))continue;
   const published=JSON.parse(receipt.data) as {url?:string};
   if(!published.url)throw Error('published PR identity missing');
   const pr=JSON.parse(await execute(['gh','pr','view',published.url,'--repo',t.repo,'--json','state,url,reviewDecision'])) as {state:string;url:string;reviewDecision?:string};
   if(pr.state!=='OPEN' || pr.url!==published.url)continue;
   if(pr.reviewDecision==='CHANGES_REQUESTED'){e.s.set(`review-returned:${x.id}:${x.approval_digest}`,{pr:pr.url,at:Date.now()});continue;}
   if(states[0].name==='state:review')continue;
   await execute(['gh','label','create','state:review','--repo',t.repo,'--color','6F42C1','--description','Factory work awaiting review','--force']);
   await execute(['gh','issue','edit',String(t.number),'--repo',t.repo,'--remove-label',states[0].name,'--add-label','state:review']);
   e.s.event(crypto.randomUUID(),'github-state',{repo:t.repo,number:t.number,state:'review',session:x.id,digest:x.approval_digest,pr:pr.url,previous:states[0].name},'Return to ready only for a newly approved digest or recorded failed review; retain custody and PR');
   changed++;
  } catch(error) {
   e.s.event(crypto.randomUUID(),'github-review-failure',{id:x.id,error:String(error)},'Retry label reconciliation; retain published work and claim');
   if(unavailable(error))break;
  }
 }
 return changed;
}
