import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {integrationFreeze} from '../launcher/integration-freeze';
test('dated source freeze starts and ends on its explicit instants, without changing release times',()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-freeze-')),from=Date.parse('2026-11-11T17:30:00-05:00'),until=Date.parse('2026-11-11T22:35:00-05:00');
 expect(integrationFreeze(dir,from)).toBeNull();
 writeFileSync(join(dir,'integration-freeze.json'),JSON.stringify({version:1,from:'2026-11-11T17:30:00-05:00',until:'2026-11-11T22:35:00-05:00',reason:'retain exact Quality proof source'}));
 expect(integrationFreeze(dir,from-1)).toBeNull();expect(integrationFreeze(dir,from)).toBe('retain exact Quality proof source');expect(integrationFreeze(dir,until-1)).toBeTruthy();expect(integrationFreeze(dir,until)).toBeNull();
 for(const bad of ['{}','not JSON',JSON.stringify({version:1,from:'2026-11-11T17:30:00-05:00',until:'2026-11-13T22:35:00-05:00',reason:'unbounded'})]){writeFileSync(join(dir,'integration-freeze.json'),bad);expect(()=>integrationFreeze(dir,from)).toThrow();}
});
