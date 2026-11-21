import {launchChrome} from '../../lib/chrome.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out='/tmp/dev825-qa-results';await mkdir(out,{recursive:true});
const browser=await launchChrome({headless:true});const results=[];
const scenarios=process.env.QA_SCENARIOS?.split(',')??['funded','error','empty','pending','locked'];
try {for(const width of (process.env.QA_WIDTHS?.split(',').map(Number)??[1440,390])) for(const scenario of scenarios) for(const tab of (process.env.QA_TABS?.split(',')??['shield','withdraw','send','request'])){
 const page=await browser.newPage({viewport:{width,height:width===390?844:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const stage=['funded','error'].includes(scenario)?'success':'input';const key=`${width}-${scenario}-${tab}`;
 try {await page.goto(`http://localhost:8093/?env=staging&qa=${scenario}&qaFlow=${tab}&qaStage=${stage}`);await page.waitForFunction(()=>window.__stellarQaDone,{timeout:45000});
 const done=await page.evaluate(()=>window.__stellarQaDone);assert.ok(!done.startsWith('ERROR'),done);
 const text=await page.locator('body').innerText();
 if(scenario==='funded'){assert.match(text,tab==='shield'?/Deposit submitted|Deposit Successful/:tab==='withdraw'?/Withdrawal Successful/:tab==='send'?/Transfer Successful/:/Send this link to get paid/);}
 if(scenario==='error')assert.match(text,/cancel|reject|failed/i);
 if(stage==='input'){assert.equal(await page.evaluate(()=>window.__stellarQaCalls.length),0);if(tab==='withdraw'&&['empty','pending'].includes(scenario))assert.equal(await page.getByRole('button',{name:'Withdraw',exact:true}).getAttribute('aria-disabled'),'true');}
 assert.equal(await page.getByTestId('hub-tab-swap').count(),0);assert.deepEqual(errors,[]);
 await page.screenshot({path:`${out}/${key}.png`});await writeFile(`${out}/${key}.txt`,text);results.push({key,pass:true});console.log('PASS',key);
 }catch(e){console.log('FAIL',key,e.message);await page.screenshot({path:`${out}/${key}-failure.png`});results.push({key,pass:false,error:e.message});}finally{await page.close();}
} }finally{await writeFile(`${out}/results-${scenarios.join("-")}.json`,JSON.stringify(results,null,2));await browser.close();}
assert.ok(results.every(r=>r.pass),'Some mocked UI cases failed');
