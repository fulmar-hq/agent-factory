import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {releaseIncident,reconcileReleaseIncidents} from '../launcher/release-incident';
const at=(day:string,time:string)=>Date.parse(day+'T'+time+':00-05:00');
function report(s:Store,day:string,time:string,missing:{input:string;reason:string}[],kind='release-rehearsal'){
 const r={day,at:at(day,time),validThrough:at(day,'22:30'),ready:missing.length===0,missing,evidence:{}};
 s.event(`report:${day}:${time}`,kind,r,'fixture',r.at);if(time==='19:00')s.set(`release-preflight-report:${day}`,r);else s.set(`release-rehearsal:${day}:${time}`,r);
}
test('Monday and Tuesday conditions name early knowability and a second consecutive missed night, with one mail/night',()=>{
 const s=new Store(':memory:'),mails=new Map<string,string>(),send=(id:string,to:string,summary:string,body:string)=>{const value=JSON.stringify([to,summary,body]);expect(mails.get(id)??value).toBe(value);mails.set(id,value);return {id,queued:true};};
 try{
 for(const [day,gaps] of [['2026-11-09',[{input:'fresh billing',reason:'wallet billing unknown'}]],['2026-11-10',[{input:'fresh billing',reason:'aws not found under installed PATH'},{input:'release usage',reason:'70% gate'},{input:'hosted acceptance path',reason:'installed source changed'}]]] as const){
  report(s,day,'14:00',[...gaps]);report(s,day,'19:00',[...gaps],'release-readiness');
  const incident=releaseIncident(s,day,at(day,'19:01'),send);expect(incident.queued).toBe(true);releaseIncident(s,day,at(day,'22:30'),send);
 }
 expect(mails.size).toBe(2);expect([...mails.values()][0]).toContain('14:00');expect([...mails.values()][1]).toContain('2 consecutive missed nights');expect([...mails.values()][1]).toContain('release usage');
 expect((s.get<any>('release-incident:2026-11-10')).gaps.every((g:any)=>g.knownBy===at('2026-11-10','14:00'))).toBe(true);
 }finally{s.close();}
});
test('missing scheduled invocation becomes knowable after its minute; watcher restart recovers historical evidence',()=>{
 const s=new Store(':memory:'),mails=new Set<string>(),send=(id:string)=>{mails.add(id);return {id,queued:true};};
 try{report(s,'2026-11-11','14:00',[]);expect(releaseIncident(s,'2026-11-11',at('2026-11-11','19:00'),send).queued).toBe(false);releaseIncident(s,'2026-11-11',at('2026-11-11','19:01'),send);expect((s.get<any>('release-incident:2026-11-11')).gaps[0].knownBy).toBe(at('2026-11-11','19:01'));reconcileReleaseIncidents(s,at('2026-11-12','12:00'),send);expect(mails.size).toBe(1);expect(s.db.query('SELECT count(*) AS n FROM debits').get()).toEqual({n:0});}finally{s.close();}
});
test('failed alert retries the original incident payload; unrecorded earlier knowability is never invented',()=>{
 const s=new Store(':memory:');try{report(s,'2026-11-11','19:00',[{input:'AWS sign-in',reason:'expired'}],'release-readiness');expect(()=>releaseIncident(s,'2026-11-11',at('2026-11-11','19:01'),()=>{throw Error('mail offline');})).toThrow('offline');let body='';releaseIncident(s,'2026-11-11',at('2026-11-11','21:31'),(id,to,summary,text)=>{body=text;return {id,queued:true};});expect(body).toContain('19:00');expect(body).not.toContain('14:00');}finally{s.close();}
});

