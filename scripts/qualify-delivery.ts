import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { command } from "../adapters/github";
import { workerSpec } from "../adapters/workers";
import { root } from "../launcher/config";
// Actual native command boundary, no model call and no credential contents read
// by the launcher or receipt. A denied connection must target a live known agent.
const dir=join(root,"runs",`publisher-qualification-${Date.now()}`),work=join(dir,"workspace");
mkdirSync(join(work,".factory-tmp"),{recursive:true});
writeFileSync(join(dir,"credential-sentinel"),"fictional protected credential\n",{mode:0o600});
const socket=process.env.SSH_AUTH_SOCK;
if(!socket || !existsSync(socket))throw Error("live signing socket required for negative probe");
const credential=join(process.env.HOME!,".codex/auth.json");
if(!existsSync(credential))throw Error("known credential required for negative probe");
cpSync(join(import.meta.dir,"../node_modules"),join(work,"node_modules"),{recursive:true});
const publisher=join(import.meta.dir,"../adapters/delivery.ts");
const t={repo:"fulmar-hq/alido",number:1,area:"fixture",kind:"fixture",title:"Fictional qualification",owner:"product",creator:"fixture",source:"fixture",outcome:"fixture",test:"fixture",approved:true as const,benefit:"normal" as const,estimateSeconds:1800,estimateTokens:8000000,paths:["fixture"],spansBackendAndScreen:false as const,heavy:false,wallet:"other" as const,costCents:0,provider:"codex" as const};
const spec=workerSpec(t,work,"print",root,{});
const overrides=spec.argv.flatMap((arg,i)=>arg==="-c"?[arg,spec.argv[i+1]]:[]);
const probe=`import os, socket, subprocess, json
results={}
def denied(name,action):
 try:
  action()
  results[name]=False
 except (OSError,PermissionError): results[name]=True
def connect():
 s=socket.socket(socket.AF_UNIX); s.settimeout(2)
 try: s.connect(${JSON.stringify(socket)})
 finally: s.close()
denied('known_agent_socket',connect)
for name,path,mode in [('credential',${JSON.stringify(credential)},os.O_RDONLY),('private_sentinel',${JSON.stringify(join(dir,"credential-sentinel"))},os.O_RDONLY),('publisher_write',${JSON.stringify(publisher)},os.O_WRONLY),('dependencies_write',${JSON.stringify(join(work,'node_modules/zod/package.json'))},os.O_WRONLY),('toolchain_write',${JSON.stringify(process.execPath)},os.O_WRONLY)]:
 denied(name,lambda p=path,m=mode:os.close(os.open(p,m)))
results['env_clean']=not any(k in os.environ for k in ['SSH_AUTH_SOCK','GH_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','FACTORY_OWNER_TOKEN'])
for name,url in [('external_dns','https://example.com'),('external_ip','https://1.1.1.1')]:
 results[name]=subprocess.run(['/usr/bin/curl','--noproxy','*','--max-time','3','-ksSf',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
results['push_QA']=subprocess.run(['/usr/bin/git','push','--dry-run','https://github.com/fulmar-hq/alido.git','HEAD:refs/heads/QA'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
open('scratch','w').write('fictional')
commands=[['config','user.name','Fictional Qualification'],['config','user.email','fixture@example.invalid'],['config','commit.gpgsign','false'],['add','scratch'],['commit','--allow-empty','-m','Fictional unsigned worker snapshot'],['bundle','create','.factory-delivery.bundle','HEAD']]
results['unsigned_bundle']=all(subprocess.run(['/usr/bin/git']+args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 for args in commands)
results['workspace_write']=True
print(json.dumps(results))
raise SystemExit(0 if all(results.values()) else 1)
`;
await command(["git","-C",work,"init","-q"]);
writeFileSync(join(work,"probe.py"),probe);
const p=Bun.spawn(["codex","sandbox",...overrides,"-P","factory","-C",work,"/usr/bin/python3","probe.py"],{cwd:work,env:spec.env,stdout:"pipe",stderr:"pipe"});
const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
writeFileSync(join(dir,"probe.json"),JSON.stringify({version:2,out,err,code,overrides,at:Date.now()},null,2),{mode:0o600});
// This command-only rehearsal cannot renew model-tool isolation on its own.
console.log(JSON.stringify({dir,out,err,code,publishing:"blocked pending full native tool and positive published-tree evidence"}));
if(code!==0)process.exitCode=1;
