import {dirname} from 'node:path';
// Scheduled jobs get an explicit PATH and private directory, never the shell's.
export function jobEnvironment(home:string,bun:string,dir:string){
 const path=[...new Set([`${home}/bin`,dirname(bun),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'])].join(':');
 return {FACTORY_PRIVATE_DIR:dir,PATH:path,TZ:'America/Toronto'};
}
