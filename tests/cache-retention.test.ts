import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
test('factory cache retention preserves custody, tracked edits, Git and evidence',()=>{
 const p=spawnSync('python3',[resolve(import.meta.dir,'cache-retention.test.py')],{encoding:'utf8'});
 expect({code:p.status,stderr:p.status===0?'':p.stderr}).toEqual({code:0,stderr:''});
});
