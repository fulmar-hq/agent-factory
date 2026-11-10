import {NativeReceipt} from '../adapters/native';
import {WorkerAccounting} from '../adapters/workers';
import type {Store} from '../tracking/store';

// Only an authenticated HTTP rejection is definitive. Timeouts, malformed replies
// and failed readback retain uncertain merge custody for read-only reconciliation.
export class FactoryMergeRejected extends Error{constructor(readonly status:number,detail:string){super(`protected merge rejected (${status}): ${detail}`);}}
export const factoryRepository='fulmar-hq/agent-factory';
export type FactoryPull={number:number;head:string;tree:string;createdAt:string;draft:boolean;state:string;mergeState:string;verify:boolean};
export type Challenge={pr:number;head:string;ok:boolean;native:{id:string;path:string;verified:boolean;models:string[];efforts:string[]};cleanup:{verified:boolean};review:{head:string;verdict:string;findings:unknown[];installedGaps?:string[]};evidenceScope?:'source-review';workspace:string;startedAt:number};
export interface MaintenancePort {
 pulls():Promise<FactoryPull[]>;
 pull(number:number):Promise<FactoryPull>;
 update?(pull:FactoryPull):Promise<void>;
 challenge(pull:FactoryPull):Promise<Challenge|undefined>;
 verifyChallenge(challenge:Challenge):boolean;
 signed(head:string,tree:string):Promise<boolean>;
 merge(number:number,head:string):Promise<{head:string;tree:string}>;
 merged(number:number):Promise<{state:string;head:string;revision?:string;tree?:string}>;
 install(head:string):Promise<string>;
}
export function acceptedChallenge(c:Challenge|undefined,p:FactoryPull):c is Challenge {
 return !!c && c.pr===p.number && c.head===p.head && c.ok===true && c.review.head===p.head && c.review.verdict==='PASS' && Array.isArray(c.review.findings) && c.review.findings.length===0 && Array.isArray(c.review.installedGaps) && c.review.installedGaps.length===0 && c.native.verified===true && c.cleanup.verified===true && c.native.models.join()==='gpt-6.1-sol' && c.native.efforts.join()==='medium';
}
// An old PASS cannot waive absent or unclassified evidence. Preserve the raw
// result; this derived disposition requires explicit evidence reconciliation.
export function normalizeChallenge(c:Challenge):Challenge {
 if(c.review.verdict!=='PASS')return c;
 if(Array.isArray(c.review.findings)&&c.review.findings.length)return {...c,review:{...c.review,verdict:'CHANGES_REQUESTED'}};
 if(!Array.isArray(c.review.findings)||!Array.isArray(c.review.installedGaps)||c.review.installedGaps.length)return {...c,review:{...c.review,verdict:'BLOCKED'}};
 return c;
}
export function nativeChallenge(c:Challenge,home:string):boolean {
 try {const receipt=new NativeReceipt('codex',c.native.id,c.workspace,home,c.startedAt),accounting=new WorkerAccounting();for(let i=0;i<256;i++){receipt.poll(accounting);if(receipt.caughtUp)break;}const evidence=receipt.evidence('gpt-6.1-sol','medium');return evidence.verified && evidence.path===c.native.path;}catch{return false;}
}
// Release owns this launcher-only lane. Product supplies scope; the independent
// challenger supplies evidence. No product release, policy or provider effects.
export async function maintainFactory(s:Store,port:MaintenancePort) {
 const result:{pr:number;state:string;reason?:string;head?:string}[]=[];
 const interrupted=()=>{const lease=s.get<{id:string}>('launcher-maintenance-lease');return !!lease&&s.get<{id:string}>('factory-maintenance-stop')?.id===lease.id;};
 const record=(p:number,state:string,reason?:string,head?:string)=>{const r={pr:p,state,reason,head};result.push(r);s.event(`factory-maintenance:${p}:${state}:${head??''}:${crypto.randomUUID()}`,'factory-maintenance',r,'Retain PRs and branches; undo installed source with a signed revert');};
 // First adopt previously merged source, including a merge whose install was
 // interrupted. Installation never resets, cleans or stashes local changes.
 const approve=async(intent:{pr:number;head:string;tree:string},merged:{head:string;tree:string})=>{
  s.set(`factory-merge-outcome:${merged.head}`,{state:'blocked',expected:intent.tree,tree:merged.tree,pr:intent.pr});
  if(merged.tree!==intent.tree||!await port.signed(merged.head,merged.tree))throw Error('merged signature or exact tested tree differs; install refused');
  s.set(`factory-merge-outcome:${merged.head}`,{state:'verified',tree:merged.tree,pr:intent.pr});s.set('factory-install-pending',{head:merged.head,tree:merged.tree});s.set('factory-merge-intent',null);
 };
 const intent=s.get<{pr:number;head:string;tree:string}>('factory-merge-intent');
 if(intent){try{const remote=await port.merged(intent.pr);if(remote.state!=='MERGED'||remote.head!==intent.head||!remote.revision||!remote.tree)throw Error('retained merge intent is unresolved; read-only reconciliation only');await approve(intent,{head:remote.revision,tree:remote.tree});record(intent.pr,'merge-reconciled',undefined,remote.revision);}catch(error){record(intent.pr,'merge-reconcile-blocked',String(error),intent.head);return result;}}
 const pending=s.get<{head:string;tree:string}>('factory-install-pending');
 if(pending){try{const approval=s.get<{state:string;tree:string}>(`factory-merge-outcome:${pending.head}`);if(approval?.state!=='verified'||approval.tree!==pending.tree||!await port.signed(pending.head,pending.tree))throw Error('pending install has no verified exact-tree approval');await port.install(pending.head);s.set('factory-install-pending',null);}catch(error){record(0,'install-blocked',String(error));return result;}}
 for(const initial of (await port.pulls()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.number-b.number)) {
  try {
   if(interrupted())return result;
   if(initial.draft){record(initial.number,'draft');continue;}
   const p=await port.pull(initial.number);if(p.state!=='OPEN'||p.head!==initial.head){record(p.number,'changed');continue;}
   if(p.mergeState==='BEHIND'&&p.verify&&port.update){
    const key=`factory-branch-update:${p.number}:${p.head}`;
    if(s.get(key)){record(p.number,'branch-update-pending',undefined,p.head);continue;}
    if(!await port.signed(p.head,p.tree))throw Error('head signature/tree unverified before branch update');
    s.set(key,{pr:p.number,head:p.head,at:Date.now()});await port.update(p);record(p.number,'branch-update-requested',undefined,p.head);return result;
   }
   if(p.mergeState!=='CLEAN'||!p.verify){record(p.number,'checks-or-base-blocked',p.mergeState,p.head);continue;}
   const c=await port.challenge(p);if(interrupted())return result;if(!acceptedChallenge(c,p)||!port.verifyChallenge(c)){record(p.number,'challenge-needed',undefined,p.head);continue;}
   if(!await port.signed(p.head,p.tree))throw Error('head signature/tree unverified');
   const fresh=await port.pull(p.number);
   if(fresh.head!==p.head||fresh.tree!==p.tree||fresh.state!=='OPEN'||!fresh.verify||fresh.mergeState!=='CLEAN')throw Error('head/check/base changed before merge');
   if(interrupted())return result;
   const intent={pr:p.number,head:p.head,tree:p.tree};s.set('factory-merge-intent',intent);
   s.event(`factory-merge-intent:${p.number}:${p.head}`,'factory-merge-intent',intent,'Reconcile this exact PR after an uncertain response; never re-merge or substitute remote main');
   let merged:{head:string;tree:string};
   try{merged=await port.merge(p.number,p.head);}catch(error){
    if(error instanceof FactoryMergeRejected){s.set(`factory-merge-rejected:${p.number}:${p.head}`,{...intent,status:error.status,error:String(error),at:Date.now()});s.event(crypto.randomUUID(),'factory-merge-rejected',{...intent,status:error.status,error:String(error)},'Definitive no-effect response; a later pass must reread every gate');s.set('factory-merge-intent',null);}
    throw error;
   }
   await approve(intent,merged);
   record(p.number,'merged',undefined,merged.head);
   const installed=await port.install(merged.head);record(p.number,'installed',undefined,installed);s.set('factory-install-pending',null);
  }catch(error){record(initial.number,'blocked',String(error),initial.head);return result;}
 }
 return result;
}
