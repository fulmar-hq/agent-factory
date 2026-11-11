import {test,expect} from 'bun:test';
import {releasePath,rebindReleaseJob} from '../launcher/release-install';
test('scheduled PATH includes user tools and the actual Bun directory without shell inheritance',()=>{
 expect(releasePath('/fictional/operator','/fictional/runtime/bun').split(':')).toEqual(['/fictional/operator/bin','/fictional/runtime','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']);
});
test('an existing idle job is rebound and actual loaded arguments and PATH are verified',async()=>{
 const calls:string[][]=[];let prints=0;
 const execute=async(args:string[])=>{calls.push(args);return args[1]==='print'?(++prints===1?'state = waiting':'program = /runtime/bun\narguments /installed/scripts/release.ts\nPATH => /operator/bin:/runtime'):'';};
 await rebindReleaseJob('com.example.preflight','/private/job.plist',501,['/runtime/bun','/installed/scripts/release.ts','/operator/bin:/runtime'],execute);
 expect(calls.map(c=>c[1])).toEqual(['print','bootout','bootstrap','print']);
});
test('active jobs and unexpected launchctl failures never get terminated or rebound',async()=>{
 for(const value of ['state = running','state = waiting\n pid = 123',null]){const calls:string[][]=[];let changed=false;
 await expect(rebindReleaseJob('job','/private/job.plist',501,[],async a=>{calls.push(a);if(value===null)throw Error('launchctl access denied');return value;},()=>{changed=true;})).rejects.toThrow();expect(calls).toHaveLength(1);expect(changed).toBe(false);
 }
});
test('missing jobs bootstrap once; mismatched readback refuses successful installation',async()=>{
 const calls:string[][]=[];let prints=0;
 await expect(rebindReleaseJob('job','/private/job.plist',501,['/new/source'],async a=>{calls.push(a);if(a[1]==='print'&&++prints===1)throw Error('Could not find service job');return 'old source';})).rejects.toThrow('loaded definition differs');
 expect(calls.map(c=>c[1])).toEqual(['print','bootstrap','print']);
});
