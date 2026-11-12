import {spawnSync} from 'node:child_process';
import {test,expect} from 'bun:test';
import {collectHostedAcceptance,hostCommand,validHostedResult} from '../adapters/hosted-acceptance';
const {probe}=require('../scripts/hosted-acceptance.cjs');
const context={revision:'a'.repeat(40),tree:'b'.repeat(40),artifact:'fictional.example/qa@sha256:'+'c'.repeat(64)};
function harness(options:{failRequest?:boolean;failExpiry?:boolean;realBusiness?:boolean;tenantLeak?:boolean}={}) {
 const calls:{sql:string;values?:unknown[]}[]=[],requests:any[]=[];
 class Client {
  async connect(){} async end(){}
  async query(sql:string,values?:unknown[]) {
   calls.push({sql,values});
   if(sql.includes('from pg_roles'))return {rows:[{rolsuper:false,rolbypassrls:false}]};
   if(sql.includes('from auth_user'))return {rows:[{id:'fictional-user',email_verified:true,two_factor_enabled:false}]};
   if(sql.includes('from memberships'))return {rows:[{business_id:'qa-synthetic-other-business',role:'owner'}]};
   if(sql.includes('from businesses'))return {rows:[{id:values?.[0],name:options.realBusiness?'Real business':'Fictional (QA synthetic)'}]};
   if(sql.startsWith('update auth_session')) {if(options.failExpiry)throw Error('sensitive driver error');return {rows:[{expired:true}]};}
   return {rows:[]};
  }
 }
 const env={QA_ENVIRONMENT:'true',OUTBOUND_ENABLED:'false',BETTER_AUTH_URL:'https://qa.goalido.com',DATABASE_URL:'postgres://synthetic:secret@alido-qa-db.cvceikyc41bm.ca-central-1.rds.amazonaws.com/alido',DATABASE_CA_FILE:'/fictional/ca',BETTER_AUTH_SECRET:'fictional-secret'};
 const fetch=async (url:string,init:any)=>{
  requests.push({url,init});
  if(options.failRequest)throw Error('sensitive network error');
  if(url.endsWith('/api/health'))return Response.json({status:'ok'});
  if(url.includes('/api/businesses/')) {
   if(!init.headers.cookie)return Response.json({error:'unauthenticated'},{status:401});
   if(url.endsWith('qa-synthetic-window-coverings'))return options.tenantLeak?Response.json({business:{id:'qa-synthetic-window-coverings'}}):Response.json({error:'forbidden'},{status:403});
   return Response.json({business:{id:'qa-synthetic-other-business'},role:'owner',secret:'response body must not escape'});
  }
  if(url.includes('/product-preferences'))return Response.json({language:'en'});
  return new Response('<html><title>Fictional</title></html>');
 };
 return {calls,requests,deps:{env,Client,readFile:()=>'',fetch}};
}
function hostResult(probe:any) {
 return {checks:Object.fromEntries(['alido-qa-web:source','alido-qa-web:running','alido-qa-web:artifact','alido-qa-web:rollback','alido-qa-worker:source','alido-qa-worker:running','alido-qa-worker:artifact','alido-qa-worker:rollback','webHealthy'].map(k=>[k,true])),probe};
}
test('synthetic HTTP lifecycle proves own read, tenant/unsigned denial and expires one retained session',async()=>{
 const h=harness(),result=await probe(h.deps);
 expect(validHostedResult(hostResult(result))).toBe(true);
 expect(h.calls.filter(c=>c.sql.startsWith('insert into auth_session'))).toHaveLength(1);
 expect(h.calls.filter(c=>c.sql.startsWith('update auth_session'))).toHaveLength(1);
 expect(h.calls.some(c=>/delete/i.test(c.sql))).toBe(false);
 expect(h.requests).toHaveLength(11);
 expect(h.requests.every(r=>r.init.method==='GET')).toBe(true);
 expect(JSON.stringify(result)).not.toMatch(/fictional-secret|response body|fictional-user|cookie|token/);
});
test('request failure still expires retained session, while failed expiry and tenant leaks refuse',async()=>{
 for(const options of [{failRequest:true},{failExpiry:true},{tenantLeak:true}]) {
  const h=harness(options),result=await probe(h.deps);
  expect(validHostedResult(hostResult(result))).toBe(false);
  expect(h.calls.filter(c=>c.sql.startsWith('update auth_session'))).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('sensitive');
 }
});
test('non-QA or non-synthetic target refuses before session mutation',async()=>{
 for(const mode of ['env','fixture']) {
  const h=harness({realBusiness:mode==='fixture'});
  if(mode==='env')h.deps.env.OUTBOUND_ENABLED='true';
  expect(validHostedResult(hostResult(await probe(h.deps)))).toBe(false);
  expect(h.calls.some(c=>c.sql.startsWith('insert'))).toBe(false);
 }
});
test('collector validates account before SSM, binds source/artifact and polls same command once',async()=>{
 const calls:string[][]=[],h=harness(),result=hostResult(await probe(h.deps));
 const id='12345678-1234-1234-1234-123456789abc';
 const execute=async(args:string[])=>{
  calls.push(args);
  if(args[0]==='curl')return '302';
  if(args.includes('get-caller-identity'))return JSON.stringify({Account:'553066147679'});
  if(args.includes('send-command'))return JSON.stringify({Command:{CommandId:id}});
  return JSON.stringify({Status:'Success',StandardOutputContent:JSON.stringify(result)});
 };
 const r=await collectHostedAcceptance(context,{execute,sleep:async()=>{},now:()=>1000});
 expect(r.passed).toBe(true);expect(r.browser).toBe(false);expect(r.commandId).toBe(id);
 expect(calls.filter(c=>c.includes('send-command'))).toHaveLength(1);
 const send=calls.find(c=>c.includes('send-command'))!;
 expect(send).toContain('i-063943f2f032b2903');expect(send).toContain('fisher-acc030');
 expect(hostCommand(context)).not.toContain('secret');
 let sent=false;
 await expect(collectHostedAcceptance(context,{execute:async(args)=>{if(args.includes('send-command'))sent=true;return JSON.stringify({Account:'329195319812'});}})).rejects.toThrow('QA account');
 expect(sent).toBe(false);
});
test('incomplete host/source or probe evidence cannot pass',async()=>{
 const r=hostResult(await probe(harness().deps));
 delete r.checks['alido-qa-web:artifact'];expect(validHostedResult(r)).toBe(false);
 expect(validHostedResult({checks:{healthy:true},probe:{checks:{sessionExpired:true}}})).toBe(false);
});

