// @ts-nocheck — local one-off probe
// Mobile-touch pill check: (1) tap the Send tab — pill must glide; (2) touch
// swipe the pager — pill must ride the finger; page must settle + adopt.
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(6000);

const pillX = () => page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!row) return null;
  const pill = Array.from(row.children).find((c) => {
    const s = getComputedStyle(c);
    return s.position === 'absolute' && s.pointerEvents === 'none';
  });
  if (!pill) return null;
  return new DOMMatrixReadOnly(getComputedStyle(pill).transform).m41;
});
const urlAction = () => page.evaluate(() => new URL(location.href).searchParams.get('action'));

// --- 1) TAP the Send tab ---
const tabBox = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  const tab = Array.from(row.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Send');
  const r = tab.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('tap Send at', JSON.stringify(tabBox), '| pill before:', await pillX());
await page.touchscreen.tap(tabBox.x, tabBox.y);
const tapSamples = [];
for (let i = 0; i < 24; i++) { tapSamples.push(Math.round((await pillX()) * 10) / 10); await page.waitForTimeout(40); }
console.log('pill after tap (40ms steps):', tapSamples.join(' '));
console.log('action after tap:', await urlAction());

// --- 2) touch SWIPE the pager left (Send -> Swap or next) ---
const cdp = await context.newCDPSession(page);
const swipe = async (x0, y0, x1, y1, steps = 12) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const pagerY = tabBox.y + 260; // inside the pager content
const swipeSamples = [];
const sampler = (async () => {
  for (let i = 0; i < 40; i++) { swipeSamples.push(Math.round((await pillX()) * 10) / 10); await page.waitForTimeout(40); }
})();
await swipe(330, pagerY, 60, pagerY);
await sampler;
console.log('pill through swipe (40ms steps):', swipeSamples.join(' '));
console.log('action after swipe:', await urlAction());
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/pill-touch.png' });

const tapMoved = Math.abs(tapSamples[tapSamples.length - 1] - tapSamples[0]) > 10;
const swipeMoved = Math.abs(swipeSamples[swipeSamples.length - 1] - swipeSamples[0]) > 10 || new Set(swipeSamples).size > 3;
console.log('tap glide:', tapMoved ? 'OK' : 'BROKEN', '| swipe tracking:', swipeMoved ? 'OK' : 'BROKEN');
await browser.close();
process.exit(tapMoved && swipeMoved ? 0 : 1);
