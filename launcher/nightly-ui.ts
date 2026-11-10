import type {Store} from '../tracking/store';
import type {ReleaseBatch} from './release-batch';

// Only requests whose published PR is in this frozen batch enter its checklist.
// Unpublished/deferred backlog remains retained for a later night.
export function nightlyUiChecklist(s:Store,batch:ReleaseBatch) {
 const sources=new Set(batch.sources.map(x=>x.number));
 const requests=s.db.query("SELECT value FROM kv WHERE key LIKE 'nightly-ui:%'").all() as {value:string}[];
 const publications=new Map((s.db.query("SELECT data FROM events WHERE kind='launcher-publish' ORDER BY at").all() as {data:string}[]).map(r=>{const p=JSON.parse(r.data);return [p.id,p];}));
 return requests.map(r=>JSON.parse(r.value)).filter(r=>{
  const p=publications.get(r.parent);
  return r.state==='pending' && r.repo==='fulmar-hq/alido' && p?.repo===r.repo && sources.has(Number(p.url?.split('/').at(-1)));
 }).map(r=>({issue:r.issue,request:r.request,note:r.note,publication:publications.get(r.parent)}));
}
export const nightlyUiInstructions='For changed UI in this frozen batch, perform the EN/FR 375px/1440px render and real keyboard checks once in nightly hosted acceptance. Per-ticket local previews are not a publication gate. Use the frozen hosted batch source; local URLs, harness startup commands and old checkpoint references in retained requests are historical context, not instructions to recreate per-ticket previews. Use synthetic records and existing authorized sessions only; never sign in or accept terms. Report missing or failed observations honestly; deferred does not mean passed.';
