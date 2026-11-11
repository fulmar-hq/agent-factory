import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {config} from './fixtures';
import {createHash} from 'node:crypto';
import {scheduledJobs,scheduledExecutables,executableLocations,jobEnvironment,plistEnvironment,missingExecutables,checkInstalledEnvironments} from '../launcher/job-environment';
const home='/Users/fictional',bun=home+'/.bun/bin/bun',dir=home+'/.factory';
const locations=new Set(Object.values(executableLocations).map(p=>p.replace('HOME',home).replace('BUN',dirname(bun))));
const which=(name:string,path:string)=>{if(name.startsWith('/'))return locations.has(name)?name:null;return path.split(':').map(d=>d+'/'+name).find(p=>locations.has(p))??null;};
const plist=(env:Record<string,string>)=>`<plist><dict><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${v}</string>`).join('')}</dict></dict></plist>`;
test('every installed job resolves the full transitive executable set in its own plist PATH',()=>{
 const agents=mkdtempSync(join(tmpdir(),'job-parity-'));
 for(const job of scheduledJobs)writeFileSync(join(agents,`com.agent-factory.${job}.plist`),plist(jobEnvironment(home,bun,dir)));
 expect(checkInstalledEnvironments(agents,dir,which,job=>join(agents,`com.agent-factory.${job}.plist`))).toHaveLength(scheduledJobs.length);
 // Tuesday's PATH loses ~/bin: the CI check must identify aws and gh for
 // release AND the other independent schedules, without this shell's PATH.
 for(const job of scheduledJobs){
  const good=jobEnvironment(home,bun,dir),bad={...good,PATH:good.PATH.split(':').filter(p=>p!==home+'/bin').join(':')};
  expect(missingExecutables(plistEnvironment(plist(bad)).PATH,scheduledExecutables,which)).toEqual(expect.arrayContaining(['aws','gh']));
  const file=join(agents,`com.agent-factory.${job}.plist`);writeFileSync(file,plist(bad));expect(()=>checkInstalledEnvironments(agents,dir,which,job=>join(agents,`com.agent-factory.${job}.plist`))).toThrow(job);writeFileSync(file,plist(good));
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

test('mixed documented installation locations use the private tick definition, not a stale Library copy',()=>{
 const root=mkdtempSync(join(tmpdir(),'mixed-jobs-')),agents=join(root,'agents');mkdirSync(agents);
 for(const job of scheduledJobs)writeFileSync(join(job==='tick'?root:agents,`com.agent-factory.${job}.plist`),plist(jobEnvironment(home,bun,root)));
 writeFileSync(join(agents,'com.agent-factory.tick.plist'),plist({...jobEnvironment(home,bun,root),PATH:'/bin'}));
 expect(checkInstalledEnvironments(agents,root,which)).toHaveLength(scheduledJobs.length);
 writeFileSync(join(root,'com.agent-factory.tick.plist'),plist({...jobEnvironment(home,bun,root),PATH:'/bin'}));
 expect(()=>checkInstalledEnvironments(agents,root,which)).toThrow('tick');
});
test('actual preparers emit resolvable scheduled plists even under a hostile invoking PATH',async()=>{
 const root=mkdtempSync(join(tmpdir(),'actual-job-preparers-')),fixtureHome=join(root,'home'),privateDir=join(root,'private'),shim=join(root,'commands');for(const p of [fixtureHome,privateDir,shim,join(fixtureHome,'bin')])mkdirSync(p,{recursive:true});
 writeFileSync(join(privateDir,'config.yaml'),JSON.stringify(config()));writeFileSync(join(privateDir,'repositories.json'),JSON.stringify({'fulmar-hq/agent-factory':repo}));
 const env={HOME:fixtureHome,PATH:shim+':/usr/bin:/bin',FACTORY_PRIVATE_DIR:privateDir};
 const run=async(script:string)=>{const p=Bun.spawn([process.execPath,join(repo,'scripts',script)],{env,stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect({code,err}).toEqual({code:0,err:''});return out;};
 await run('prepare.ts');
 // Stub only external installer read/lint operations. No launchd load, AWS,
 // credential or model command is allowed by these executable fixtures.
 for(const tool of scheduledExecutables)writeFileSync(join(fixtureHome,'bin',tool),'#!/bin/sh\nexit 91\n',{mode:0o700});
 writeFileSync(join(shim,'readlink'),'#!/bin/sh\nprintf /usr/share/zoneinfo/America/Toronto\n',{mode:0o700});
 writeFileSync(join(shim,'plutil'),'#!/bin/sh\nexit 0\n',{mode:0o700});
 writeFileSync(join(shim,'git'),'#!/bin/sh\ncase "$*" in "branch --show-current") printf main;; "status --porcelain") :;; "remote get-url origin") printf https://github.com/fulmar-hq/agent-factory.git;; *) exit 92;; esac\n',{mode:0o700});
 await run('install-release.ts');
 const available=new Set(Object.values(executableLocations).map(p=>p.replace('HOME',fixtureHome).replace('BUN',dirname(process.execPath))));
 const resolve=(name:string,path:string)=>name.startsWith('/')?(available.has(name)?name:null):path.split(':').map(d=>d+'/'+name).find(p=>available.has(p))??null;
 const actual=checkInstalledEnvironments(privateDir,privateDir,resolve,job=>join(privateDir,`com.agent-factory.${job}.plist`));expect(actual).toHaveLength(scheduledJobs.length);
 for(const row of actual)expect(row.path).not.toBe(env.PATH);
},20000);
