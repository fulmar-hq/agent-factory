import {Database} from 'bun:sqlite';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigSchema,type Config} from './config';
import {usageGate} from './engine';
import {queueWake,type Wake} from './wake';
import {Store} from '../tracking/store';
import {LIMIT_KINDS,actionRole,limitReviewAt,ownerMessageId,roleActionId,type LimitKind} from './loop-contract';
import {loopActing,readLoopFlags} from './loop-flags';

const MINUTE=60000,HOUR=60*MINUTE;
// Fixed in source. Nothing here reads or changes a usage gate, capacity, the
// wallet, a pause or the release schedule; a limit that explains an idle
// factory is named and timed, never lifted, shortened or worked round.
export const IDLE_RULES={
 alarmAfter:20*MINUTE,        // first alarm: empty queue and stopped builders
 firstRepeatAfter:HOUR,       // first repeat, counted from the first alarm
 repeatEvery:2*HOUR,          // later repeats, counted from the previous one
 repeatsPerDay:12,            // across every episode, in any 24 hours
 ownerLineAfter:2*HOUR,       // one plain line for Vincent, whatever the cause
 intakeContextMaxAge:2*HOUR,  // how old a backlog view a repeat wake may reuse
 gap:{window:HOUR,unavailable:20*MINUTE,consecutive:3,longestReading:10*MINUTE},
} as const;
/** The class a pause question belongs to. Other producers of the same question use `pausedWithReadyActionId`. */
export const PAUSED_WITH_READY='paused-with-ready';
/** One action mail per pause, whoever raises it: a second writer building this id adds no second mail. */
export const pausedWithReadyActionId=(pauseSince:number)=>roleActionId(actionRole({kind:'limit-review'}),PAUSED_WITH_READY,String(pauseSince));

export type IdleLimit={kind:LimitKind;since?:number;until?:number;setBy?:string;detail?:string};
export type IdleQueueObservation={at:number;eligible:boolean;reason:string;lastActivity:number;heartbeatAt:number;observationUnavailable?:boolean;
 /** Ready count the tick last reported, when it is fresh. */
 ready?:number|null;
 /** A limit that explains why nothing is being built. Set only while no builder is running. */
 limit?:IdleLimit;
 /** When builders last did anything, where a limit explains the idle and that history is on record. */
 idleSince?:number;
 /** How the last intake ended, when the queue is empty. */
 intake?:string};
type Reader={query:Database['query']};
type Heartbeat={at:number;status:string;ready?:number;claimed?:number;refusals?:{reason?:string}[]}|null;
type Reading={windows?:{used:number;resetsAt:number}[]}|null|undefined;
const BUILDER_ACTIVITY="'reservation','start-attempt','native-start-attempt','session-continuation','worker-cleanup','worker-exit','worker-halt','worker-failure'";
// Claim refusals that are a limit doing its job. Anything else is not a limit.
const LIMIT_REFUSALS:[RegExp,LimitKind][]=[[/usage stop|high benefit only/,'usage-stop'],[/usage window missing/,'usage-window-missing'],[/worker unqualified/,'worker-unqualified'],[/disk admission refused/,'disk-refused'],[/wallet empty/,'wallet-stop']];

