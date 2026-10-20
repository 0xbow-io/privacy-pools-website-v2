// One-off verification probe for the split-screen / bottom-sheet / tab-bar work.
// Not part of the visual suite — needs a dev server on :8081.
import { chromium, type Page } from 'playwright';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function boot(width: number, height: number, url: string) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  return { browser, page };
}

/** Rect of the shield card (the element containing the action tabs). */
function shieldRect(page: Page) {
  return page.evaluate(() => {
    const leaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Amount to shield',
    );
    if (!leaf) return null;
    let el = leaf as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width > 300) return { x: r.x, w: r.width, right: r.right };
      el = el.parentElement;
    }
    return null;
  });
}

async function clickText(page: Page, text: string) {
  return page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === t,
    );
    if (!el) return false;
    let p: HTMLElement | null = el as HTMLElement;
    for (let i = 0; i < 6 && p; i++) {
      if (p.getAttribute('role') === 'button' || p.tagName === 'BUTTON') { p.click(); return true; }
      p = p.parentElement;
    }
    (el as HTMLElement).click();
    return true;
  }, text);
}

async function desktopSplit() {
  console.log('\n=== DESKTOP SPLIT (vault, 1440x900) ===');
  const { browser, page } = await boot(1440, 900, `${BASE}/?theme=1`);

  const before = await shieldRect(page);
  check('shield card found and centred', !!before && Math.abs((before.x + before.w / 2) - 720) < 40,
    before ? `centre=${Math.round(before.x + before.w / 2)}` : 'not found');

  await clickText(page, 'Explore pools');
  await page.waitForTimeout(1200);

  const after = await shieldRect(page);
  check('shield card moved LEFT', !!after && !!before && after.x < before.x - 80,
    before && after ? `x ${Math.round(before.x)} → ${Math.round(after.x)}` : '');

  const panel = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="split-panel-close"]');
    if (!btn) return null;
    let el = btn as HTMLElement | null;
    for (let i = 0; i < 6 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width > 350) return { x: r.x, w: r.width, right: r.right };
      el = el.parentElement;
    }
    return null;
  });
  check('data panel present on the RIGHT', !!panel && !!after && panel.x > after.right - 4,
    panel && after ? `widget right=${Math.round(after.right)}, panel x=${Math.round(panel.x)} w=${Math.round(panel.w)}` : 'panel not found');

  check('no modal/dialog used for the panel',
    await page.evaluate(() => !document.querySelector('[role="dialog"]')));

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow', noOverflow);

  // Tables inside the panel must have adapted to the COLUMN width, not 1440.
  const tableCols = await page.evaluate(() => {
    const t = document.body.innerText;
    // The positions table's wide-only column is YIELD EARNED (was POOL VALUE until 2026-09-21).
    return { hasWalletBalance: t.includes('WALLET BALANCE'), hasYieldEarned: t.includes('YIELD EARNED') };
  });
  check('panel renders the pools table', tableCols.hasYieldEarned, JSON.stringify(tableCols));

  await page.screenshot({ path: 'scripts/visual/reports/probe-split-open.png' });

  // --- two-way selection -------------------------------------------------
  const beforeSym = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && /^Get Started Shielding |^Connect a wallet to shield |^Shield (ETH|USDC|USDT)$/.test((e.textContent || '').trim()),
    );
    return el ? (el.textContent || '').trim() : null;
  });
  const picked = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="asset-row-USDC"]') as HTMLElement | null;
    if (!row) return false;
    row.click();
    return true;
  });
  await page.waitForTimeout(700);
  const afterSym = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && /^Get Started Shielding |^Connect a wallet to shield |^Shield (ETH|USDC|USDT)$/.test((e.textContent || '').trim()),
    );
    return el ? (el.textContent || '').trim() : null;
  });
  check('picking USDC in the panel updates the shield widget', picked && !!afterSym && afterSym.includes('USDC'),
    `"${beforeSym}" → "${afterSym}"`);

  // --- dismissal ---------------------------------------------------------
  await page.evaluate(() => (document.querySelector('[data-testid="split-panel-close"]') as HTMLElement)?.click());
  await page.waitForTimeout(1200);
  const closed = await shieldRect(page);
  check('closing re-centres the shield card', !!closed && !!before && Math.abs(closed.x - before.x) < 12,
    closed && before ? `x ${Math.round(closed.x)} vs original ${Math.round(before.x)}` : '');
  check('panel gone after close', await page.evaluate(() => !document.querySelector('[data-testid="split-panel-close"]')));

  await browser.close();
}

