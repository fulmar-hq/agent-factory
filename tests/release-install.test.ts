import {test,expect} from 'bun:test';
import {releasePath,rebindReleaseJob,loadedReleaseJob,type ReleaseJobIdentity} from '../launcher/release-install';
const expected:ReleaseJobIdentity={program:'/runtime/bun',args:['/runtime/bun','/installed/scripts/release.ts','preflight'],directory:'/installed',path:'/operator/bin:/runtime'};
const printed=(x=expected)=>`gui/501/job = {\n\tactive count = 0\n\tstate = not running\n\tprogram = ${x.program}\n\targuments = {\n${x.args.map(a=>'\t\t'+a+'\n').join('')}\t}\n\tworking directory = ${x.directory}\n\tdefault environment = {\n\t\tPATH => /wrong/default\n\t}\n\tenvironment = {\n\t\tPATH => ${x.path}\n\t}\n\tresource coalition = {\n\t\tactive count = 1\n\t}\n}`;
function fixture(options:{running?:boolean;missing?:boolean;identity?:ReleaseJobIdentity;disabled?:boolean;error?:boolean;race?:boolean}={}){
 const calls:string[][]=[];let disabled=options.disabled??false,prints=0,changed=false,terminated=false,running=options.running??false;
 const execute=async(a:string[])=>{calls.push(a);const action=a[1];
  if(action==='print-disabled')return `\tdisabled services = {\n\t\t"job" => ${disabled?'disabled':'enabled'}\n\t}\n`;
  if(action==='disable'){disabled=true;return '';}
  if(action==='enable'){disabled=false;return '';}
  if(action==='print'){
   prints++;if(options.error)throw Error('launchctl access denied');
   if(prints===1){if(options.race&&!disabled)running=true;if(options.missing)throw Error('Could not find service job');return running?'\tactive count = 1\n\tstate = running\n\tpid = 123':printed();}
   return printed(options.identity??expected);
  }
  if(action==='bootout'&&running)terminated=true;
  return '';
 };
 return {execute,calls,prepare:()=>{changed=true;},state:()=>({disabled,changed,terminated})};
}
test('scheduled PATH includes user tools and actual Bun without shell inheritance',()=>{expect(releasePath('/fictional/operator','/fictional/runtime/bun').split(':')).toEqual(['/fictional/operator/bin','/fictional/runtime','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']);});
test('rebind fences scheduled starts before final idle read and restores normal schedules',async()=>{
 const f=fixture({race:true});await rebindReleaseJob('job','/private/job.plist',501,expected,f.execute,f.prepare);
 expect(f.calls.map(c=>c[1])).toEqual(['print-disabled','disable','print-disabled','print','bootout','enable','bootstrap','print']);
 expect(f.state()).toEqual({disabled:false,changed:true,terminated:false});expect(loadedReleaseJob(printed())).toEqual(expected);
});
for(const options of [{running:true},{error:true}])test(`running/unreadable custody refuses without termination or definition changes ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options);await expect(rebindReleaseJob('job','/private/job.plist',501,expected,f.execute,f.prepare)).rejects.toThrow();
 expect(f.calls.some(c=>c[1]==='bootout'||c[1]==='bootstrap')).toBe(false);expect(f.state()).toEqual({disabled:false,changed:false,terminated:false});
});
test('an existing disabled hold is preserved without enabling or installation',async()=>{
 const f=fixture({disabled:true});await expect(rebindReleaseJob('job','/private/job.plist',501,expected,f.execute,f.prepare)).rejects.toThrow('already disabled');expect(f.calls.map(c=>c[1])).toEqual(['print-disabled']);expect(f.state().disabled).toBe(true);
});
test('missing jobs bootstrap once and never boot out an unknown service',async()=>{
 const f=fixture({missing:true});await rebindReleaseJob('job','/private/job.plist',501,expected,f.execute,f.prepare);expect(f.calls.filter(c=>c[1]==='bootstrap')).toHaveLength(1);expect(f.calls.some(c=>c[1]==='bootout')).toBe(false);
});
for(const field of ['program','args','directory','path','stage'] as const)test(`loaded ${field} requires an exact value, never a substring`,async()=>{
 const bad={...expected,args:[...expected.args]};if(field==='stage')bad.args[2]='production';else if(field==='args')bad.args[1]+='-old';else bad[field]+='-old';
 const f=fixture({identity:bad});await expect(rebindReleaseJob('job','/private/job.plist',501,expected,f.execute,f.prepare)).rejects.toThrow('loaded definition differs');
});
test('an unverified disabled-state interlock cannot boot out a job',async()=>{
 const f=fixture();await expect(rebindReleaseJob('job','/private/job.plist',501,expected,async a=>a[1]==='print-disabled'?'\tdisabled services = {\n}\n':f.execute(a),f.prepare)).rejects.toThrow('interlock not verified');expect(f.calls.some(c=>c[1]==='bootout')).toBe(false);expect(f.state().disabled).toBe(false);
});
