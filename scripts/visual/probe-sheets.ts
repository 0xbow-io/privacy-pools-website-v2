// One-off verification probe: notification bottom sheet + drag-to-dismiss.
// Needs a dev server on :8081.
import { chromium, type Page } from 'playwright';
import { installEvmWallet, loadDevAccount } from './evm-wallet';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function boot(width: number, height: number, url: string, connected = false) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  if (connected) await installEvmWallet(page, loadDevAccount());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  if (connected) {
    for (let i = 0; i < 30; i++) {
      if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText))) break;
      await page.waitForTimeout(1000);
    }
  }
  await page.waitForTimeout(2500);
  return { browser, page };
}

const has = (page: Page, sel: string) => page.evaluate((s) => !!document.querySelector(s), sel);
const tap = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return false;
  el.click();
  return true;
}, sel);

/** Centre of an element, for mouse gestures. */
const centreOf = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, sel);

/**
 * Drag a sheet's header downwards with the mouse. PanResponder is wired to
 * RN-Web's responder system, which maps mouse events too, so this is the same
 * path a finger takes on a phone.
 *
 * Grab the DRAG AREA, never a button inside it: dragging from the close button
 * made a short drag register as a click (dismissing for the wrong reason) and a
 * long drag end outside the button (doing nothing at all) — the assertion was
 * measuring the button, not the gesture.
 */
async function dragDown(page: Page, handleSel: string, distance: number) {
  const from = await centreOf(page, handleSel);
  if (!from) return false;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several steps: a single jump can be treated as a teleport and never crosses
  // the "is this a drag?" threshold.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x, from.y + (distance * i) / 8);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  return true;
}

async function signedOutMobile() {
  console.log('\n=== MOBILE vault, SIGNED OUT ===');
  const { browser, page } = await boot(390, 844, `${BASE}/?theme=1`);
  check('notification bell hidden when signed out', !(await has(page, '[data-testid="notification-bell"]')));

  // --- drag-to-dismiss on the More drawer (needs no wallet) --------------
  check('More tab tapped', await tap(page, '[data-testid="explore-tab-more"]'));
  await page.waitForTimeout(800);
  check('More drawer open', await has(page, '[data-testid="more-drawer-close"]'));

  // A short drag must NOT dismiss — it should settle back.
  await dragDown(page, '[data-testid="more-drag-area"]', 40);
  await page.waitForTimeout(700);
  check('a 40px drag settles back (does not dismiss)', await has(page, '[data-testid="more-drawer-close"]'));

  // A long drag must dismiss.
  await dragDown(page, '[data-testid="more-drag-area"]', 260);
  await page.waitForTimeout(1000);
  check('a 260px drag DISMISSES the More drawer', !(await has(page, '[data-testid="more-drawer-close"]')));

  // The drag wrapper calls setPointerCapture on pointerdown. Buttons INSIDE it
  // must still receive their clicks, or dragging traded away the close button.
  check('More tab re-opened', await tap(page, '[data-testid="explore-tab-more"]'));
  await page.waitForTimeout(800);
  const closeBtn = await centreOf(page, '[data-testid="more-drawer-close"]');
  if (closeBtn) {
    await page.mouse.click(closeBtn.x, closeBtn.y);
    await page.waitForTimeout(800);
  }
  check('the close button inside the drag area still works',
    !(await has(page, '[data-testid="more-drawer-close"]')), closeBtn ? 'clicked' : 'button not found');

  // Same for the Info back button, which also lives in the drag area.
  await tap(page, '[data-testid="explore-tab-more"]');
  await page.waitForTimeout(800);
  await tap(page, '[data-testid="more-nav-info"]');
  await page.waitForTimeout(700);
  const backBtn = await centreOf(page, '[data-testid="more-drawer-back"]');
  if (backBtn) {
    await page.mouse.click(backBtn.x, backBtn.y);
    await page.waitForTimeout(700);
  }
  check('the Info back button inside the drag area still works',
    await has(page, '[data-testid="more-nav-info"]'), backBtn ? 'clicked' : 'button not found');
  await tap(page, '[data-testid="more-drawer-close"]');
  await page.waitForTimeout(700);

  // --- and on a data sheet ----------------------------------------------
  check('My balances tapped', await tap(page, '[data-testid="explore-tab-mine"]'));
  await page.waitForTimeout(1200);
  check('data sheet open', await has(page, '[data-testid="drawer-close"]'));
  await dragDown(page, '[data-testid="drawer-drag-area"]', 260);
  await page.waitForTimeout(1200);
  check('drag DISMISSES the data sheet', !(await has(page, '[data-testid="drawer-close"]')));

  await browser.close();
}

async function connectedMobileVault() {
  console.log('\n=== MOBILE vault, CONNECTED ===');
  const { browser, page } = await boot(390, 844, `${BASE}/?theme=1`, true);
  const bell = await has(page, '[data-testid="notification-bell"]');
  check('bell shown once signed in', bell);
  if (!bell) { await browser.close(); return; }

  check('bell tapped', await tap(page, '[data-testid="notification-bell"]'));
  await page.waitForTimeout(900);
  check('opens a BOTTOM SHEET on mobile', await has(page, '[data-testid="notification-sheet"]'));

  const geo = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="notification-sheet"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), vh: innerHeight, w: Math.round(r.width), vw: innerWidth };
  });
  check('sheet is bottom-anchored and full width',
    !!geo && Math.abs(geo.bottom - geo.vh) <= 2 && Math.abs(geo.w - geo.vw) <= 2, JSON.stringify(geo));
  check('sheet shows the notification content',
    await page.evaluate(() => /My activity|Pool/.test(document.body.innerText)));

  await page.screenshot({ path: 'scripts/visual/reports/probe-notif-sheet.png' });

  await dragDown(page, '[data-testid="notification-drag-area"]', 260);
  await page.waitForTimeout(1000);
  check('drag DISMISSES the notification sheet', !(await has(page, '[data-testid="notification-sheet"]')));

  await browser.close();
}

async function unaffected() {
  console.log('\n=== MUST BE UNCHANGED ===');
  // Desktop keeps its dropdown.
  const d = await boot(1440, 900, `${BASE}/?theme=1`, true);
  check('desktop vault: bell present when signed in', await has(d.page, '[data-testid="notification-bell"]'));
  await tap(d.page, '[data-testid="notification-bell"]');
  await d.page.waitForTimeout(800);
  check('desktop vault: dropdown, NOT a sheet', !(await has(d.page, '[data-testid="notification-sheet"]')));
  await d.browser.close();
}

await signedOutMobile();
await connectedMobileVault();
await unaffected();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
