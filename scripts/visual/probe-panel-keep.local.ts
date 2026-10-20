// @ts-nocheck — local one-off probe
// Split-screen + tab click: /?action=shield&panel=balances then click the
// Withdraw tab. The panel param must survive (split view stays), action=withdraw.
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await page.goto('http://localhost:8080/?theme=4&action=shield&panel=balances', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(6000);
const before = await page.evaluate(() => location.search);
console.log('before:', before);

// Click the Withdraw tab inside the hub tab row via real coordinates,
// measured at click time.
const box = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  const tab = Array.from(row.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Withdraw');
  const r = tab.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(3000);
const after = await page.evaluate(() => location.search);
const panelVisible = await page.evaluate(() => (document.body.innerText || '').includes('My balances'));
console.log('after:', after, '| balances panel visible:', panelVisible);
const u = new URLSearchParams(after);
const pass = u.get('panel') === 'balances' && u.get('action') === 'withdraw' && panelVisible;
console.log(pass ? 'PASS — panel survived the tab click' : 'FAIL — panel lost');
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/panel-keep.png' });
await browser.close();
process.exit(pass ? 0 : 1);