function usageLimit(error:string,readings:Reading[],gate:number,now:number):IdleLimit|null {
 if(/usage window missing/.test(error))return {kind:'usage-window-missing'};
 // A stale or unknown reading is missing evidence, not a limit.
 if(!/usage stop|high benefit only/.test(error))return null;
 const resets=readings.flatMap(r=>r?.windows??[]).filter(w=>w.used>=gate&&Number.isSafeInteger(w.resetsAt)&&w.resetsAt>now).map(w=>w.resetsAt);
 return {kind:'usage-stop',...(resets.length?{until:Math.max(...resets)}:{}),...(/high benefit only/.test(error)?{detail:'high-benefit work only'}:{})};
}
// Ready work that no builder took: a limit explains it only when every refusal this tick was a limit.
function claimLimit(h:NonNullable<Heartbeat>,readings:Record<string,Reading>|null,c:Config,now:number):IdleLimit|null {
 if(h.claimed!==0||!Array.isArray(h.refusals)||!h.refusals.length)return null;
 const byKind=new Map<LimitKind,string[]>();
 for(const r of h.refusals){
  const reason=String(r?.reason??''),kind=LIMIT_REFUSALS.find(([pattern])=>pattern.test(reason))?.[1];
  if(!kind)return null;
  byKind.set(kind,[...(byKind.get(kind)??[]),reason]);
 }
 const [kind,reasons]=[...byKind].sort((a,b)=>b[1].length-a[1].length)[0]!;
 if(kind!=='usage-stop')return {kind};
 const highOnly=reasons.every(r=>/high benefit only/.test(r));
 return usageLimit(highOnly?'high benefit only':'usage stop',Object.values(readings??{}),highOnly?c.usage_gates.admit_below:c.usage_gates.stop_at,now);
}
// The first pause after the last resume: a repeated pause call does not move the start.
function pauseLimit(db:Reader,now:number):IdleLimit {
 const resume=db.query("SELECT rowid AS n FROM events WHERE kind='resume' AND at<=? ORDER BY rowid DESC LIMIT 1").get(now) as {n:number}|null;
 const pause=db.query("SELECT at,data FROM events WHERE kind='pause' AND at<=? AND rowid>? ORDER BY rowid LIMIT 1").get(now,resume?.n??0) as {at:number;data:string}|null;
 let setBy:string|undefined;
 try{const d=pause?JSON.parse(pause.data):null;if(d?.ownerSupplied===true&&typeof d.owner==='string')setBy=d.owner.slice(0,40);}catch{/* An unreadable pause record names nobody. */}
 return {kind:'paused',...(pause&&Number.isSafeInteger(pause.at)&&pause.at>0?{since:pause.at}:{}),...(setBy?{setBy}:{})};
}
// Read from the small completion and result records only; a wake's own row carries its whole backlog view.
function intakeOutcome(db:Reader,since:number):string {
 const done=db.query("SELECT data FROM events WHERE kind='owner-wake-complete' AND id GLOB 'owner-complete:intake:*' ORDER BY at DESC,rowid DESC LIMIT 1").get() as {data:string}|null;
 if(!done)return 'has not finished a run';
 const last=JSON.parse(done.data) as {id:string;ok?:boolean};
 if(last.ok!==true)return 'did not finish its last run';
 const row=db.query('SELECT value FROM kv WHERE key=?').get(`owner-result:${last.id}`) as {value:string}|null;
 if(!row)return 'has a result the launcher has not applied yet';
 if(JSON.parse(row.value).applied===false){
  const refused=db.query("SELECT data FROM events WHERE kind='owner-result-refused' AND json_extract(data,'$.id')=? ORDER BY at DESC LIMIT 1").get(last.id) as {data:string}|null;
  return `had its last result refused by the launcher: ${String(refused?JSON.parse(refused.data).error:'reason not recorded').slice(0,160)}`;
 }
 if(db.query('SELECT 1 FROM kv WHERE key=?').get(`proposal:${last.id}:0`))return 'proposed tasks but none is ready to claim';
 const runs=(db.query("SELECT COUNT(*) AS n FROM events WHERE kind='owner-wake-complete' AND id GLOB 'owner-complete:intake:*' AND at>?").get(since) as {n:number}).n;
 return runs>1?`returned no tasks; ${runs} runs since the queue emptied`:'returned no tasks';
}
// This observer never changes controller custody. Reviews and owner turns do not
// count as builder progress. Unknown dormant custody cannot establish idleness.
export function observeIdleQueue(db:Reader,c:Config,now:number):IdleQueueObservation {
 const get=<T>(key:string):T|null=>{const r=db.query('SELECT value FROM kv WHERE key=?').get(key) as {value:string}|null;return r?JSON.parse(r.value):null;};
 const no=(reason:string,observationUnavailable=false):IdleQueueObservation=>({at:now,eligible:false,reason,lastActivity:now,heartbeatAt:now,...(observationUnavailable?{observationUnavailable:true}:{})});
 // Actual builder start/cleanup receipts survive observer restarts. Maintenance
 // challenge starts are intentionally absent from this query.
 const lastBuilt=()=>{const r=db.query(`SELECT MAX(at) AS at FROM events WHERE kind IN (${BUILDER_ACTIVITY}) AND at<=?`).get(now) as {at:number|null};return Number.isSafeInteger(r.at)&&r.at!>0?r.at!:null;};
 // A limit explains an idle factory only while no builder is running.
 const byLimit=(reason:string,ready:number|null,limit:IdleLimit|null):IdleQueueObservation=>{
  const base={...no(reason),ready};
  if(!limit||db.query("SELECT id FROM sessions WHERE status IN ('starting','running') LIMIT 1").get())return base;
  const since=lastBuilt();return {...base,limit,...(since===null?{}:{idleSince:since})};
 };
 const paused=get('paused'),latest=get<Heartbeat>('heartbeat');
 if(paused!==false){
  if(paused!==true)return no('paused');
  const p=latest?.status==='ok'?latest:get<Heartbeat>('last-successful-heartbeat');
  const ready=p&&p.status==='ok'&&Number.isSafeInteger(p.at)&&p.at>0&&p.at<=now&&now-p.at<=15*MINUTE&&Number.isSafeInteger(p.ready)?p.ready!:null;
  return byLimit('paused',ready,pauseLimit(db,now));
 }
 const h=latest?.status==='reconciling'?get<Heartbeat>('last-successful-heartbeat'):latest;
 if(!h||h.status!=='ok'||!Number.isSafeInteger(h.at)||h.at<=0||h.at>now||now-h.at>300000)return no('queue not freshly confirmed empty',true);
 if(Number.isSafeInteger(h.ready)&&h.ready!>0)return byLimit('queue has ready work',h.ready!,claimLimit(h,get<Record<string,Reading>>('readings'),c,now));
 if(h.ready!==0)return no('queue not freshly confirmed empty',true);
 for(const project of Object.values(c.projects)){
  const inventory=get<{observedAt:number;count?:number;truncated?:boolean;error?:string|null}>(`github:${project.repo}`);
  if(!inventory||inventory.error||inventory.truncated!==false||!Number.isSafeInteger(inventory.count)||inventory.count!<0||!Number.isSafeInteger(inventory.observedAt)||inventory.observedAt<=0||inventory.observedAt>h.at||now-inventory.observedAt>300000)return no('complete fresh project inventory unavailable',true);
 }
 const sessions=db.query("SELECT id,status,pid FROM sessions WHERE status!='archived' LIMIT 10001").all() as {id:string;status:string;pid:number|null}[];
 if(sessions.length>10000)return no('session inventory truncated');
 for(const x of sessions){
  if(!['finished','paused','waiting-browser','waiting-person','waiting-question','question'].includes(x.status)||x.pid!==null||get<{verified:boolean}>(`cleanup-evidence:${x.id}`)?.verified!==true)return no('builder active or custody unknown');
 }
 const provider=c.owners[c.autonomy?.intake_owner??'product']?.harness;
 if(!provider)return no('product provider unavailable');
 const reading=get<Record<string,Reading>>('readings')?.[provider];
 try{usageGate(reading,true,now,c,provider);}catch(error){return byLimit('usage does not allow work',0,usageLimit(String(error),[reading],c.usage_gates.stop_at,now));}
 const activity=lastBuilt();
 if(activity===null)return no('builder history unavailable');
 return {at:now,eligible:true,reason:'empty queue and stopped builders; high-benefit usage allowed',lastActivity:activity,heartbeatAt:h.at,ready:0,intake:intakeOutcome(db,activity)};
}

