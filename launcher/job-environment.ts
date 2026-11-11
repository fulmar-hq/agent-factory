import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {releasePath} from './release-install';
export const scheduledJobs=['tick','product-top-up','health','maintenance','release.preflight','release.qa','release.production','release.reconcile','release.rehearsal-early','release.rehearsal-late'] as const;
export type ScheduledJob=typeof scheduledJobs[number];
// Union of the scheduled entry points' transitive executable dependencies. An
// executable is a dependency even when reached only on a failure/recovery path.
export const scheduledExecutables=['aws','gh','git','python3','codex','claude','node','session-manager-plugin','bun','script','ps','df','ssh','curl','tar','cp','open','lsof','security','osascript','sh','bash','env','readlink','launchctl','plutil','chmod','find','du','sysctl'] as const;
export const fixedExecutables=['/bin/bash','/bin/df','/bin/ps','/bin/sh','/usr/bin/env','/usr/bin/git','/usr/bin/python3','/usr/sbin/lsof','/usr/sbin/sysctl'] as const;
export const executableLocations:Record<typeof scheduledExecutables[number],string>={aws:'HOME/bin/aws',gh:'HOME/bin/gh',git:'/usr/bin/git',python3:'/usr/bin/python3',codex:'BUN/codex',claude:'HOME/bin/claude',node:'HOME/bin/node','session-manager-plugin':'HOME/bin/session-manager-plugin',bun:'BUN/bun',script:'/usr/bin/script',ps:'/bin/ps',df:'/bin/df',ssh:'/usr/bin/ssh',curl:'/usr/bin/curl',tar:'/usr/bin/tar',cp:'/bin/cp',open:'/usr/bin/open',lsof:'/usr/sbin/lsof',security:'/usr/bin/security',osascript:'/usr/bin/osascript',sh:'/bin/sh',bash:'/bin/bash',env:'/usr/bin/env',readlink:'/usr/bin/readlink',launchctl:'/bin/launchctl',plutil:'/usr/bin/plutil',chmod:'/bin/chmod',find:'/usr/bin/find',du:'/usr/bin/du',sysctl:'/usr/sbin/sysctl'};
export function jobEnvironment(home:string,bun:string,dir:string){return {FACTORY_PRIVATE_DIR:dir,PATH:releasePath(home,bun),TZ:'America/Toronto'};}
export function missingExecutables(path:string,executables:readonly string[]=[...scheduledExecutables,...fixedExecutables],which=(name:string,p:string)=>Bun.which(name,{PATH:p})):string[]{
 if(!path||path.split(':').some(p=>!p.startsWith('/')))throw Error('scheduled PATH must contain only absolute directories');
 return executables.filter(name=>!which(name,path));
}
const unxml=(value:string)=>value.replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
// Deliberately small reader for our generated plist shape. Ambiguous or absent
// PATH/environment is an error rather than a fallback to the invoking shell.
export function plistEnvironment(xml:string){
 const blocks=[...xml.matchAll(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)];
 if(blocks.length!==1)throw Error('installed job environment absent or ambiguous');
 const field=(name:string,optional=false)=>{const rows=[...blocks[0][1].matchAll(new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`,'g'))];if(optional&&rows.length===0)return undefined;if(rows.length!==1)throw Error(`installed job ${name} absent or ambiguous`);return unxml(rows[0][1]);};
 return {FACTORY_PRIVATE_DIR:field('FACTORY_PRIVATE_DIR')!,PATH:field('PATH')!,TZ:field('TZ',true)};
}
export function checkInstalledEnvironments(agents:string,dir:string,which=(name:string,p:string)=>Bun.which(name,{PATH:p}),locate=(job:ScheduledJob)=>join(job==='tick'?dir:agents,`com.agent-factory.${job}.plist`)){
 return scheduledJobs.map(job=>{
  const file=locate(job);if(!existsSync(file))throw Error('scheduled plist missing: '+job);
  const env=plistEnvironment(readFileSync(file,'utf8'));
  if(env.FACTORY_PRIVATE_DIR!==dir||(env.TZ!==undefined&&env.TZ!=='America/Toronto'||job.startsWith('release.')&&env.TZ!=='America/Toronto'))throw Error('installed job private directory/timezone differs: '+job);
  const missing=missingExecutables(env.PATH,[...scheduledExecutables,...fixedExecutables],which);if(missing.length)throw Error(`${job}: executables missing under installed PATH: ${missing.join(', ')}`);
  return {job,path:env.PATH,executables:scheduledExecutables.length+fixedExecutables.length};
 });
}

export function validateLoadedEnvironment(xml:string,raw:string,dir:string,job:ScheduledJob){
 const expected=plistEnvironment(xml),blocks=[...raw.matchAll(/^\tenvironment = \{\n([\s\S]*?)^\t\}/gm)];
 if(blocks.length!==1)throw Error('loaded environment absent or ambiguous: '+job);
 const field=(name:string,optional=false)=>{const rows=[...blocks[0][1].matchAll(new RegExp(`^\\t\\t${name} => (.+)$`,'gm'))];if(optional&&rows.length===0)return undefined;if(rows.length!==1)throw Error('loaded '+name+' absent or ambiguous: '+job);return rows[0][1];};
 const actual={FACTORY_PRIVATE_DIR:field('FACTORY_PRIVATE_DIR')!,PATH:field('PATH')!,TZ:field('TZ',true)};
 if(actual.FACTORY_PRIVATE_DIR!==dir||actual.FACTORY_PRIVATE_DIR!==expected.FACTORY_PRIVATE_DIR||actual.PATH!==expected.PATH||actual.TZ!==expected.TZ)throw Error('loaded private directory, PATH or timezone differs from its plist: '+job);
 return actual;
}
