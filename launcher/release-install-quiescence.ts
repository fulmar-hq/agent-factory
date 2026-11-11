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
  const workers=db.query("SELECT COUNT(*) AS n FROM sessions WHERE status IN ('reserved','starting','running','unknown')").get() as {n:number};
  if(workers.n)throw Error('active or unknown worker custody prevents release-job installation');
  const rows=db.query("SELECT key,value FROM kv WHERE key LIKE 'executor:%' LIMIT 1001").all() as {key:string;value:string}[];
  if(rows.length>1000)throw Error('release-effect inventory exceeds inspection bound');
  for(const row of rows.filter(r=>/^executor:\d{4}-\d{2}-\d{2}:(preflight|freeze|qa|promote|readback)$/.test(r.key))){
   const effect=JSON.parse(row.value);if(!['success','failure'].includes(effect?.state))throw Error('retained release effect requires reconciliation before job installation: '+row.key);
  }
 }finally{db.close();}
}
