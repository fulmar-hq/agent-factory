import {createHash} from 'node:crypto';
import type {Engine} from './engine';
import {command,type Issue} from '../adapters/github';

type Entry={id:string;labels:{name:string}[]};
// Product refill must see real backlog and refused drafts before review work.
// Reviews remain visible as duplicate context, never the refill objective.
export function intakeContext<T extends Entry>(entries:T[],productOnly:boolean):T[]{
 if(!productOnly)return [...entries.filter(i=>i.labels.some(l=>l.name==='state:review')),...entries.filter(i=>!i.labels.some(l=>l.name==='state:review'))].slice(0,50);
 const product=entries.filter(i=>!i.id.startsWith('fulmar-hq/agent-factory#'));
 const review=(i:T)=>i.labels.some(l=>['state:review','state:building'].includes(l.name));
 const priority=(i:T)=>i.labels.some(l=>l.name==='state:ready')?0:1;
 return [...product.filter(i=>!review(i)).sort((a,b)=>priority(a)-priority(b)),...product.filter(review)].slice(0,50);
}
const digest=(body:string)=>createHash('sha256').update(body).digest('hex');
type Draft={repo:string;title:string;existingIssue?:number;bodyDigest?:string};
// Complete a never-attempted coding brief on its original issue. This does not
// approve it: the ordinary policy, exact-digest approval and admission still run.
export async function completeIntakeDraft(e:Engine,p:Draft,brief:Record<string,unknown>,key:string,execute=command){
 const number=p.existingIssue!,id=`${p.repo}#${number}`;
 if(!p.bodyDigest||!Number.isSafeInteger(number)||number<=0)throw Error('existing draft requires exact bodyDigest');
 if(e.sessions().some(s=>s.ticket===id))throw Error('existing draft has attempted custody; use diagnosis');
 if(brief.category!=='product'||(brief.intakeEvidence as {kind?:string;number?:number})?.kind!=='issue'||(brief.intakeEvidence as {number?:number}).number!==number)throw Error('existing draft must cite its original product issue');
 const current=JSON.parse(await execute(['gh','issue','view',String(number),'--repo',p.repo,'--json','number,title,body,url,updatedAt,state,labels'])) as Issue;
 if(current.number!==number||current.state!=='OPEN'||current.title!==p.title||!Array.isArray(current.labels)||typeof current.body!=='string')throw Error('existing draft identity changed');
 if(current.labels.filter(l=>l.name.startsWith('state:')).some(l=>l.name!=='state:ready'))throw Error('existing draft must be unapproved ready work, not a blocked or active task');
 if(current.labels.some(l=>l.name.startsWith('ready:')||['state:building','state:review','state:done'].includes(l.name)))throw Error('existing draft already approved or in delivery');
 const planKey=`proposal-draft:${key}`;
 const prior=e.s.get<{number:number;original:string;body:string}>(planKey);
 let plan=prior;
 if(!plan){
  if(digest(current.body)!==p.bodyDigest)throw Error('existing draft body changed');
  const blocks=[...current.body.matchAll(/```factory\s*\n[\s\S]*?\n```/g)];
  if(blocks.length>1)throw Error('existing draft has ambiguous factory blocks');
  const marker=`<!-- ${key} -->`;
  const prose=blocks.length?current.body.replace(blocks[0][0],'').trimEnd():current.body.trimEnd();
  plan={number,original:current.body,body:`${prose}\n\n${marker}\n\`\`\`factory\n${JSON.stringify(brief,null,2)}\n\`\`\``};
  e.s.set(planKey,plan);
 }
 if(plan.number!==number||(current.body!==plan.original&&current.body!==plan.body))throw Error('existing draft edit custody changed');
 // Reuse the exact retained edit after a lost response; never replace later edits.
 if(current.body!==plan.body)await execute(['gh','issue','edit',String(number),'--repo',p.repo,'--body',plan.body]);
 const readback=JSON.parse(await execute(['gh','issue','view',String(number),'--repo',p.repo,'--json','number,body,state,labels'])) as Issue;
 if(readback.number!==number||readback.state!=='OPEN'||readback.body!==plan.body||readback.labels.some(l=>l.name.startsWith('ready:')||l.name.startsWith('state:')&&l.name!=='state:ready'||['state:building','state:review','state:done'].includes(l.name)))throw Error('existing draft readback changed');
 await execute(['gh','issue','edit',String(number),'--repo',p.repo,'--add-label','state:ready']);
 e.s.set(key,number);
 return number;
}
