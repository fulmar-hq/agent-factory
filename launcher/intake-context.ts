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
