import {AsyncLocalStorage} from 'node:async_hooks';
export const githubContext=new AsyncLocalStorage<string>();
import {Store} from '../tracking/store';
import {root} from '../launcher/config';
import {join} from 'node:path';
export class GitHubUnavailable extends Error {
 constructor(message:string,readonly retryAt:number){super(message);this.name='GitHubUnavailable';}
}
export const unavailable=(error:unknown)=>error instanceof GitHubUnavailable || /(?:GitHubUnavailable|API rate limit|secondary rate limit|(?:gh|git) (?:failed|timed out).*(?:timeout|connection|network|resolve|EOF|HTTP 5[0-9]{2}|context deadline|temporary failure)|GitHub backoff)/is.test(String(error));
export function retryAtFor(error:unknown,now:number,resets?:{resources?:Record<string,{remaining:number;reset:number}>}) {
 const rate=/rate limit/i.test(String(error));
 const exhausted=Object.entries(resets?.resources??{}).filter(([k,v])=>['core','graphql'].includes(k)&&v.remaining===0).map(([,v])=>v.reset*1000+1000);
 return Math.max(now+60000,...(rate?exhausted:[]),...(rate&&!exhausted.length?[now+15*60000]:[]));
}
export const githubSource=(argv=process.argv)=>/factory-health-watch/.test(argv.join(' '))?'health':/maintain-factory/.test(argv.join(' '))?'maintenance':/tick\.ts/.test(argv.join(' '))?'tick':/worker(?:-entry)?\.ts/.test(argv.join(' '))?'builder':/owner\.ts/.test(argv.join(' '))?'owner':/board/.test(argv.join(' '))?'board':'control';
export function githubBudget(action:'before'|'success'|'failure',args:string[],error?:unknown,retryAt?:number,now=Date.now(),directory=githubContext.getStore()??root) {
 const s=new Store(join(directory,'controller.sqlite'));
 try {
  if(action==='before') {
   const hold=s.get<{retryAt:number;error:string}>('github-backoff');
   if(hold && hold.retryAt>now)throw new GitHubUnavailable(`GitHub backoff: ${hold.error}`,hold.retryAt);
   const key=`github-calls:${Math.floor(now/3600000)}:${githubSource()}`;
   s.atomic(()=>{const v=s.get<Record<string,number>>(key)??{};s.set(key,{...v,commands:(v.commands??0)+1});});
  } else if(action==='failure' && retryAt) {
   s.atomic(()=>{const prior=s.get<{retryAt:number}>('github-backoff');s.set('github-backoff',{retryAt:Math.max(retryAt,prior?.retryAt??0),error:String(error),at:now});s.event(crypto.randomUUID(),'github-unavailable',{source:githubSource(),error:String(error),retryAt},'Keep custody and snapshots; retry after reset, never infer an empty queue',now);});
  }
 }finally{s.close();}
}

// Keep only counts and quota metadata. Never persist debug bodies, headers,
// query text, issue text or authentication material.
export function githubHttpCounts(debug:string,body:string) {
 const requests=(debug.match(/^> (?:GET|POST|PUT|PATCH|DELETE) /gm)??[]).length;
 let graphqlPoints=0;
 if(requests)try{const r=JSON.parse(body);graphqlPoints=r?.data?.rateLimit?.cost??0;}catch{}
 return {requests,graphqlPoints};
}
export function recordGithubHttp(debug:string,body:string,now=Date.now(),directory=githubContext.getStore()??root) {
 const counts=githubHttpCounts(debug,body),s=new Store(join(directory,'controller.sqlite'));
 try{s.atomic(()=>{const key=`github-calls:${Math.floor(now/3600000)}:${githubSource()}`,v=s.get<Record<string,number>>(key)??{};s.set(key,{...v,requests:(v.requests??0)+counts.requests,graphqlPoints:(v.graphqlPoints??0)+counts.graphqlPoints});});}finally{s.close();}
}

export function githubDiagnostic(stderr:string) {
 return stderr.split('\n').filter(line=>/^(?:gh: |GraphQL: |error: |error connecting to |check your internet connection|fatal: |Post |Get |HTTP )/.test(line)).slice(-3).join('\n').slice(-500) || 'GitHub command failed; raw debug omitted';
}
