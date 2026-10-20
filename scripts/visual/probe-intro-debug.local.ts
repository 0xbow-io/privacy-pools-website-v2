// @ts-nocheck
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';
const account = mnemonicToAccount(process.env.TEST_PHRASE.trim());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await installEvmWallet(page, account);
await page.goto('http://localhost:8080/?theme=4&intro=true', { waitUntil: 'domcontentloaded', timeout: 90_000 });
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => ({ search: location.search, len: (document.body.innerText || '').length }));
  console.log(`${(i + 1) * 1.5}s`, JSON.stringify(s));
}
await browser.close();
