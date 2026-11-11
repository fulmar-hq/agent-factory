import {jobEnvironment,missingExecutables} from '../launcher/job-environment';
import {mkdirSync,existsSync,copyFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {assertReleaseInstallQuiescent} from '../launcher/release-install-quiescence';
import {rebindReleaseJob} from '../launcher/release-install';
import {homedir} from 'node:os';
import {root} from '../launcher/config';
import {processIdentity} from '../launcher/process';
import {command} from '../adapters/github';
const zone=await command(['readlink','/etc/localtime']);if(!zone.trim().endsWith('/America/Toronto'))throw Error('launchd calendar requires system timezone America/Toronto');
const install=process.argv.includes('--install');
// The registered installation owns scheduled jobs, regardless of which
// worktree the installer was invoked from. Never pin launchd to a trial copy.
const repositories=await Bun.file(join(root,'repositories.json')).json();
const repo=realpathSync(repositories['fulmar-hq/agent-factory']);
if((await command(['git','branch','--show-current'],repo)).trim()!=='main'||(await command(['git','status','--porcelain'],repo)).trim()||!(await command(['git','remote','get-url','origin'],repo)).trim().match(/^https:\/\/github.com\/fulmar-hq\/agent-factory(?:\.git)?$/))throw Error('clean registered factory main required');
const environment=jobEnvironment(homedir(),process.execPath,root),pathEnv=environment.PATH;
// Definition preparation is portable and starts no jobs. Actual installation
// must prove both PATH names and fixed Mac interpreter paths on the target.
if(install){const missing=missingExecutables(pathEnv);if(missing.length)throw Error(`release tools missing from scheduled PATH: ${missing.join(', ')}`);}
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const jobs=[['preflight',19,0],['qa',20,0],['production',21,30],['reconcile',null,null],['rehearsal-early',14,0],['rehearsal-late',17,40]] as const;
const archive=join(root,'receipts',`release-install-${Date.now()}`);mkdirSync(archive,{recursive:true,mode:0o700});
// Preparation starts no job/process and keeps an exclusive filesystem claim.
// Only effect-bearing installation requires native process-identity proof.
const identity=install?processIdentity(process.pid):undefined;if(install&&!identity)throw Error('installer process identity unavailable');
const lock=join(root,'release-install-active');mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'claim.json'),JSON.stringify({pid:process.pid,identity,at:Date.now(),repo,install}),{mode:0o600});
try{
for(const [stage,hour,minute] of jobs){
 const args=stage.startsWith('rehearsal-')?['rehearsal',stage==='rehearsal-early'?'14:00':'17:40']:[stage];
 const label=`com.agent-factory.release.${stage}`,path=join(root,`${label}.plist`);
 if(existsSync(path))copyFileSync(path,join(archive,`${label}.plist`));
 const schedule=hour===null?'<key>StartInterval</key><integer>30</integer>':`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
 const body=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(repo,'scripts/release.ts'))}</string>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict><key>FACTORY_PRIVATE_DIR</key><string>${xml(root)}</string><key>PATH</key><string>${xml(pathEnv)}</string><key>TZ</key><string>America/Toronto</string></dict>${schedule}<key>RunAtLoad</key><false/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${xml(join(root,'release.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root,'release.error.log'))}</string></dict></plist>\n`;
 writeFileSync(path,body,{mode:0o600});await command(['plutil','-lint',path]);
 if(install){
  const installed=join(homedir(),'Library/LaunchAgents',`${label}.plist`);mkdirSync(resolve(installed,'..'),{recursive:true});
  if(existsSync(installed))copyFileSync(installed,join(archive,`${label}.installed.plist`));
  await rebindReleaseJob(label,installed,process.getuid!(),{program:process.execPath,args:[process.execPath,join(repo,'scripts/release.ts'),...args],directory:repo,path:pathEnv},()=>assertReleaseInstallQuiescent(root),command,()=>copyFileSync(path,installed));
 }
 console.log(`${install?'installed':'prepared'} ${label}`);
}
writeFileSync(join(archive,'undo.txt'),jobs.map(([stage])=>`launchctl bootout gui/${process.getuid!()}/com.agent-factory.release.${stage}`).join('\n')+'\nArchive installed plists. Restore prior definitions only after reconciling effects. Retain release receipts and claims.\n');

}finally{renameSync(lock,join(archive,'completed-custody'));}
