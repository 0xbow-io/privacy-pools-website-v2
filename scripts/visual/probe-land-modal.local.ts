// @ts-nocheck — local one-off probe
// Reproduce the wallet-picker flow the harness skips: a managed overlay entry
// (?modal=connect) is on the history stack while the wallet connects; the
// overlay then closes via history.back() — exactly what the real picker does.
// Without the overlay guard the landing pushed its panel entry on top and the
// pop stripped it, reading as a user dismissal -> terminal stop.
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const PHRASE = process.env.TEST_PHRASE;
if (!PHRASE) throw new Error('TEST_PHRASE missing from env');
const account = mnemonicToAccount(PHRASE.trim());

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[PP-LAND]')) console.log(t.slice(0, 300));
});
await installEvmWallet(page, account);
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
// Raise the overlay AFTER hydration (like the real picker — a pre-hydration
// push gets erased by Expo's own replaceState) but BEFORE the funded signal
// arrives, so the landing decision happens under the overlay.
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(400);
  const search = await page.evaluate(() => {
    if (!location.search.includes('modal=connect') && !location.search.includes('panel=')) {
      history.pushState({}, '', location.pathname + location.search + (location.search ? '&' : '?') + 'modal=connect');
    }
    return location.search;
  });
  if (search.includes('modal=connect')) { console.log('overlay raised:', search); break; }
}

// Wait until the wallet has connected and the pools data has loaded (the
// landing would fire now if not deferred by the overlay).
await page.waitForTimeout(12_000);
const midPanel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('panel while overlay open =', midPanel, '(must be null — deferred)');

// The picker closes after a successful connect: pop its entry.
await page.evaluate(() => history.back());
await page.waitForTimeout(6_000);
const panel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('panel after overlay close =', panel, panel === 'balances' ? '(LANDED ✓)' : '(DEAD ✗)');
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/real-land-4-modal.png' });
await browser.close();
process.exit(midPanel === null && panel === 'balances' ? 0 : 1);
