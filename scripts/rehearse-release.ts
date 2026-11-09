import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../tracking/store';
import {root} from '../launcher/config';
import {ReleaseExecutor,recordAcceptance,type ReleasePort,type ReleaseStep} from '../launcher/release';
const revision='a'.repeat(40),tree='b'.repeat(40),artifact='sha256:'+'c'.repeat(64),day='2026-11-09';
// This isolated synthetic port never imports the live GitHub adapter or owner runner.
if(process.argv[2]==='--fixture-child'){
 const [dir,scenario,stage,time]=process.argv.slice(3);
 if(!dir || !scenario || !time || !stage)throw Error('fixture arguments missing');
 const s=new Store(join(dir,`${scenario}.sqlite`)),now=Date.parse(`${day}T${time}:00-05:00`);
 const port:ReleasePort={snapshot:async()=>({revision,tree,holdId:'fictional-hold',held:true,overlap:false}),perform:async(step)=>{
  s.event(`fixture-effect:${step}`,'fictional-effect',{step},'Fictional rehearsal only',now);
  if(scenario==='uncertain' && step==='preflight')throw Error('fictional lost remote response');
  return {step};
 },observe:async(step)=>({state:scenario==='failed-check' && step==='preflight'?'failure':'success',evidence:{artifact,completedAt:now,holdId:'fictional-hold',production:'d'.repeat(40),tree,healthy:true,rollback:'fictional-stopped-pair'}})};
 try{
  if(stage==='accept')recordAcceptance(s,`qa-deployed:${day}:${tree}`,'fictional-native',{day,revision,tree,artifact,verdict:'ACCEPT',evidence:'SYNTHETIC: fixture acceptance only'},now);
  else await new ReleaseExecutor(s,port,async()=>null,()=>now).run(stage as 'preflight'|'qa'|'production'|'reconcile');
 }finally{s.close();}
}else{
 const runs=join(root,'runs');mkdirSync(runs,{recursive:true,mode:0o700});const dir=mkdtempSync(join(runs,'release-rehearsal-'));
 const run=async(scenario:string,stage:string,time:string)=>{
  const child=Bun.spawn([process.execPath,import.meta.path,'--fixture-child',dir,scenario,stage,time],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:dir}});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0)throw Error(`Rehearsal child failed: ${err}${out}`);
 };
 for(const scenario of ['night-one','night-two']){
  await run(scenario,'preflight','19:00');await run(scenario,'preflight','19:00');
  await run(scenario,'qa','20:00');await run(scenario,'reconcile','20:01');
  await run(scenario,'accept','20:02');await run(scenario,'production','21:30');
  await run(scenario,'reconcile','21:31');await run(scenario,'production','21:30');
 }
 await run('failed-check','preflight','19:00');await run('failed-check','qa','20:00');
 await run('late','qa','20:01');await run('uncertain','preflight','19:00');await run('uncertain','preflight','19:00');
 const results:Record<string,unknown>={};let pass=true;
 for(const scenario of ['night-one','night-two','failed-check','late','uncertain']){
  const s=new Store(join(dir,`${scenario}.sqlite`));try{
   const effects=(s.db.query("SELECT data FROM events WHERE kind='fictional-effect'").all() as {data:string}[]).map(r=>JSON.parse(r.data).step);
   const expected=scenario.startsWith('night-')?['preflight','qa','promote','readback']:scenario==='late'?[]:['preflight'];
   const ok=JSON.stringify(effects)===JSON.stringify(expected) && (!scenario.startsWith('night-')||s.get<{state:string}>(`executor:${day}:readback`)?.state==='success');
   pass&&=ok;results[scenario]={pass:ok,effects,receiptCount:s.rows('events').length};
  }finally{s.close();}
 }
 const summary={pass,synthetic:true,modelCalls:0,chatRequired:false,eachTransitionFreshProcess:true,twoLiveNightsProven:false,results};
 writeFileSync(join(dir,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify({dir,...summary}));if(!pass)process.exitCode=1;
}
