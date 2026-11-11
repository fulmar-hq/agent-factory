import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
async function lock(path:string,milliseconds:number,mode='IMMEDIATE'){
 const child=Bun.spawn([process.execPath,'-e',`const {Database}=require('bun:sqlite');const d=new Database(process.argv[1]);d.exec('BEGIN ${mode}');console.log('locked');setTimeout(()=>{d.exec('COMMIT');d.close()},${milliseconds});`,path],{stdout:'pipe',stderr:'pipe'});
 const reader=child.stdout.getReader();await reader.read();reader.releaseLock();return child;
}
test('timeout applies before WAL setup while another process holds a short lock',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'store-init-lock-')),'state.sqlite'),db=new Database(path);db.exec('CREATE TABLE probe(id INTEGER)');db.close();
 const child=await lock(path,250,'EXCLUSIVE');const s=new Store(path);expect(s.get('paused')).toBe(true);s.close();expect(await child.exited).toBe(0);
});
test('retry only BEGIN acquisition; never replay a callback or synchronous spawn effect',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'store-begin-lock-')),'state.sqlite'),s=new Store(path);s.db.exec('PRAGMA busy_timeout=1');
 const child=await lock(path,150);let calls=0;s.atomic(()=>{calls++;s.set('claimed','once');});expect(calls).toBe(1);expect(s.get('claimed')).toBe('once');expect(await child.exited).toBe(0);
 const failure=Object.assign(Error('database is locked'),{code:'SQLITE_BUSY'});let effects=0;expect(()=>s.atomic(()=>{effects++;throw failure})).toThrow(failure);expect(effects).toBe(1);s.close();
});