export function openIdleState(path:string):Database {
 const state=new Database(path,{create:true,strict:true});
 state.exec(`PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS observations(at INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,opened INTEGER NOT NULL,queued INTEGER,wake TEXT,evidence TEXT); CREATE TABLE IF NOT EXISTS observation_gap(id INTEGER PRIMARY KEY,since INTEGER NOT NULL,ended INTEGER);
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,at INTEGER NOT NULL,recipient TEXT NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,queued INTEGER,delivery TEXT,wake TEXT);
  CREATE TABLE IF NOT EXISTS gap_rule(id INTEGER PRIMARY KEY,since INTEGER NOT NULL,rule TEXT NOT NULL,tripped INTEGER NOT NULL,ended INTEGER);`);
 if(!(state.query('PRAGMA table_info(incidents)').all() as {name:string}[]).some(x=>x.name==='evidence'))state.exec('ALTER TABLE incidents ADD COLUMN evidence TEXT');
 return state;
}
const zoned=(at:number,timeZone:string)=>{
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(x=>[x.type,x.value]));
 return {day:`${p.year}-${p.month}-${p.day}`,clock:`${p.hour}:${p.minute}`,weekday:String(p.weekday)};
};
/** "15:16" on the same Toronto day, otherwise "Thursday 03:00". */
const when=(at:number,now:number,timeZone:string)=>{const t=zoned(at,timeZone);return t.day===zoned(now,timeZone).day?t.clock:`${t.weekday} ${t.clock}`;};
function causeInWords(o:IdleQueueObservation,timeZone:string):string {
 const l=o.limit,ready=Number.isSafeInteger(o.ready)&&o.ready!>0?`${o.ready} ready`:'';
 if(!l)return o.intake?`queue empty, intake ${o.intake}`:'queue empty';
 if(l.kind==='paused')return `paused${l.since?` since ${when(l.since,o.at,timeZone)}`:''}${Number.isSafeInteger(o.ready)?` with ${o.ready} ready`:''}`;
 return `${LIMIT_KINDS[l.kind].what}${l.detail?` (${l.detail})`:''}${l.until?` until ${when(l.until,o.at,timeZone)}`:''}${ready?`, ${ready}`:''}`;
}

