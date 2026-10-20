// @ts-nocheck — local one-off probe
// Account-switch landing: connect an UNFUNDED account A, kill its landing
// cycle by navigating away (a real user choice), come back home, then switch
// the wallet to the FUNDED account B (accountsChanged, like a real extension).
// B must get a fresh landing cycle -> /?panel=balances.
import { chromium } from 'playwright';
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const FUNDED = mnemonicToAccount(process.env.TEST_PHRASE.trim()).address;
const accountA = privateKeyToAccount(generatePrivateKey());
console.log('A (unfunded):', accountA.address, '| B (funded):', FUNDED);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/\[PP-LAND\] (identity|balances|managed|navigation)/.test(t)) console.log(t.slice(0, 260));
});
await installEvmWallet(page, accountA);
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(10_000);

// A is armed and unfunded. End A's cycle with a real navigation.
await page.getByText('Portfolio', { exact: true }).first().click();
await page.waitForTimeout(4000);
console.log('after nav-away, path =', await page.evaluate(() => location.pathname));
await page.goBack();
await page.waitForTimeout(3000);
console.log('back home, path =', await page.evaluate(() => location.pathname),
  'panel =', await page.evaluate(() => new URL(location.href).searchParams.get('panel')));

// Switch to the funded account.
await page.evaluate((addr) => window.__hwEvmSwitchAddress(addr), FUNDED);
await page.waitForTimeout(12_000);
const panel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('\nSWITCH RESULT panel =', panel, panel === 'balances' ? '(REDIRECTED ✓)' : '(NO REDIRECT ✗)');
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/real-land-5-switch.png' });
await browser.close();
process.exit(panel === 'balances' ? 0 : 1);
