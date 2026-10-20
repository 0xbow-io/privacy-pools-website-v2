// @ts-nocheck — local one-off probe, uses real playwright types
// REAL end-to-end landing test: the TEST_PHRASE account (real Sepolia deposits,
// real signatures) connects on '/', must land on /?panel=balances, sign in via
// the auto-opened modal, and show synced balances. Screenshots along the way.
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const PHRASE = process.env.TEST_PHRASE;
if (!PHRASE) throw new Error('TEST_PHRASE missing from env');
const account = mnemonicToAccount(PHRASE.trim());
console.log('test account:', account.address);

const BASE = 'http://localhost:8080';
const SHOT = (n: string) => `/tmp/ppv2-nativewind/scripts/visual/reports/real-land-${n}.png`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[PP-LAND]') || t.includes('[PP-SESSION]')) console.log(t.slice(0, 350));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));

await installEvmWallet(page, account);
await page.goto(`${BASE}/?theme=4`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
for (let i = 0; i < 30; i++) {
  if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText))) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(10_000);
await page.screenshot({ path: SHOT('1-after-connect') });

const panel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('panel after connect =', panel, panel === 'balances' ? '(REDIRECTED ✓)' : '(NO REDIRECT ✗)');

// The unlock modal auto-opens offering passkey; a headless browser has no
// passkey, so take the wallet-signature path — the harness signs typed data
// node-side for real.
const bodyText = () => page.evaluate(() => document.body.innerText);
const walletPath = page.getByText('Use wallet signature instead', { exact: false }).first();
if (await walletPath.isVisible().catch(() => false)) {
  console.log('clicking: Use wallet signature instead');
  await walletPath.click().catch(() => {});
  await page.waitForTimeout(1500);
  // The header banner ALSO says "Sign in" — click the CTA inside the unlock
  // modal specifically: the "Sign in" text nearest to "Unlock your account".
  await page.getByText('Unlock your account', { exact: false }).waitFor({ timeout: 10_000 }).catch(() => {});
  const clicked = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && d.textContent?.includes('Unlock your account');
    });
    const host = overlays.pop() ?? document.body;
    const cta = Array.from(host.querySelectorAll('*')).find(
      (el) => el.textContent?.trim() === 'Sign in' && el.children.length === 0,
    ) as HTMLElement | undefined;
    if (!cta) return false;
    cta.click();
    return true;
  });
  console.log('modal Sign in clicked:', clicked);
}
// Wait for keystore unlock + note sync.
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const t = await bodyText();
  if (/Total balance/.test(t) && !/Sign in to sync/.test(t)) break;
  if (i % 15 === 14) console.log('waiting for sync…', /Sign in to sync/.test(t) ? 'still locked' : 'syncing');
}
await page.waitForTimeout(5_000);
await page.screenshot({ path: SHOT('2-balances') });
const finalPanel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
const text = await bodyText();
console.log('final panel =', finalPanel);
console.log('has "My balances":', /My [Bb]alances/.test(text), '| has Total balance:', /Total balance/.test(text));

// THE USER'S FAILING SCENARIO: reload on plain '/' with cached notes (signed
// session happened) + auto-reconnecting wallet. Their trace shows noteBal:true
// with the machine already stopped — reproduce from the very first line.
console.log('\n=== RELOAD on plain / with CACHED NOTES ===');
await page.evaluate(() => history.replaceState({}, '', '/?theme=4'));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(20_000);
const panel3 = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('\nRELOAD-WITH-NOTES RESULT panel =', panel3, panel3 === 'balances' ? '(REDIRECTED ✓)' : '(NO REDIRECT ✗)');
await page.screenshot({ path: SHOT('3-reload') });
await browser.close();
process.exit(finalPanel === 'balances' && panel3 === 'balances' ? 0 : 1);
