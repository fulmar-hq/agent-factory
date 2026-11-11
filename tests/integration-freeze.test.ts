import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {integrationFreeze} from '../launcher/integration-freeze';
test('dated source freeze starts and ends on its explicit instants, without changing release times',()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-freeze-')),from=Date.parse('2026-11-11T17:30:00-05:00'),until=Date.parse('2026-11-11T22:35:00-05:00');
 expect(integrationFreeze(dir,from)).toContain('Daily');
 writeFileSync(join(dir,'integration-freeze.json'),JSON.stringify({version:1,from:'2026-11-11T17:30:00-05:00',until:'2026-11-11T22:35:00-05:00',reason:'retain exact Quality proof source'}));
 expect(integrationFreeze(dir,from-1)).toBeNull();expect(integrationFreeze(dir,from)).toBe('retain exact Quality proof source');expect(integrationFreeze(dir,until-1)).toBeTruthy();expect(integrationFreeze(dir,until)).toBeNull();
 for(const bad of ['{}','not JSON',JSON.stringify({version:1,from:'2026-11-11T17:30:00-05:00',until:'2026-11-13T22:35:00-05:00',reason:'unbounded'})]){writeFileSync(join(dir,'integration-freeze.json'),bad);expect(()=>integrationFreeze(dir,from)).toThrow();}
});

test('standing freeze repeats daily, respects Toronto daylight time and cannot expire with a dated file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'standing-freeze-'));
 for(const [day,offset] of [['2026-11-11','-05:00'],['2026-11-12','-05:00'],['2027-07-01','-04:00'],['2027-03-14','-04:00'],['2027-11-07','-05:00']]){
  const at=(time:string)=>Date.parse(day+'T'+time+':00'+offset);
  expect(integrationFreeze(dir,at('17:29'))).toBeNull();expect(integrationFreeze(dir,at('17:30'))).toContain('Daily');expect(integrationFreeze(dir,at('22:34'))).toContain('Daily');expect(integrationFreeze(dir,at('22:35'))).toBeNull();
 }
 writeFileSync(join(dir,'integration-freeze.json'),JSON.stringify({version:1,from:'2026-11-11T17:30:00-05:00',until:'2026-11-11T22:35:00-05:00',reason:'old dated hold'}));
 expect(integrationFreeze(dir,Date.parse('2026-11-12T17:30:00-05:00'))).toContain('Daily');
});
