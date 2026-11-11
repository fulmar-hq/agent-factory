import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {root} from '../launcher/config';
import {command} from '../adapters/github';
import {loadedReleaseJob} from '../launcher/release-install';
import {scheduledJobs,type ScheduledJob,checkInstalledEnvironments,validateLoadedEnvironment} from '../launcher/job-environment';
const loaded=new Map<ScheduledJob,{file:string;identity:ReturnType<typeof loadedReleaseJob>}>();
for(const job of scheduledJobs){
 const raw=await command(['launchctl','print',`gui/${process.getuid!()}/com.agent-factory.${job}`]);
 const paths=[...raw.matchAll(/^\tpath = (.+)$/gm)];if(paths.length!==1||!paths[0][1].startsWith('/'))throw Error('loaded plist path unavailable: '+job);
 validateLoadedEnvironment(readFileSync(paths[0][1],'utf8'),raw,root,job);
 loaded.set(job,{file:paths[0][1],identity:loadedReleaseJob(raw)});
}
const checked=checkInstalledEnvironments(join(homedir(),'Library/LaunchAgents'),root,undefined,job=>loaded.get(job)!.file);
for(const row of checked)if(row.path!==loaded.get(row.job)!.identity.path)throw Error('loaded PATH differs from its plist: '+row.job);
const releases=[...loaded.entries()].filter(([job])=>job.startsWith('release.')).map(([,value])=>value.identity),preflight=loaded.get('release.preflight')!.identity;
for(const identity of releases)if(identity.program!==preflight.program||identity.directory!==preflight.directory||identity.path!==preflight.path||JSON.stringify(identity.args.slice(0,2))!==JSON.stringify(preflight.args.slice(0,2)))throw Error('release/rehearsal loaded environment or code path differs');
console.log(JSON.stringify(checked));
