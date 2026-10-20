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

// Open My activity and click the first transaction row.
await page.evaluate(() => history.replaceState({}, '', '/?theme=4&panel=activity'));
await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.body.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(9000);
// Rows carry the type glyph + amount; click the first Deposit text in the panel.
const row = page.getByText('Deposit', { exact: true }).first();
await row.click({ timeout: 15000 });
await page.waitForTimeout(2500);
const t = await page.evaluate(() => document.body.innerText);
console.log('modal open:', /View on|Settled|Pending/.test(t), '| has hero amount:', /ETH/.test(t));
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/tx-detail-card.png' });
await browser.close();
