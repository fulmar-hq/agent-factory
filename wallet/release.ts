import type {Store} from '../tracking/store';
import type {Billing,Config} from '../launcher/config';
import {reviewedSchema} from '../adapters/billing';
import {observeBilling,available,awsRefusal,monthAt} from './ledger';

// The configured native rule is gross actual + retained remaining cost + all
// outstanding reservations + lag, strictly below the monthly ceiling. The old
// allocation reserve is not added a second time to that complete envelope.
// Unknown/legacy policy retains the existing conservative wallet behavior.
export function releaseAvailable(s:Store,c:Config,b:Billing|undefined,raw:unknown,now:number):number {
 if(awsRefusal(s,c,now,b)||!b)return 0;
 const policy=(raw as {wallet?:{aws?:unknown}})?.wallet?.aws;
 const thresholds=policy as Config['wallet']['aws']|undefined;
 if(!thresholds || ['ceiling_usd_month','stop_at_actual','hold_at_projected'].some(k=>thresholds[k as keyof typeof thresholds]!==c.wallet.aws[k as keyof typeof thresholds]))return 0;
 const p=reviewedSchema.safeParse(policy);
 if(!p.success)return available(s,c,'aws',now,b);
 if(p.data.reviewed_month!==monthAt(now))return 0;
 const d=new Date(now),days=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
 const fixed=Math.ceil(p.data.stopped_monthly_gross_usd*(days-d.getUTCDate()+1)/days*100);
 const unposted=Math.ceil((p.data.lag_reserve_usd+p.data.reserved_usd)*100);
 if(b.fixedCents!==fixed||b.unpostedCents!==unposted||b.projectedCents!==b.postedCents+fixed+unposted)return 0;
 const committed=(s.db.query("SELECT COALESCE(SUM(cents),0) AS cents FROM debits WHERE source='aws' AND month=?").get(monthAt(now)) as {cents:number}).cents;
 // One cent remains at equality: a proposed operation may never reach75.
 return Math.max(0,Math.floor(c.wallet.aws.ceiling_usd_month*100)-b.projectedCents-committed-1);
}

// Include every existing irreversible commitment when evaluating a persistent
// native STOP. The proposed operation is checked separately before debit.
export function observeReleaseBilling(s:Store,c:Config,b:Billing,now:number){
 const committed=(s.db.query("SELECT COALESCE(SUM(cents),0) AS cents FROM debits WHERE source='aws' AND month=?").get(monthAt(now)) as {cents:number}).cents;
 observeBilling(s,c,{...b,projectedCents:b.projectedCents+committed,receipt:`${b.receipt}; committed:${committed}`},now);
}