// The changed observation-gap rule. One reading every five minutes can lose
// evidence on and off for hours without ever being unavailable for twenty
// minutes in a row. This counts loss inside any hour, and an episode ends only
// after a full hour without the rule tripping.
function gapRule(state:Database,now:number) {
 const g=IDLE_RULES.gap,from=now-g.window;
 const rows=(state.query('SELECT at,json FROM observations WHERE at>=? AND at<=? ORDER BY at').all(from-g.longestReading,now) as {at:number;json:string}[]).map(r=>({at:r.at,unavailable:JSON.parse(r.json).observationUnavailable===true}));
 let lost=0,inARow=0,first:number|null=null;
 rows.forEach((r,i)=>{
  inARow=r.unavailable?inARow+1:0;
  if(!r.unavailable)return;
  if(r.at>=from)first??=r.at;
  const next=rows[i+1];
  // A reading stands until the next one, but never for longer than two missed runs.
  if(next)lost+=Math.max(0,Math.min(next.at,r.at+g.longestReading)-Math.max(r.at,from));
 });
 const rule=inARow>=g.consecutive?`${g.consecutive} readings in a row`:lost>=g.unavailable?'20 minutes in an hour':null;
 const open=state.query('SELECT id,since,tripped FROM gap_rule WHERE ended IS NULL ORDER BY id LIMIT 1').get() as {id:number;since:number;tripped:number}|null;
 if(rule){
  if(open){state.query('UPDATE gap_rule SET tripped=? WHERE id=?').run(now,open.id);return {since:open.since,rule};}
  state.query('INSERT INTO gap_rule(id,since,rule,tripped) VALUES(?,?,?,?)').run(now,first??now,rule,now);return {since:first??now,rule};
 }
 if(open&&now-open.tripped>=g.window){state.query('UPDATE gap_rule SET ended=? WHERE id=?').run(now,open.id);return null;}
 return open?{since:open.since,rule:null}:null;
}

export type IdleSettings={timezone:string;gapRuleActs:boolean};
export type IdleRepeat={id:string;episode:string;step:number;idleSince:number;firstAlarmAt:number;refusal:string;previousWake:string|null};
export type IdleRepeatOutcome={wake:string|null;note?:string};
export type IdleStep={alert:string|null;repeat:(IdleRepeat&IdleRepeatOutcome)|null;repeatError:string|null;limit:string|null;notices:string[];gapRule:string|null};
/**
 * Applies one observation to the watcher's own state file: first alarm,
 * repeats, 'idle by limit' records, the pause question and Vincent's line. It
 * opens no controller and no mail. `queue` is asked for one intake wake per due
 * repeat; if it throws nothing is recorded, so the next run asks again.
 */
