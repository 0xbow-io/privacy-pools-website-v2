// Read-only production output-selection regression; no wallet transactions.
import assert from 'node:assert/strict';
import { launchChrome } from '../lib/chrome.mjs';
const browser = await launchChrome({headless:true});
try {
for (const width of [1440,390]) {
 const page=await browser.newPage({viewport:{width,height:1100}});
 page.setDefaultTimeout(15000);
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 await page.goto(`${process.env.PROBE_URL ?? 'http://localhost:8092'}/?env=prod`,{waitUntil:'domcontentloaded'});
 await page.getByTestId('hub-shield-pay-token').first().waitFor();
 for (const id of [1,56,10,8453,42161,4114]) {
  await page.getByTestId('hub-shield-pay-token').first().click();
  const payNames={1:'ETH on Ethereum',56:'BNB on BNB Chain',10:'ETH on Optimism',8453:'ETH on Base',42161:'ETH on Arbitrum',4114:'cBTC on Citrea'};
  await page.getByRole('button',{name:payNames[id],exact:true}).click();
  const output=page.getByTestId('hub-shield-pool').first();
  await output.waitFor();
  await page.waitForTimeout(400);
  const label=await output.getAttribute('aria-label');
  if(id===4114) { assert(await output.isDisabled()); assert.match(label,/cBTC.*Citrea/); console.log(width,id,'fixed',label); continue; }
  assert(await output.isEnabled(),`${id} retains output selection`);
  await output.click();
  await page.getByText('Deposit in pool',{exact:true}).waitFor();
  const rows=page.locator('[data-testid^="token-select-row-"]');
  const names=await rows.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));
  assert(names.length>1,`${id} has multiple outputs`);
  assert(!names.some(n=>/Stellar|Sepolia|XLM/.test(n)));
  console.log(width,id,JSON.stringify(names));
  const alternative=rows.filter({hasText:'USDT'}).first();
  if(await alternative.count()) { await alternative.click(); assert.match(await output.innerText(),/USDT/); }
  else await page.getByRole('button',{name:'Close token selector',exact:true}).click();
 }
 assert.deepEqual(errors,[]); await page.close();
}
} finally {await browser.close();}
