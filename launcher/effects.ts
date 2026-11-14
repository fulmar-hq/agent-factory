import {Store} from '../tracking/store';
import {processIdentity} from './process';
// Serialize external effects across overlapping launcher ticks without holding
// a SQLite transaction across network awaits. A live holder never loses the
// lease to a timeout; a dead process can be reclaimed by identity.
export async function autonomyEffects<T>(s:Store,run:()=>Promise<T>,identity=processIdentity):Promise<T|undefined> {
 const token=crypto.randomUUID();
 const claimed=s.atomic(()=>{
  const old=s.get<{pid:number;identity:string;token:string}>('autonomy-effects');
  if(old && identity(old.pid)===old.identity)return false;
  s.set('autonomy-effects',{pid:process.pid,identity:identity(process.pid),token});return true;
 });
 if(!claimed)return;
 try{return await run();}finally{s.atomic(()=>{if(s.get<{token:string}>('autonomy-effects')?.token===token)s.set('autonomy-effects',null);});}
}