export function advanceIdleQueue(state:Database,o:IdleQueueObservation,settings:IdleSettings,queue?:(repeat:IdleRepeat)=>IdleRepeatOutcome):IdleStep {
 const now=o.at,notices:string[]=[];
 const record=(id:string,kind:string,json:unknown)=>state.query('INSERT OR IGNORE INTO records(id,at,kind,json) VALUES(?,?,?,?)').run(id,now,kind,JSON.stringify(json)).changes===1;
 const notice=(id:string,recipient:string,summary:string,body:string)=>{if(state.query('INSERT OR IGNORE INTO notices(id,at,recipient,summary,body) VALUES(?,?,?,?,?)').run(id,now,recipient,summary.length>120?summary.slice(0,119)+'…':summary,body.slice(0,800)).changes===1)notices.push(id);};
 state.query('INSERT OR IGNORE INTO observations VALUES(?,?)').run(now,JSON.stringify(o));
 // Unknown is a monitoring failure, never proof of an empty queue. Persist
 // one episode across changing freshness reasons, process exits and restarts.
 const priorGap=state.query('SELECT since FROM observation_gap WHERE ended IS NULL ORDER BY since LIMIT 1').get() as {since:number}|null;
 if(o.observationUnavailable&&!priorGap)state.query('INSERT INTO observation_gap(id,since) VALUES(?,?)').run(now,now);
 else if(!o.observationUnavailable)state.query('UPDATE observation_gap SET ended=? WHERE ended IS NULL').run(now);
 const gap=o.observationUnavailable?(priorGap??{since:now}):null;
 const continuous=gap&&now-gap.since>20*MINUTE?`factory-queue-observation:${gap.since}`:null;
 // The changed rule is always computed and recorded. It may send only once an
 // operator has flipped its switch; until then today's rule above still sends.
 const changed=gapRule(state,now);
 const unknown=settings.gapRuleActs?(changed?`factory-queue-observation:${changed.since}`:null):continuous;
 const idle=o.eligible&&now-o.lastActivity>IDLE_RULES.alarmAfter?`factory-idle-queue:${o.lastActivity}`:null;
 for(const id of [unknown,idle])if(id)state.query('INSERT OR IGNORE INTO incidents(id,opened,evidence) VALUES(?,?,?)').run(id,now,JSON.stringify({source:'watcher',observation:o}));

 // Repeats: only while the first alarm's own conditions still hold (queue
 // empty, builders stopped, not paused, usage allowed). No mail per repeat.
 let repeat:IdleStep['repeat']=null,repeatError:string|null=null;
 if(idle){
  const first=(state.query('SELECT opened FROM incidents WHERE id=?').get(idle) as {opened:number}).opened;
  const earlier=state.query("SELECT COUNT(*) AS n,MAX(at) AS last FROM records WHERE kind='repeat' AND json_extract(json,'$.episode')=?").get(idle) as {n:number;last:number|null};
  const today=(state.query("SELECT COUNT(*) AS n FROM records WHERE kind='repeat' AND at>?").get(now-24*HOUR) as {n:number}).n;
  const due=earlier.last===null?first+IDLE_RULES.firstRepeatAfter:earlier.last+IDLE_RULES.repeatEvery;
  if(now>=due&&today<IDLE_RULES.repeatsPerDay){
   const previous=state.query("SELECT json_extract(json,'$.wake') AS wake FROM records WHERE kind='repeat' AND json_extract(json,'$.wake') IS NOT NULL ORDER BY at DESC LIMIT 1").get() as {wake:string}|null;
   const candidate:IdleRepeat={id:`${idle}:repeat:${earlier.n+1}`,episode:idle,step:earlier.n+1,idleSince:o.lastActivity,firstAlarmAt:first,refusal:o.intake??'outcome not recorded',previousWake:previous?.wake??null};
   try{
    const outcome=queue?queue(candidate):{wake:null,note:'no wake queue supplied'};
    record(candidate.id,'repeat',{...candidate,...outcome});repeat={...candidate,...outcome};
   }catch(error){repeatError=String(error);}
  }
 }

 // How long, and why, whatever the cause. A limit is named and timed here;
 // nothing below resumes, lifts or works round it.
 const limit=o.limit??null;
 let since:number|null=o.eligible?o.lastActivity:null,limitRecord:string|null=null;
 if(limit){
  limitRecord=`idle-by-limit:${limit.kind}:${limit.since??limit.until??o.idleSince??zoned(now,settings.timezone).day}`;
  record(limitRecord,'idle-by-limit',{status:'idle by limit',limit:limit.kind,what:LIMIT_KINDS[limit.kind].what,since:limit.since??null,until:limit.until??null,setBy:limit.kind==='paused'?limit.setBy??'not recorded':null,detail:limit.detail??null,ready:o.ready??null,idleSince:o.idleSince??null,effect:'no repeat alarm and no intake wake while this limit explains the idle'});
  const seen=(state.query('SELECT at FROM records WHERE id=?').get(limitRecord) as {at:number}).at;
  since=o.idleSince??limit.since??seen;
  if(limit.kind==='paused'&&Number.isSafeInteger(o.ready)&&o.ready!>0){
   const paused=limit.since??seen,quiet=Math.max(paused,since);
   if(now>=limitReviewAt('paused',quiet))notice(pausedWithReadyActionId(paused),actionRole({kind:'limit-review'}),
    `Factory ${causeInWords(o,settings.timezone)} and nothing running. Is this pause still intended?`,
    `Paused at ${new Date(paused).toISOString()}${limit.setBy?` by ${limit.setBy}`:'; who set it is not recorded'}. No builder has run since at least ${new Date(quiet).toISOString()}. This asks only whether the pause is still intended. It does not resume the factory or change any limit; resuming stays with the normal owner control. If nothing changes, Vincent is told once the idle reaches 2 hours. Evidence: health/idle-queue.sqlite, record ${limitRecord}.`);
  }
 }
 if(since!==null&&now-since>=IDLE_RULES.ownerLineAfter){
  // One a day for a cause: the id carries the Toronto day, and a long idle is
  // named again 24 hours after its last line, not at midnight.
  const id=ownerMessageId({tier:'routine',kind:'idle',subject:limit?.kind??'queue-empty',day:zoned(now,settings.timezone).day});
  if(!state.query('SELECT 1 FROM notices WHERE substr(id,1,?)=? AND at>?').get(id.length-10,id.slice(0,-10),now-24*HOUR))notice(id,'Vincent',`Idle ${Math.floor((now-since)/HOUR)} h: ${causeInWords(o,settings.timezone)}.`,'');
 }
 return {alert:idle??unknown,repeat,repeatError,limit:limitRecord,notices,gapRule:changed?.rule??null};
}

