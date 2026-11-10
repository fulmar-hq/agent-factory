import type {Store} from '../tracking/store';
import type {Config} from './config';
export function githubHealth(s:Store,c:Config,now:number) {
 const errors=Object.values(c.projects).flatMap(p=>{const v=s.get<{error?:string;retryAt?:number}>(`github:${p.repo}`);return !v || v.error?[{repo:p.repo,error:v?.error??'GitHub observation missing',retryAt:v?.retryAt}]:[];});
 const hold=s.get<{retryAt:number;error:string}>('github-backoff');
 if(!errors.length && (!hold || hold.retryAt<=now))return null;
 const prior=s.get<{ready?:number|null;lastKnownReady?:number|null}>('heartbeat');
 return {at:now,status:'degraded',ready:null,lastKnownReady:prior?.lastKnownReady??prior?.ready??null,paused:s.get('paused')===true,claimed:0,refusals:[],errors,retryAt:Math.max(now+60000,hold?.retryAt??0,...errors.map(e=>e.retryAt??0))};
}
