import {join,resolve,relative,basename,extname,sep} from 'node:path';
import {mkdirSync,openSync,closeSync,fstatSync,readSync,readFileSync,writeFileSync,realpathSync,copyFileSync,chmodSync,constants} from 'node:fs';
import type {Store} from '../tracking/store';
// What an owner wake is given to read. A wake's command tools can open the
// source checkout and the wake's own scratch folder, never the rest of the
// private factory folder, so anything it must read is copied into that scratch
// folder and named there. Launch arguments stay under one fixed size; whatever
// would not fit is read from a file instead of failing the launch.

// macOS refuses to start a process whose arguments and environment together
// pass about 1 MB (E2BIG). Owner launches stay at half of that. (Linux also
// limits one argument to 128 KB; the factory host is macOS.)
export const LAUNCH_ARGUMENT_BYTES=512*1024;
// A larger event is saved as a file in the scratch folder and named in the prompt.
export const INLINE_EVENT_BYTES=256*1024;
// Everything under <scratch>/evidence together, including its manifest.
export const EVIDENCE_BYTES=2*1024*1024;
const FILE_BYTES=256*1024,MANIFEST_BYTES=64*1024,MAX_NAMED_FILES=16,MAX_SESSIONS=3;
// Only retained publisher receipts and earlier owner-wake results are copied.
const RETAINED=[['runs','delivery'],['runs','owner-wakes']];
const TEXT=new Set(['.json','.jsonl','.log','.txt','.md']);
// Fail closed: a name or content that looks like a credential is never copied.
const CREDENTIAL_NAME=/^\.|credential|secret|token|password|passwd|private|auth|cookie|keychain|\.(?:pem|key|p12)$|^id_(?:rsa|ed25519|ecdsa)/i;
const CREDENTIAL_CONTENT=/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|\d{8,10}:[A-Za-z0-9_-]{35})\b/;

export const launchBytes=(argv:string[])=>argv.reduce((n,a)=>n+Buffer.byteLength(a)+1,0);
// The prompt is the last launch argument for both harnesses. This is the last
// line of defence: with the event and evidence already in files it is rarely
// needed, but no owner launch may fail only because its prompt is large.
export function boundLaunch<T extends {argv:string[]}>(spec:T,scratch:string):T {
 if(launchBytes(spec.argv)<=LAUNCH_ARGUMENT_BYTES)return spec;
 const prompt=spec.argv.at(-1)!,path=join(scratch,'prompt.md');
 writeFileSync(path,prompt,{flag:'wx',mode:0o600});
 const argv=[...spec.argv.slice(0,-1),`Your instructions for this turn are ${Buffer.byteLength(prompt)} bytes, too large to pass on the command line. They are saved in ${path}. Read that whole file first, in pieces if needed, then follow it exactly as if it had been given here. Every limit in it applies, including what you must not do.`];
 if(launchBytes(argv)>LAUNCH_ARGUMENT_BYTES)throw Error('owner launch arguments exceed the fixed cap');
 return {...spec,argv};
}
// The prompt keeps the start and the end of a long owner record. The whole
// record is copied beside it so the omitted middle can actually be read.
export function ownerRecord(scratch:string,path:string) {
 const full=readFileSync(path,'utf8');
 if(full.length<=60000)return full;
 const copy=join(scratch,'owner-record.md');
 // A clone where the disk supports it, so a long record costs no extra space per wake.
 copyFileSync(path,copy,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);chmodSync(copy,0o600);
 return full.slice(0,12000)+`\n[${full.length-60000} characters from the middle of this record are left out here. The complete record is readable at ${copy}; search it before relying on something this excerpt does not show.]\n`+full.slice(-48000);
}
// A small event stays in the prompt; a large one is saved whole and described.
// `repoint` swaps private paths for their readable copies (see copyEvidence).
export function eventForPrompt(scratch:string,event:unknown,repoint=(text:string)=>text) {
 const text=repoint(JSON.stringify(event)),size=Buffer.byteLength(text);
 if(size<=INLINE_EVENT_BYTES)return text;
 const path=join(scratch,'event.json'),payload=(event as {payload?:unknown}|null)?.payload;
 writeFileSync(path,JSON.stringify(JSON.parse(text),null,1)+'\n',{flag:'wx',mode:0o600});
 const parts=payload && typeof payload==='object' && !Array.isArray(payload) ? Object.entries(payload).map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v) ?? '')] as const).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,n])=>`payload.${k} (${n} bytes)`).join(', ') : '';
 return `[This event is ${size} bytes, too large to pass on the command line. The complete event is the JSON file ${path}, one value per line. Read it from there, in pieces if needed, before deciding anything.${parts ? ` Its largest parts: ${parts}.` : ''}]`;
}