// One intake wake of the existing kind, so the launcher applies its intake.json
// as it does any other. The wake reuses the newest ordinary intake's view of
// the backlog and adds why the queue is still empty.
function queueIntakeRepeat(dir:string,c:Config,r:IdleRepeat,now:number):IdleRepeatOutcome {
 const policy=c.autonomy;
 if(!policy)return {wake:null,note:'intake is not configured'};
 const s=new Store(join(dir,'controller.sqlite'));
 try{return s.atomic(()=>{
  if(s.get('paused')!==false)return {wake:null,note:'paused before the wake could be queued'};
  const earlier=r.previousWake?s.get<{state?:string}>(`owner-wake:${r.previousWake}`)?.state:undefined;
  if(earlier&&['queued','starting','running'].includes(earlier))return {wake:null,note:`the earlier repeat wake is still ${earlier}`};
  const round=s.get<{wake?:string;at?:number}>('intake-round'),prior=round?.wake?s.get<Wake>(`owner-wake:${round.wake}`):null;
  const reuse=!!prior&&prior.kind==='product-intake'&&prior.owner===policy.intake_owner&&typeof prior.payload==='object'&&prior.payload!==null&&Number.isSafeInteger(round!.at)&&now-round!.at!<=IDLE_RULES.intakeContextMaxAge;
  const name=`idle-repeat:${r.idleSince}:${r.step}`,id=`intake:${name}`;
  const idleRepeat={step:r.step,idleSince:r.idleSince,firstAlarmAt:r.firstAlarmAt,lastIntake:r.refusal,context:reuse?{from:round!.wake,at:round!.at}:null,
   note:`The queue has been empty with builders stopped since ${new Date(r.idleSince).toISOString()}. The last intake ${r.refusal}. Propose runnable work under the current intake policy, or return an empty intake.`};
  queueWake(s,{id,owner:policy.intake_owner,kind:'product-intake',payload:{...(reuse?prior!.payload as object:{intake_mode:policy.intake_mode,projects:c.projects,policy:policy.auto_approval}),round:name,ready:0,idleSince:r.idleSince,refusals:[],occupied:[],idleRepeat}},now);
  return {wake:id};
 });}finally{s.close();}
}
// What became of each repeat's wake, read back so the record shows it: when it
// was dispatched, how it ended and the ready count afterwards. The controller
// is only read here; the watcher's own file is written after it is closed.
type OpenRepeat={id:string;record:{wake:string}};
const openRepeats=(state:Database,now:number):OpenRepeat[]=>(state.query("SELECT id,json FROM records WHERE kind='repeat' AND at>? AND json_extract(json,'$.wake') IS NOT NULL AND json_extract(json,'$.settled') IS NULL").all(now-48*HOUR) as {id:string;json:string}[]).map(r=>({id:r.id,record:JSON.parse(r.json)}));
function readRepeatWakes(controller:Reader,open:OpenRepeat[]) {
 return open.map(({id,record})=>{
  const wake=controller.query("SELECT json_extract(value,'$.state') AS state FROM kv WHERE key=?").get(`owner-wake:${record.wake}`) as {state:string|null}|null;
  const dispatched=controller.query('SELECT at FROM events WHERE id=?').get(`owner-dispatch:${record.wake}`) as {at:number}|null;
  const result=controller.query('SELECT value FROM kv WHERE key=?').get(`owner-result:${record.wake}`) as {value:string}|null;
  return {id,record,wakeState:wake?.state??'missing',dispatchedAt:dispatched?.at??null,result:result?JSON.parse(result.value) as unknown:null};
 });
}
function recordRepeatWakes(state:Database,read:ReturnType<typeof readRepeatWakes>,now:number,ready:number|null) {
 for(const {id,record,...seen} of read){
  const settled=seen.result!==null||['blocked','expired'].includes(seen.wakeState);
  state.query('UPDATE records SET json=? WHERE id=?').run(JSON.stringify({...record,...seen,...(settled?{settled:now,readyAfter:ready}:{})}),id);
 }
}
// Queue only: a row is delivered when Alido Mail says so, read back here on every run.
function deliverIdleMail(state:Database,mail:string,now:number,current:string|null) {
 const pending=state.query('SELECT id,evidence FROM incidents WHERE wake IS NULL ORDER BY opened LIMIT 100').all() as {id:string;evidence:string|null}[];
 const notices=state.query('SELECT id,recipient,summary,body FROM notices WHERE wake IS NULL AND at>? ORDER BY at LIMIT 100').all(now-7*24*HOUR) as {id:string;recipient:string;summary:string;body:string}[];
 if(!pending.length&&!notices.length){const prior=current?state.query('SELECT wake FROM incidents WHERE id=?').get(current) as {wake:string|null}|null:null;return {alert:current,wake:prior?.wake??null};}
 if(!existsSync(mail))throw Error('existing Alido Mail bridge unavailable');
 const bridge=new Database(mail,{readwrite:true,strict:true});
 try{
  bridge.exec('PRAGMA busy_timeout=1000');
  const insert=(id:string,recipient:string,app:string,kind:string,summary:string,body:string)=>{
   const hash=createHash('sha256').update(summary+'\n'+body).digest('hex');
   bridge.query(`INSERT OR IGNORE INTO messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,summary,body,thread_id,depth,hash,state,wake_state) VALUES(?,?,?,'Factory Desk','codex','factory-idle-queue',?,?,?,'none',?,?,?,0,?,'unread','pending')`).run(id,id,now,recipient,app,kind,summary,body,id,hash);
   return {hash,row:bridge.query('SELECT kind,hash,wake_state,wake_id FROM messages WHERE id=?').get(id) as {kind:string;hash:string;wake_state:string;wake_id:string|null}|null};
  };
  let alert:string|null=current,wake:string|null=current?(state.query('SELECT wake FROM incidents WHERE id=?').get(current) as {wake:string|null}|null)?.wake??null:null;
  for(const incident of pending){
   if(!incident.evidence)throw Error('retained idle incident needs original evidence; do not manufacture an observation');
   JSON.parse(incident.evidence);
   const id=incident.id;
   const unknown=id.startsWith('factory-queue-observation:');
   const summary=unknown?'Factory queue observation has been unavailable for over 20 minutes. Supply and builder activity need checking.':'Factory had an empty queue and idle builders for over 20 minutes while usage allowed high-benefit work.';
   const body=unknown?'Restore fresh complete queue evidence and verify useful product supply and actual builder claims. Unknown queue evidence cannot establish healthy operation or an empty queue. Retained incident evidence is in health/idle-queue.sqlite.':'Restore useful product-only supply and verify actual builder claims. If work has resumed, confirm the product-only top-up remains loaded. Retained incident evidence is in health/idle-queue.sqlite.';
   const {hash,row}=insert(id,'Coordinator','claude','action',summary,body);
   if(row?.kind!=='action'||row.hash!==hash)throw Error('idle alert identity conflicts; retain for reconciliation');
   state.query('UPDATE incidents SET queued=COALESCE(queued,?),wake=? WHERE id=?').run(now,row.wake_state==='woken'?row.wake_id:null,id);
   alert=id;wake=row.wake_state==='woken'?row.wake_id:null;
  }
  // These ids come from the loop contract, so another writer may already have
  // raised the same condition; its row then stands and no second one is added.
  for(const n of notices){
   const vincent=n.recipient==='Vincent',{row}=insert(n.id,n.recipient,vincent?'telegram':'codex',vincent?'fyi':'action',n.summary,n.body);
   state.query('UPDATE notices SET queued=COALESCE(queued,?),delivery=?,wake=? WHERE id=?').run(now,row?.wake_state??null,row?.wake_state==='woken'?row.wake_id:null,n.id);
  }
  return {alert,wake};
 }finally{bridge.close();}
}

