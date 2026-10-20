// @ts-nocheck — local one-off probe
// Shield busy view: input stays visible+inert with progress below; the
// harness wallet hard-rejects eth_sendTransaction, so the flow then FAILS
// and must restore the form (CTA back + error line).
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const account = mnemonicToAccount(process.env.TEST_PHRASE.trim());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await installEvmWallet(page, account);
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(10_000);
// Complete the unlock (wallet-signature path) so the CTA actually deposits.
const walletPath = page.getByText('Use wallet signature instead', { exact: false }).first();
if (await walletPath.isVisible().catch(() => false)) {
  await walletPath.click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && d.textContent?.includes('Unlock your account');
    });
    const host = overlays.pop();
    const cta = Array.from(host.querySelectorAll('*')).find(
      (el) => el.textContent?.trim() === 'Sign in' && el.children.length === 0,
    );
    cta.click();
  });
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    if (!/Sign in to sync/.test(await page.evaluate(() => document.body.innerText))) break;
  }
}
// Close the balances panel so the hub is centered and simple.
await page.evaluate(() => history.replaceState({}, '', '/?theme=4'));
await page.waitForTimeout(1500);

// Fill 0.01 and press Shield ETH.
const input = page.getByPlaceholder('0').first();
await input.click(); await input.fill('0.01');
await page.getByText('Shield ETH', { exact: true }).first().click();

// Poll for the busy view.
let busySeen = false, busyShot = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => document.body.innerText);
  if (/Depositing 0\.01/.test(t)) {
    busySeen = true;
    const inputVisible = /Amount to shield/.test(t) && /Wallet balance/.test(t);
    if (!busyShot) {
      busyShot = true;
      console.log('BUSY view: progress shown, input still visible =', inputVisible, '| CTA hidden =', !/Shield ETH/.test(t));
      await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/shield-busy.png' });
    }
  }
  if (busySeen && !/Depositing 0\.01/.test(t)) break; // flow ended (failure expected)
}
await page.waitForTimeout(2000);
const after = await page.evaluate(() => document.body.innerText);
const restored = /Shield ETH/.test(after) && /Amount to shield/.test(after);
console.log('busy view seen:', busySeen, '| form restored after failure:', restored, '| error line:', /rejected|failed|refuses|error/i.test(after));
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/shield-after-fail.png' });
await browser.close();
process.exit(busySeen && restored ? 0 : 1);
