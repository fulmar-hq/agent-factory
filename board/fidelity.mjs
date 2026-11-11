// Private reference and screenshots stay outside Git. Test instrumentation only exposes its existing data.
import {chromium,webkit} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const out=process.env.BOARD_SCREENSHOTS, reference=process.env.BOARD_MOCKUP;
if(!out || !reference)throw Error('Set BOARD_SCREENSHOTS and BOARD_MOCKUP');
await mkdir(out,{recursive:true});
const source=await readFile(reference,'utf8'), url=process.env.BOARD_URL || 'http://127.0.0.1:4318';
const reports=[];
for(const engine of [chromium,webkit]) {
 for(const viewport of [{width:1440,height:900},{width:1280,height:800},{width:768,height:1024},{width:375,height:812}])for(const colorScheme of ['light','dark']) {
  const browser=await engine.launch({headless:true});
  try {
  console.error(`Comparing ${engine.name()} ${viewport.width} ${colorScheme}`);
  const context=await browser.newContext({viewport,colorScheme,reducedMotion:'reduce',timezoneId:'America/Toronto'});
  const ref=await context.newPage(),live=await context.newPage();
  await ref.route('**/reference.html',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:source.replace('  render();\n})();','  window.reference={RUNNING,NEXT,WAITING,DONE,DONE_TOTAL,S,render};\n  render();\n})();')}));
  await ref.goto('http://reference.local/reference.html');
  // The reference explicitly calls this review-only picker “not part of the real page”.
  await ref.locator('#mock').evaluate(el=>el.remove());
  await live.goto(url);await live.locator('.board').waitFor();
  const stem=`${engine.name()}-${viewport.width}-${colorScheme}`;
  await ref.screenshot({path:join(out,`mockup-${stem}.png`)});
  await live.screenshot({path:join(out,`live-${stem}.png`)});
  const measurements=await live.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,meters:[...document.querySelectorAll('.meter')].map(el=>({right:el.getBoundingClientRect().right,clipped:el.scrollWidth>el.clientWidth+1}))}));
  if(measurements.overflow || measurements.meters.some(m=>m.right>viewport.width || m.clipped))throw Error(`Clipping ${stem}`);
  await ref.locator('#col-running .row').first().click();
  await live.locator('#col-running .row').first().click();
  await ref.screenshot({path:join(out,`mockup-popup-${stem}.png`)});
  await live.screenshot({path:join(out,`live-popup-${stem}.png`)});
  await ref.keyboard.press('Escape');await live.keyboard.press('Escape');await ref.mouse.move(0,0);await live.mouse.move(0,0);
  // Equal-data comparison isolates design from the real desk's changing contents.
  const sample=await ref.evaluate(()=>{const r=window.reference;return {running:r.RUNNING,next:r.NEXT.slice(0,5),waiting:r.WAITING,done:r.DONE,total:r.DONE_TOTAL};});
  const now=Date.parse('2026-11-09T16:15:00Z'), fixture=await (await live.request.get(url+'/api/board')).json();
  const task=(x,i)=>({id:String(i),title:x.t,owner:x.o,purpose:x.d || x.t,seconds:(x.used ?? 0)*60,estimateSeconds:(x.est ?? 30)*60,lastActivity:now-(x.act ?? 0)*60000,started:now-(x.used ?? 0)*60000,ownerRun:!!x.run,tone:'ok',barTone:(x.used>x.est || x.act>=15)?'warn':'ok',over:x.used>x.est,quiet:x.act>=15,technical:{}});
  fixture.now=now;fixture.notice=null;fixture.questions=[];
  fixture.hero={mode:'working',title:'Working',soft:'6 tasks running',lede:'Nothing needs you.'};
  fixture.usage=[{provider:'codex',percent:19,resetsAt:Date.parse('2026-11-11T12:40:00Z'),tone:'ok'},{provider:'claude',percent:41,resetsAt:Date.parse('2026-11-13T14:00:00Z'),tone:'ok'}];
  fixture.aws={dollars:27.52,ceiling:75,tone:'ok',stopped:true};
  fixture.nextRelease={at:Date.parse('2026-11-10T01:00:00Z'),name:'QA'};fixture.nextLiveAt=Date.parse('2026-11-10T02:30:00Z');
  fixture.releases=[{at:fixture.nextRelease.at,label:'Scheduled',tone:'info'},{at:fixture.nextLiveAt,label:'Scheduled',tone:'info'}];
  fixture.running=sample.running.map(task);fixture.upNext=sample.next.map(task);
  fixture.waiting=sample.waiting.flatMap(g=>Array.from({length:g.total},(_,i)=>({...task(g.items[i] ?? g.items[0],g.k+i),waitGroup:g.k})));
  fixture.done=sample.done.map((x,i)=>({...task(x,'done'+i),out:x.out,at:x.w.ago!==undefined ? now-x.w.ago*60000 : x.w.y ? Date.parse('2026-11-08T05:00:00Z')+(x.w.y[0]*60+x.w.y[1])*60000 : Date.parse('2026-11-08T02:38:00Z')}));
  fixture.completed={count:31,medianSeconds:28*60,over:4};fixture.counts={running:6,upNext:5,waiting:32,done48h:31,needsYou:0};
  await live.route('**/api/board?*',route=>route.fulfill({json:fixture}));await live.reload();await live.locator('.board').waitFor();
  // Equalize only data: sample queue size, wall-clock labels, and its sample-only footer.
  await ref.evaluate(()=>{const r=window.reference;r.NEXT.splice(5);r.render();document.querySelector('#mock')?.remove();document.querySelector('#col-done .note')?.remove();});
  await live.screenshot({path:join(out,`equal-data-live-${stem}.png`)});
  await ref.screenshot({path:join(out,`equal-data-mockup-${stem}.png`)});
  const styles=async p=>p.evaluate(()=>Object.fromEntries(['.wrap','.top','.band','.meters','.mid','.flow','.board','.half','.col','.sec-head','.row.run','.chip.line','.row-top','.row-foot','.track','.pill','.group-btn','.sheet'].map(selector=>{const el=document.querySelector(selector),s=el&&getComputedStyle(el);return [selector,s?Object.fromEntries(['display','gridTemplateColumns','padding','margin','gap','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','borderRadius','backgroundColor','color'].map(k=>[k,s[k]])):null];})));
  const a=await styles(ref),b=await styles(live),differences=[];
  for(const selector of Object.keys(a))for(const key of Object.keys(a[selector] || {}))if(a[selector][key]!==b[selector]?.[key])differences.push({selector,property:key,mockup:a[selector][key],live:b[selector]?.[key]});
  reports.push({engine:engine.name(),...viewport,colorScheme,measurements,styleDifferences:differences});
  await Promise.race([context.close(),new Promise(resolve=>setTimeout(resolve,3000))]);
  }finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,3000))]);}
 }
}
await writeFile(join(out,'fidelity-measurements.json'),JSON.stringify(reports,null,2));
if(reports.some(r=>r.styleDifferences.length))throw Error('Reference styles differ; see fidelity-measurements.json');
console.log(JSON.stringify(reports.map(x=>({engine:x.engine,width:x.width,scheme:x.colorScheme,differences:x.styleDifferences})),null,2));
