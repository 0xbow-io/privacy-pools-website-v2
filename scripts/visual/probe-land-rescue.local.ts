// @ts-nocheck
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';
const account = mnemonicToAccount(process.env.TEST_PHRASE.trim());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m) => { const t = m.text(); if (/\[PP-LAND\] (navigation|re-arming|balances landing)/.test(t)) console.log(t.slice(0, 160)); });
await installEvmWallet(page, account);
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(12_000);
console.log('after connect, panel =', await page.evaluate(() => new URL(location.href).searchParams.get('panel')));
// Navigate away (real stop) and come back.
await page.keyboard.press('Escape'); // unlock modal if present
await page.waitForTimeout(800);
await page.getByText('Portfolio', { exact: true }).first().click({ timeout: 15000, force: true });
await page.waitForTimeout(3500);
await page.goBack();
await page.waitForTimeout(6000);
const panel = await page.evaluate(() => new URL(location.href).searchParams.get('panel'));
console.log('back home, panel =', panel, panel === 'balances' ? '(RESCUED ✓)' : '(still dead ✗)');
await browser.close();
process.exit(panel === 'balances' ? 0 : 1);
