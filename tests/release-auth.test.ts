import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withReleaseAuth} from '../launcher/release-auth';
import {originalSessionExpiry} from '../launcher/release-readiness';
test('expired or missing original sign-in never invokes AWS reads; only a real newer receipt allows them',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'release-auth-')),now=Date.parse('2026-11-10T23:25:00-05:00');let calls=0;
 const run=async()=>{calls++;return 'read';};
 await expect(withReleaseAuth(dir,run,()=>now)).rejects.toThrow();
 writeFileSync(join(dir,'release-auth-session.json'),JSON.stringify({version:1,kind:'original-password-mfa-session',signedInAt:'2026-11-09T23:24:00-05:00',expiresAt:'2026-11-10T23:24:00-05:00',receipt:'fictional original session'}));
 for(let i=0;i<3;i++)await expect(withReleaseAuth(dir,run,()=>now+i*300000)).rejects.toThrow();
 expect(calls).toBe(0);
 // Even a past release deadline must not hide an already-expired session.
 expect(()=>originalSessionExpiry(JSON.parse(require('node:fs').readFileSync(join(dir,'release-auth-session.json'),'utf8')),now,now-3600000)).toThrow();
 writeFileSync(join(dir,'release-auth-session.json'),JSON.stringify({version:1,kind:'original-password-mfa-session',signedInAt:'2026-11-10T23:25:00-05:00',expiresAt:'2026-11-11T23:25:00-05:00',receipt:'fictional owner renewal'}));
 expect(await withReleaseAuth(dir,run,()=>now+1)).toBe('read');expect(calls).toBe(1);
});