async function mobileSheet() {
  console.log('\n=== MOBILE (vault, 390x844) ===');
  const { browser, page } = await boot(390, 844, `${BASE}/?theme=1`);

  const bar = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="explore-tab-pools"]') as HTMLElement | null;
    if (!el) return null;
    let p: HTMLElement | null = el.parentElement;
    const r = el.getBoundingClientRect();
    const s = p ? getComputedStyle(p) : null;
    return {
      tabBottom: r.bottom, vh: innerHeight,
      backdrop: s?.backdropFilter || (s as unknown as { webkitBackdropFilter?: string })?.webkitBackdropFilter || '',
      bg: s?.backgroundColor || '',
    };
  });
  check('bottom tab bar present', !!bar);
  check('bar sits at the bottom of the viewport', !!bar && bar.vh - bar.tabBottom < 60,
    bar ? `gap=${Math.round(bar.vh - bar.tabBottom)}px` : '');
  check('bar has the glass backdrop-filter', !!bar && /blur/.test(bar.backdrop), bar?.backdrop || 'none');
  const alpha = bar ? /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(bar.bg)?.[1] : undefined;
  check('bar fill is a TRANSLUCENT colour (blur has something to tint)',
    !!alpha && Number(alpha) > 0.2 && Number(alpha) < 1, bar?.bg || '');

  await page.screenshot({ path: 'scripts/visual/reports/probe-mobile-bar.png' });

  // Open a sheet from the bar.
  await page.evaluate(() => (document.querySelector('[data-testid="explore-tab-mine"]') as HTMLElement)?.click());
  await page.waitForTimeout(1200);

  const sheet = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="drawer-close"]');
    if (!btn) return null;
    let el = btn as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
      const s = getComputedStyle(el);
      if (parseFloat(s.borderTopLeftRadius) > 4 && parseFloat(s.borderBottomLeftRadius) < 2) {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height, vh: innerHeight };
      }
      el = el.parentElement;
    }
    return null;
  });
  check('sheet opened', !!sheet);
  const ratio = sheet ? sheet.h / sheet.vh : 0;
  check('sheet covers ~70–80% of the screen', ratio >= 0.68 && ratio <= 0.82, `${Math.round(ratio * 100)}%`);
  check('sheet is flush to the bottom edge', !!sheet && Math.abs(sheet.bottom - sheet.vh) <= 2);
  check('tab bar hidden while the sheet is open (no interference)',
    await page.evaluate(() => !document.querySelector('[data-testid="explore-tab-pools"]')));

  await page.screenshot({ path: 'scripts/visual/reports/probe-mobile-sheet.png' });

  // Card layout must be checked on a section that actually HAS rows while
  // disconnected — "My balances" is empty then, so counting zero cards and
  // zero rows there would pass vacuously. The asset list is always populated.
  await page.goto(`${BASE}/?theme=1&panel=pools`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(3000);
  const cards = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-testid^="asset-card-"]').length,
    tableRows: document.querySelectorAll('[data-testid^="asset-row-"]').length,
    headerVisible: document.body.innerText.includes('WALLET BALANCE'),
  }));
  check('asset list is actually populated (guards a vacuous pass)', cards.cards + cards.tableRows > 0, JSON.stringify(cards));
  check('assets render as CARDS, not table rows', cards.cards > 0 && cards.tableRows === 0, JSON.stringify(cards));
  check('no wide-table column header in the sheet', !cards.headerVisible);

  const cardShape = await page.evaluate(() => {
    const card = document.querySelector('[data-testid^="asset-card-"]') as HTMLElement | null;
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const texts = Array.from(card.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
      .map((e) => {
        const b = e.getBoundingClientRect();
        return { t: (e.textContent || '').trim().slice(0, 14), x: Math.round(b.x - r.x), y: Math.round(b.y - r.y) };
      });
    return { w: Math.round(r.width), texts };
  });
  // Spec: icon+ticker top-left, balance top-right, USD beneath it.
  const shapeOk = !!cardShape && (() => {
    const ticker = cardShape.texts.find((t) => /^(ETH|USDC|USDT|SUI)$/.test(t.t));
    const right = cardShape.texts.filter((t) => t.x > cardShape.w / 2).sort((a, b) => a.y - b.y);
    return !!ticker && ticker.x < cardShape.w / 2 && right.length >= 2 && right[0].y < right[1].y;
  })();
  check('card layout: ticker top-left, balance above USD on the right', shapeOk,
    cardShape ? JSON.stringify(cardShape.texts.slice(0, 5)) : 'no card');

  const glassBg = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="explore-tab-pools"]') as HTMLElement | null;
    return el?.parentElement ? getComputedStyle(el.parentElement).backgroundColor : 'no-bar';
  });
  console.log(`  (tab bar fill while sheet open: ${glassBg})`);

  await browser.close();
}

await desktopSplit();
await mobileSheet();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
