import {dirname} from 'node:path';
import {command} from '../adapters/github';
export const releaseTools=['aws','gh','git','python3','codex','claude','node','session-manager-plugin','bun','script','ps','df','ssh','curl','tar'] as const;
export function releasePath(home:string,bun:string){return [...new Set([`${home}/bin`,dirname(bun),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'])].join(':');}
export type ReleaseJobIdentity={program:string;args:string[];directory:string;path:string};
export function loadedReleaseJob(raw:string):ReleaseJobIdentity {
 const field=(name:string)=>{const hits=[...raw.matchAll(new RegExp('^\\t'+name+' = (.+)$','gm'))];if(hits.length!==1)throw Error('loaded job field unavailable or ambiguous: '+name);return hits[0][1];};
 const block=(name:string)=>{const hits=[...raw.matchAll(new RegExp('^\\t'+name+' = \\{\\n([\\s\\S]*?)^\\t\\}','gm'))];if(hits.length!==1)throw Error('loaded job block unavailable or ambiguous: '+name);return hits[0][1];};
 const args=block('arguments').split('\n').filter(Boolean).map(line=>{if(!line.startsWith('\t\t'))throw Error('loaded argument malformed');return line.slice(2);});
 const paths=[...block('environment').matchAll(/^\t\tPATH => (.+)$/gm)];if(paths.length!==1)throw Error('loaded job PATH unavailable or ambiguous');
 return {program:field('program'),args,directory:field('working directory'),path:paths[0][1]};
}
// A copied plist does not change a loaded job. Rebind an idle job explicitly;
// never terminate an active release/reconciliation process during installation.
export async function rebindReleaseJob(label:string,path:string,uid:number,expected:ReleaseJobIdentity,execute=command,prepare=()=>{}){
 const service=`gui/${uid}/${label}`;let loaded:string|undefined;
 try{loaded=await execute(['launchctl','print',service]);}catch(error){if(!/Could not find (?:service|specified service)/i.test(String(error)))throw error;}
 if(loaded&&/\bpid = [1-9]\d*|\bstate = running\b/.test(loaded))throw Error(`${label} is running; retain its custody and retry installation after it exits`);
 if(loaded)await execute(['launchctl','bootout',service]);
 prepare();
 await execute(['launchctl','bootstrap',`gui/${uid}`,path]);
 const actual=await execute(['launchctl','print',service]);
 const identity=loadedReleaseJob(actual);
 if(identity.program!==expected.program||identity.directory!==expected.directory||identity.path!==expected.path||JSON.stringify(identity.args)!==JSON.stringify(expected.args))throw Error(`${label} loaded definition differs; retain installation evidence`);
 return actual;
}
