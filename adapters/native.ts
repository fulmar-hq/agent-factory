import { openSync, closeSync, readSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WorkerAccounting } from "./workers";

const Row = z.object({
  type:z.string(), sessionId:z.string().optional(), cwd:z.string().optional(), effort:z.string().optional(),
  payload:z.object({id:z.string().optional(),cwd:z.string().optional(),model:z.string().optional(),effort:z.string().optional()}).passthrough().optional(),
  message:z.object({model:z.string().optional()}).passthrough().optional(),
  params:z.object({model:z.string().optional(),output_config:z.object({effort:z.string().optional()}).optional()}).optional(),
});
// Never choose the newest session. Resolve the exact native ID under its harness root.
export class NativeReceipt {
  path?:string;
  private offset=0;
  private pending=Buffer.alloc(0);
  private bound=false;
  caughtUp=false;
  private models=new Set<string>();
  private efforts=new Set<string>();
  constructor(readonly provider:string, readonly id:string, readonly workspace:string, readonly home:string, readonly started:number) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("invalid native receipt ID");
  }
  poll(accounting:WorkerAccounting) {
    if (!this.path) {
      if(this.provider==="claude") {
        const p=join(this.home,".claude","projects",this.workspace.replace(/[^a-zA-Z0-9]/g,"-"),`${this.id}.jsonl`);
        try {statSync(p);this.path=p;}catch{return;}
      } else {
        for(const day of new Set([-86400000,0,86400000].map(n=>new Date(this.started+n).toISOString().slice(0,10).replaceAll("-","/")))) {
          const dir=join(this.home,".codex","sessions",day);
          let names:string[]=[];try {names=readdirSync(dir);}catch{continue;}
          const name=names.find(n=>n.endsWith(`-${this.id}.jsonl`));
          if(name) {this.path=join(dir,name);break;}
        }
      }
    }
    if(!this.path)return;
    const fd=openSync(this.path,"r");
    try {
      if(statSync(this.path).size<this.offset)throw Error("native receipt truncated");
      const chunk=Buffer.alloc(1024*1024), n=readSync(fd,chunk,0,chunk.length,this.offset);
      this.offset+=n;
      this.pending=Buffer.concat([this.pending,chunk.subarray(0,n)]);
      let end:number;
      while((end=this.pending.indexOf(10))>=0) {
        const line=this.pending.subarray(0,end).toString("utf8");this.pending=this.pending.subarray(end+1);
        let json:unknown;try {json=JSON.parse(line);}catch{throw Error("malformed native receipt");}
        const parsed=Row.safeParse(json);if(!parsed.success)continue;
        const x=parsed.data;
        if(this.provider==="codex") {
          if(x.type==="session_meta") {
            if(x.payload?.id!==this.id || x.payload.cwd!==this.workspace)throw Error("native receipt custody mismatch");
            this.bound=true;
          }
          if(!this.bound)throw Error("unbound native receipt");
          if(x.type==="turn_context") {if(x.payload?.model)this.models.add(x.payload.model);if(x.payload?.effort)this.efforts.add(x.payload.effort);}
        } else {
          if(x.sessionId!==this.id)throw Error("native receipt custody mismatch");
          if(x.cwd && x.cwd!==this.workspace)throw Error("native receipt workspace mismatch");
          if(x.cwd===this.workspace)this.bound=true;
          if(x.type==="assistant") {if(x.message?.model)this.models.add(x.message.model);if(x.effort)this.efforts.add(x.effort);}
          if(x.type==="api-request") {if(x.params?.model)this.models.add(x.params.model);if(x.params?.output_config?.effort)this.efforts.add(x.params.output_config.effort);}
        }
        accounting.ingest(this.provider,line);
      }
      if(this.pending.length>16*1024*1024)throw Error("native receipt line too large");
      this.caughtUp=this.offset===statSync(this.path).size && this.pending.length===0;
    } finally {closeSync(fd);}
  }
  evidence(model:string, effort:string) {
    const expected=this.provider==="claude" && model==="opus-5.5" ? "claude-opus-5-5" : model;
    const models=[...this.models],efforts=[...this.efforts];
    return {path:this.path,id:this.id,bound:this.bound,models,efforts,
      conflict:models.some(m=>m!==expected)||efforts.some(e=>e!==effort),
      verified:this.caughtUp&&this.bound&&models.length===1&&models[0]===expected&&efforts.length===1&&efforts[0]===effort};
  }
}
