import {test,expect} from 'bun:test';
import {acceptanceProfile,assertIndependent} from '../launcher/acceptance-profile';
import {config} from './fixtures';
import {Store} from '../tracking/store';
const day='2026-11-12',through=Date.parse(day+'T22:30:00-05:00');
const ticket={version:1,repo:'fulmar-hq/alido',number:1192,owner:'quality',day,provider:'codex',model:'gpt-6.1-sol',effort:'medium',source:'fictional explicit acting-chat decision',expiresAt:through+1,excludedNatives:['fictional-release-writer']};
test('one ticket selects Codex without changing permanent Claude owner',async()=>{
 const c=config();c.owners.quality={harness:'claude',model:'opus-5.5',effort:'medium'};c.model_override='per_ticket_wins_then_per_role';
 const e=await acceptanceProfile(c,'/fictional',day,through,async()=>ticket);
 expect(e.role).toEqual({harness:'codex',model:'gpt-6.1-sol',effort:'medium'});expect(c.owners.quality.harness).toBe('claude');
 expect((await acceptanceProfile(c,'/fictional',day,through,async()=>null)).role.harness).toBe('claude');
 for(const bad of [{...ticket,day:'2026-11-13'},{...ticket,expiresAt:through},{...ticket,owner:'release'},{...ticket,excludedNatives:[]},{...ticket,provider:'claude'}])await expect(acceptanceProfile(c,'/fictional',day,through,async()=>bad)).rejects.toThrow();
 delete c.model_override;await expect(acceptanceProfile(c,'/fictional',day,through,async()=>ticket)).rejects.toThrow('policy');
});
test('writer identities cannot supply acceptance even when tuple matches',()=>{
 const s=new Store(':memory:');try{
 s.set('owner-runtime:release',{native:'fictional-release'});
 expect(()=>assertIndependent(s,'fictional-release',[])).toThrow('release writer');
 expect(()=>assertIndependent(s,'fictional-author',['fictional-author'])).toThrow('batch author');
 expect(()=>assertIndependent(s,'',[])).toThrow();
 expect(()=>assertIndependent(s,'fictional-fresh-quality',['fictional-author'])).not.toThrow();
 }finally{s.close();}
});
