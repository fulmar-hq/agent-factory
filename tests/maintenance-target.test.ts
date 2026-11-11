import {test,expect} from 'bun:test';
import {maintenanceTarget} from '../launcher/maintenance-target';
test('serial maintenance accepts one exact PR and refuses ambiguous or invalid requests',()=>{
 expect(maintenanceTarget(['--once'])).toBeUndefined();expect(maintenanceTarget(['--once','--pr','197'])).toBe(197);
 for(const args of [[],['--pr','197'],['--once','--pr','0'],['--once','--pr','1.5'],['--once','--pr','9007199254740992'],['--once','--pr','197','198']])expect(()=>maintenanceTarget(args)).toThrow('Usage');
});
