import { z } from 'zod';
import { command } from './github';

const pageInfo = z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()});
const labels = z.object({nodes:z.array(z.object({name:z.string()})),pageInfo});
const issue = z.object({number:z.number().int().positive(),title:z.string(),body:z.string(),url:z.string(),updatedAt:z.string(),closedAt:z.string().nullable(),state:z.enum(['OPEN','CLOSED']),labels});
const review = z.object({id:z.string(),state:z.string(),submittedAt:z.string().nullable()});
const check = z.object({name:z.string().optional(),status:z.string().optional(),conclusion:z.string().nullable().optional(),detailsUrl:z.string().nullable().optional(),targetUrl:z.string().nullable().optional(),state:z.string().optional()});
const pull = z.object({number:z.number().int().positive(),title:z.string(),url:z.string(),headRefOid:z.string(),headRefName:z.string(),reviewDecision:z.string().nullable(),reviews:z.object({nodes:z.array(review),pageInfo}),closingIssuesReferences:z.object({nodes:z.array(z.object({number:z.number().int(),url:z.string()})),pageInfo}),commits:z.object({nodes:z.array(z.object({commit:z.object({statusCheckRollup:z.object({contexts:z.object({nodes:z.array(check),pageInfo})}).nullable()})}))})});
const issueFields = 'number title body url updatedAt closedAt state labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}';
const pullFields = `number title url headRefOid headRefName reviewDecision
 reviews(first:100){nodes{id state submittedAt} pageInfo{hasNextPage endCursor}}
 closingIssuesReferences(first:100){nodes{number url} pageInfo{hasNextPage endCursor}}
 commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{state targetUrl}} pageInfo{hasNextPage endCursor}}}}}}`;

// A completed cursor chain, not a result-count ceiling, establishes completeness.
// Stage all pages before publishing any snapshot or wake. Nested truncation and
// changing totals fail closed; the next scheduled tick can retry the read.
export async function githubPages(repo:string,kind:'issues'|'pullRequests',execute=command) {
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('invalid repository');
 const [owner,name]=repo.split('/');
 const schema=z.object({data:z.object({rateLimit:z.object({cost:z.number(),remaining:z.number(),resetAt:z.string()}).optional(),repository:z.object({[kind]:z.object({totalCount:z.number().int().nonnegative(),nodes:z.array(kind==='issues'?issue:pull),pageInfo})})}),errors:z.unknown().optional()});
 const query=`query($owner:String!,$name:String!,$endCursor:String){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){${kind}(first:100,after:$endCursor${kind==='pullRequests'?',states:OPEN':''},orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{${kind==='issues'?issueFields:pullFields}} pageInfo{hasNextPage endCursor}}}}`;
 let cursor:string|undefined,total:number|undefined;
 const seen=new Set<string>(),numbers=new Set<number>(),rows:unknown[]=[];
 const deadline=Date.now()+120000;
 for(;;) {
  if(Date.now()>=deadline)throw Error('GitHub pagination deadline exceeded');
  const raw=schema.parse(JSON.parse(await execute(['gh','api','graphql','--cache','10m','-f',`query=${query}`,'-F',`owner=${owner}`,'-F',`name=${name}`,...(cursor?['-F',`endCursor=${cursor}`]:[])],undefined,Math.max(1,deadline-Date.now()))));
  if(raw.errors!==undefined)throw Error('GitHub pagination returned errors');
  const page=raw.data.repository[kind];
  if(total!==undefined && total!==page.totalCount)throw Error('GitHub pagination total changed');
  total=page.totalCount;
  for(const node of page.nodes) {
   if(numbers.has(node.number) || node.url!==`https://github.com/${repo}/${kind==='issues'?'issues':'pull'}/${node.number}`)throw Error('GitHub pagination identity mismatch');
   numbers.add(node.number);
   if('labels' in node) {
    if(node.labels.pageInfo.hasNextPage)throw Error('GitHub issue labels truncated');
    rows.push({...node,labels:node.labels.nodes});
   } else {
    const contexts=node.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    if(node.reviews.pageInfo.hasNextPage || node.closingIssuesReferences.pageInfo.hasNextPage || contexts?.pageInfo.hasNextPage)throw Error('GitHub PR evidence truncated');
    rows.push({...node,reviewDecision:node.reviewDecision??'',reviews:node.reviews.nodes.map(r=>({...r,submittedAt:r.submittedAt??''})),closingIssuesReferences:node.closingIssuesReferences.nodes,statusCheckRollup:(contexts?.nodes??[]).map(c=>Object.fromEntries(Object.entries(c).filter(([,v])=>v!==null)))});
   }
  }
  if(rows.length>total)throw Error('GitHub pagination count exceeded');
  if(!page.pageInfo.hasNextPage) {
   if(rows.length!==total)throw Error('GitHub pagination incomplete');
   return rows;
  }
  const next=page.pageInfo.endCursor;
  if(!page.nodes.length || !next || seen.has(next))throw Error('GitHub pagination cursor stalled');
  seen.add(next);cursor=next;
 }
}

const restIssueSchema=z.object({number:z.number().int().positive(),title:z.string(),body:z.string().nullable(),html_url:z.string(),updated_at:z.string(),closed_at:z.string().nullable(),state:z.enum(['open','closed']),labels:z.array(z.object({name:z.string()})),pull_request:z.unknown().optional()});
export function restIssue(repo:string,raw:unknown) {
 const i=restIssueSchema.parse(raw);
 if(i.pull_request || i.html_url!==`https://github.com/${repo}/issues/${i.number}`)throw Error('GitHub REST issue identity mismatch');
 return {number:i.number,title:i.title,body:i.body??'',url:i.html_url,updatedAt:i.updated_at,closedAt:i.closed_at,state:i.state.toUpperCase(),labels:i.labels};
}
// Scheduling needs open issues, not thousands of closed bodies/label connections.
// gh follows REST Link headers; a late-page failure rejects the entire command.
export async function openIssuePages(repo:string,execute=command) {
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('invalid repository');
 const pages=z.array(z.array(restIssueSchema)).parse(JSON.parse(await execute(['gh','api','--paginate','--slurp',`repos/${repo}/issues?state=open&per_page=100`],undefined,120000)));
 if(!pages.length || pages.some((p,n)=>p.length>100 || n<pages.length-1&&p.length!==100))throw Error('GitHub REST pagination malformed');
 const seen=new Set<number>();
 return pages.flatMap(page=>page.filter(i=>!i.pull_request).map(i=>{
  if(seen.has(i.number)||i.state!=='open')throw Error('GitHub REST issue identity mismatch');seen.add(i.number);
  return restIssue(repo,i);
 }));
}
