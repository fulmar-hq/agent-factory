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
function disabledService(raw:string,label:string){
 const blocks=[...raw.matchAll(/^\s*disabled services = \{\n([\s\S]*?)^\s*\}/gm)];if(blocks.length!==1)throw Error('launchd disabled-service inventory unavailable');
 const rows=blocks[0][1].split('\n').filter(l=>l.trim()).map(line=>{const row=line.match(/^\s*"([^"\n]+)" => (enabled|disabled)\s*$/);if(!row)throw Error('launchd disabled-service row malformed');return {label:row[1],disabled:row[2]==='disabled'};});
 const matches=rows.filter(row=>row.label===label);if(matches.length>1)throw Error('launchd disabled-service identity ambiguous');return matches[0]?.disabled??false;
}
// Caller holds exclusive installation custody and verifies the existing
// admission pause, protected hours and empty effect inventory. Disabled alone
// does not fence a loaded launchd job. Only an unadmitted read-only reconciler
// may be interrupted; calendar release processes retain their native custody.
export async function rebindReleaseJob(label:string,path:string,uid:number,expected:ReleaseJobIdentity,assertQuiescent:()=>void,execute=command,prepare=()=>{}){
 const domain=`gui/${uid}`,service=`${domain}/${label}`;
 if(disabledService(await execute(['launchctl','print-disabled',domain]),label))throw Error(`${label} is already disabled; preserve its owner's hold`);
 assertQuiescent();
 let loaded:string|undefined;
 try{loaded=await execute(['launchctl','print',service]);}catch(error){if(!/Could not find (?:service|specified service)/i.test(String(error)))throw error;}
 if(loaded){
  const old=loadedReleaseJob(loaded),states=[...loaded.matchAll(/^\tstate = (.+)$/gm)],counts=[...loaded.matchAll(/^\tactive count = (\d+)$/gm)];
  if(old.program!==expected.program||old.args.length!==3||old.args[2]!==expected.args[2]||!old.args[1].endsWith('/scripts/release.ts'))throw Error('loaded release job identity is unknown; retain custody');
  const idle=states.length===1&&states[0][1]==='not running'&&counts.length===1&&counts[0][1]==='0'&&!/^\tpid = /m.test(loaded);
  if(!idle&&expected.args[2]!=='reconcile')throw Error(`${label} calendar process is active or unknown; retain it`);
  // Recheck synchronously immediately before bootout after all async reads.
  assertQuiescent();await execute(['launchctl','bootout',service]);
 }
 prepare();
 // The exclusive operation claim and pause remain in place through readback.
 assertQuiescent();await execute(['launchctl','bootstrap',domain,path]);
 const actual=await execute(['launchctl','print',service]),identity=loadedReleaseJob(actual);
 if(identity.program!==expected.program||identity.directory!==expected.directory||identity.path!==expected.path||JSON.stringify(identity.args)!==JSON.stringify(expected.args))throw Error(`${label} loaded definition differs; retain installation evidence`);
 return actual;
}
