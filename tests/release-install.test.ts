import {test,expect} from 'bun:test';
import {releasePath,rebindReleaseJob,loadedReleaseJob,type ReleaseJobIdentity} from '../launcher/release-install';
const expected:ReleaseJobIdentity={program:'/runtime/bun',args:['/runtime/bun','/installed/scripts/release.ts','preflight'],directory:'/installed',path:'/operator/bin:/runtime'};
const printed=(x=expected,running=false)=>`gui/501/job = {\n\tactive count = ${running?1:0}\n\tstate = ${running?'running':'not running'}\n${running?'\tpid = 123\n':''}\tprogram = ${x.program}\n\targuments = {\n${x.args.map(a=>'\t\t'+a+'\n').join('')}\t}\n\tworking directory = ${x.directory}\n\tdefault environment = {\n\t\tPATH => /wrong/default\n\t}\n\tenvironment = {\n\t\tPATH => ${x.path}\n\t}\n\tresource coalition = {\n\t\tactive count = 1\n\t}\n}`;
function fixture(options:{running?:boolean;missing?:boolean;identity?:ReleaseJobIdentity;disabled?:boolean;error?:boolean;race?:boolean;stage?:string}={}){
 const calls:string[][]=[];let prints=0,changed=false,terminated=false,running=options.running??false,checks=0;
 const identity={...expected,args:[...expected.args.slice(0,2),options.stage??'preflight']};
 const execute=async(a:string[])=>{calls.push(a);const action=a[1];
  if(action==='print-disabled')return `\tdisabled services = {\n\t\t"job" => ${options.disabled?'disabled':'enabled'}\n\t}\n`;
  if(action==='print'){
   prints++;if(options.error)throw Error('launchctl access denied');
   if(prints===1){if(options.missing)throw Error('Could not find service job');const before=printed(identity,running);if(options.race)running=true;return before;}
   return printed(options.identity??identity);
  }
  if(action==='bootout'&&running)terminated=true;
  return '';
 };
 return {execute,calls,identity,verify:()=>{checks++;},prepare:()=>{changed=true;},state:()=>({changed,terminated,checks})};
}
test('scheduled PATH includes user tools and actual Bun without shell inheritance',()=>{expect(releasePath('/fictional/operator','/fictional/runtime/bun').split(':')).toEqual(['/fictional/operator/bin','/fictional/runtime','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']);});
test('unadmitted observer start between print and bootout is safe only under verified quiescence',async()=>{
 const f=fixture({race:true,stage:'reconcile'});await rebindReleaseJob('job','/private/job.plist',501,f.identity,f.verify,f.execute,f.prepare);
 expect(f.calls.map(c=>c[1])).toEqual(['print-disabled','print','bootout','bootstrap','print']);expect(f.state()).toEqual({changed:true,terminated:true,checks:3});expect(loadedReleaseJob(printed())).toEqual(expected);
});
for(const options of [{running:true},{error:true}])test(`calendar/unreadable custody is retained ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options);await expect(rebindReleaseJob('job','/private/job.plist',501,f.identity,f.verify,f.execute,f.prepare)).rejects.toThrow();expect(f.calls.some(c=>c[1]==='bootout'||c[1]==='bootstrap')).toBe(false);expect(f.state().changed).toBe(false);expect(f.state().terminated).toBe(false);
});
test('a hold or lost quiescence blocks immediately before bootout',async()=>{
 const f=fixture({race:true,stage:'reconcile'});let checks=0;
 await expect(rebindReleaseJob('job','/private/job.plist',501,f.identity,()=>{if(++checks===2)throw Error('admission pause or release inventory changed');},f.execute,f.prepare)).rejects.toThrow('inventory changed');expect(f.calls.some(c=>c[1]==='bootout')).toBe(false);
 const held=fixture({disabled:true});await expect(rebindReleaseJob('job','/private/job.plist',501,held.identity,held.verify,held.execute,held.prepare)).rejects.toThrow('already disabled');expect(held.calls.map(c=>c[1])).toEqual(['print-disabled']);
});
test('missing jobs bootstrap once and never boot out unknown service',async()=>{const f=fixture({missing:true});await rebindReleaseJob('job','/private/job.plist',501,f.identity,f.verify,f.execute,f.prepare);expect(f.calls.filter(c=>c[1]==='bootstrap')).toHaveLength(1);expect(f.calls.some(c=>c[1]==='bootout')).toBe(false);});
// lesson: loaded-job-not-rebound (docs/lessons.md)
for(const field of ['program','args','directory','path','stage'] as const)test(`loaded ${field} requires exact value, never substring`,async()=>{
 const bad={...expected,args:[...expected.args]};if(field==='stage')bad.args[2]='production';else if(field==='args')bad.args[1]+='-old';else bad[field]+='-old';const f=fixture({identity:bad});await expect(rebindReleaseJob('job','/private/job.plist',501,f.identity,f.verify,f.execute,f.prepare)).rejects.toThrow('loaded definition differs');
});
