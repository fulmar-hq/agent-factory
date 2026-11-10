import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {billingFromBudget,releaseBilling} from '../adapters/billing';
const now=Date.parse('2031-11-10T01:00:00Z');
const policy={wallet:{aws:{ceiling_usd_month:75,hold_at_projected:75,stop_at_actual:68,stop_rule:'gross_actual_plus_remaining_cost_plus_reservations_plus_lag',reviewed_month:'2031-11',stopped_monthly_gross_usd:30,lag_reserve_usd:5,reserved_usd:2}}};
const budget=()=>({BudgetType:'COST',TimeUnit:'MONTHLY',BudgetLimit:{Amount:'75',Unit:'USD'},CostTypes:{IncludeTax:true,IncludeSubscription:true,IncludeRefund:false,IncludeCredit:false},TimePeriod:{Start:'2031-11-01T00:00:00Z'},LastUpdatedTime:'2031-11-09T18:12:00Z',CalculatedSpend:{ActualSpend:{Amount:'20.123',Unit:'USD'},ForecastedSpend:{Amount:'110.5',Unit:'USD'}}});
test('retains actual source time and conservatively rounds reviewed gross obligations',()=>{
 const b=billingFromBudget(budget(),policy,'fixture',now);expect(b.observedAt).toBe(Date.parse(budget().LastUpdatedTime));expect(b.postedCents).toBe(2013);expect(b.fixedCents).toBe(2100);expect(b.unpostedCents).toBe(700);expect(b.projectedCents).toBe(4813);
});
test('wrong month, stale, future, net cost and ceiling drift refuse',()=>{
 for(const patch of [{LastUpdatedTime:'2031-11-08T01:00:00Z'},{LastUpdatedTime:'2031-11-11T01:00:00Z'},{TimePeriod:{Start:'2031-10-01'}},{CostTypes:{...budget().CostTypes,IncludeCredit:true}},{BudgetLimit:{Amount:'76',Unit:'USD'}}])expect(()=>billingFromBudget({...budget(),...patch},policy,'fixture',now)).toThrow();
});
test('unreviewed month cannot reuse retained-cost forecast',()=>{
 const p=structuredClone(policy);p.wallet.aws.reviewed_month='2031-10';expect(billingFromBudget(budget(),p,'fixture',now).projectedCents).toBe(11050);
});
test('missing and stale files trigger real reread; changed policy and higher actual cannot hide behind cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'billing-test-'));
 try{
 await writeFile(join(dir,'config.yaml'),JSON.stringify(policy));await writeFile(join(dir,'release-billing-source.json'),JSON.stringify({profile:'fixture',accountId:'111111111111',budgetName:'Fictional gross budget'}));
 await writeFile(join(dir,'readings.json'),JSON.stringify({codex:{source:'preserve'},billing:{postedCents:0}}));
 let calls:string[][]=[];const execute=async(args:string[])=>{calls.push(args);return JSON.stringify({Budget:budget()});};
 const a=await releaseBilling(dir,now,execute);expect(a.postedCents).toBe(2013);
 const changed=structuredClone(policy);changed.wallet.aws.reserved_usd=3;await writeFile(join(dir,'config.yaml'),JSON.stringify(changed));
 const b=await releaseBilling(dir,now,async args=>{calls.push(args);const value=budget();value.CalculatedSpend.ActualSpend.Amount='68';return JSON.stringify({Budget:value});});
 expect(b.postedCents).toBe(6800);expect(b.unpostedCents).toBe(800);expect(calls.length).toBe(2);expect(calls.every(a=>a.slice(0,3).join(' ')==='aws budgets describe-budget')).toBe(true);
 expect(JSON.parse(await readFile(join(dir,'readings.json'),'utf8')).codex.source).toBe('preserve');
 await expect(releaseBilling(dir,now,async()=>{throw Error('expired SSO');})).rejects.toThrow('expired SSO');
 expect(JSON.parse(await readFile(join(dir,'release-billing.json'),'utf8')).postedCents).toBe(6800);
 }finally{await rm(dir,{recursive:true,force:true});}
});

import {Store} from '../tracking/store';
import {ConfigSchema} from '../launcher/config';
import {releaseAvailable,observeReleaseBilling} from '../wallet/release';
import {debit} from '../wallet/ledger';
test('native envelope keeps every commitment and strict cap boundary; changed or expired policy refuses',async()=>{
 const c=ConfigSchema.parse(Bun.YAML.parse(await Bun.file(join(import.meta.dir,'../examples/config.yaml')).text()));
 c.wallet.aws={ceiling_usd_month:75,reserve_usd:15,hold_at_projected:75,stop_at_actual:68};
 const s=new Store(':memory:');try{
 const b=billingFromBudget(budget(),policy,'fixture',now);
 expect(releaseAvailable(s,c,b,policy,now)).toBe(2686);
 s.atomic(()=>debit(s,'existing','aws',2586,now));
 expect(releaseAvailable(s,c,b,policy,now)).toBe(100);
 // At only99 cents of strict headroom, a dollar reservation must refuse.
 s.atomic(()=>debit(s,'other','aws',1,now));expect(releaseAvailable(s,c,b,policy,now)).toBe(99);
 const p=structuredClone(policy);p.wallet.aws.reserved_usd=4;expect(releaseAvailable(s,c,b,p,now)).toBe(0);
 p.wallet.aws.reviewed_month='2031-10';expect(releaseAvailable(s,c,b,p,now)).toBe(0);
 expect(releaseAvailable(s,c,b,{},now)).toBe(0);
 s.set('aws-stop-latched',true);expect(releaseAvailable(s,c,b,policy,now)).toBe(0);
 }finally{s.close();}
});
test('two stores cannot both reserve the last dollar of native headroom',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'billing-race-')),path=join(dir,'db');
 const a=new Store(path),bStore=new Store(path);
 try{
 const c=ConfigSchema.parse(Bun.YAML.parse(await Bun.file(join(import.meta.dir,'../examples/config.yaml')).text()));c.wallet.aws={ceiling_usd_month:75,reserve_usd:15,hold_at_projected:75,stop_at_actual:68};
 const reading=billingFromBudget(budget(),policy,'fixture',now);
 a.atomic(()=>debit(a,'prior','aws',2586,now));
 const claim=(s:Store,id:string)=>s.atomic(()=>{if(releaseAvailable(s,c,reading,policy,now)<100)return false;debit(s,id,'aws',100,now);return true;});
 expect(claim(a,'first')).toBe(true);expect(claim(bStore,'second')).toBe(false);
 }finally{a.close();bStore.close();await rm(dir,{recursive:true,force:true});}
});

test('commitment-inclusive native stop persists and stale policy thresholds refuse',async()=>{
 const c=ConfigSchema.parse(Bun.YAML.parse(await Bun.file(join(import.meta.dir,'../examples/config.yaml')).text()));c.wallet.aws={ceiling_usd_month:75,reserve_usd:15,hold_at_projected:75,stop_at_actual:68};
 const s=new Store(':memory:');try{
 const b=billingFromBudget(budget(),policy,'fixture',now);
 const changed=structuredClone(policy);changed.wallet.aws.ceiling_usd_month=74;expect(releaseAvailable(s,c,b,changed,now)).toBe(0);
 s.atomic(()=>debit(s,'pending','aws',2687,now));
 observeReleaseBilling(s,c,b,now);expect(s.get('aws-stop-latched')).toBe(true);
 }finally{s.close();}
});
