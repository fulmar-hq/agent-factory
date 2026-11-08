import { existsSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { command } from "./github";
import type { Ticket } from "../launcher/config";

export const deliveryRepo = "fulmar-hq/alido";
export const branchFor = (id:string) => `feat/factory-${id.slice(0,16)}`;
// Trusted setup runs before model tools. No shared writable Git metadata or
// dependency symlinks into another checkout. Original gitfile stays archived.
export async function prepareDelivery(workspace:string, source:string, archive:string, id:string) {
  mkdirSync(archive,{recursive:true,mode:0o700});
  workspace=realpathSync(workspace);
  const git = (...args:string[]) => command(["git","-C",workspace,...args]);
  if (!existsSync(join(workspace,".git/HEAD"))) {
    const head=(await git("rev-parse","HEAD")).trim();
    const branch=(await git("branch","--show-current")).trim();
    if (branch !== branchFor(id)) throw Error("worker branch mismatch");
    const clone=join(archive,"local-clone");
    await command(["git","clone","--no-hardlinks","--no-checkout",source,clone]);
    await command(["git","-C",clone,"checkout","-b",branch,head]);
    renameSync(join(workspace,".git"),join(archive,"original-gitfile"));
    renameSync(join(clone,".git"),join(workspace,".git"));
  }
  if (!existsSync(join(workspace,"node_modules"))) {
    if (!existsSync(join(source,"node_modules"))) throw Error("installed dependencies missing");
    await command(process.platform === "darwin" ? ["cp","-cR",join(source,"node_modules"),join(workspace,"node_modules")] : ["cp","-R",join(source,"node_modules"),join(workspace,"node_modules")]);
  }
  const exclude=join(workspace,".git/info/exclude");
  const {appendFileSync}=await import("node:fs");
  appendFileSync(exclude,"\n.factory-tmp/\n.factory-delivery.bundle\n");
  for (const [key,value] of [
    ["user.name","Vincent Messina"], ["user.email","72951696+vincentmessina@users.noreply.github.com"],
    ["gpg.format","ssh"], ["user.signingkey",join(process.env.HOME!,".ssh/fisher_commit_signing_ed25519.pub")],
    ["commit.gpgsign","true"], ["core.hooksPath","/dev/null"], ["core.excludesFile","/dev/null"],
  ]) await git("config","--local",key,value);
}

export function deliveryRequest(raw:unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid delivery request");
  const r=raw as Record<string,unknown>;
  if (Object.keys(r).sort().join(",") !== "body,title" || typeof r.title !== "string" || typeof r.body !== "string" || !r.title.trim() || r.title.length>200 || r.body.length>20000) throw Error("title and body only");
  return {title:r.title,body:r.body};
}
// A native network allowlist cannot restrict github.com to a repository. This
// broker owns credentials and network; the sandbox gets only this Unix socket.
// Import a bundle into a private controlled repo. Never run trusted Git against
// worker-writable config/hooks, or accept a destination/ref/command from a worker.
export async function deliveryBroker(t:Ticket, id:string, workspace:string, dir:string, baseline:string, log:(data:unknown)=>void, execute=command) {
  if (t.repo !== deliveryRepo) throw Error("delivery repository not admitted");
  const socket=join("/tmp",`factory-delivery-${id.slice(0,16)}-${crypto.randomUUID().slice(0,8)}.sock`);
  const bare=join(dir,"delivery.git");
  if (!existsSync(bare)) await execute(["git","clone","--bare","--no-hardlinks",workspace,bare]);
  const branch=branchFor(id);
  let busy=false;
  const server=Bun.serve({unix:socket, async fetch(req) {
    if(req.method!=="POST" || new URL(req.url).pathname!=="/deliver") return new Response("refused",{status:403});
    if(busy) return new Response("delivery busy",{status:409});
    busy=true;
    try {
      const reader=req.body?.getReader();
      if(!reader)throw Error("request body required");
      let text="",size=0;
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        size+=value.length;if(size>25000){await reader.cancel();throw Error("request too large");}
        text+=new TextDecoder().decode(value,{stream:true});
      }
      const {title,body}=deliveryRequest(JSON.parse(text));
      const bundle=join(workspace,".factory-delivery.bundle");
      if(realpathSync(bundle)!==join(realpathSync(workspace),".factory-delivery.bundle")) throw Error("bundle symlink refused");
      const git=(...args:string[])=>execute(["git","-c","core.hooksPath=/dev/null","-C",bare,...args]);
      await git("fetch","--no-tags",bundle,`HEAD:refs/heads/${branch}`);
      const head=(await git("rev-parse",branch)).trim();
      await git("merge-base","--is-ancestor",baseline,head);
      const changed=(await git("diff","--name-only",baseline,head)).trim().split("\n").filter(Boolean);
      if(!changed.length || changed.some(p=>!t.paths.includes(p))) throw Error("delivery paths outside approved scope");
      const commits=(await git("rev-list",`${baseline}..${head}`)).trim().split("\n");
      for(const sha of commits) await git("-c",`gpg.ssh.allowedSignersFile=${join(process.env.HOME!,".ssh/fisher_allowed_signers")}`,"verify-commit",sha);
      const destination=`https://github.com/${deliveryRepo}.git`;
      await git("push",destination,`refs/heads/${branch}:refs/heads/${branch}`);
      const existing=JSON.parse(await execute(["gh","pr","list","--repo",deliveryRepo,"--head",branch,"--base","QA","--json","url"]));
      const url=existing[0]?.url ?? (await execute(["gh","pr","create","--repo",deliveryRepo,"--base","QA","--head",branch,"--title",title,"--body",body])).trim();
      log({head,url,branch,repo:deliveryRepo});
      return Response.json({head,url});
    } catch(error) { return new Response(String(error),{status:400}); }
    finally {busy=false;}
  }});
  return {socket,close:()=>server.stop(true)};
}
