import {mkdirSync,existsSync,copyFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {root} from '../launcher/config';
import {command} from '../adapters/github';
const zone=await command(['readlink','/etc/localtime']);if(!zone.trim().endsWith('/America/Toronto'))throw Error('launchd calendar requires system timezone America/Toronto');
const install=process.argv.includes('--install');
const repo=resolve(import.meta.dir,'..');
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const jobs=[['preflight',19,0],['qa',20,0],['production',21,30],['reconcile',null,null]] as const;
const archive=join(root,'receipts',`release-install-${Date.now()}`);mkdirSync(archive,{recursive:true,mode:0o700});
for(const [stage,hour,minute] of jobs){
 const label=`com.agent-factory.release.${stage}`,path=join(root,`${label}.plist`);
 if(existsSync(path))copyFileSync(path,join(archive,`${label}.plist`));
 const schedule=hour===null?'<key>StartInterval</key><integer>30</integer>':`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
 const body=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(repo,'scripts/release.ts'))}</string><string>${stage}</string></array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict><key>FACTORY_PRIVATE_DIR</key><string>${xml(root)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>TZ</key><string>America/Toronto</string></dict>${schedule}<key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${xml(join(root,'release.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root,'release.error.log'))}</string></dict></plist>\n`;
 writeFileSync(path,body,{mode:0o600});await command(['plutil','-lint',path]);
 if(install){
  const installed=join(homedir(),'Library/LaunchAgents',`${label}.plist`);mkdirSync(resolve(installed,'..'),{recursive:true});
  if(existsSync(installed))copyFileSync(installed,join(archive,`${label}.installed.plist`));
  copyFileSync(path,installed);
  try{await command(['launchctl','print',`gui/${process.getuid!()}/${label}`]);}
  catch{await command(['launchctl','bootstrap',`gui/${process.getuid!()}`,installed]);}
  await command(['launchctl','print',`gui/${process.getuid!()}/${label}`]);
 }
 console.log(`${install?'installed':'prepared'} ${label}`);
}
writeFileSync(join(archive,'undo.txt'),'Undo: launchctl bootout gui/UID/com.agent-factory.release.{preflight,qa,production,reconcile}; archive the installed plists. Restore archived prior definitions only after reconciling effects. Never delete release receipts or reset claims.\n');