type Copied={file:string;from:string;bytes:number;originalBytes?:number};
type Skipped={path:string;reason:string};
// First quarter and the rest from the end, so both the start and the outcome of a long file survive.
function readBounded(path:string,limit:number) {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const stat=fstatSync(fd);if(!stat.isFile())throw Error('not a regular file');
  const read=(length:number,position:number)=>{const b=Buffer.alloc(length);return b.subarray(0,readSync(fd,b,0,length,position));};
  if(stat.size<=limit)return {content:read(stat.size,0),size:stat.size};
  const note=Buffer.from(`\n[${stat.size-limit} bytes left out of this copy]\n`),head=Math.floor(limit/4),tail=limit-head-note.length;
  return {content:Buffer.concat([read(head,0),note,read(tail,stat.size-tail)]),size:stat.size};
 } finally {closeSync(fd);}
}
function sessions(payload:unknown) {
 const e=((payload as {evidence?:unknown}|null)?.evidence ?? payload) as {session?:unknown;wake?:unknown;recent?:unknown}|null;
 const found=[e?.session,typeof e?.wake==='string' && e.wake.startsWith('diagnose:') ? e.wake.slice(9) : undefined,...(Array.isArray(e?.recent) ? e.recent.map(r=>(r as {session?:unknown}|null)?.session) : [])];
 return [...new Set(found.filter((x):x is string=>typeof x==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(x)))].slice(0,MAX_SESSIONS);
}
// Returns why a named path may not be copied, or nothing when it may.
function refusal(dir:string,path:string) {
 const parts=relative(dir,resolve(path)).split(sep);
 const inside=(p:string[])=>RETAINED.some(r=>r.every((name,i)=>p[i]===name) && p.length>r.length);
 if(!inside(parts))return 'outside the retained run folders';
 if(parts.some(p=>CREDENTIAL_NAME.test(p)))return 'hidden or credential-like name';
 if(!TEXT.has(extname(path).toLowerCase()))return 'not a text evidence file';
 let real:string;try {real=realpathSync(path);}catch{return 'missing';}
 if(!inside(relative(realpathSync(dir),real).split(sep)))return 'links outside the retained run folders';
}
// Copies the evidence a failure-diagnosis or owner-decision event refers to:
// the failed session's event rows, the failed worker's log (start and end),
// and the files the event names. One unreadable item is listed, never fatal.
export function copyEvidence(s:Pick<Store,'db'>,dir:string,scratch:string,payload:unknown) {
 // A path under the private folder, as it appears inside JSON text.
 const privatePath=new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[^\\s"\'\\\\,;:()\\[\\]{}<>]+','g'),trim=(p:string)=>p.replace(/\.+$/,'');
 const ids=sessions(payload),named=[...new Set((JSON.stringify(payload) ?? '').match(privatePath)?.map(trim))];
 const files:Copied[]=[],notCopied:Skipped[]=[],copies:Record<string,string>={},lines:string[]=[];
 const repoint=(text:string)=>text.replace(privatePath,found=>{const copy=copies[trim(found)];return copy ? copy+found.slice(trim(found).length) : found;});
 if(!ids.length && !named.length)return {repoint,prompt:'',files,notCopied};
 const out=join(scratch,'evidence');mkdirSync(out,{mode:0o700});
 let left=EVIDENCE_BYTES-MANIFEST_BYTES;
 const save=(name:string,from:string,content:Buffer,what:string,originalBytes=content.length)=>{
  if(CREDENTIAL_CONTENT.test(content.toString('latin1')))return void notCopied.push({path:from,reason:'credential-like content'});
  if(content.length>left)return void notCopied.push({path:from,reason:'evidence size cap reached'});
  const file=join(out,name),shortened=originalBytes>content.length;
  left-=content.length;writeFileSync(file,content,{flag:'wx',mode:0o600}); // counted first: a failed write still spends its share
  files.push({file,from:from.slice(0,400),bytes:content.length,...(shortened ? {originalBytes} : {})});
  lines.push(`- ${file}: ${what}${shortened ? ` (shortened from ${originalBytes} bytes)` : ''}`);
  return file;
 };
 const attempt=(what:string,copy:()=>void)=>{
  try {copy();}
  catch(error){const code=(error as NodeJS.ErrnoException).code;notCopied.push({path:what,reason:code==='ENOENT' ? 'missing' : code==='ELOOP' ? 'is a link' : code ?? (error as Error).message.slice(0,200)});}
 };
 for(const [n,session] of ids.entries())attempt(`recorded events for session ${session}`,()=>{
  const rows=s.db.query("SELECT id,kind,at,data FROM events WHERE instr(id,?)>0 AND kind NOT IN ('owner-wake-queued','owner-wake-dispatch') ORDER BY at").all(session) as {id:string;kind:string;at:number;data:string}[];
  const kept:Buffer[]=[];let size=0;
  for(const r of rows) {
   const line=Buffer.from(JSON.stringify({id:r.id,kind:r.kind,at:r.at,data:JSON.parse(r.data)})+'\n');
   if(size+line.length>FILE_BYTES || CREDENTIAL_CONTENT.test(line.toString('latin1')))continue;
   kept.push(line);size+=line.length;
  }
  if(kept.length)save(`events-${n+1}.jsonl`,`recorded events for session ${session}`,Buffer.concat(kept),`the launcher's recorded events for session ${session}, oldest first (${kept.length} of ${rows.length} rows)`);
 });
 for(const [n,session] of ids.entries())attempt(`worker log for session ${session}`,()=>{
  const {content,size}=readBounded(join(dir,`worker-${session}.jsonl`),FILE_BYTES);
  save(`worker-log-${n+1}.jsonl`,`worker log for session ${session}`,content,`the failed worker's own output for session ${session}; its final report is at the end`,size);
 });
 for(const [n,path] of named.slice(0,MAX_NAMED_FILES).entries())attempt(path,()=>{
  const why=refusal(dir,path);if(why)return void notCopied.push({path,reason:why});
  const {content,size}=readBounded(path,FILE_BYTES);
  const file=save(`${n+1}-${basename(path).replace(/[^A-Za-z0-9._-]/g,'_').slice(-80)}`,path,content,`the file this event named, ${basename(path).slice(-80)}`,size);
  if(file)copies[path]=file;
 });
 for(const path of named.slice(MAX_NAMED_FILES))notCopied.push({path,reason:'too many named files'});
 const skipped=notCopied.slice(0,2*MAX_NAMED_FILES).map(x=>({path:x.path.slice(0,400),reason:x.reason}));
 writeFileSync(join(out,'manifest.json'),Buffer.from(JSON.stringify({capBytes:EVIDENCE_BYTES,files,notCopied:skipped},null,1)).subarray(0,MANIFEST_BYTES),{flag:'wx',mode:0o600});
 const prompt=`\nEvidence for this event was copied into ${out}, which you can read. The private originals cannot be opened from your sandbox; where the event named a file that was copied, its path now points at the copy. Read these before you decide:\n${lines.join('\n') || '- nothing could be copied'}${skipped.length ? `\nNot copied:\n${skipped.map(x=>`- ${x.path}: ${x.reason}`).join('\n')}` : ''}\nA file listed as missing does not exist; that is itself a finding. Do not stop only because an original private path cannot be opened: work from these copies, and if they are not enough say exactly which file you still need and why.`;
 return {repoint,prompt,files,notCopied:skipped};
}
