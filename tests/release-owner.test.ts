import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownerSpec} from '../launcher/owner';
import {ticket} from './fixtures';
test('Quality scratch has read/write working-directory authority; controller siblings remain denied',()=>{
 const home=process.env.HOME,dir=mkdtempSync(join(tmpdir(),'quality-policy-'));process.env.HOME=dir;
 try{
 const scratch=join(dir,'scratch');mkdirSync(scratch);const spec=ownerSpec({...ticket(),provider:'claude'},'/fictional/source',scratch);
 expect(spec.argv).toContain('--add-dir');expect(spec.settings?.sandbox.filesystem.allowRead).toContain(scratch);
 expect(spec.settings?.sandbox.filesystem.allowWrite).toEqual([scratch]);expect(spec.settings?.sandbox.filesystem.denyWrite).toContain('/fictional/source');
 expect(spec.settings?.sandbox.filesystem.denyWrite.some(p=>scratch===p||scratch.startsWith(p+'/'))).toBe(false);
 }finally{process.env.HOME=home;}
});
