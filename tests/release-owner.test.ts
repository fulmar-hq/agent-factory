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

import {AcceptanceSchema} from '../launcher/release';
test('native findings arrays preserve every finding in canonical wire evidence',()=>{
 const raw={day:'2026-11-12',revision:'a'.repeat(40),tree:'b'.repeat(40),artifact:'fictional@sha256:'+'c'.repeat(64),verdict:'ACCEPT',evidence:['Hosted tenant denial passed.','Browser interaction remains unproven.']};
 const parsed=AcceptanceSchema.parse(raw);expect(parsed.evidence).toBe(raw.evidence.join('\n'));expect(parsed.verdict).toBe('ACCEPT');expect(raw.evidence).toHaveLength(2);
 for(const evidence of [[],[''],[{}],[true],{},null])expect(()=>AcceptanceSchema.parse({...raw,evidence})).toThrow();
 expect(()=>AcceptanceSchema.parse({...raw,extra:'untrusted'})).toThrow();
});
