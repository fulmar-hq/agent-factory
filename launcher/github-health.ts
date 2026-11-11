import {GitHubUnavailable,retryAtFor} from '../adapters/github-budget';
import type {Store} from '../tracking/store';
import type {Config} from './config';
export function githubHealth(s:Store,c:Config,now:number) {
 const errors=Object.values(c.projects).flatMap(p=>{const v=s.get<{error?:string;retryAt?:number}>(`github:${p.repo}`);return !v || v.error?[{repo:p.repo,error:v?.error??'GitHub observation missing',retryAt:v?.retryAt}]:[];});
 const hold=s.get<{retryAt:number;error:string}>('github-backoff');
 if(!errors.length && (!hold || hold.retryAt<=now))return null;
 const prior=s.get<{ready?:number|null;lastKnownReady?:number|null}>('heartbeat');
 return {at:now,status:'degraded',ready:null,lastKnownReady:prior?.lastKnownReady??prior?.ready??null,paused:s.get('paused')===true,claimed:0,refusals:[],errors,retryAt:Math.max(now+60000,hold?.retryAt??0,...errors.map(e=>e.retryAt??0))};
}

// Late owner polling and final intake reads happen after the inventory pass.
// Persist their failure too, so restart cannot turn it into healthy readiness.
export function recordLateGithubFailure(s:Store,error:unknown,now=Date.now()) {
 const retryAt=error instanceof GitHubUnavailable?error.retryAt:retryAtFor(error,now);
 s.atomic(()=>{
  const prior=s.get<{retryAt:number}>('github-backoff');
  s.set('github-backoff',{retryAt:Math.max(retryAt,prior?.retryAt??0),error:String(error),at:now});
  s.event(crypto.randomUUID(),'github-unavailable',{source:'late-tick',error:String(error),retryAt},'Retain snapshots, claims and queued wakes; retry after GitHub recovery',now);
 });
}
