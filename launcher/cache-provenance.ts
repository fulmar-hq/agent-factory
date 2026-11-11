import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import type {Store} from '../tracking/store';

// Trusted callers record only freshly installed, pre-test inventories. Never
// infer provenance from a worker receipt or from an already-used checkout.
export function publisherDependencyRecorder(s:Store, root:string, session:string) {
  return (checkout:string, manifest:unknown, fingerprint:string) => {
    const path=resolve(checkout);
    if(realpathSync(root)!==resolve(root) || realpathSync(path)!==path || !['delivery','browser-drain'].some(area=>path.startsWith(join(root,'runs',area,session)+sep)))throw Error('publisher dependency path outside session');
    const inventory=manifest as {version?:number;fingerprint?:string;entries?:unknown};
    if(!/^[a-f0-9]{64}$/.test(fingerprint) || inventory?.version!==1 || inventory.fingerprint!==fingerprint || !inventory.entries || typeof inventory.entries!=='object' || Array.isArray(inventory.entries))throw Error('invalid publisher dependency inventory');
    s.atomic(()=>{
      const row=s.db.query('SELECT status FROM sessions WHERE id=?').get(session) as {status:string}|null;
      if(row?.status!=='finished')throw Error('publisher session not finished');
      const key='publisher-dependency-installation:'+createHash('sha256').update(path).digest('hex');
      if(s.get(key)!==null)throw Error('publisher dependency provenance already recorded');
      const shared='dependency-cache-manifest:'+fingerprint;
      const prior=s.get(shared);
      if(prior!==null && JSON.stringify(prior)!==JSON.stringify(manifest))throw Error('dependency manifest conflicts');
      if(prior===null)s.set(shared,manifest);
      s.set(key,{version:1,session,checkout:path,fingerprint});
    });
  };
}
