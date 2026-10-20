// @ts-nocheck — local one-off probe, uses real playwright types
// Positive-case landing repro: connect with an address the ASP knows is funded
// (0xD358... has 13 snapshot deposits) and watch every PP-LAND line from boot.
// Signing still uses the dev key — the session stays locked, which is exactly
// the user's scenario (redirect must fire on public deposits alone).
import { chromium } from 'playwright';
import { installEvmWallet, loadDevAccount } from './evm-wallet';

const FUNDED = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
const BASE = 'http://localhost:8080';

const dev = loadDevAccount();
const spoofed = new Proxy(dev, {
  get: (t, p) => (p === 'address' ? FUNDED : (t as never)[p as keyof typeof t]),
}) as typeof dev;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m: { text: () => string }) => {
  const t = m.text();
  if (t.includes('[PP-LAND]') || t.includes('[PP-SESSION]') || t.includes('[PP-PANEL]')) {
    console.log(t.slice(0, 400));
  }
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));

await installEvmWallet(page, spoofed);
await page.goto(`${BASE}/?theme=4`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
for (let i = 0; i < 30; i++) {
  if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText))) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(10_000);

const panel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('\nRESULT panel =', panel, panel === 'balances' ? '(REDIRECTED ✓)' : '(NO REDIRECT ✗)');

// The user's failing flow is not a fresh connect — it is a RELOAD with an
// auto-reconnecting wallet and cached notes. Reload on plain '/' (what they
// report) and watch the whole boot again.
console.log('\n=== RELOAD on plain / (auto-reconnect + cached notes) ===');
await page.evaluate(() => history.replaceState({}, '', '/?theme=4'));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(15_000);
const panel2 = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('\nRELOAD RESULT panel =', panel2, panel2 === 'balances' ? '(REDIRECTED ✓)' : '(NO REDIRECT ✗)');
await browser.close();
process.exit(panel === 'balances' && panel2 === 'balances' ? 0 : 1);
