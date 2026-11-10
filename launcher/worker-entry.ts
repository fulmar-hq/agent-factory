import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {publisherSources,publisherBoundary,samePublisherBoundary} from './publisher-evidence';
// Capture the implementation before dynamically importing the supervisor. A
// changed source during import or work refuses publishing and cannot renew it.
const checkout=resolve(import.meta.dir,'..'),dir=process.env.FACTORY_PRIVATE_DIR??join(homedir(),'.alido-private/factory');
const before=Object.fromEntries(publisherSources.map(path=>[path,readFileSync(join(checkout,path),'utf8')]));
const {runWorker}=await import('./worker');
for(const [path,bytes] of Object.entries(before))if(readFileSync(join(checkout,path),'utf8')!==bytes)throw Error('worker implementation changed during import');
const boundary=publisherBoundary(checkout,dir);
await runWorker(process.argv[2],{boundary,assert:()=>{if(!samePublisherBoundary(boundary,publisherBoundary(checkout,dir)))throw Error('publisher implementation/policy/toolchain changed during work');}});
