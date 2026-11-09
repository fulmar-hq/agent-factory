import {test,expect} from 'bun:test';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {ConfigSchema,TicketSchema} from '../launcher/config';
import {WorkerAccounting} from '../adapters/workers';
import {config,ticket,admission} from './fixtures';
const tuning={estimate_tokens:8000000 as const,checkpoint_tokens:14400000 as const,pause_tokens:16000000 as const,estimate_minutes:30 as const,checkpoint_minutes:54 as const,pause_minutes:60 as const};
function setup(){const s=new Store(':memory:'),e=new Engine(s,ConfigSchema.parse({...config(),ticket_budget_default:tuning}));e.pause(false,'owner');s.set('token-calibration:codex',99000000);return e;}
test('Day-1 defaults replace old turn calibration and freeze the original baseline',()=>{
 const e=setup(),x=e.admit(ticket(),admission()),brief=JSON.parse(x.brief);
 expect(brief.estimateTokens).toBe(8000000);expect(brief.estimateSeconds).toBe(1800);
 expect(e.budget(x)).toMatchObject({checkpointTokens:14400000,pauseTokens:16000000,checkpointSeconds:3240,pauseSeconds:3600,nextTurnBlocked:false});
 const raw={...ticket()} as Record<string,unknown>;delete raw.estimateTokens;delete raw.estimateSeconds;
 expect(TicketSchema.parse(raw)).toMatchObject({estimateTokens:8000000,estimateSeconds:1800});e.s.close();
});
for(const dimension of ['tokens','time'] as const)test(`first ${dimension} threshold checkpoints, pauses and retains measured overshoot`,()=>{
 const e=setup(),x=e.admit(ticket(),admission());e.claimStart(x.id);
 e.account(x.id,dimension==='time'?3239:1,dimension==='tokens'?14399999:1);expect(e.sessions()[0].checkpoint).toBe(0);
 e.account(x.id,dimension==='time'?3240:1,dimension==='tokens'?14400000:1);expect(e.sessions()[0].checkpoint).toBe(1);
 e.account(x.id,dimension==='time'?3602:1,dimension==='tokens'?16000007:1);
 const stopped=e.sessions()[0];expect(stopped.status).toBe('paused');expect(e.budget(stopped)).toMatchObject({nextTurnBlocked:true,overshootTokens:dimension==='tokens'?7:0,overshootSeconds:dimension==='time'?2:0});
 expect(e.s.get<{reason:string}>(`stop:${x.id}`)?.reason).toContain('next turn blocked');
 expect(()=>e.continueSession(x.id,'no extension',()=>{})).toThrow();expect(JSON.parse(stopped.brief).estimateTokens).toBe(8000000);e.s.close();
});
test('persisted overrun cannot start another native turn',async()=>{
 const {superviseSession}=await import('../launcher/worker');const e=setup(),x=e.admit(ticket(),admission());e.claimStart(x.id);
 e.s.db.query("UPDATE sessions SET actual_tokens=16000001,pid=? WHERE id=?").run(process.pid,x.id);
 await expect(superviseSession(e,x.id,JSON.parse(e.sessions()[0].brief),'/unused','/unused')).rejects.toThrow('next turn blocked');
 expect(e.s.rows('events').some((r:any)=>r.kind==='native-start-attempt')).toBe(false);e.s.close();
});
test('cached Codex inputs are reported separately and never added twice',()=>{
 const a=new WorkerAccounting();const row=JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:120,cached_input_tokens:80}}}});
 a.ingest('codex',row);a.ingest('codex',row);a.ingest('codex',JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:80}}));
 expect(a.tokens).toBe(120);expect(a.cachedTokens).toBe(80);
});

test('comparable receipts cannot shrink explicitly approved ticket budgets',()=>{
 const e=setup(),x=e.admit(ticket(),admission());e.claimStart(x.id);e.account(x.id,240,4000000);e.finish(x.id,true);
 const y=e.admit({...ticket(2),estimateTokens:8000000,estimateSeconds:1800},admission());
 expect(JSON.parse(y.brief)).toMatchObject({estimateTokens:8000000,estimateSeconds:1800});
 expect(JSON.parse(e.sessions()[0].brief)).toMatchObject({estimateTokens:8000000,estimateSeconds:1800});e.s.close();
});

test('larger comparable receipts raise future reservations only',()=>{
 const e=setup(),x=e.admit(ticket(),admission());e.claimStart(x.id);e.account(x.id,2000,9000000);e.finish(x.id,true);
 const y=e.admit(ticket(2),admission());
 expect(JSON.parse(y.brief)).toMatchObject({estimateTokens:9000000,estimateSeconds:2000});
 expect(JSON.parse(x.brief)).toMatchObject({estimateTokens:8000000,estimateSeconds:1800});e.s.close();
});
