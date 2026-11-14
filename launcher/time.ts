export function toronto(now:number) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const p=(k:string)=>parts.find(x=>x.type===k)!.value;
 return {day:`${p('year')}-${p('month')}-${p('day')}`,minute:Number(p('hour'))*60+Number(p('minute'))};
}
export function deadlineAt(now:number,minute:number){const d=new Date(now);return now-d.getUTCSeconds()*1000-d.getUTCMilliseconds()+(minute-toronto(now).minute)*60000;}
