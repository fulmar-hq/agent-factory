import {test,expect} from 'bun:test';
import {config,ticket,now,meter,admission,qualification} from './fixtures';
import {ConfigSchema} from '../launcher/config';
import {pushPace,buildEffort,usageThresholds,qualificationFor} from '../launcher/push';
import {slotLimit,reconcileCapacity} from '../launcher/capacity';
import {Store} from '../tracking/store';
import {Engine,usageGate} from '../launcher/engine';
import {supply} from '../launcher/autonomy';
import {greenChecks,challengeAndMerge} from '../launcher/challenge';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
function pushConfig(){const c=config();c.owners.release={harness:'codex',model:'gpt-6.1-sol',effort:'medium'};c.usage_push={until:new Date(now+48*3600000).toISOString(),target:'Useful implementation',pace:'remaining/hours',admit_below:.97,ready_buffer:'slots + 6',effort:{build:'high',intake:'medium',review:'medium'},challenger:'one per head',guard:'useful only'};c.usage_gates={admit_below:.97,high_benefit_only_below:.97,stop_at:.98,max_meter_age_minutes:15};c.capacity.controller={start:10,max:16,interval_minutes:30,busy_above:.8,failure_below:.3,mini_memory_free_floor:.25};return c;}
const weekly=()=>({...meter(.14),nativeProvider:'codex' as const,windows:[{used:.14,resetsAt:now+48*3600000,durationMinutes:10080}]});
test('new config validates, impossible capacity and reversed gates refuse',()=>{
 const c=pushConfig();expect(ConfigSchema.safeParse(c).success).toBe(true);
 expect(ConfigSchema.safeParse({...c,capacity:{...c.capacity,controller:{...c.capacity.controller,start:17}}}).success).toBe(false);
 expect(ConfigSchema.safeParse({...c,usage_gates:{...c.usage_gates,stop_at:.5}}).success).toBe(false);
});
test('weekly pace uses fresh native evidence and never a short window',()=>{
 const c=pushConfig();expect(pushPace(c,weekly(),now)).toMatchObject({remainingPercent:86,hoursToReset:48,belowPace:true});
 expect(pushPace(c,weekly(),now)!.requiredPercentPerHour).toBeCloseTo(86/48);
 for(const bad of [undefined,{...weekly(),nativeProvider:'claude'},{...weekly(),observedAt:now-900001},{...weekly(),observedAt:now+1},{...weekly(),windows:[{used:.14,resetsAt:now+3600000,durationMinutes:300}]}])expect(pushPace(c,bad,now)).toBeNull();
 expect(pushPace(c,weekly(),now+48*3600000)).toBeNull();
});
test('temporary Codex thresholds end automatically and do not raise Claude gates',()=>{
 const c=pushConfig();expect(()=>usageGate({...meter(.96),nativeProvider:'codex'},false,now,c,'codex')).not.toThrow();
 expect(()=>usageGate(meter(.98),true,now,c,'codex')).toThrow('usage stop');
 expect(usageThresholds(c,now,'claude').stop_at).toBe(.9);
 expect(usageThresholds(c,Date.parse(c.usage_push!.until),'codex').admit_below).toBe(.7);
});
test('high builds require an actual matching high qualification',()=>{
 const c=pushConfig(),s=new Store(':memory:'),e=new Engine(s,c);e.pause(false,'owner');
 expect(buildEffort(c,{...ticket(),effort:'medium'},now)).toBe('high');
 expect(()=>e.admit(ticket(),admission())).toThrow('unqualified');
 const high={...qualification(),effort:'high' as const};
 expect(e.admit(ticket(),{...admission(),qualification:qualificationFor({'codex:high':high},'codex','high')}).status).toBe('reserved');s.close();
});
test('capacity adopts new start, steps below start on memory/failure, grows only with real healthy samples',()=>{
 const c=pushConfig(),s=new Store(':memory:');s.set('capacity-controller',{slots:6});
 expect(reconcileCapacity(s,c,10,'normal',now,.6)!.slots).toBe(10);
 expect(reconcileCapacity(s,c,10,'normal',now+60000,.24)!.slots).toBe(9);
 expect(slotLimit(s,c)).toBe(9);
 for(let m=2;m<=33;m++)reconcileCapacity(s,c,9,'normal',now+m*60000,null);
 expect(slotLimit(s,c)).toBe(9);
 for(let m=34;m<=64;m++)reconcileCapacity(s,c,9,'normal',now+m*60000,.5);
 expect(slotLimit(s,c)).toBe(10);
 s.event('failed','worker-failure',{id:'bad'},'retain',now+65*60000);
 expect(reconcileCapacity(s,c,10,'normal',now+65*60000,.5)!.slots).toBe(9);s.close();
});
test('below pace intake asks for slots plus six, rather than the old buffer',()=>{
 const c=pushConfig(),s=new Store(':memory:'),e=new Engine(s,c);e.pause(false,'owner');
 c.autonomy={intake_owner:'builder',ready_buffer:3,auto_approval:{max_minutes:30,max_docs_per_round:1,protected_paths:['AGENTS.md']},restart:{max_retries:1,causes_per_hour:3}};
 s.set('readings',{codex:weekly()});supply(e,Array.from({length:13},(_,n)=>ticket(n+1)),now);
 const round=s.get<{wake:string}>('intake-round')!;expect(s.get<any>(`owner-wake:${round.wake}`).payload.target).toBe(16);s.close();
});
for(const mode of ['missing','blocked','wrong-head','reject','pending','changes','pass'] as const)test(`continuous release requires native challenge and current green checks: ${mode}`,async()=>{
 const s=new Store(':memory:'),c=pushConfig();s.set('paused',false);c.projects={factory:{repo:'fulmar-hq/agent-factory',owners:['builder'],tests:'bun test'}};
 const head='a'.repeat(40),base='b'.repeat(40),url='https://github.com/fulmar-hq/agent-factory/pull/7',id=`challenger:fulmar-hq/agent-factory:7:${head}`;
 s.event('pub','launcher-publish',{id:'fixture',url,head},'retain',now);
 const scratch=mkdtempSync(join(tmpdir(),'factory-challenge-'));
 const verdict={head:mode==='wrong-head'?base:head,verdict:mode==='reject'?'CHANGES_REQUESTED':'PASS',evidence:'Inspected concrete synthetic source and boundary checks.'};
 writeFileSync(join(scratch,'challenge.json'),JSON.stringify(verdict));
 const calls:string[][]=[];
 const execute=async(args:string[])=>{calls.push(args);if(args.includes('list'))return JSON.stringify([{number:7,url,headRefOid:head,baseRefOid:base,baseRefName:'main',isDraft:false,reviewDecision:mode==='changes'?'CHANGES_REQUESTED':'',headRefName:'feat/factory-fixture'}]);if(args.includes('checks'))return JSON.stringify([{bucket:mode==='pending'?'pending':'pass'}]);if(args.includes('view'))return JSON.stringify({headRefOid:head,baseRefName:'main',state:'OPEN',isDraft:false});if(args[1]==='api')return args.includes('POST')?'{}':'[]';return '';};
 await challengeAndMerge(s,c,execute,now);
 if(mode!=='missing')s.set(`owner-wake:${id}`,{state:mode==='blocked'?'blocked':'done',cleanupVerified:true,native:'review-native',scratch});
 await challengeAndMerge(s,c,execute,now+1);await challengeAndMerge(s,c,execute,now+2);
 expect(calls.filter(a=>a.includes('merge')).length).toBe(mode==='pass'?1:0);
 if(mode==='pass')expect(calls.find(a=>a.includes('merge'))).toContain('--match-head-commit');s.close();
});
test('empty/skipped/failed checks never count as green',()=>{expect(greenChecks([])).toBe(false);for(const bucket of ['skipping','cancel','fail','pending'])expect(greenChecks([{bucket}])).toBe(false);});
