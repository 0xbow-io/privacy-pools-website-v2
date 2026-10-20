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

// Go to Withdraw via a real load, fill amount + recipient, request the quote.
await page.goto('http://localhost:8080/?theme=4&action=withdraw', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/withdraw-form-pre.png' });
const input = page.getByPlaceholder('0').first();
await input.click(); await input.fill('0.01');
await page.waitForTimeout(1500);
const filled = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input, textarea'));
  const rec = inputs.find((i) => /recipient/i.test(i.placeholder || ''));
  if (!rec) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(rec, '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D');
  rec.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
console.log('recipient filled:', filled);
await page.waitForTimeout(1500);
// The inline CTA says Withdraw (or Fetching Quote...)
const cta = page.getByText(/^(Withdraw|Fetching Quote)/, { exact: false }).last();
await cta.click({ timeout: 15000 }).catch(async (e) => { console.log('CTA click failed:', String(e).slice(0,120)); });
let onReview = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const t = await page.evaluate(() => document.body.innerText);
  if (/Unshielding/.test(t) && /You receive/.test(t)) { onReview = true; break; }
}
console.log('compact review rendered:', onReview);
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/withdraw-review-compact.png' });
const t = await page.evaluate(() => document.body.innerText);
console.log('has fee line:', /Fee 0\./.test(t), '| has quote countdown:', /quote \d+s/.test(t), '| input still visible:', /Amount to withdraw/.test(t));
await browser.close();
process.exit(onReview ? 0 : 1);
