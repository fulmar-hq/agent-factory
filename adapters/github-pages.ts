import { z } from 'zod';
import { command } from './github';

const pageInfo = z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()});
const labels = z.object({nodes:z.array(z.object({name:z.string()})),pageInfo});
const issue = z.object({number:z.number().int().positive(),title:z.string(),body:z.string(),url:z.string(),updatedAt:z.string(),closedAt:z.string().nullable(),state:z.enum(['OPEN','CLOSED']),labels});
const review = z.object({id:z.string(),state:z.string(),submittedAt:z.string().nullable()});
const check = z.object({name:z.string().optional(),status:z.string().optional(),conclusion:z.string().nullable().optional(),detailsUrl:z.string().nullable().optional(),targetUrl:z.string().nullable().optional(),state:z.string().optional()});
const pull = z.object({number:z.number().int().positive(),title:z.string(),url:z.string(),headRefOid:z.string(),headRefName:z.string(),baseRefName:z.string(),reviewDecision:z.string().nullable(),reviews:z.object({nodes:z.array(review),pageInfo}),closingIssuesReferences:z.object({nodes:z.array(z.object({number:z.number().int(),url:z.string()})),pageInfo}),commits:z.object({nodes:z.array(z.object({commit:z.object({statusCheckRollup:z.object({contexts:z.object({nodes:z.array(check),pageInfo})}).nullable()})}))})});
const issueFields = 'number title body url updatedAt closedAt state labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}';
const pullFields = `number title url headRefOid headRefName baseRefName reviewDecision
 reviews(first:100){nodes{id state submittedAt} pageInfo{hasNextPage endCursor}}
 closingIssuesReferences(first:100){nodes{number url} pageInfo{hasNextPage endCursor}}
 commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{state targetUrl}} pageInfo{hasNextPage endCursor}}}}}}`;

// A completed cursor chain, not a result-count ceiling, establishes completeness.
// Stage all pages before publishing any snapshot or wake. Nested truncation and
// changing totals fail closed; the next scheduled tick can retry the read.
export async function githubPages(repo:string,kind:'issues'|'pullRequests',execute=command) {
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('invalid repository');
 const [owner,name]=repo.split('/');
 const schema=z.object({data:z.object({repository:z.object({[kind]:z.object({totalCount:z.number().int().nonnegative(),nodes:z.array(kind==='issues'?issue:pull),pageInfo})})}),errors:z.unknown().optional()});
 const query=`query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){${kind}(first:100,after:$endCursor${kind==='pullRequests'?',states:OPEN':''},orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{${kind==='issues'?issueFields:pullFields}} pageInfo{hasNextPage endCursor}}}}`;
 let cursor:string|undefined,total:number|undefined;
 const seen=new Set<string>(),numbers=new Set<number>(),rows:unknown[]=[];
 const deadline=Date.now()+120000;
 for(;;) {
  if(Date.now()>=deadline)throw Error('GitHub pagination deadline exceeded');
  const raw=schema.parse(JSON.parse(await execute(['gh','api','graphql','-f',`query=${query}`,'-F',`owner=${owner}`,'-F',`name=${name}`,...(cursor?['-F',`endCursor=${cursor}`]:[])],undefined,Math.max(1,deadline-Date.now()))));
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
