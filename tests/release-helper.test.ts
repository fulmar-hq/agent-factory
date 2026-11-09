import {test,expect} from 'bun:test';
import {command} from '../adapters/github';
test('trusted release helper offline failure and native-handle regressions',async()=>{
 const result=await command(['python3','-B','tests/alido_release_test.py'],import.meta.dir+'/..');
 expect(result).toBe('');
});
