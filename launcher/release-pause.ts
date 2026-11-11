import {queueWake} from './wake';
import {readReleaseBatch} from './release-batch';
import {toronto} from './release';
import {releaseAction,type ReleaseOwner} from './release-actions';
import type {Store} from '../tracking/store';
export function pauseOwner(value:unknown):ReleaseOwner {
 if(value===undefined)return 'Coordinator';
 if(typeof value==='string'&&['Coordinator','Release','Quality','Platform','Product'].includes(value))return value as ReleaseOwner;
 throw Error('pause owner must be Coordinator, Release, Quality, Platform or Product');
}
type Episode={id:string;at:number|null;owner:ReleaseOwner;attributed:boolean};
// First pause after the last real resume, including legacy repeated true calls.
// Initial prepared safety pauses have no invented caller or set timestamp.
export function activePauseEpisode(s:Store,now=Date.now()):Episode {
 const resume=s.db.query("SELECT id,rowid FROM events WHERE kind='resume' AND at<=? ORDER BY rowid DESC LIMIT 1").get(now) as {id:string;rowid:number}|null;
 const row=s.db.query("SELECT id,at,data FROM events WHERE kind='pause' AND at<=? AND rowid>? ORDER BY rowid LIMIT 1").get(now,resume?.rowid??0) as {id:string;at:number;data:string}|null;
 const prior=s.get<Episode>('release-pause-episode'),id=`after-resume:${resume?.id??'initial'}`;
 if(prior?.id===id)return prior;
 const raw=row?JSON.parse(row.data):null;
 let owner:ReleaseOwner='Coordinator';try{owner=pauseOwner(raw?.owner);}catch{/* Legacy unknown caller remains Coordinator's escalation. */}
 const episode={id,at:row?.at??null,owner,attributed:raw?.ownerSupplied!==false&&typeof raw?.owner==='string'&&['Coordinator','Release','Quality','Platform','Product'].includes(raw.owner)};s.set('release-pause-episode',episode);return episode;
}
type PauseAction={id:string;to:ReleaseOwner;summary:string;body:string;at:number;day:string;episode:string;queuedAt?:number};
function drainPauseActions(s:Store,now:number,send:typeof releaseAction){
 const rows=s.db.query("SELECT key,value FROM kv WHERE key LIKE 'release-pause-action:%' AND json_extract(value,'$.queuedAt') IS NULL ORDER BY json_extract(value,'$.at'),key LIMIT 2001").all() as {key:string;value:string}[];
 if(rows.length>2000)throw Error('pending pause action inventory exceeds bound');
 let queued=0;
 // Materialize before any external mail work. Each recipient has independent
 // retry custody; one failure cannot strand another episode or recipient.
 for(const row of rows){const action=JSON.parse(row.value) as PauseAction;
  try{
   send(action.id,action.to,action.summary,action.body,now);
   if(action.to!=='Coordinator')queueWake(s,{id:`mail:${action.id}`,owner:action.to.toLowerCase(),kind:'release-pause-action',payload:{mailId:action.id,summary:action.summary,body:action.body}},now);
   s.set(row.key,{...action,queuedAt:now});queued++;
  }catch(error){s.event(`${action.id}:alert-failure`,'release-pause-alert-failure',{id:action.id,error:String(error)},'Retain pending recipient action; retry even after resume or another pause',now);}
 }
 return {queued:queued>0,pending:rows.length-queued};
}
// New intents require a verified current-day batch/window. Already-admitted
// intents drain independently, including after resume, a later pause or midnight.
export function watchReleasePause(s:Store,dir:string,now=Date.now(),send=releaseAction){
 const {day,minute}=toronto(now);let episode:Episode|undefined,accepted=false;
 if(minute>=1050&&minute<1355&&s.get('paused')!==false)try{readReleaseBatch(dir,day);accepted=true;}catch{/* No invented acceptance. Retained intents still drain. */}
 if(accepted){
  episode=activePauseEpisode(s,now);
  const deadline=minute<1140?'19:00':minute<1200?'20:00':minute<1290?'21:30':'22:35';
  const current=episode;
  s.atomic(()=>{for(const to of new Set<ReleaseOwner>(['Coordinator',current.owner])){
   const id=`release-pause:${day}:${current.id}:${to}`,key=`release-pause-action:${id}`;
   if(s.get(key))continue;
   s.set(key,{id,to,at:now,day,episode:current.id,summary:`Factory pause needs release review. Due ${day} ${deadline} Eastern.`,body:`An accepted batch was scheduled for ${day}. A factory pause was observed during 17:30–22:35 America/Toronto at ${new Date(now).toISOString()}. Accountable pausing role: ${current.owner}${current.attributed?'':' (generic/legacy owner control; actual caller not recorded)'}. Reconcile its release impact immediately and before the next fixed window; do not automatically lift the pause. Pause first set: ${current.at===null?'unknown':new Date(current.at).toISOString()}.`} satisfies PauseAction);
  }});
 }
 return {...drainPauseActions(s,now,send),...(episode?{day,episode:episode.id,owner:episode.owner}:{})};
}
