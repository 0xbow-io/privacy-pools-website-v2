import { chromium } from 'playwright';
const BASE = process.env.PROBE_URL ?? 'http://localhost:8080';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.addInitScript(() => { try { window.localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'); } catch {} });
await page.goto(`${BASE}/?theme=1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
const tap = async (testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error('no box ' + testId);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
await tap('explore-tab-more');
await page.waitForTimeout(1200);
console.log('open:', await page.getByTestId('more-drawer').isVisible().catch(() => false));
await tap('more-drawer-close');
await page.waitForTimeout(800);
console.log('after X close:', await page.getByTestId('more-drawer').isVisible().catch(() => false));
// Reopen, then tap the backdrop (top area) after the guard window.
await tap('explore-tab-more');
await page.waitForTimeout(900);
await page.touchscreen.tap(195, 120);
await page.waitForTimeout(800);
console.log('after backdrop tap:', await page.getByTestId('more-drawer').isVisible().catch(() => false));
await browser.close();
