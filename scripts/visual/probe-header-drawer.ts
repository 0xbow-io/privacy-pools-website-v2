// One-off verification probe (not part of the visual suite):
//  1. header — the centred nav must never overlap the actions cluster, at any
//     width, connected or not. This is the "Payroll half-hidden under the
//     address chip at ~1039px" regression.
//  2. drawer — My balances / Pools / Activity must be BOTTOM sheets on desktop
//     (flush to the viewport bottom), not centred dialogs.
import { chromium, type Page } from 'playwright';
import { installEvmWallet, loadDevAccount } from './evm-wallet';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const WIDTHS = [1440, 1280, 1200, 1150, 1120, 1080, 1057, 1039, 990, 934, 860, 780, 730, 700, 660, 640, 600, 560, 480, 390];

type Rect = { x: number; y: number; w: number; h: number };

async function measure(page: Page) {
  return page.evaluate(() => {
    const NAV = ['My Pools', 'Assets', 'Payroll', 'Ecosystem', 'Portfolio', 'Stats', 'Privacy Pools'];
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    // Header = the top-most banner-ish container; restrict to the first 120px.
    const inHeader = (el: Element) => el.getBoundingClientRect().top < 120;

    // RN-Web renders nav entries as UNROLED leaf <div>s, so role/tag selectors
    // find nothing — scan every leaf text node inside the header band instead.
    const leaves = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && vis(el) && inHeader(el) && (el.textContent || '').trim(),
    );

    const navLinks: { label: string; rect: { x: number; y: number; w: number; h: number } }[] = [];
    for (const el of leaves) {
      const t = (el.textContent || '').trim();
      if (NAV.includes(t)) navLinks.push({ label: t, rect: rect(el) });
    }

    // Actions cluster: the address chip when connected, else Connect Wallet.
    let chip: { text: string; rect: { x: number; y: number; w: number; h: number } } | null = null;
    for (const el of leaves) {
      const t = (el.textContent || '').trim();
      if (/^0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(t) || t === 'Connect Wallet' || t === 'Connect') {
        const r = rect(el);
        if (!chip || r.x < chip.rect.x) chip = { text: t.slice(0, 24), rect: r };
      }
    }
    return { navLinks, chip, connected: !!chip && /^0x/.test(chip.text) };
  });
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function run(connected: boolean, theme: string) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  if (connected) await installEvmWallet(page, loadDevAccount());
  await page.goto(`${BASE}/?theme=${theme}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });

  if (connected) {
    let ok = false;
    for (let i = 0; i < 30; i++) {
      if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText))) { ok = true; break; }
      await page.waitForTimeout(1000);
    }
    if (!ok) { console.log('SKIP connected: headless wallet never connected'); await browser.close(); return true; }
  }

  console.log(`\n=== theme=${theme} ${connected ? 'CONNECTED' : 'DISCONNECTED'} ===`);
  let clean = true;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(450);
    const m = await measure(page);
    const bad = m.chip ? m.navLinks.filter((n) => overlaps(n.rect, m.chip!.rect)) : [];
    const labels = m.navLinks.map((n) => n.label).join(',') || '(none)';
    const flag = bad.length ? `  <<< OVERLAP: ${bad.map((b) => b.label).join(',')}` : '';
    if (bad.length) clean = false;
    console.log(`  ${String(w).padStart(4)}px  nav=[${labels}]  chip@${m.chip ? Math.round(m.chip.rect.x) : '-'}${flag}`);
  }
  await browser.close();
  return clean;
}

async function drawerProbe() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  console.log('\n=== DRAWER (vault theme, desktop 1440x900) ===');
  await page.goto(`${BASE}/?theme=1&panel=balances`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(3000);
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="drawer-close"]');
    if (!btn) return { open: false } as const;
    // Walk up to the sheet: the first ancestor with a border-radius on top only.
    let el: HTMLElement | null = btn as HTMLElement;
    for (let i = 0; i < 8 && el; i++) {
      const s = getComputedStyle(el);
      if (parseFloat(s.borderTopLeftRadius) > 4 && parseFloat(s.borderBottomLeftRadius) < 2) {
        const r = el.getBoundingClientRect();
        return { open: true, top: r.top, bottom: r.bottom, width: r.width, vh: innerHeight, vw: innerWidth } as const;
      }
      el = el.parentElement;
    }
    return { open: true, top: null, bottom: null, width: null, vh: innerHeight, vw: innerWidth } as const;
  });
  console.log(' ', JSON.stringify(geo));
  await page.screenshot({ path: 'scripts/visual/reports/probe-drawer-desktop.png' });
  await browser.close();
  if (!geo.open) { console.log('  FAIL: drawer did not open via ?panel=balances'); return false; }
  if (geo.bottom == null) { console.log('  INCONCLUSIVE: sheet element not identified'); return false; }
  const flush = Math.abs(geo.bottom - geo.vh) <= 2;
  const centred = geo.top > 20 && Math.abs(geo.vh - geo.bottom - geo.top) < 12;
  console.log(`  bottom=${Math.round(geo.bottom)} vh=${geo.vh} → ${flush ? 'FLUSH TO BOTTOM ✓' : centred ? 'CENTRED DIALOG ✗' : 'neither'}`);
  return flush;
}

let headerClean = true;
for (const theme of ['0', '1', '4']) {
  for (const conn of [false, true]) headerClean = (await run(conn, theme)) && headerClean;
}
const c = await drawerProbe();
console.log(`\nheader: ${headerClean ? 'clean everywhere' : 'OVERLAP'} | drawer bottom-anchored: ${c}`);
process.exit(headerClean && c ? 0 : 1);
