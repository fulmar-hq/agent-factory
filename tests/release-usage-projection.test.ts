import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {observeReleaseUsage,projectUsage,collectUsageProjection} from '../launcher/release-usage-projection';
import {config} from './fixtures';
import type {Meter} from '../launcher/config';
const now=Date.parse('2026-11-11T14:00:00-05:00'),target=Date.parse('2026-11-11T18:30:00-05:00');
const meter=(at:number,used:number,resetsAt=target+3600000):Meter=>({nativeProvider:'codex',source:'fictional native quota',observedAt:at,windows:[{name:'weekly',durationMinutes:10080,used,resetsAt}]});
test('current burn forecasts the 18:30 70% gate without changing it; all windows must pass',()=>{
 const before=meter(now-30*60000,.4),current=meter(now,.44),p=projectUsage(current,[before],'codex',now,target,.7);expect(p.underGate).toBe(false);expect(p.windows[0].projectedUsed).toBeCloseTo(.8);
 expect(projectUsage(meter(now,.41),[before],'codex',now,target,.7).underGate).toBe(true);
 const boundary=projectUsage(meter(now,.7),[meter(now-30*60000,.7)],'codex',now,target,.7);expect(boundary.underGate).toBe(false);
});
test('missing/stale history, counter decreases and changed resets never become zero burn',()=>{
 for(const [current,history] of [[undefined,[]],[meter(now-16*60000,.4),[meter(now-40*60000,.3)]],[meter(now,.4),[]],[meter(now,.3),[meter(now-30*60000,.4)]],[meter(now,.4,target+1),[meter(now-30*60000,.3,target+2)]]] as [Meter|undefined,Meter[]][])expect(()=>projectUsage(current,history,'codex',now,target,.7)).toThrow();
});
test('a projected reset is explicitly an assumption and never creates a native reading',()=>{
 const reset=now+3600000,current=meter(now,.6,reset),history=[meter(now-30*60000,.55,reset)],p=projectUsage(current,history,'codex',now,target,.7);expect(p.windows[0].resetAssumed).toBe(true);expect(p.windows[0].projectedUsed).toBeCloseTo(.35);expect(current.windows[0].used).toBe(.6);expect(current.observedAt).toBe(now);
});
test('14:00 projection reports both owner gaps to existing readiness, with bounded native history',async()=>{
 const s=new Store(':memory:'),c=config();c.owners={release:{harness:'codex',model:'gpt-6.1-sol',effort:'medium'},quality:{harness:'codex',model:'gpt-6.1-sol',effort:'medium'}};
 try{
 for(let i=0;i<90;i++)observeReleaseUsage(s,{codex:meter(now-(90-i)*5*60000,.4)},now-(90-i)*5*60000);
 expect((s.get<Meter[]>('release-usage-history:codex')??[]).length).toBeLessThanOrEqual(72);
 const r={day:'2026-11-11',at:now,validThrough:target+4*3600000,ready:true,missing:[] as {input:string;reason:string}[],evidence:{}};
 await collectUsageProjection(s,c,'/fictional',r,{codex:meter(now,.6)},async()=>null);expect(r.ready).toBe(false);expect(r.missing.map(x=>x.input)).toEqual(['release usage projection','quality usage projection']);expect(c.usage_gates.admit_below).toBe(.7);expect(c.usage_gates.stop_at).toBe(.9);
 expect(s.db.query('SELECT count(*) AS n FROM debits').get()).toEqual({n:0});
 }finally{s.close();}
});

test('sample capture uses collection completion time and refuses a genuinely future native timestamp',()=>{
 const s=new Store(':memory:');try{const reading=meter(now+500,.3);observeReleaseUsage(s,{codex:reading},now);expect(s.get('release-usage-history:codex')).toBeNull();observeReleaseUsage(s,{codex:reading},now+1000);expect(s.get<Meter[]>('release-usage-history:codex')?.[0].observedAt).toBe(now+500);}finally{s.close();}
});
