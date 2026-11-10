import {z} from 'zod';
import {join} from 'node:path';
import {openSync,readFileSync,fstatSync,closeSync,constants} from 'node:fs';
import type {Config} from './config';
import type {Engine} from './engine';
import {command} from '../adapters/github';

const Evidence=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('issue'),number:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('pr'),number:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('session'),session:z.string().min(1)}).strict(),
 z.object({kind:z.literal('factory-plan'),step:z.string().regex(/^A[1-9]$/),quote:z.string().min(20).max(2000)}).strict(),
]);
function correctionPlan(dir:string) {
 const fd=openSync(join(dir,'autonomy-correction-plan.md'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const stat=fstatSync(fd);if(!stat.isFile() || stat.size>128*1024)throw Error('bounded regular correction plan required');
  return readFileSync(fd,'utf8');
 } finally {closeSync(fd);}
}
export function intakeInstructions(c:Config,dir:string) {
 if(c.refill)return 'Product-only refill. Work down the existing real product backlog. Prioritize multi-staff and mixed-calendar booking, Outlook, Leads, onboarding, Settings and reply quality. Every proposal needs category: product and intakeEvidence: {kind: issue, number: the existing OPEN product backlog issue}. Repair or split that real outcome without duplicating active work. Never create review, challenge or acceptance tickets, tests-only filler, report documents or factory maintenance tasks. Review belongs to the same ticket and PR. Return an empty tickets array when no safe product leaf exists. Return mix: {product: ticket count, other: 0}, including empty refills. Spare usage goes only to product work; usage never changes review requirements.';
 if(c.autonomy?.intake_mode!=='drain')return 'Intake mode: build. New useful product scope is permitted within the existing policy.';
 let plan='Correction plan unavailable: do not propose factory-plan tickets.';
 try {plan=correctionPlan(dir).split('## 5. Steps')[1]?.split('## 6.')[0] ?? plan;}catch{}
 return `Intake mode: drain. Clear existing work before reprioritizing. Do not propose new Alido product scope, even to fill the buffer. An empty tickets array is valid. Review-state work is work to staff: propose bounded review, challenge and fix-up leaves against the existing OPEN issue/PR, using kind fix and executable targeted checks or findings. Do not wait for all reviews or create new product scope. Only repairs for existing OPEN issues/PRs or failed sessions, and factory self-tickets from the correction plan in fulmar-hq/agent-factory, are allowed. Every brief must include intakeEvidence: {kind: "issue" or "pr", number: positive integer}, {kind: "session", session: "failed session ID"}, or {kind: "factory-plan", step: "A1" through "A9", quote: "exact source excerpt, at least 20 characters"}. Issue/PR/session references must belong to the proposed repo. Existing-work leaves must use kind fix. Review/challenge leaves must describe the acceptance evidence to check; repair leaves must explain the concrete defect. A reference does not authorize extending the existing scope. Factory-plan tickets must implement the quoted step. Leave already-running work alone.\nCorrection plan steps (private context, never copy the plan into Git):\n${plan}`;
}
// Validate at both creation and auto-approval. A stale queued build wake cannot
// mint new scope after a mode change. Remote errors and absent proof fail closed.
export async function enforceIntakeMode(e:Engine,repo:string,raw:Record<string,unknown>,dir:string,execute=command) {
 if(e.c.refill) {
  const objective=String(raw.outcome??'').trim();
  const reportPaths=Array.isArray(raw.paths)&&raw.paths.some(p=>typeof p==='string'&&/-challenge\.md$/.test(p));
  if(reportPaths||/^(?:independently\s+)?(?:review|challenge|accept|audit|verify)\b/i.test(objective)||/(?:read.only|independent)\s+(?:review|challenge|acceptance)|no (?:code|implementation) changes|review.report/i.test(objective))throw Error('refill: review or acceptance work belongs on the original PR');
  if(raw.category!=='product' || !['fix','feature','product'].includes(String(raw.kind)) || !raw.intakeEvidence || /^(?:review|challenge|accept|acceptance|audit|verify)\b/i.test(String(raw.title ?? '')))throw Error('refill: product tasks only; no review or acceptance tickets');
  const evidence=Evidence.parse(raw.intakeEvidence);
  if(evidence.kind!=='issue')throw Error('refill: existing product backlog issue required');
  const source=JSON.parse(await execute(['gh','issue','view',String(evidence.number),'--repo',repo,'--json','number,state,title,labels']));
  if(source.number!==evidence.number || source.state!=='OPEN' || typeof source.title!=='string' || !Array.isArray(source.labels) || /^(?:review|challenge|accept|acceptance|audit|verify)\b/i.test(source.title) || source.labels.some((l:{name?:string})=>/^kind:(?:review|challenge|acceptance)$/.test(l.name??'')))throw Error('refill: source must be an open product backlog issue');
  if(repo==='fulmar-hq/agent-factory')throw Error('refill: factory maintenance is not product backlog');
  return;
 }
 if(e.c.autonomy?.intake_mode!=='drain')return;
 const evidence=Evidence.parse(raw.intakeEvidence);
 if(evidence.kind==='factory-plan') {
  if(repo!=='fulmar-hq/agent-factory')throw Error('drain: factory-plan work belongs in fulmar-hq/agent-factory');
  const plan=correctionPlan(dir);
  const section=plan.split(`**${evidence.step}. `)[1]?.split(/\n\*\*A[1-9]\. |\n## /)[0];
  if(!section?.includes(evidence.quote))throw Error('drain: correction-plan step/quote not found');
  return;
 }
 if(raw.kind!=='fix')throw Error('drain: existing work permits repairs only');
 if(evidence.kind==='session') {
  const session=e.sessions().find(x=>x.id===evidence.session);
  const failure=e.s.db.query("SELECT id FROM events WHERE (kind='worker-failure' OR (kind='worker-exit' AND json_extract(data,'$.ok')=0)) AND json_extract(data,'$.id')=?").get(evidence.session);
  if(!session || session.ticket.slice(0,session.ticket.lastIndexOf('#'))!==repo || !failure)throw Error('drain: failed session evidence missing or wrong repo');
  return;
 }
 const source=JSON.parse(await execute(['gh',evidence.kind==='pr'?'pr':'issue','view',String(evidence.number),'--repo',repo,'--json','number,state']));
 if(source.number!==evidence.number || source.state!=='OPEN')throw Error('drain: repair source must still be open');
}
