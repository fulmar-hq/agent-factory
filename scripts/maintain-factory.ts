#!/usr/bin/env bun
import {mkdirSync,writeFileSync,readFileSync,renameSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {command} from '../adapters/github';
import {root} from '../launcher/config';
import {Store} from '../tracking/store';
import {maintainFactory,nativeChallenge,factoryRepository,type FactoryPull,type Challenge,type MaintenancePort} from '../launcher/factory-maintenance';
const repo=resolve(import.meta.dir,'..');
const api=async(path:string)=>JSON.parse(await command(['gh','api',`repos/${factoryRepository}/${path}`]));
const git=(...args:string[])=>command(['git','-C',repo,...args]);
async function pull(number:number):Promise<FactoryPull>{
 const p=JSON.parse(await command(['gh','pr','view',String(number),'--repo',factoryRepository,'--json','number,headRefOid,headRefName,createdAt,isDraft,state,mergeStateStatus,statusCheckRollup,baseRefName']));
 if(p.baseRefName!=='main')throw Error('factory main PR required');
 const commit=await api(`git/commits/${p.headRefOid}`);
 return {number:p.number,head:p.headRefOid,tree:commit.tree.sha,createdAt:p.createdAt,draft:p.isDraft,state:p.state,mergeState:p.mergeStateStatus,verify:p.statusCheckRollup.some((c:{name:string;conclusion:string;status:string})=>c.name==='Verify'&&c.status==='COMPLETED'&&c.conclusion==='SUCCESS')};
}
export function maintenancePort(s:Store):MaintenancePort{return {
 pulls:async()=>{const list=JSON.parse(await command(['gh','pr','list','--repo',factoryRepository,'--state','open','--limit','101','--json','number,createdAt,headRefOid,isDraft,baseRefName']));if(list.length>100)throw Error('factory PR inventory truncated');return list.filter((p:{baseRefName:string})=>p.baseRefName==='main').map((p:{number:number;headRefOid:string;createdAt:string;isDraft:boolean})=>({number:p.number,head:p.headRefOid,createdAt:p.createdAt,draft:p.isDraft,state:'OPEN',tree:'',verify:false,mergeState:'UNKNOWN'}));},
 pull,
 challenge:async p=>{const rows=s.db.query("SELECT data FROM events WHERE kind='codex-challenge' ORDER BY at DESC").all() as {data:string}[];for(const row of rows){const c=JSON.parse(row.data);if(Number(c.pr)===p.number&&c.head===p.head){c.pr=Number(c.pr);return c as Challenge;}}},
 verifyChallenge:c=>nativeChallenge(c,homedir()),
 signed:async(head,tree)=>{const c=await api(`commits/${head}`);return c.sha===head&&c.commit.tree.sha===tree&&c.commit.verification.verified===true&&c.commit.verification.reason==='valid';},
 merged:async number=>{const p=await api(`pulls/${number}`);if(p.base?.ref!=='main'||p.base?.repo?.full_name!==factoryRepository||p.head?.repo?.full_name!==factoryRepository)throw Error('merge reconciliation repository/base differs');if(!p.merged)return {state:p.state==='open'?'OPEN':'CLOSED',head:p.head.sha};const c=await api(`git/commits/${p.merge_commit_sha}`);return {state:'MERGED',head:p.head.sha,revision:p.merge_commit_sha,tree:c.tree.sha};},
 merge:async(number,head)=>{await command(['gh','pr','merge',String(number),'--repo',factoryRepository,'--squash','--match-head-commit',head]);const p=await api(`pulls/${number}`);if(!p.merged||p.head.sha!==head)throw Error('merge readback mismatch');const c=await api(`git/commits/${p.merge_commit_sha}`);return {head:p.merge_commit_sha,tree:c.tree.sha};},
 install:async target=>{
  if((await git('branch','--show-current')).trim()!=='main'||(await git('status','--porcelain')).trim())throw Error('installed main must be clean; preserve and reconcile local work');
  if(!(await git('remote','get-url','origin')).trim().match(/^https:\/\/github.com\/fulmar-hq\/agent-factory(?:\.git)?$/))throw Error('installed origin mismatch');
  await git('fetch','origin','main');const remote=(await git('rev-parse','origin/main')).trim();
  if(target==='main')throw Error('explicit verified install revision required');
  const approval=s.get<{state:string;tree:string}>(`factory-merge-outcome:${target}`);if(approval?.state!=='verified')throw Error('install revision has no verified merge approval');
  await git('merge-base','--is-ancestor',target,remote);
  const verified=await api(`commits/${target}`);if(verified.sha!==target||verified.commit.tree.sha!==approval.tree||verified.commit.verification.verified!==true||verified.commit.verification.reason!=='valid')throw Error('installed revision signature unverified');
  const before=(await git('rev-parse','HEAD')).trim();await git('merge','--ff-only',target);const after=(await git('rev-parse','HEAD')).trim();
  if(after!==target)throw Error('installed readback differs');s.event(`factory-install:${before}:${after}`,'factory-install',{before,after,checkout:repo},'Use a reviewed signed revert; preserve runtime state and all branches');return after;
 }
};}
if(import.meta.main){
 if(process.argv.slice(2).join()!=='--once')throw Error('Usage: bun scripts/maintain-factory.ts --once');
 const directory=join(root,'maintenance');mkdirSync(directory,{recursive:true,mode:0o700});
 const lock=join(directory,'active');
 // Interrupted custody is retained, never stolen on a timeout.
 try{mkdirSync(lock,{mode:0o700});}catch{throw Error('maintenance already claimed; reconcile retained lock before retry');}
 writeFileSync(join(lock,'claim.json'),JSON.stringify({pid:process.pid,at:Date.now(),checkout:repo}),{mode:0o600});
 const s=new Store(join(root,'controller.sqlite'));let ownsLease=false;const leaseId=`integration:${crypto.randomUUID()}`;
 try{s.atomic(()=>{if(s.get('launcher-maintenance-lease')&&s.get<{state:string}>('launcher-maintenance-lease')?.state!=='released')throw Error('another launcher maintenance run retains custody');s.set('launcher-maintenance-lease',{id:leaseId,kind:'integration',state:'active',pid:process.pid,at:Date.now()});ownsLease=true;});console.log(JSON.stringify(await maintainFactory(s,maintenancePort(s))));}
 finally{if(ownsLease&&s.get<{id:string}>('launcher-maintenance-lease')?.id===leaseId)s.set('launcher-maintenance-lease',{id:leaseId,kind:'integration',state:'released',at:Date.now()});s.close();renameSync(lock,join(directory,`completed-${Date.now()}-${crypto.randomUUID()}`));}
}
