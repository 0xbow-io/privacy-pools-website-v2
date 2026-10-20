/* Jelly bottom bar probe: mobile viewport, per-theme screenshots + tap checks. */
import { chromium } from 'playwright';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8080';


async function tapTab(page: import('playwright').Page, testId: string) {
  // RNGH listens on its own gesture surface above the item — dispatch a real
  // pointer tap at the item's center so the topmost layer receives it.
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (const theme of [1, 2, 4]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Returning-user profile: skip the smart-wallet onboarding overlay.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'); } catch {}
    });
    await page.goto(`${BASE}/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);

    const bar = page.getByTestId('explore-tab-mine');
    const barVisible = await bar.isVisible().catch(() => false);
    console.log(`theme=${theme} bar visible:`, barVisible, 'pageerrors:', errors.length ? errors.slice(0, 2) : 'none');

    await page.screenshot({ path: `.pwcheck/jelly-t${theme}.png` });

    if (barVisible) {
      // Tap "More" — drawer opens, bar stays; pill should move to More.
      await tapTab(page, 'explore-tab-more');
      await page.waitForTimeout(900);
      await page.screenshot({ path: `.pwcheck/jelly-t${theme}-more.png` });
      // The drawer covers the bar — close it via its own X, not a bar tap.
      await page.getByTestId('more-drawer-close').click();
      await page.waitForTimeout(600);

      // Tap "Explore pools" — full-page stack route, bar STAYS visible.
      await tapTab(page, 'explore-tab-pools');
      await page.waitForTimeout(1800);
      const barStays = await bar.isVisible().catch(() => false);
      const urlIsRoute = page.url().includes('/explore/pools');
      console.log(`theme=${theme} pools tap → bar visible:`, barStays, 'route:', urlIsRoute);
      await page.screenshot({ path: `.pwcheck/jelly-t${theme}-pools.png` });

      // My balances from the pools page — stack replaces forward, bar stays.
      await tapTab(page, 'explore-tab-mine');
      await page.waitForTimeout(1500);
      console.log(`theme=${theme} balances route:`, page.url().includes('/explore/balances'));
      await page.screenshot({ path: `.pwcheck/jelly-t${theme}-balances.png` });

      // Browser back pops the stack.
      await page.goBack();
      await page.waitForTimeout(1200);
      console.log(`theme=${theme} back →`, new URL(page.url()).pathname);

      // Shield tab returns home.
      await tapTab(page, 'explore-tab-shield');
      await page.waitForTimeout(1200);
      console.log(`theme=${theme} shield →`, new URL(page.url()).pathname);
    }
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