test('a CLI refusal is escalated immediately and an unchanged reconciliation adds no diary event',()=>{
 const s=new Store(':memory:'),send=(id:string)=>({id,queued:true}),day='2026-11-11';
 try{s.event('executor-cli:'+day+':qa:missing-command','release-executor-refusal',{stage:'qa',error:'aws not found'},'fixture',at(day,'20:00'));expect(releaseIncident(s,day,at(day,'20:00'),send).queued).toBe(true);const before=s.db.query("SELECT count(*) AS n FROM events WHERE kind='release-incident'").get();releaseIncident(s,day,at(day,'20:00')+1000,send);expect(s.db.query("SELECT count(*) AS n FROM events WHERE kind='release-incident'").get()).toEqual(before);expect((s.get<any>('release-incident:'+day)).gaps[0].reason).toBe('aws not found');}finally{s.close();}
});

test('a rehearsal error or refused off-schedule attempt is not a missed release night',()=>{
 const s=new Store(':memory:'),day='2026-11-11',send=()=>{throw Error('must not mail');};
 try{s.event('executor-cli:'+day+':rehearsal:failure','release-executor-refusal',{stage:'rehearsal',error:'missing input'},'fixture',at(day,'14:00'));s.event('off-hour','release-executor',{day,kind:'refused:qa outside window',data:{reason:'qa outside window'}},'fixture',at(day,'14:00'));s.set('executor:'+day+':preflight',{state:'running'});expect(releaseIncident(s,day,at(day,'19:01'),send).queued).toBe(false);}finally{s.close();}
});

test('a resolved rehearsal gap is not blamed for a later QA failure, whose real observation time is retained',()=>{
 const s=new Store(':memory:'),day='2026-11-11',send=(id:string)=>({id,queued:true});
 try{report(s,day,'14:00',[{input:'fresh billing',reason:'temporarily stale'}]);report(s,day,'17:40',[]);report(s,day,'19:00',[],'release-readiness');s.set('executor:'+day+':preflight',{state:'success'});s.set('executor:'+day+':qa',{state:'failure',context:{day,revision:'a'.repeat(40),tree:'b'.repeat(40),deadline:at(day,'21:20')},evidence:{reason:'QA workflow failed'}});s.event('executor:'+day+':qa:failure','release-executor',{day,kind:'qa:failure'},'fixture',at(day,'20:20'));releaseIncident(s,day,at(day,'20:21'),send);const incident=s.get<any>('release-incident:'+day);expect(incident.gaps).toEqual([{input:'QA window',reason:'QA workflow failed',knownBy:at(day,'20:20'),basis:'recorded observation'}]);expect(incident.body).not.toContain('billing');}finally{s.close();}
});

test('an outbox failure on an older night cannot suppress recording the other missed nights',()=>{
 const s=new Store(':memory:');try{for(const day of ['2026-11-09','2026-11-10','2026-11-11'])report(s,day,'19:00',[{input:'fresh billing',reason:'missing'}],'release-readiness');const results=reconcileReleaseIncidents(s,at('2026-11-11','22:30'),()=>{throw Error('outbox unavailable');});expect(results).toHaveLength(3);for(const day of ['2026-11-09','2026-11-10','2026-11-11'])expect(s.get('release-incident:'+day)).not.toBeNull();}finally{s.close();}
});

test('the Monday pause is first knowable when set at 20:45, not when Production refuses at 21:30',()=>{
 const s=new Store(':memory:'),day='2026-11-09';try{report(s,day,'14:00',[{input:'fresh billing',reason:'wallet billing unknown'}]);report(s,day,'19:00',[{input:'fresh billing',reason:'wallet billing unknown'}],'release-readiness');s.event('evening-pause','pause',{owner:'Platform'},'fixture',at(day,'20:45'));s.event('production-refused','release-executor',{day,kind:'refused:factory paused',data:{reason:'factory paused'}},'fixture',at(day,'21:30'));releaseIncident(s,day,at(day,'21:31'),id=>({id,queued:true}));const incident=s.get<any>('release-incident:'+day);expect(incident.gaps.find((g:any)=>g.input==='factory state').knownBy).toBe(at(day,'20:45'));expect(incident.body).toContain('20:45');}finally{s.close();}
});

