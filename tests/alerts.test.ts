import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { qualificationAlerts,watchdogAlert } from "../launcher/alerts";
import { Store } from "../tracking/store";
import { qualification } from "./fixtures";

test("expiry alerts use one retained bridge line per provider/expiry, including crash retry and renewal", () => {
  const dir=mkdtempSync(join(tmpdir(),"factory-alert-")), path=join(dir,"mail.sqlite"), db=new Database(path), s=new Store(":memory:");
  // Existing bridge outbox columns; no new bot, network or model call.
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT);CREATE TABLE telegram_messages(message_id INTEGER PRIMARY KEY,mail_id TEXT,sent_at INTEGER)`);
  const now=Date.now(), q={...qualification(),expiresAt:now+7200001};
  try {
    qualificationAlerts(s,{codex:q},now,path);
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(0);
    q.expiresAt--;
    qualificationAlerts(s,{codex:q,claude:{...q,qualified:false}},now,path);
    qualificationAlerts(s,{codex:q},now+1,path);
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(1);
    const row=db.query("SELECT * FROM messages").get() as Record<string,unknown>;
    expect(row).toMatchObject({recipient:"Vincent",recipient_app:"telegram",body:"",wake_state:"pending",state:"unread"});
    expect(String(row.summary)).not.toContain("\n");
    // A crash after queue insertion, before controller marking, cannot queue twice.
    const restarted=new Store(":memory:");
    qualificationAlerts(restarted,{codex:q},now+2,path); restarted.close();
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(1);
    qualificationAlerts(s,{codex:{...q,expiresAt:now+3600000}},now,path);
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(2);
    qualificationAlerts(s,{claude:{...q,expiresAt:now-1}},now,join(dir,"missing.sqlite"));
    expect(s.rows("events").some(x=>(x as {kind:string}).kind==="qualification-alert-failure")).toBe(true);
    qualificationAlerts(s,{claude:{...q,expiresAt:now-1}},now,path);
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(3);
  } finally {s.close();db.close();rmSync(dir,{recursive:true});}
});


test("watchdog bridges one message per incident and silently closes",()=>{
 const dir=mkdtempSync(join(tmpdir(),"factory-stall-alert-")),path=join(dir,"mail.sqlite"),db=new Database(path),s=new Store(":memory:");
 db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,send_id TEXT,created_at INTEGER,sender TEXT,sender_app TEXT,sender_ref TEXT,recipient TEXT,recipient_app TEXT,kind TEXT,reply TEXT,summary TEXT,body TEXT,thread_id TEXT,depth INTEGER,hash TEXT,state TEXT,wake_state TEXT)`);
 try{
  s.set('watchdog-stall',{id:'fixture-stall',state:'open',summary:'Synthetic stall evidence'});
  watchdogAlert(s,1,path);watchdogAlert(s,2,path);
  expect(db.query('SELECT * FROM messages').all()).toHaveLength(1);
  s.set('alert:fixture-stall',null);watchdogAlert(s,3,path);
  expect(db.query('SELECT * FROM messages').all()).toHaveLength(1);
  s.set('watchdog-stall',{id:'fixture-stall',state:'resolved',summary:'Synthetic stall evidence'});watchdogAlert(s,4,path);
  expect(db.query('SELECT * FROM messages').all()).toHaveLength(1);
 }finally{s.close();db.close();rmSync(dir,{recursive:true});}
});
