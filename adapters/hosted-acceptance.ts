import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {command} from './github';
const ACCOUNT='553066147679',INSTANCE='i-063943f2f032b2903',PROFILE='fisher-acc030',REGION='ca-central-1';
export type HostedContext={revision:string;tree:string;artifact:string;deadline?:number};
type Options={execute?:typeof command;now?:()=>number;sleep?:(ms:number)=>Promise<void>};
const sha=/^[a-f0-9]{40}$/;
const digest=/@sha256:[a-f0-9]{64}$/;
export function hostCommand(context:HostedContext,script=readFileSync(join(import.meta.dir,'../scripts/hosted-acceptance.cjs'),'utf8')) {
 const program=`import json,subprocess,base64\n`+
 `expected=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(context)).toString('base64')}'))\n`+
 `def inspect(name):\n r=subprocess.run(['docker','inspect',name],capture_output=True,text=True,timeout=10)\n return json.loads(r.stdout)[0] if r.returncode==0 else None\n`+
 `checks={}\nmetadata={}\n`+
 `for name in ['alido-qa-web','alido-qa-worker']:\n d=inspect(name)\n source=d['Config'].get('Labels',{}).get('org.opencontainers.image.revision') if d else None\n image=d['Config']['Image'] if d else None\n running=bool(d and d['State']['Running'])\n checks[name+':source']=source==expected['revision']\n checks[name+':running']=running\n checks[name+':artifact']=bool(image and image.endswith(expected['artifact'][expected['artifact'].index('@sha256:'):]))\n metadata[name]={'revision':source,'image':image,'running':running,'healthy':bool(d and d['State'].get('Health',{}).get('Status')=='healthy')}\n p=inspect(name+'-previous')\n checks[name+':rollback']=bool(p and p['State']['Running'] is False)\n`+
 `checks['webHealthy']=metadata['alido-qa-web']['healthy']\n`+
 `result={'checks':checks,'containers':metadata}\n`+
 `if all(checks.values()):\n p=subprocess.run(['docker','exec','-i','alido-qa-web','node'],input=base64.b64decode('${Buffer.from(script).toString('base64')}').decode(),text=True,capture_output=True,timeout=170)\n try: result['probe']=json.loads(p.stdout) if p.returncode==0 else {'failure':'probe_exit'}\n except Exception: result['probe']={'failure':'probe_output'}\n`+
 `print(json.dumps(result,separators=(',',':')))\n`;
 return `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(program).toString('base64')}'))"`;
}
export function validHostedResult(raw:any) {
 const expected=['qaSafety','qaDatabase','runtimeRole','syntheticUser','syntheticMembership','ownFixture','otherFixture','health','unsignedDenied','workspace','preferences','tenantDenied','screen:inbox','screen:follow-ups','screen:leads','screen:bookings','screen:learning','screen:settings','sessionExpired','databaseClosed'];
 const hostChecks=['alido-qa-web:source','alido-qa-web:running','alido-qa-web:artifact','alido-qa-web:rollback','alido-qa-worker:source','alido-qa-worker:running','alido-qa-worker:artifact','alido-qa-worker:rollback','webHealthy'];
 return !!raw && hostChecks.every(k=>raw.checks?.[k]===true) && raw.probe?.version===1 && raw.probe?.method==='synthetic-http' && !raw.probe.failure && expected.every(k=>raw.probe.checks?.[k]===true);
}
/** Explicit trusted operator path: one scoped SSM probe; never invoked by dry-run. */
export async function collectHostedAcceptance(c:HostedContext,o:Options={}) {
 if(!sha.test(c.revision)||!sha.test(c.tree)||!digest.test(c.artifact))throw Error('Exact hosted source/tree/artifact required');
 const execute=o.execute??command,now=o.now??Date.now,sleep=o.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
 const startedAt=now();
 if(c.deadline!==undefined&&startedAt+200000>=c.deadline)throw Error('Hosted acceptance needs its bounded probe window');
 const aws=(...args:string[])=>execute(['aws','--profile',PROFILE,'--region',REGION,...args]);
 const identity=JSON.parse(await aws('sts','get-caller-identity'));
 if(identity.Account!==ACCOUNT)throw Error('QA account identity mismatch');
 const publicStatus=Number((await execute(['curl','--silent','--show-error','--max-time','15','--output','/dev/null','--write-out','%{http_code}','https://qa.goalido.com/api/health'])).trim());
 const sent=JSON.parse(await aws('ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunShellScript','--timeout-seconds','30','--comment','Alido synthetic hosted acceptance','--parameters',JSON.stringify({commands:[hostCommand(c)],executionTimeout:['180']}),'--output','json'));
 const id=sent.Command?.CommandId;
 if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('SSM command custody unknown; never redispatch automatically');
 for(let i=0;i<90;i++) {
  await sleep(2000);
  let invocation;
  try{invocation=JSON.parse(await aws('ssm','get-command-invocation','--command-id',id,'--instance-id',INSTANCE));}
  catch{continue;} // Native invocation can appear shortly after accepted dispatch; no new send.
  if(['Pending','InProgress','Delayed'].includes(invocation.Status))continue;
  let result;
  if(invocation.Status==='Success')try{result=JSON.parse(invocation.StandardOutputContent);}catch{}
  return {version:1,method:'synthetic-http',browser:false,...c,startedAt,completedAt:now(),account:ACCOUNT,instance:INSTANCE,commandId:id,status:invocation.Status,publicHttps:{status:publicStatus,reachable:[200,302,303].includes(publicStatus),bodyInspected:false},passed:invocation.Status==='Success'&&[200,302,303].includes(publicStatus)&&validHostedResult(result),result:result??{failure:'ssm_probe_failed'}};
 }
 throw Error(`SSM hosted probe unresolved: ${id}; retain custody, never redispatch automatically`);
}
