import { command } from "../adapters/github";
import type { Config } from "../launcher/config";
import type { Store } from "../tracking/store";
export type BoardPull = {
  number: number; url: string; title?: string; headRefOid: string; headRefName?: string;
  reviewDecision?: string; closingIssuesReferences?: {number:number;url:string}[];
  reviews: {id:string;state:string;submittedAt:string}[];
  statusCheckRollup: {status?:string;conclusion?:string;detailsUrl?:string;targetUrl?:string;state?:string;name?:string}[];
};
export type PullSnapshot = {at:number; pulls:BoardPull[]; error?:boolean};
export const pullFields = 'number,title,headRefOid,headRefName,reviews,reviewDecision,statusCheckRollup,url,closingIssuesReferences';
export function pullState(pr: BoardPull) {
  // A release hold is a release dependency, not a broken build or a running check.
  const checks = (pr.statusCheckRollup ?? []).filter(c=>!/release[ -]hold/i.test(c.name ?? ''));
  return {review:pr.reviewDecision,releaseHeld:(pr.statusCheckRollup ?? []).some(c=>/release[ -]hold/i.test(c.name ?? '') && ['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(c.status ?? c.state ?? '')),
    pending:checks.some(c=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(c.status ?? c.state ?? '')),
    failed:(pr.statusCheckRollup ?? []).some(c=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','ACTION_REQUIRED'].includes(c.conclusion ?? c.state ?? ''))};
}
export function recordPulls(s:Store,repo:string,pulls:BoardPull[],now:number) {
  if(!Array.isArray(pulls) || pulls.some(pr=>!pr || !Number.isInteger(pr.number) || !pr.url?.startsWith(`https://github.com/${repo}/pull/`)))throw Error('invalid board PR evidence');
  if(pulls.length>=100)throw Error('board PR reconciliation truncated');
  s.atomic(()=>{
    s.set(`board-pulls:${repo}`,{at:now,pulls} satisfies PullSnapshot);
    for(const pr of pulls)s.set(`board-pr:${pr.url}`,{at:now,head:pr.headRefOid,...pullState(pr)});
  });
}
// Reuses the launcher's read-only GitHub source; no wake, admission or model effects.
export async function refreshPulls(s:Store,c:Config,now=Date.now(),execute=command) {
  await Promise.all(Object.values(c.projects).map(async project=>{
    const key=`board-pulls:${project.repo}`, prior=s.get<PullSnapshot>(key);
    if(prior && prior.at<=now && now-prior.at<60000)return;
    try {
      const pulls=JSON.parse(await execute(['gh','pr','list','--repo',project.repo,'--state','open','--limit','100','--json',pullFields])) as BoardPull[];
      recordPulls(s,project.repo,pulls,now);
    } catch {
      if(prior)s.set(key,{...prior,error:true});
    }
  }));
}