test('actual host probe checks deployed digest while retaining the distinct candidate tuple',()=>{
 const deployedArtifact='553066147679.dkr.ecr.ca-central-1.amazonaws.com/alido-qa@sha256:'+'d'.repeat(64);
 function run(deployed?:string){
  const command=hostCommand({...context,...(deployed?{deployedArtifact:deployed}:{})},'fictional HTTP probe');
  const encoded=command.match(/b64decode\('([^']+)'\)/)![1]!;
  const program=Buffer.from(encoded,'base64').toString();
  const harness=`import json,subprocess,types
from unittest.mock import patch
def fake(args,**kwargs):
 if args[1]=='exec':return types.SimpleNamespace(returncode=0,stdout='{}')
 previous=args[-1].endswith('-previous')
 value={'Config':{'Labels':{'org.opencontainers.image.revision':${JSON.stringify(context.revision)}},'Image':${JSON.stringify(deployedArtifact)}},'State':{'Running':not previous,'Health':{'Status':'healthy'}}}
 return types.SimpleNamespace(returncode=0,stdout=json.dumps([value]))
with patch.object(subprocess,'run',side_effect=fake):exec(${JSON.stringify(program)})
`;
  const result=spawnSync('python3',['-c',harness],{encoding:'utf8'});
  expect(result.status).toBe(0);return JSON.parse(result.stdout);
 }
 expect(run(deployedArtifact).checks['alido-qa-web:artifact']).toBe(true);
 expect(run(deployedArtifact).checks['alido-qa-worker:artifact']).toBe(true);
 expect(run().checks['alido-qa-web:artifact']).toBe(false);
 expect(run(context.artifact).checks['alido-qa-web:artifact']).toBe(false);
});
