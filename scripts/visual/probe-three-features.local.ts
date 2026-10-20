// @ts-nocheck — local one-off probe
// 1) Privacy & keys menu gains Export/Import Notes -> recovery modal opens.
// 2) /?intro=true shows the marketing front page while CONNECTED; engaging
//    the widget removes it and strips the param.
// 3) Receive-payment modal shows the transience warning (claim flow UI).
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const account = mnemonicToAccount(process.env.TEST_PHRASE.trim());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await installEvmWallet(page, account);
const R = { ok: 0, fail: 0 };
const check = (label, pass, detail = '') => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); pass ? R.ok++ : R.fail++; };

// ---- 2) intro=true (connected) ----
await page.goto('http://localhost:8080/?theme=4&intro=true', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(12_000);
await page.keyboard.press('Escape'); // unlock modal, if any
// The below-fold FrontPage is a lazy chunk — first compile on the dev server
// can take a while; wait for its acts to appear.
await page.waitForFunction(() => !!document.querySelector('[data-testid="front-act-1"]'), null, { timeout: 60_000 }).catch(() => {});
let t = await page.evaluate(() => document.body.innerText);
const connected = /0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(t);
check('connected', connected);
const actInfo = await page.evaluate(() => {
  const act = document.querySelector('[data-testid="front-act-1"]');
  if (!act) return null;
  const r = act.getBoundingClientRect(); const st = getComputedStyle(act);
  return { h: r.height, vis: st.visibility, text: (act.textContent || '').slice(0, 30) };
});
check('front page visible while connected (intro=true)', !!actInfo && actInfo.h > 100 && actInfo.vis === 'visible', JSON.stringify(actInfo));
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/intro-1-front.png' });
// Engage the widget: focus the amount input.
const input = page.getByPlaceholder('0').first();
await input.click().catch(() => {});
await page.waitForTimeout(2500);
const introParam = await page.evaluate(() => new URL(location.href).searchParams.get('intro'));
check('intro param stripped on engage', introParam === null, String(introParam));
t = await page.evaluate(() => document.body.innerText);
const actAfter = await page.evaluate(() => !!document.querySelector('[data-testid="front-act-1"]'));
check('marketing gone after engage', !actAfter);
// codex R1 finding 5: a later shallow setParams must NOT resurrect `intro`.
const sendTabBox = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  const tab = row && Array.from(row.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Send');
  if (!tab) return null;
  const r = tab.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (sendTabBox) { await page.mouse.click(sendTabBox.x, sendTabBox.y); await page.waitForTimeout(2000); }
const introBack = await page.evaluate(() => new URL(location.href).searchParams.get('intro'));
check('intro NOT resurrected by tab setParams', introBack === null, String(introBack));
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/intro-2-engaged.png' });

// ---- 1) Privacy & keys -> Export/Import Notes ----
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(8000);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
// Open the account (Actions) dropdown: click the address chip.
await page.getByText(/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/).first().click();
await page.waitForTimeout(800);
t = await page.evaluate(() => document.body.innerText);
const privacyEntry = page.getByText('Privacy & keys', { exact: false }).first();
if (await privacyEntry.isVisible().catch(() => false)) {
  await privacyEntry.click();
  await page.waitForTimeout(600);
  t = await page.evaluate(() => document.body.innerText);
  check('Export Notes entry present', /Export Notes/.test(t));
  check('Import Notes entry present', /Import Notes/.test(t));
  await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/notes-menu.png' });
  await page.getByText('Export Notes', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  t = await page.evaluate(() => document.body.innerText);
  check('export-notes modal opened', /backup|Backup/.test(t), t.slice(0, 80));
  await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/notes-export-modal.png' });
  await page.keyboard.press('Escape');
} else {
  console.log('menu text snapshot:', t.slice(0, 400));
  check('Privacy & keys submenu reachable', false);
}

// ---- 3) receive-payment transience warning ----
// The receive modal gates on an unlocked keystore: sign in first.
const walletPath = page.getByText('Sign in to sync', { exact: false }).first();
await page.getByText(/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/).first().click().catch(() => {});
await page.keyboard.press('Escape');
await page.evaluate(() => { const api = window.__paymentReq; if (api) api.openReceive(); });
await page.waitForTimeout(1500);
let seedText = await page.evaluate(() => document.body.innerText);
if (/Unlock your account|Unlock with passkey/.test(seedText)) {
  const wp = page.getByText('Use wallet signature instead', { exact: false }).first();
  if (await wp.isVisible().catch(() => false)) { await wp.click(); await page.waitForTimeout(1200); }
  await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && d.textContent?.includes('Unlock your account');
    });
    const host = overlays.pop();
    const cta = host && Array.from(host.querySelectorAll('*')).find((el) => el.textContent?.trim() === 'Sign in' && el.children.length === 0);
    if (cta) cta.click();
  });
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(2000); if (!/Sign in to sync/.test(await page.evaluate(() => document.body.innerText))) break; }
  await page.waitForTimeout(2000);
}
const opened = await page.evaluate(() => {
  const api = window.__paymentReq;
  if (!api) return false;
  api.openReceive();
  return true;
});
await page.waitForTimeout(1500);
if (opened) {
  t = await page.evaluate(() => document.body.innerText);
  check('receive modal shows transience warning', /saves the payment to this browser only/i.test(t));
  check('claim mentioned', /Claim it on-chain/i.test(t));
  await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/claim-warning.png' });
} else {
  console.log('TEST_MODE affordance unavailable — checking /receive page copy instead');
  await page.goto('http://localhost:8080/receive/bogus?theme=4', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  t = await page.evaluate(() => document.body.innerText);
  check('receive page renders', /Receive Payment|Invalid receive link/.test(t));
}

console.log(`\n${R.ok} passed, ${R.fail} failed`);
await browser.close();
process.exit(R.fail ? 1 : 0);