export function watchIdleQueue(dir:string,mail:string,now=Date.now()) {
 const c=ConfigSchema.parse(Bun.YAML.parse(readFileSync(join(dir,'config.yaml'),'utf8')));
 const flags=readLoopFlags(dir);
 mkdirSync(join(dir,'health'),{recursive:true,mode:0o700});
 const state=openIdleState(join(dir,'health','idle-queue.sqlite'));
 try{
  const open=openRepeats(state,now),controller=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
  let observation:IdleQueueObservation,wakes:ReturnType<typeof readRepeatWakes>;
  try{controller.exec('PRAGMA busy_timeout=1000; BEGIN');observation=observeIdleQueue(controller,c,now);wakes=readRepeatWakes(controller,open);}finally{controller.close();}
  recordRepeatWakes(state,wakes,now,observation.ready??null);
  // The controller is written only here, and only to queue one intake wake for a due repeat.
  const step=advanceIdleQueue(state,observation,{timezone:c.timezone,gapRuleActs:loopActing(flags,'idle-observation-gap')},repeat=>queueIntakeRepeat(dir,c,repeat,now));
  return {...observation,...deliverIdleMail(state,mail,now,step.alert),repeat:step.repeat,...(step.repeatError?{repeatError:step.repeatError}:{}),idleByLimit:step.limit,notices:step.notices,gapRule:step.gapRule,...(flags.alarm?{switchAlarm:flags.alarm}:{})};
 }finally{state.close();}
}

