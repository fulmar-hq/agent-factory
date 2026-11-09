// Opt-in browser acceptance: bun install --cwd board && BOARD_URL=http://127.0.0.1:4319 bun board/verify.ts
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const out = process.env.BOARD_SCREENSHOTS;
if (!out) throw Error("Set BOARD_SCREENSHOTS to the private run folder");
await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true, executablePath:process.env.BOARD_CHROMIUM});
const url = process.env.BOARD_URL ?? "http://127.0.0.1:4318";
const results = [];
try {
  for (const viewport of [{width:375,height:812},{width:1440,height:900},{width:820,height:1000}]) {
    for (const colorScheme of ["light","dark"]) {
      const page = await browser.newPage({viewport,colorScheme,reducedMotion:"reduce",timezoneId:"America/Toronto"});
      const errors = [];
      page.on("pageerror",e=>errors.push(e.message));
      page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
      await page.goto(url);
      await page.locator('.board').waitFor();
      const text = await page.locator('body').textContent() ?? '';
      if (/\d{4}-\d\d-\d\dT\d\d:|\{\s*"|\[object Object\]|NaN|undefined/.test(text)) throw Error('Raw data in DOM');
      const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth);
      if(overflow) throw Error(`Horizontal overflow at ${viewport.width}`);
      const order = await page.locator('.board > section').evaluateAll(els=>els.map(el=>el.id).join(','));
      if(order !== (viewport.width >= 1100 ? 'col-next,col-running,col-waiting,col-done' : 'col-running,col-next,col-waiting,col-done')) throw Error(`Column DOM order: ${order}`);
      if(await page.locator('[style],style,script:not([src])').count()) throw Error('Inline CSS/script violates CSP');
      if(await page.locator('.group:not(.open) .g-item:visible').count()) throw Error('Waiting group is not collapsed');
      if(await page.locator('#col-next .row:visible').count()>5) throw Error('Up next exceeds five');
      if(viewport.width>=1100) {
        const scrolling=await page.locator('.col-body').evaluateAll(els=>els.every(el=>getComputedStyle(el).overflowY==='auto'));
        if(!scrolling)throw Error('Columns do not scroll independently');
      }
      if(await page.locator('#legend[open]').count())throw Error('Legend must start collapsed');
      if(await page.locator('.flow .sdot').count()!==4 || await page.locator('.sec-head .sdot').count()!==4)throw Error('Stage dots missing');
      await page.screenshot({path:join(out,`live-${viewport.width}-${colorScheme}.png`),fullPage:true});
      const row = page.locator('.row:visible').first();
      if(await row.count()) {
        const key=await row.getAttribute('data-k');
        await row.click();
        await page.locator('.sheet.open').waitFor();
        if(await page.evaluate(()=>document.activeElement?.id) !== 'sheet-title')throw Error('Sheet heading not focused');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        if(!await page.evaluate(()=>!!document.activeElement?.closest('#sheet')))throw Error('Focus escaped sheet');
        await page.screenshot({path:join(out,`sheet-${viewport.width}-${colorScheme}.png`)});
        await page.keyboard.press('Escape');
        if(await page.evaluate(()=>document.activeElement?.getAttribute('data-k'))!==key)throw Error('Focus not restored');
      }
      const completed = page.locator('#col-done .row:visible').first();
      if(await completed.count()) {
        await completed.click();
        const facts = await page.locator('.facts').textContent();
        if(!['Started','Finished','Took','Expected'].every(word=>facts.includes(word)))throw Error('Completion timing facts missing');
        const details = await page.locator('#sheet-body').textContent();
        if(/\d{4}-\d\d-\d\dT|\{\s*"/.test(details))throw Error('Raw completion data');
        await page.screenshot({path:join(out,`completed-${viewport.width}-${colorScheme}.png`)});
        await page.keyboard.press('Escape');
      }
      await page.locator('#lang-fr').click();
      await page.waitForFunction(()=>document.documentElement.lang==='fr');
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('French overflow');
      await page.screenshot({path:join(out,`live-${viewport.width}-${colorScheme}-fr.png`),fullPage:true});
      // A fictional open question exercises the otherwise-empty live Needs-you state.
      const fixture = await (await page.request.get(url + '/api/board')).json();
      fixture.questions = [{id:'fictional-choice',title:'Keep AWS off tonight?',context:'Tonight’s release needs AWS to run.',choices:[{label:'Keep off',value:'off'},{label:'On tonight',value:'on'}],default:'stays off',deadline:fixture.now+3600000,defaultLine:'If you don’t answer by 7:30 PM: stays off',technical:{details:'Fictional acceptance question'}}];
      fixture.counts.needsYou=1; fixture.hero={mode:'needs',title:'Needs you',soft:'1 question',lede:'The running tasks carry on while you decide.'};
      await page.route('**/api/board?*', route=>route.fulfill({json:fixture}));
      await page.reload(); await page.locator('.ask').waitFor();
      if(await page.locator('.ask-choices .btn').count()!==2)throw Error('Structured choices missing');
      await page.screenshot({path:join(out,`question-${viewport.width}-${colorScheme}.png`),fullPage:true});
      await page.locator('[data-k="q0"]').click();
      await page.locator('.sheet.open').waitFor();
      await page.keyboard.press('Escape');
      if(await page.evaluate(()=>document.activeElement?.getAttribute('data-k'))!=='q0')throw Error('Question focus not restored');
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Question overflow');
      // Fictional data exercises every colour even when the real desk is quiet.
      fixture.questions=[];
      fixture.hero={mode:'working',title:'Working',soft:'3 tasks running',lede:''};
      fixture.usage=[{provider:'codex',percent:70,resetsAt:fixture.now+86400000,tone:'warn'},{provider:'claude',percent:90,resetsAt:fixture.now+86400000,tone:'bad'}];
      fixture.aws={dollars:27.52,ceiling:75,plan:60,redAbove:65,tone:'ok',stopped:true};
      const task={owner:'Product',purpose:'Fictional colour acceptance task',started:fixture.now-600000,seconds:600,estimateSeconds:1800,lastActivity:fixture.now-60000,ownerRun:false,status:'',technical:{},tone:'ok',barTone:'ok',over:false,quiet:false};
      fixture.running=[
        {...task,id:'pace',title:'On pace'},
        {...task,id:'over',title:'Past estimate',seconds:1801,over:true,barTone:'warn'},
        {...task,id:'quiet',title:'No recent log write',lastActivity:fixture.now-900000,quiet:true,barTone:'warn'}
      ];
      fixture.waiting=[1,2,3].map(n=>({...task,id:'fix'+n,title:'Needs a fix '+n,waitGroup:'fix',tone:'warn',status:'Checks need a fix'}));
      fixture.done=['live','test','closed'].map((out,i)=>({...task,id:'done'+i,title:'Completed '+out,out,at:fixture.now-60000,tone:['ok','info','rest'][i],over:i===1,barTone:i===1?'warn':'ok',seconds:i===1?1801:600}));
      fixture.counts.running=3;fixture.counts.waiting=3;fixture.counts.done48h=3;
      fixture.completed={count:3,medianSeconds:600,over:1};
      fixture.releases=[{at:fixture.now,state:'scheduled',tone:'info',label:'Scheduled'},{at:fixture.now,state:'skipped',tone:'rest',label:'Skipped: AWS is off'}];
      await page.evaluate(()=>localStorage.setItem('fd-lang','en'));
      await page.reload();await page.locator('#col-running .row').first().waitFor();
      const classes=await page.locator('#col-running progress').evaluateAll(els=>els.map(el=>el.className));
      if(classes.join(',')!=='ok,warn,warn')throw Error('Running tones: '+classes);
      if(await page.locator('.meter-sub .pill.warn').textContent()!=='High' || await page.locator('.meter-sub .pill.bad').first().textContent()!=='At limit')throw Error('Usage words missing');
      if(await page.locator('.meter progress').evaluateAll(els=>els.map(el=>el.className).join(','))!=='warn,bad,ok')throw Error('AWS latch changed spend colour');
      for(const word of ['1 over','1 quiet','3 need a fix'])if(!await page.locator('.flow').textContent().then(t=>t.includes(word)))throw Error('Missing trouble count '+word);
      if(await page.locator('.act.quiet').textContent()!=='No activity for 15\u00a0min')throw Error('Quiet wording missing');
      if(await page.locator('#col-done progress').evaluateAll(els=>els.map(el=>el.className).join(','))!=='ok,warn,ok')throw Error('Completed tones');
      const borders=await page.locator('.row,.col,.flow-cell,.group').evaluateAll(els=>els.some(el=>parseFloat(getComputedStyle(el).borderLeftWidth)>0));
      if(borders)throw Error('Coloured left borders are prohibited');
      await page.screenshot({path:join(out,`tones-${viewport.width}-${colorScheme}.png`),fullPage:true});
      await page.locator('#legend-sum').click();
      if(await page.locator('#legend-list li:visible').count()!==5)throw Error('Colour meanings missing');
      await page.locator('#legend-sum').click();
      await page.locator('#lang-fr').click();await page.waitForFunction(()=>document.documentElement.lang==='fr');
      if(await page.locator('#legend-sum').textContent()!=='Ce que signifient les couleurs')throw Error('French legend missing');
      if(await page.locator('.meter-sub .pill.warn').textContent()!=='Élevé')throw Error('French usage label missing');
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Colour states French overflow');
      if(errors.length)throw Error(errors.join('\n'));
      if(process.env.BOARD_MOCKUP) {
        const ref=await browser.newPage({viewport,colorScheme,reducedMotion:'reduce'});
        await ref.goto('file://'+process.env.BOARD_MOCKUP);
        const tokens=['--ok','--info','--warn','--bad','--rest','--accent-soft','--accent-ink','--info-soft','--info-ink','--warn-soft','--warn-ink','--bad-soft','--bad-ink'];
        const readTokens=names=>Object.fromEntries(names.map(name=>[name,getComputedStyle(document.documentElement).getPropertyValue(name).trim()]));
        if(JSON.stringify(await page.evaluate(readTokens,tokens))!==JSON.stringify(await ref.evaluate(readTokens,tokens)))throw Error('Status tokens differ from approved mockup');
        // Comparison omits the mockup-only state picker and uses its default real design state.
        await ref.locator('#mock').evaluate(el=>el.remove());
        await ref.screenshot({path:join(out,`mockup-${viewport.width}-${colorScheme}.png`),fullPage:true});
        await ref.close();
      }
      results.push({width:viewport.width,colorScheme,passed:true});
      await page.close();
    }
  }
  console.log(JSON.stringify(results));
} finally {await browser.close();}
