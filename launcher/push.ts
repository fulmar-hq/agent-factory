import {MeterSchema,type Config,type Ticket} from './config';
export function pushing(c:Config,now:number) {return !!c.usage_push && now<Date.parse(c.usage_push.until);}
// The temporary higher Codex thresholds end at the authorized reset. Other
// providers retain the original gates even while the Codex push is active.
export function usageThresholds(c:Config,now:number,provider?:string) {
 if(!pushing(c,now) || provider!=='codex')return {admit_below:.7,high_benefit_only_below:.9,stop_at:.9};
 return c.usage_gates;
}
export function buildEffort(c:Config,t:Ticket,now:number) {
 return pushing(c,now) && t.provider==='codex' ? c.usage_push!.effort.build : t.effort ?? c.owners[t.owner].effort;
}
export function qualificationFor<T>(q:Record<string,T>,provider:string,effort:string) {return q[`${provider}:${effort}`] ?? q[provider];}
export function pushPace(c:Config,raw:unknown,now:number) {
 if(!pushing(c,now))return null;
 const parsed=MeterSchema.safeParse(raw);if(!parsed.success)return null;
 const m=parsed.data;
 if(m.nativeProvider!=='codex' || m.observedAt>now || now-m.observedAt>c.usage_gates.max_meter_age_minutes*60000)return null;
 const until=Date.parse(c.usage_push!.until);
 // Never mistake the short rolling window for the weekly allowance.
 const weekly=m.windows.find(w=>w.durationMinutes===10080 || w.name==='seven_day') ?? m.windows.find(w=>Math.abs(w.resetsAt-until)<60000);
 if(!weekly || weekly.resetsAt<=now)return null;
 const hoursToReset=(Math.min(until,weekly.resetsAt)-now)/3600000;
 const remainingPercent=(1-weekly.used)*100,requiredPercentPerHour=remainingPercent/hoursToReset;
 const elapsed=168-(weekly.resetsAt-now)/3600000;
 const actualPercentPerHour=elapsed>0 ? weekly.used*100/elapsed : null;
 return {remainingPercent,hoursToReset,requiredPercentPerHour,actualPercentPerHour,belowPace:actualPercentPerHour===null || actualPercentPerHour<requiredPercentPerHour};
}
