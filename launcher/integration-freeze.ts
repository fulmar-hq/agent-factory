import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
const Freeze=z.object({version:z.literal(1),from:z.iso.datetime({offset:true}),until:z.iso.datetime({offset:true}),reason:z.string().min(1).max(500)}).strict();
// A dated source-install freeze leaves product workers and the release schedule
// alone. Read at every integration effect boundary; never extend it implicitly.
export function integrationFreeze(dir:string,now=Date.now()):string|null {
 let raw:string;try{raw=readFileSync(join(dir,'integration-freeze.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 const f=Freeze.parse(JSON.parse(raw)),from=Date.parse(f.from),until=Date.parse(f.until);
 if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||until-from>24*3600000)throw Error('source integration freeze must be bounded to at most24hours');
 return now>=from&&now<until?f.reason:null;
}
