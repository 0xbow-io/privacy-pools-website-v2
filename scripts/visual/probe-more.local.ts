import { chromium } from 'playwright';
const BASE = process.env.PROBE_URL ?? 'http://localhost:8080';
async function tapTab(page: any, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { window.localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'); } catch {} });
  await page.goto(`${BASE}/?theme=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  // From home
  await tapTab(page, 'explore-tab-more');
  await page.waitForTimeout(900);
  console.log('home → more drawer visible:', await page.getByTestId('more-drawer').isVisible().catch(() => false));
  await page.getByTestId('more-drawer-close').click();
  await page.waitForTimeout(600);
  // From an explore page
  await tapTab(page, 'explore-tab-pools');
  await page.waitForTimeout(1500);
  await tapTab(page, 'explore-tab-more');
  await page.waitForTimeout(900);
  const vis = await page.getByTestId('more-drawer').isVisible().catch(() => false);
  console.log('explore/pools → more drawer visible:', vis, 'url:', new URL(page.url()).pathname);
  await page.screenshot({ path: '.pwcheck/more-on-explore.png' });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
