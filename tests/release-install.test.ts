import {test,expect} from 'bun:test';
import {releasePath,rebindReleaseJob,loadedReleaseJob,type ReleaseJobIdentity} from '../launcher/release-install';
const expected:ReleaseJobIdentity={program:'/runtime/bun',args:['/runtime/bun','/installed/scripts/release.ts','preflight'],directory:'/installed',path:'/operator/bin:/runtime'};
const printed=(x=expected)=>`gui/501/job = {\n\tstate = not running\n\tprogram = ${x.program}\n\targuments = {\n${x.args.map(a=>'\t\t'+a+'\n').join('')}\t}\n\tworking directory = ${x.directory}\n\tdefault environment = {\n\t\tPATH => /wrong/default\n\t}\n\tenvironment = {\n\t\tPATH => ${x.path}\n\t}\n}`;
test('scheduled PATH includes user tools and the actual Bun directory without shell inheritance',()=>{
 expect(releasePath('/fictional/operator','/fictional/runtime/bun').split(':')).toEqual(['/fictional/operator/bin','/fictional/runtime','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']);
});
test('an existing idle job is rebound and actual loaded arguments and PATH are verified',async()=>{
 const calls:string[][]=[];let prepared=false;
 const execute=async(args:string[])=>{calls.push(args);return printed();};
 await rebindReleaseJob('com.example.preflight','/private/job.plist',501,expected,execute,()=>{prepared=true;});
 expect(calls.map(c=>c[1])).toEqual(['print','bootout','bootstrap','print']);expect(prepared).toBe(true);expect(loadedReleaseJob(printed())).toEqual(expected);
});
test('active jobs and unexpected launchctl failures never change the definition or get rebound',async()=>{
 for(const value of ['state = running','state = waiting\n pid = 123',null]){const calls:string[][]=[];let changed=false;
 await expect(rebindReleaseJob('job','/private/job.plist',501,expected,async a=>{calls.push(a);if(value===null)throw Error('launchctl access denied');return value;},()=>{changed=true;})).rejects.toThrow();expect(calls).toHaveLength(1);expect(changed).toBe(false);
 }
});
test('missing jobs bootstrap once; partial readback never verifies installation',async()=>{
 const calls:string[][]=[];let prints=0;
 await expect(rebindReleaseJob('job','/private/job.plist',501,expected,async a=>{calls.push(a);if(a[1]==='print'&&++prints===1)throw Error('Could not find service job');return 'old source';})).rejects.toThrow();
 expect(calls.map(c=>c[1])).toEqual(['print','bootstrap','print']);
});
for(const field of ['program','args','directory','path','stage'] as const)test(`loaded ${field} requires an exact value, never a substring`,async()=>{
 const bad={...expected,args:[...expected.args]};if(field==='stage')bad.args[2]='production';else if(field==='args')bad.args[1]+='-old';else bad[field]+='-old';
 let prints=0;
 await expect(rebindReleaseJob('job','/private/job.plist',501,expected,async a=>a[1]==='print'&&++prints===2?printed(bad):printed())).rejects.toThrow('loaded definition differs');
});
