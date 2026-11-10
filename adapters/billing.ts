import {join} from 'node:path';
import {rename,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {BillingSchema,type Billing} from '../launcher/config';
import {monthAt} from '../wallet/ledger';
import {command} from './github';

const amount=z.object({Amount:z.string().regex(/^\d+(\.\d+)?$/),Unit:z.literal('USD')});
const budgetSchema=z.object({BudgetType:z.literal('COST'),TimeUnit:z.literal('MONTHLY'),BudgetLimit:amount,
 CostTypes:z.object({IncludeTax:z.literal(true),IncludeSubscription:z.literal(true),IncludeRefund:z.literal(false),IncludeCredit:z.literal(false)}),
 TimePeriod:z.object({Start:z.string()}),LastUpdatedTime:z.string(),CalculatedSpend:z.object({ActualSpend:amount,ForecastedSpend:amount})});
export const reviewedSchema=z.object({stop_rule:z.literal('gross_actual_plus_remaining_cost_plus_reservations_plus_lag'),reviewed_month:z.string(),
 stopped_monthly_gross_usd:z.number().finite().nonnegative(),lag_reserve_usd:z.number().finite().nonnegative(),reserved_usd:z.number().finite().nonnegative()});
const sourceSchema=z.object({profile:z.string().regex(/^[\w-]+$/),accountId:z.string().regex(/^\d{12}$/),budgetName:z.string().min(1).max(100)}).strict();

export function billingFromBudget(rawBudget:unknown,policy:unknown,receipt:string,now:number):Billing {
 const b=budgetSchema.parse(rawBudget),observedAt=Date.parse(b.LastUpdatedTime),month=monthAt(now);
 if(!Number.isFinite(observedAt)||observedAt>now||now-observedAt>=24*3600000||!Number.isFinite(Date.parse(b.TimePeriod.Start))||new Date(b.TimePeriod.Start).toISOString().slice(0,7)!==month)throw Error('gross billing receipt stale or wrong month');
 const raw=policy as {wallet?:{aws?:unknown}},reviewed=reviewedSchema.safeParse(raw?.wallet?.aws);
 const cents=(n:number)=>Math.ceil(n*100),postedCents=cents(Number(b.CalculatedSpend.ActualSpend.Amount));
 let fixedCents=0,unpostedCents=0,projectedCents=cents(Number(b.CalculatedSpend.ForecastedSpend.Amount));
 if(reviewed.success && reviewed.data.reviewed_month===month){
  const p=reviewed.data,d=new Date(now),days=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  fixedCents=cents(p.stopped_monthly_gross_usd*(days-d.getUTCDate()+1)/days);
  unpostedCents=cents(p.lag_reserve_usd+p.reserved_usd);
  projectedCents=postedCents+fixedCents+unpostedCents;
 }
 const ceiling=(raw?.wallet?.aws as {ceiling_usd_month?:number})?.ceiling_usd_month;
 if(!Number.isFinite(ceiling)||Number(b.BudgetLimit.Amount)!==ceiling)throw Error('billing ceiling differs from policy');
 return BillingSchema.parse({observedAt,month,postedCents,fixedCents,unpostedCents,projectedCents,receipt});
}

// Trusted read-only billing path, explicitly configured by the owner. Uses only
// the existing Budgets API, never CE, resource APIs, sign-in or a model. Every
// admission rereads AWS; neither polling nor cache mtime refreshes source age.
export async function releaseBilling(dir:string,now=Date.now(),execute=command):Promise<Billing> {
 const source=sourceSchema.parse(await Bun.file(join(dir,'release-billing-source.json')).json());
 const policyText=await Bun.file(join(dir,'config.yaml')).text();
 const policy=Bun.YAML.parse(policyText);
 const output=await execute(['aws','budgets','describe-budget','--profile',source.profile,'--region','us-east-1',
  '--account-id',source.accountId,'--budget-name',source.budgetName,'--output','json','--no-cli-pager']);
 const data=JSON.parse(output),hash=createHash('sha256').update(policyText+'\n'+output).digest('hex');
 const b=billingFromBudget(data.Budget,policy,`AWS Budgets DescribeBudget ${source.accountId}/${source.budgetName}; policy+source sha256:${hash}`,now);
 const path=join(dir,'release-billing.json'),temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(b)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);
 return b;
}
