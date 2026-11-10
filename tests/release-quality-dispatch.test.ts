import {test,expect} from 'bun:test';
import {tmpdir} from 'node:os';
import {Store} from '../tracking/store';
import {queueWake,pendingWakes,type Wake} from '../launcher/wake';
import {dispatchReleaseQuality} from '../launcher/release-quality-dispatch';
test('busy acceptance remains exclusively with pinned release source and later dispatches once',()=>{
 const s=new Store(':memory:');const w:Wake={id:'fictional-pinned',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()+60000}};
 let starts=0;try{
 s.set('owner-runtime:quality',{workspace:tmpdir(),pid:123,identity:'fictional-old-owner'});queueWake(s,w);
 expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++},()=> 'fictional-old-owner')).toBe(false);
 expect(pendingWakes(s)).toEqual([]);expect(s.get<any>('owner-wake:'+w.id).state).toBe('waiting-release-runner');
 s.set('owner-runtime:quality',{workspace:tmpdir()});
 expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++})).toBe(true);
 expect(starts).toBe(1);expect(dispatchReleaseQuality(s,w,'/fictional',()=>{starts++})).toBe(false);expect(starts).toBe(1);
 }finally{s.close();}
});
test('a pinned expired wake cannot start or become a general runnable wake',()=>{
 const s=new Store(':memory:');const w:Wake={id:'fictional-expired',owner:'quality',kind:'qa-deployed',payload:{deadline:Date.now()-1}};
 try{s.set('owner-runtime:quality',{workspace:tmpdir()});queueWake(s,w);expect(dispatchReleaseQuality(s,w,'/fictional',()=>{throw Error('must not start')})).toBe(false);expect(pendingWakes(s)).toEqual([]);expect(s.get<any>('owner-wake:'+w.id).state).toBe('expired');}finally{s.close();}
});
