import {join} from 'node:path';
import {optionalJSON} from './config';
import {originalSessionExpiry} from './release-readiness';
// Check original sign-in provenance before AWS reads. Waiting for the owner
// rereads this local receipt; it never invokes SSO, refreshes or retries AWS.
export async function withReleaseAuth<T>(dir:string,run:()=>Promise<T>,clock=Date.now):Promise<T>{
 const raw=await optionalJSON(join(dir,'release-auth-session.json')),now=clock();
 originalSessionExpiry(raw,now,now);
 return run();
}
