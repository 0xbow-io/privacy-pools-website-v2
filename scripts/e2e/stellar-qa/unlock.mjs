import {launchChrome} from '../../lib/chrome.mjs';
import assert from 'node:assert/strict';
const browser=await launchChrome({headless:true});try{
for(const width of [1440,390]){const p=await browser.newPage({viewport:{width,height:1100}});await p.goto('http://localhost:8093/?env=staging&qa=locked&qaFlow=withdraw&qaStage=input');await p.waitForFunction(()=>window.__stellarQaDone,{timeout:45000});assert.doesNotMatch(await p.locator('body').innerText(),/Insufficient Stellar balance/);await p.getByRole('button',{name:'Withdraw',exact:true}).click();await p.getByTestId('hub-page-withdraw').getByText('100.00 XLM',{exact:true}).waitFor();await p.waitForTimeout(500);if(await p.getByTestId('drawer-close').isVisible())await p.getByTestId('drawer-close').click();await p.getByRole('button',{name:'Withdraw',exact:true}).click();await p.getByText('Confirm Withdrawal',{exact:true}).waitFor();await p.screenshot({path:`/tmp/dev825-unlock-${width}.png`});console.log('PASS locked withdrawal unlock and review',width);await p.close();}
const race = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await race.goto('http://localhost:8093/?env=staging&qa=locked&qaFlow=withdraw&qaStage=input&qaUnlock=reject', { waitUntil: 'domcontentloaded' });
await race.waitForFunction(() => window.__stellarQaDone, { timeout: 45000 });
await race.getByRole('button', { name: 'Withdraw', exact: true }).click();
await race.getByTestId('hub-tab-send').click();
await race.waitForTimeout(1800);
await race.getByTestId('hub-tab-withdraw').click();
assert.doesNotMatch(await race.locator('body').innerText(), /Transaction was rejected/);
console.log('PASS stale unlock rejection cannot affect a reopened withdrawal');
await race.close();
}finally{await browser.close();}
