// One-off verification probe for the mobile bottom nav + More drawer.
// Needs a dev server on :8081.
import { chromium, type Page } from 'playwright';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function boot(width: number, url: string) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(3200);
  return { browser, page };
}

const has = (page: Page, sel: string) => page.evaluate((s) => !!document.querySelector(s), sel);
const tap = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return false;
  el.click();
  return true;
}, sel);

/** Visible leaf texts, for list assertions. */
const visibleTexts = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && (el.textContent || '').trim()
      && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => (el.textContent || '').trim()));

const NAV = ['My Pools', 'Stats', 'Ecosystem', 'Payroll'];
const FOOTER = ['White Paper', 'Docs', 'X', 'Telegram', 'Support', 'Github', 'Terms', 'Privacy', 'Newsletter'];

async function mobileHome() {
  console.log('\n=== MOBILE home 390px ===');
  const { browser, page } = await boot(390, `${BASE}/?theme=1`);

  check('bottom bar present', await has(page, '[data-testid="explore-tab-mine"]'));
  check('More tab present', await has(page, '[data-testid="explore-tab-more"]'));
  const tabCount = await page.evaluate(() => document.querySelectorAll('[data-testid^="explore-tab-"]').length);
  check('bar has exactly 4 tabs', tabCount === 4, `${tabCount}`);

  check('header hamburger GONE on mobile',
    await page.evaluate(() => !document.querySelector('[aria-label="Navigation menu"]')));

  const texts = await visibleTexts(page);
  const footerOnPage = FOOTER.filter((l) => texts.includes(l));
  // Unobservable locally for the same reason (see desktopUnchanged) — recorded,
  // not counted as proof the mobile gate works.
  console.log(`  NOTE  footer links on mobile page: ${footerOnPage.length === 0 ? 'none' : JSON.stringify(footerOnPage)} (footer also globally off via the smart-wallet flag)`);

  await page.screenshot({ path: 'scripts/visual/reports/probe-mnav-bar.png' });

  // --- More drawer -------------------------------------------------------
  check('More tab tapped', await tap(page, '[data-testid="explore-tab-more"]'));
  await page.waitForTimeout(900);
  check('More drawer opened', await has(page, '[data-testid="more-drawer-close"]'));

  const navRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="more-nav-"]'))
      .map((el) => (el.textContent || '').trim()));
  check('drawer lists the page links', NAV.every((n) => navRows.some((r) => r.includes(n))), JSON.stringify(navRows));
  check('drawer has an Info row', await has(page, '[data-testid="more-nav-info"]'));
  const drawerTexts = await visibleTexts(page);
  check('Info row sits at the BOTTOM of the list',
    drawerTexts.lastIndexOf('Info') > drawerTexts.indexOf('Payroll'),
    `Info@${drawerTexts.lastIndexOf('Info')} Payroll@${drawerTexts.indexOf('Payroll')}`);
  await page.screenshot({ path: 'scripts/visual/reports/probe-mnav-more.png' });

  // --- Info sub-pane -----------------------------------------------------
  check('Info tapped', await tap(page, '[data-testid="more-nav-info"]'));
  await page.waitForTimeout(700);
  const infoRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="more-info-"]'))
      .map((el) => (el.textContent || '').trim()));
  check('Info pane lists ALL footer links', FOOTER.every((l) => infoRows.some((r) => r.includes(l))),
    `${infoRows.length} rows: ${JSON.stringify(infoRows)}`);
  check('Info pane offers a way back', await has(page, '[data-testid="more-drawer-back"]'));
  await page.screenshot({ path: 'scripts/visual/reports/probe-mnav-info.png' });

  check('back returns to the page links', await tap(page, '[data-testid="more-drawer-back"]'));
  await page.waitForTimeout(600);
  check('page links visible again', await has(page, '[data-testid="more-nav-info"]'));

  await browser.close();
}

async function mobileOtherRoute() {
  console.log('\n=== MOBILE non-home route (/transactions) 390px ===');
  const { browser, page } = await boot(390, `${BASE}/transactions?theme=1`);
  check('bar is mounted app-wide, not just on home', await has(page, '[data-testid="explore-tab-more"]'));
  check('hamburger gone here too',
    await page.evaluate(() => !document.querySelector('[aria-label="Navigation menu"]')));
  const texts = await visibleTexts(page);
  console.log(`  NOTE  footer links on /transactions: ${FOOTER.filter((l) => texts.includes(l)).length}`);
  // The exploratory tabs must navigate home with the panel from another route.
  check('tapped My balances', await tap(page, '[data-testid="explore-tab-mine"]'));
  await page.waitForTimeout(2500);
  const url = page.url();
  check('navigated home carrying the panel', /panel=balances/.test(url) && new URL(url).pathname === '/', url);
  await browser.close();
}

async function desktopUnchanged() {
  console.log('\n=== DESKTOP 1440px — must be unchanged ===');
  const { browser, page } = await boot(1440, `${BASE}/?theme=1`);
  check('no bottom bar on desktop',
    await page.evaluate(() => !document.querySelector('[data-testid^="explore-tab-"]')));
  // The footer cannot be observed in this environment: local .env sets
  // EXPO_PUBLIC_ENABLE_SMART_WALLET=true, and smartWalletActive() makes Footer
  // return null on web at EVERY width (its links live in Settings > About in
  // that mode). So the desktop-footer expectation is unobservable here rather
  // than failing — asserting it would be asserting the flag, not the change.
  const texts = await visibleTexts(page);
  const footerSeen = FOOTER.filter((l) => texts.includes(l));
  if (footerSeen.length === 0) {
    console.log('  SKIP  desktop footer — globally disabled by EXPO_PUBLIC_ENABLE_SMART_WALLET; mobile gate unverifiable locally');
  } else {
    check('footer still present on desktop', footerSeen.length >= 5, JSON.stringify(footerSeen));
  }
  await browser.close();

  // The hamburger only exists once the nav collapses, so check a width where it does.
  const narrowDesk = await boot(1000, `${BASE}/?theme=1`);
  check('hamburger still present at 1000px (tablet/desktop)',
    await has(narrowDesk.page, '[aria-label="Navigation menu"]'));
  await narrowDesk.browser.close();
}

await mobileHome();
await mobileOtherRoute();
await desktopUnchanged();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