test('an incomplete configuration report cannot erase earlier knowledge of an unresolved input',()=>{
 const s=new Store(':memory:'),day='2026-11-11';try{report(s,day,'14:00',[{input:'fresh billing',reason:'stale'}]);report(s,day,'17:40',[{input:'release configuration',reason:'config could not be read'}]);report(s,day,'19:00',[{input:'fresh billing',reason:'still stale'}],'release-readiness');releaseIncident(s,day,at(day,'19:01'),id=>({id,queued:true}));expect(s.get<any>('release-incident:'+day).gaps[0].knownBy).toBe(at(day,'14:00'));}finally{s.close();}
});

test('pending incident mail retries beyond the two-night discovery horizon, without replaying queued mail',()=>{
 const s=new Store(':memory:'),day='2026-11-08';let sends=0;
 try{report(s,day,'19:00',[],'release-readiness');expect(()=>releaseIncident(s,day,at(day,'20:01'),()=>{throw Error('bridge offline');})).toThrow('offline');reconcileReleaseIncidents(s,at('2026-11-11','12:00'),id=>{expect(id).toBe('release-incident-action:'+day);sends++;return {id,queued:true};});expect(sends).toBe(1);reconcileReleaseIncidents(s,at('2026-11-12','12:00'),()=>{throw Error('queued action replay');});expect(sends).toBe(1);}finally{s.close();}
});
test('an off-schedule CLI setup error is excluded during an otherwise healthy preflight',()=>{
 const s=new Store(':memory:'),day='2026-11-11';try{s.event('executor-cli:'+day+':qa:early-error','release-executor-refusal',{stage:'qa',error:'synthetic config error'},'fixture',at(day,'14:00'));report(s,day,'19:00',[],'release-readiness');s.set('executor:'+day+':preflight',{state:'success'});expect(releaseIncident(s,day,at(day,'19:00'),()=>{throw Error('no failed window');}).queued).toBe(false);}finally{s.close();}
});
test('historical recovery and consecutive counting include admitted event-only CLI failures',()=>{
 const s=new Store(':memory:');try{for(const day of ['2026-11-09','2026-11-10'])s.event('executor-cli:'+day+':qa:config','release-executor-refusal',{stage:'qa',error:'synthetic config error'},'fixture',at(day,'20:00'));const sent:string[]=[];reconcileReleaseIncidents(s,at('2026-11-11','12:00'),id=>{sent.push(id);return {id,queued:true};});expect(sent).toHaveLength(2);expect(s.get<any>('release-incident:2026-11-10').consecutiveMisses).toBe(2);}finally{s.close();}
});
test('late setup failure retains its genuinely scheduled invocation time',()=>{
 const s=new Store(':memory:'),day='2026-11-11';try{s.event('executor-cli:'+day+':qa:late-config','release-executor-refusal',{stage:'qa',invokedAt:at(day,'20:00'),error:'synthetic config error'},'fixture',at(day,'20:02'));releaseIncident(s,day,at(day,'20:02'),id=>({id,queued:true}));expect(s.get<any>('release-incident:'+day).gaps).toContainEqual({input:'release configuration',reason:'synthetic config error',knownBy:at(day,'20:02'),basis:'recorded observation'});}finally{s.close();}
});

test('a recorded resume separates afternoon pause knowledge from a new evening pause',()=>{
 const s=new Store(':memory:'),day='2026-11-11';try{s.event('afternoon-pause','pause',{},'fixture',at(day,'13:00'));report(s,day,'14:00',[{input:'factory state',reason:'factory paused'}]);s.event('evening-resume','resume',{},'fixture',at(day,'18:00'));report(s,day,'19:00',[{input:'release configuration',reason:'configuration unknown'}],'release-readiness');s.event('new-evening-pause','pause',{},'fixture',at(day,'20:45'));s.event('evening-refusal','release-executor',{day,kind:'refused:factory paused',data:{reason:'factory paused'}},'fixture',at(day,'21:30'));releaseIncident(s,day,at(day,'21:31'),id=>({id,queued:true}));expect(s.get<any>('release-incident:'+day).gaps.find((g:any)=>g.input==='factory state').knownBy).toBe(at(day,'20:45'));}finally{s.close();}
});
