import { chromium } from 'playwright';
const BASE = process.env.PROBE_URL ?? 'http://localhost:8080';
async function run(mode: 'touch' | 'mouse') {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: mode === 'touch',
    isMobile: mode === 'touch',
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { window.localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'); } catch {} });
  await page.goto(`${BASE}/?theme=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const box = await page.getByTestId('explore-tab-more').boundingBox();
  if (!box) { console.log(mode, 'no box'); await browser.close(); return; }
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  if (mode === 'touch') await page.touchscreen.tap(cx, cy);
  else await page.mouse.click(cx, cy);
  await page.waitForTimeout(1200);
  console.log(mode, 'tap → drawer visible:', await page.getByTestId('more-drawer').isVisible().catch(() => false));
  await browser.close();
}
await run('touch');
await run('mouse');
