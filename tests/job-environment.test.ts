import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {scheduledJobs,scheduledExecutables,executableLocations,jobEnvironment,plistEnvironment,missingExecutables,checkInstalledEnvironments} from '../launcher/job-environment';
const home='/Users/fictional',bun=home+'/.bun/bin/bun',dir=home+'/.factory';
const locations=new Set(Object.values(executableLocations).map(p=>p.replace('HOME',home).replace('BUN',dirname(bun))));
const which=(name:string,path:string)=>{if(name.startsWith('/'))return locations.has(name)?name:null;return path.split(':').map(d=>d+'/'+name).find(p=>locations.has(p))??null;};
const plist=(env:Record<string,string>)=>`<plist><dict><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${v}</string>`).join('')}</dict></dict></plist>`;
test('every installed job resolves the full transitive executable set in its own plist PATH',()=>{
 const agents=mkdtempSync(join(tmpdir(),'job-parity-'));
 for(const job of scheduledJobs)writeFileSync(join(agents,`com.agent-factory.${job}.plist`),plist(jobEnvironment(home,bun,dir)));
 expect(checkInstalledEnvironments(agents,dir,which)).toHaveLength(scheduledJobs.length);
 // Tuesday's PATH loses ~/bin: the CI check must identify aws and gh for
 // release AND the other independent schedules, without this shell's PATH.
 for(const job of scheduledJobs){
  const good=jobEnvironment(home,bun,dir),bad={...good,PATH:good.PATH.split(':').filter(p=>p!==home+'/bin').join(':')};
  expect(missingExecutables(plistEnvironment(plist(bad)).PATH,scheduledExecutables,which)).toEqual(expect.arrayContaining(['aws','gh']));
  const file=join(agents,`com.agent-factory.${job}.plist`);writeFileSync(file,plist(bad));expect(()=>checkInstalledEnvironments(agents,dir,which)).toThrow(job);writeFileSync(file,plist(good));
 }
});
test('new or absent executables, relative PATH entries and ambiguous plist evidence fail closed',()=>{
 expect(missingExecutables(jobEnvironment(home,bun,dir).PATH,['new-release-tool'],which)).toEqual(['new-release-tool']);
 expect(()=>missingExecutables(':/usr/bin',[],which)).toThrow('absolute');expect(()=>plistEnvironment('<plist/>')).toThrow('absent');
 expect(()=>plistEnvironment(plist({...jobEnvironment(home,bun,dir)}).replace('</dict></dict>','<key>PATH</key><string>/bin</string></dict></dict>'))).toThrow('ambiguous');
});
// Audit all trusted job dependencies, including adapters and delegated Python
// helpers. Literal execution sites cannot add a binary unnoticed. Dynamic argv
// sites have exact-source audit pins: changes require rereading their complete
// executable chain and deliberately updating this small inventory.
const repo=join(import.meta.dir,'..');
function sources(path:string):string[]{return readdirSync(join(repo,path),{withFileTypes:true}).flatMap(e=>e.isDirectory()?sources(path+'/'+e.name):/\.(ts|py|cjs)$/.test(e.name)?[path+'/'+e.name]:[]);}
const files=[...sources('launcher'),...sources('adapters'),...sources('scripts'),...sources('wallet')].filter(p=>!/(?:rehearse-|qualify-delivery|install|prepare|check-job-environment|factory\.ts|watchdog)/.test(p));
const audit=JSON.parse(readFileSync(join(repo,'launchd/executable-audit.json'),'utf8')) as Record<string,string>;
test('executable inventory covers literal calls and every dynamic execution boundary has a current audit',()=>{
 const known=new Set<string>(scheduledExecutables),dynamic:Record<string,string>={};
 for(const file of files){const source=readFileSync(join(repo,file),'utf8');
  for(const match of source.matchAll(/\b(?:command|execute|spawn|spawnSync|execFileSync|read|os\.exec)\(\s*(?:\[\s*)?(['"])([^'"\n]+)\1/g)){
   const tool=match[2];if(tool.startsWith('PRAGMA ')||tool.includes(' '))continue;
   expect(known.has(tool.split('/').at(-1)!),`${file}: ${tool}`).toBe(true);
  }
  if(/\b(?:spawn|spawnSync|execFileSync|Popen|subprocess\.run)\(/.test(source))dynamic[file]=createHash('sha256').update(source).digest('hex');
 }
 expect(dynamic).toEqual(audit);
});
