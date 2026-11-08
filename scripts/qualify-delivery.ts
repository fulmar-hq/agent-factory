import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerSpec } from "../adapters/workers";
import { command } from "../adapters/github";
import { root } from "../launcher/config";
const dir=join(root,"runs",`delivery-qualification-${Date.now()}`), work=join(dir,"workspace");
mkdirSync(join(work,".factory-tmp"),{recursive:true});
writeFileSync(join(dir,"outside-sentinel"),"fictional protected evidence\n");
const git=(...args:string[])=>command(["git","-C",work,...args]);
await git("init");
await command(["cp","-R",join(import.meta.dir,"../node_modules"),join(work,"node_modules")]);
for(const [k,v] of [["user.name","Vincent Messina"],["user.email","72951696+vincentmessina@users.noreply.github.com"],["gpg.format","ssh"],["user.signingkey",join(process.env.HOME!,".ssh/fisher_commit_signing_ed25519.pub")],["commit.gpgsign","true"]]) await git("config",k,v);
writeFileSync(join(work,"fixture.test.ts"),'import {test,expect} from "bun:test"; import {z} from "zod"; test("dependencies execute",()=>expect(z.string().parse("fixture")).toBe("fixture"));');
const socket=join("/tmp",`factory-probe-${Date.now()}.sock`);
const server=Bun.serve({unix:socket,fetch:()=>new Response("scoped broker reachable")});
const t={repo:"fulmar-hq/alido",number:1,area:"fixture",kind:"fixture",title:"Fictional qualification",owner:"product",creator:"fixture",source:"fixture",outcome:"fixture",test:"fixture",approved:true as const,benefit:"normal" as const,estimateSeconds:600,estimateTokens:9000000,paths:["fixture"],spansBackendAndScreen:false as const,heavy:false,wallet:"other" as const,costCents:0,provider:"codex" as const};
const spec=workerSpec(t,work,"print",root,{socket});
const config=spec.argv.flatMap((arg,i)=>arg==="-c"?[arg,spec.argv[i+1]]:[]);
const probe= `set -eu
cd '${work}'
pwd
echo TMPDIR=$TMPDIR
export TMPDIR='${join(work,".factory-tmp")}'
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
bun --version
node --version
bun test fixture.test.ts
echo NODE_MODULES_PASS
echo SSH_AUTH_SOCK=$SSH_AUTH_SOCK
ssh-add -l
printf 'fictional qualification\\n' > fixture
git add fixture
git commit -S -m 'test: qualify sandbox signing'
curl --fail --unix-socket '${socket}' http://localhost/
if cat '${join(dir,"outside-sentinel")}' 2>/dev/null; then exit 71; fi
if echo changed >> '${join(dir,"outside-sentinel")}' 2>/dev/null; then exit 72; fi
if echo changed >> '${join(process.env.HOME!,"Developer/agent-factory/.git/factory-denied-probe")}' 2>/dev/null; then exit 73; fi
if curl --max-time 3 --fail https://example.com 2>/dev/null; then exit 74; fi
if curl --noproxy '*' --max-time 3 -k --fail https://1.1.1.1 2>/dev/null; then exit 75; fi
for p in '${join(root,"config.yaml")}' '${join(root,"controller.sqlite")}'; do
  if cat "$p" >/dev/null 2>&1; then exit 76; fi
  if python3 -c 'import os,sys; os.close(os.open(sys.argv[1],os.O_WRONLY))' "$p" 2>/dev/null; then exit 77; fi
done
printf '\\nALL_BOUNDARIES_PASS\\n'
`;
try {
 const p=Bun.spawn(["codex","sandbox",...config,"-P","factory","-C",work,"/bin/sh","-c",probe],{cwd:work,env:spec.env,stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 writeFileSync(join(dir,"probe.json"),JSON.stringify({out,err,code,argv:config,probe},null,2));
 console.log(JSON.stringify({dir,out,err,code}));
 if(code!==0 || !out.includes("NODE_MODULES_PASS") || !err.includes("1 pass") || !out.includes("ALL_BOUNDARIES_PASS"))throw Error("native delivery boundary qualification failed");
 await git("-c",`gpg.ssh.allowedSignersFile=${join(process.env.HOME!,".ssh/fisher_allowed_signers")}`,"verify-commit","HEAD");
 writeFileSync(join(dir,"qualified.json"),JSON.stringify({code:0,signed:true,receipt:join(dir,"probe.json"),at:Date.now()}));
 console.log("SIGNED_COMMIT_VERIFIED");
} finally {server.stop(true);}
