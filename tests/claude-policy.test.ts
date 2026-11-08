import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeSettings, materializeSettings, workerSpec, privateDenyPaths } from "../adapters/workers";
import { ticket, config } from "./fixtures";
import { Store } from "../tracking/store";
import { Engine } from "../launcher/engine";
import { claimSupervisor, superviseSession } from "../launcher/worker";

test("generated per-run native policy protects private siblings without denying the nested worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-policy-")), workspace = join(dir,"workspaces/run");
  mkdirSync(workspace, {recursive:true}); mkdirSync(join(dir,"workspaces/other"));
  writeFileSync(join(dir,"owner-token"),"fictional");
  try {
    const spec = workerSpec({...ticket(),provider:"claude",model:"opus-5.5"},workspace,"print",dir);
    const paths = privateDenyPaths(dir,workspace);
    expect(paths.sort()).toEqual([join(realpathSync(dir),"owner-token"),join(realpathSync(dir),"workspaces/other")].sort());
    expect(() => privateDenyPaths(dir,dir)).toThrow("private root");
    const path = join(dir,"run.settings.json"), generated = materializeSettings(spec,path);
    expect(generated.argv[generated.argv.indexOf("--settings")+1]).toBe(path);
    expect(generated.argv[generated.argv.indexOf("--model")+1]).toBe("claude-opus-5-5");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const policy = JSON.parse(readFileSync(path,"utf8"));
    expect(policy).toEqual(spec.settings);
    expect(policy.permissions).toMatchObject({allow:["Bash"],blockReadsOutsideWorkingDirectories:true,blockWritesOutsideWorkingDirectories:true});
    expect(policy.permissions.deny).toContain(`Edit(/${realpathSync(dir)}/owner-token/**)`);
    expect(policy.sandbox.filesystem.denyWrite).toEqual(paths);
    expect(policy.switchModelsOnFlag).toBe(false);
    expect(() => materializeSettings(spec,path)).toThrow();
  } finally {rmSync(dir,{recursive:true});}
});

test("a streamed fallback stops the supervisor before transcript polling or completion", async () => {
  const dir=mkdtempSync(join(tmpdir(),"factory-model-")), s=new Store(join(dir,"state.sqlite")), e=new Engine(s,config());
  const prior=process.env.PATH;
  writeFileSync(join(dir,"claude"),`#!/bin/sh\necho '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"claude-opus-4-8","usage":{"input_tokens":1}}}}'\nexec sleep 60\n`,{mode:0o700});
  process.env.PATH=dir+":"+prior;
  const t={...ticket(),provider:"claude" as const,model:"opus-5.5",estimateTokens:100000};
  s.db.query("INSERT INTO sessions(id,ticket,owner,provider,status,brief) VALUES(?,?,?,?,?,?)").run("model","example/demo#1","builder","claude","reserved",JSON.stringify(t));
  e.pause(false,"owner"); e.claimStart("model"); claimSupervisor(e,"model");
  try {
    await superviseSession(e,"model",t,dir,join(dir,"native.jsonl"));
    expect(e.sessions()[0]).toMatchObject({status:"paused",pid:null});
    expect(s.get("stop:model")).toMatchObject({reason:"native stream model conflict",models:["claude-opus-4-8"]});
    expect(e.claimStart("model")).toBe(false);
  } finally {process.env.PATH=prior;s.close();rmSync(dir,{recursive:true});}
},10000);
