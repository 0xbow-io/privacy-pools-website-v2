// @ts-nocheck
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';
const account = mnemonicToAccount(process.env.TEST_PHRASE.trim());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
page.on('console', (m) => { const t = m.text(); if (t.includes('[PP-INTRO]')) console.log(t.slice(0, 250)); });
await installEvmWallet(page, account);
await page.goto('http://localhost:8080/?theme=4&intro=true', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForTimeout(20_000);
console.log('len:', await page.evaluate(() => (document.body.innerText || '').length));
console.log(await page.evaluate(() => {
  const act = document.querySelector('[data-testid="front-act-1"]');
  const hint = document.querySelector('[data-testid="front-scroll-hint"]');
  const info = { actExists: !!act, hintExists: !!hint };
  if (act) {
    const r = act.getBoundingClientRect();
    const s = getComputedStyle(act);
    info.actRect = { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
    info.actDisplay = s.display; info.actVisibility = s.visibility; info.actOpacity = s.opacity;
    info.actText = (act.textContent || '').slice(0, 60);
  }
  return JSON.stringify(info);
}));
await browser.close();
