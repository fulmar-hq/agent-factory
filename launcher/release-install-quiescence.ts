import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {toronto} from './release';
import {integrationFreeze} from './integration-freeze';
// Use the existing admission pause, not launchctl's load-only Disabled flag.
// Outside the release/proof window, a reconciler with no retained effects is
// an unadmitted observer. Its durable reads may be interrupted and resumed.
export function assertReleaseInstallQuiescent(dir:string,now=Date.now()){
 const minute=toronto(now).minute;
 if(minute>=1050&&minute<1355||integrationFreeze(dir,now))throw Error('release jobs cannot be rebound during the proof/release window');
 const db=new Database(join(dir,'controller.sqlite'),{readonly:true,strict:true});
 try{db.exec('PRAGMA busy_timeout=1000; BEGIN');
  const paused=db.query("SELECT value FROM kv WHERE key='paused'").get() as {value:string}|null;
  if(!paused||JSON.parse(paused.value)!==true)throw Error('pause admissions through the authenticated control before rebinding release jobs');
  const workers=db.query("SELECT id,status,pid FROM sessions WHERE status!='archived' LIMIT 10001").all() as {id:string;status:string;pid:number|null}[];
  if(workers.length>10000)throw Error('worker custody inventory exceeds inspection bound');
  for(const worker of workers){
   const row=db.query('SELECT value FROM kv WHERE key=?').get('cleanup-evidence:'+worker.id) as {value:string}|null;
   if(!['finished','paused','waiting-browser','waiting-person','waiting-question','question'].includes(worker.status)||worker.pid!==null||!row||JSON.parse(row.value)?.verified!==true)throw Error('active or unknown worker custody prevents release-job installation');
  }
  const rows=db.query("SELECT key,value FROM kv WHERE key LIKE 'executor:%' LIMIT 1001").all() as {key:string;value:string}[];
  if(rows.length>1000)throw Error('release-effect inventory exceeds inspection bound');
  for(const row of rows.filter(r=>/^executor:\d{4}-\d{2}-\d{2}:(preflight|freeze|qa|promote|readback)$/.test(r.key))){
   const effect=JSON.parse(row.value);
   // A deadline/identity/inventory failure retains uncertain remote custody.
   // The adapter records run+conclusion only after observing that run completed.
   const settledFailure=effect?.state==='failure'&&Number.isSafeInteger(effect.evidence?.run)&&effect.evidence.run>0&&['failure','cancelled','timed_out','action_required','neutral','skipped','startup_failure','stale'].includes(effect.evidence?.conclusion);
   if(effect?.state!=='success'&&!settledFailure)throw Error('retained release effect requires reconciliation before job installation: '+row.key);
  }
 }finally{db.close();}
}