/** Runs stored observations through the rules on a scratch state. Sends nothing, queues nothing, opens no controller. */
export function replayIdleObservations(observations:IdleQueueObservation[],settings:IdleSettings) {
 const state=openIdleState(':memory:');
 try{
  const wakes:{at:number;id:string}[]=[];
  for(const o of observations)advanceIdleQueue(state,o,settings,r=>{const wake=`intake:idle-repeat:${r.idleSince}:${r.step}`;wakes.push({at:o.at,id:wake});return {wake};});
  return {
   wakes,
   alarms:state.query('SELECT id,opened FROM incidents ORDER BY opened').all() as {id:string;opened:number}[],
   records:(state.query('SELECT id,at,kind,json FROM records ORDER BY at').all() as {id:string;at:number;kind:string;json:string}[]).map((r):Record<string,unknown>&{id:string;at:number;kind:string}=>({...JSON.parse(r.json),id:r.id,at:r.at,kind:r.kind})),
   notices:state.query('SELECT id,at,recipient,summary,body FROM notices ORDER BY at').all() as {id:string;at:number;recipient:string;summary:string;body:string}[],
   gapEpisodes:state.query('SELECT since,rule,id AS opened,ended FROM gap_rule ORDER BY id').all() as {since:number;rule:string;opened:number;ended:number|null}[],
  };
 }finally{state.close();}
}
// `bun launcher/idle-queue.ts --replay <copy of idle-queue.sqlite> [timezone]` replays the stored
// observations of a private copy and prints what the idle rules and each observation-gap rule
// would have done. Read-only: it sends nothing and queues nothing. Attach the output as the
// parity report before the idle-observation-gap switch is flipped.
if(import.meta.main){
 const [flag,path,timezone='America/Toronto']=process.argv.slice(2);
 if(flag!=='--replay'||!path)throw Error('idle-queue --replay <copy of idle-queue.sqlite> [timezone]');
 const stored=new Database(path,{readonly:true,strict:true});
 try{
  const observations=(stored.query('SELECT json FROM observations ORDER BY at').all() as {json:string}[]).map(r=>JSON.parse(r.json) as IdleQueueObservation);
  const recordOnly=replayIdleObservations(observations,{timezone,gapRuleActs:false}),acting=replayIdleObservations(observations,{timezone,gapRuleActs:true});
  const stamp=(at:number|null)=>at===null?null:new Date(at).toISOString(),gapAlarm=(a:{id:string})=>a.id.startsWith('factory-queue-observation:');
  console.log(JSON.stringify({observations:observations.length,from:stamp(observations[0]?.at??null),to:stamp(observations.at(-1)?.at??null),
   recordedGaps:(stored.query('SELECT since,ended FROM observation_gap ORDER BY since').all() as {since:number;ended:number|null}[]).map(g=>({since:stamp(g.since),ended:stamp(g.ended),minutes:g.ended===null?null:Math.round((g.ended-g.since)/MINUTE)})),
   todaysRuleWouldSend:recordOnly.alarms.filter(gapAlarm).map(a=>stamp(a.opened)),
   changedRuleWouldSend:acting.gapEpisodes.map(e=>({since:stamp(e.since),opened:stamp(e.opened),rule:e.rule,ended:stamp(e.ended)})),
   idle:{firstAlarms:recordOnly.alarms.filter(a=>!gapAlarm(a)).map(a=>stamp(a.opened)),repeatWakes:recordOnly.wakes.map(w=>stamp(w.at)),
    limits:recordOnly.records.filter(r=>r.kind==='idle-by-limit').map(r=>({at:stamp(r.at),limit:r.limit})),notices:recordOnly.notices.map(n=>({at:stamp(n.at),to:n.recipient,id:n.id,summary:n.summary}))},
  },null,1));
 }finally{stored.close();}
}
