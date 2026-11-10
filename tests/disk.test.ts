import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {diskReading,observeDisk} from '../launcher/disk';
test('80% warning deduplicates across ticks, records recovery and rearms',()=>{
 const s=new Store(':memory:');const warnings:string[]=[];const warn=(m:string)=>{warnings.push(m);};
 try {
  observeDisk(s,{at:1,path:'fixture',freeGiB:80,usedFraction:0.7999},warn);
  expect(warnings).toHaveLength(0);
  observeDisk(s,{at:2,path:'fixture',freeGiB:79,usedFraction:0.8},warn);
  observeDisk(s,{at:3,path:'fixture',freeGiB:78,usedFraction:0.81},warn);
  expect(warnings).toHaveLength(1);expect(warnings[0]).toContain('79.0 GiB free');
  expect(s.get('paused')).toBe(true);
  observeDisk(s,{at:4,path:'fixture',freeGiB:100,usedFraction:0.7},warn);
  observeDisk(s,{at:5,path:'fixture',freeGiB:79,usedFraction:0.8},warn);
  expect(warnings).toHaveLength(2);
 }finally{s.close();}
});
test('missing filesystem evidence stays visibly unknown and never clears pause',()=>{
 const s=new Store(':memory:');const warnings:string[]=[];
 try {
  const r=diskReading('/nonexistent-factory-disk-fixture',10);expect('error' in r).toBe(true);
  observeDisk(s,r,m=>{warnings.push(m);});observeDisk(s,{...r,at:11},m=>{warnings.push(m);});
  expect(s.get<{state:string}>('disk-capacity')?.state).toBe('unknown');expect(warnings).toHaveLength(1);expect(s.get('paused')).toBe(true);
 }finally{s.close();}
});
