// One-off verification probe for the consolidated Activity table.
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
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  // Wait for real rows, not just a painted shell — an empty table would let
  // every wrapping assertion pass vacuously.
  await page.waitForFunction(
    () => /ADDRESS/.test(document.body?.innerText || ''),
    null,
    { timeout: 60_000 },
  ).catch(() => console.log('  [warn] table header never appeared'));
  await page.waitForTimeout(4000);
  return { browser, page };
}

/**
 * Header labels of the ACTIVITY table, in visual order.
 *
 * Scoped to the transactions table's own subtree: the page also renders
 * MyPrivacyPools, whose ASSET header would otherwise be collected here and
 * make the column order look wrong.
 */
function headers(page: Page) {
  return page.evaluate(() => {
    const KNOWN = ['ADDRESS', 'TYPE', 'CHAIN', 'ASSET', 'AMOUNT', 'TOTAL VALUE', 'TOKEN AMOUNT', 'DATE-TIME', 'DATE & TIME', 'STATUS'];
    const addr = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'ADDRESS'
        && el.getBoundingClientRect().width > 0,
    );
    if (!addr) return [];
    // Walk up to the header ROW: the nearest ancestor holding both ADDRESS and
    // the last column, without swallowing the rest of the page.
    let row: HTMLElement | null = addr.parentElement;
    for (let i = 0; i < 6 && row; i++) {
      const t = row.textContent || '';
      if (t.includes('ADDRESS') && (t.includes('DATE') || t.includes('AMOUNT'))) break;
      row = row.parentElement;
    }
    if (!row) return [];
    return Array.from(row.querySelectorAll('*'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return el.children.length === 0 && r.width > 0 && r.height > 0 && KNOWN.includes((el.textContent || '').trim());
      })
      .map((el) => ({ t: (el.textContent || '').trim(), x: Math.round(el.getBoundingClientRect().x) }))
      .sort((a, b) => a.x - b.x)
      .map((h) => h.t);
  });
}

/**
 * Cells inside the ACTIVITY table whose text occupies more than one line box.
 *
 * Counts line boxes via Range.getClientRects() rather than dividing height by
 * line-height: computed line-height is often `normal`, which parses to NaN, and
 * a NaN fallback reported tall single-line text (the Statistics card's 24px
 * figures) as "2.3 lines" — a false positive that hid whether the real table
 * was fine. Scoped to the table for the same reason.
 */
function wrappedCells(page: Page) {
  return page.evaluate(() => {
    const addr = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'ADDRESS'
        && el.getBoundingClientRect().width > 0,
    );
    let table: HTMLElement | null = addr?.parentElement ?? null;
    for (let i = 0; i < 9 && table; i++) {
      const t = table.textContent || '';
      if (t.includes('ADDRESS') && /Deposit|Withdrawal|Transfer|Exit/.test(t)) break;
      table = table.parentElement;
    }
    if (!table) return [{ text: 'TABLE-NOT-FOUND', lines: 0, w: 0 }];

    const out: { text: string; lines: number; w: number }[] = [];
    for (const el of Array.from(table.querySelectorAll('*'))) {
      if (el.children.length !== 0) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      // Numeric / date-ish content only: amounts, fiat values, timestamps, addrs.
      if (!/^[$]?[\d.,]+(\s?[A-Z]{2,5})?$|^\d{2}[.:]\d{2}([.:]\d{2})?$|^0x[0-9a-fA-F]/.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = range.getClientRects().length;
      if (lines > 1) out.push({ text: text.slice(0, 24), lines, w: Math.round(r.width) });
    }
    return out;
  });
}

async function listRow(page: Page) {
  return page.evaluate(() => {
    // Anchor on the META LINE ("0x… · date · time"). Anchoring on the type word
    // matched the page's "Deposit" ACTION BUTTON instead, because that comes
    // first in document order — only an activity row has this dotted line.
    const metaLeaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0
        && /\u00B7/.test(el.textContent || '')
        && (el.textContent || '').split('\u00B7').length >= 3
        && el.getBoundingClientRect().width > 0,
    );
    if (!metaLeaf) return null;
    // Walk up to the FULL row, by CONTENT not size: the row's left column is
    // already >280px wide on a desktop surface, so a size threshold stopped
    // there and the amount stack (in the right column) was never measured.
    // The whole row is the first ancestor holding the meta line AND an amount.
    let row: HTMLElement | null = metaLeaf.parentElement;
    for (let i = 0; i < 8 && row; i++) {
      const t = row.textContent || '';
      if (/\u00B7/.test(t) && /(\$|\?)/.test(t) && /\d/.test(t)) break;
      row = row.parentElement;
    }
    if (!row) return null;
    const rr = row.getBoundingClientRect();
    const leaves = Array.from(row.querySelectorAll('*'))
      .filter((el) => el.children.length === 0 && (el.textContent || '').trim()
        && el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // Explicit leading-[..] is set on every row text, so line-height parses.
        // Do NOT count Range client rects here: numberOfLines={1} compiles to
        // -webkit-line-clamp, which reports one rect per candidate line even
        // when the text is visually clamped to one — that read as a wrap.
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
        return {
          t: (el.textContent || '').trim().slice(0, 34),
          x: Math.round(r.x - rr.x),
          y: Math.round(r.y - rr.y),
          size: parseFloat(cs.fontSize),
          lines: Math.round((r.height / lh) * 10) / 10,
          clipped: el.scrollWidth > el.clientWidth + 1,
        };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
    return { w: Math.round(rr.width), h: Math.round(rr.height), leaves };
  });
}

async function activitySurface(label: string, url: string, width: number) {
  console.log(`\n=== ${label} ===`);
  const { browser, page } = await boot(width, url);

  // Bring the feed into view so the screenshot shows what we measured.
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && /^Transactions/.test((e.textContent || '').trim()),
    );
    el?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(900);

  const noHeaders = await page.evaluate(() => {
    const t = document.body.innerText;
    return !/TOTAL VALUE|TOKEN AMOUNT|DATE-TIME/.test(t);
  });
  check('old column headers gone', noHeaders);

  const row = await listRow(page);
  check('list row found', !!row, row ? `w=${row.w} h=${row.h} leaves=${row.leaves.length}` : 'none');
  if (!row) { await browser.close(); return; }

  const texts = row.leaves.map((l) => l.t);
  const type = row.leaves.find((l) => /^(Deposit|Withdrawal|Transfer|Exit)/.test(l.t));
  const meta = row.leaves.find((l) => /·/.test(l.t));
  const token = row.leaves.find((l) => /[A-Z]{2,5}$/.test(l.t) && /[\d.]/.test(l.t));
  const usd = row.leaves.find((l) => /^[<]?\$/.test(l.t));

  check('row has type + meta line', !!type && !!meta, JSON.stringify(texts.slice(0, 4)));
  check('meta line is counterparty · date · time', !!meta && (meta.t.match(/·/g) || []).length >= 2, meta?.t);
  check('token amount and USD both present', !!token && !!usd, `${token?.t} / ${usd?.t}`);
  check('TOKEN is above USD (as specified)', !!token && !!usd && token.y < usd.y,
    token && usd ? `token y=${token.y}, usd y=${usd.y}` : '');
  check('token is the larger/primary text', !!token && !!usd && token.size > usd.size,
    token && usd ? `${token.size}px vs ${usd.size}px` : '');
  check('type sits above the meta line', !!type && !!meta && type.y < meta.y);

  const wrapped = row.leaves.filter((l) => l.lines > 1.5);
  check('nothing in the row wraps to a second line', wrapped.length === 0, JSON.stringify(wrapped));
  const clipped = row.leaves.filter((l) => l.clipped).map((l) => l.t);
  console.log(`     (ellipsized, by design: ${clipped.length ? JSON.stringify(clipped) : 'none'})`);

  const badge = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg')).map((s) => Math.round(s.getBoundingClientRect().width));
    return { has28: svgs.includes(28), has11to13: svgs.some((w) => w >= 10 && w <= 14) };
  });
  check('28px asset mark with a small chain badge', badge.has28 && badge.has11to13, JSON.stringify(badge));

  check('no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await page.screenshot({ path: `scripts/visual/reports/probe-list-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png` });
  await browser.close();
}

async function vaultPoolTable() {
  console.log('\n=== VAULT pool page split column (1440px) ===');
  const { browser, page } = await boot(1440, `${BASE}/chains/sepolia/eth?theme=1`);

  const h = await headers(page);
  check('table header found', h.length > 0, JSON.stringify(h));
  check('CHAIN column removed', !h.includes('CHAIN'), JSON.stringify(h));
  check('TOTAL VALUE / TOKEN AMOUNT merged away', !h.includes('TOTAL VALUE') && !h.includes('TOKEN AMOUNT'));
  check('single AMOUNT column present', h.filter((x) => x === 'AMOUNT').length === 1);
  check('DATE & TIME label used', h.includes('DATE & TIME') && !h.includes('DATE-TIME'));
  check('column order is Address | Type | Asset | Amount | Date & Time',
    JSON.stringify(h) === JSON.stringify(['ADDRESS', 'TYPE', 'ASSET', 'AMOUNT', 'DATE & TIME']), JSON.stringify(h));

  // Rows must actually exist, or the wrap check below proves nothing.
  const rowCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = (el.textContent || '').trim();
      return el.children.length === 0 && /^(Deposit|Withdrawal|Transfer|Exit)$/.test(t)
        && el.getBoundingClientRect().width > 0;
    }).length);
  check('table has real rows (guards a vacuous wrap check)', rowCount > 0, `${rowCount} type pills`);

  const wrapped = await wrappedCells(page);
  check('no numeric/date cell wraps to multiple lines', wrapped.length === 0, JSON.stringify(wrapped.slice(0, 5)));

  // Amount cell: token amount above, fiat below, fiat smaller.
  const amountShape = await page.evaluate(() => {
    const leaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'AMOUNT'
        && el.getBoundingClientRect().width > 0,
    );
    if (!leaf) return null;
    const col = leaf.getBoundingClientRect();
    const texts = Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        if (el.children.length !== 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && Math.abs(r.x - col.x) < 26 && r.y > col.y + 10;
      })
      .map((el) => ({
        t: (el.textContent || '').trim(),
        y: Math.round(el.getBoundingClientRect().y),
        size: parseFloat(getComputedStyle(el).fontSize),
      }))
      .sort((a, b) => a.y - b.y);
    return texts.slice(0, 2);
  });
  const shapeOk = !!amountShape && amountShape.length === 2
    && /[A-Z]{2,5}$/.test(amountShape[0].t) && amountShape[1].t.startsWith('$')
    && amountShape[1].size < amountShape[0].size;
  check('Amount cell: token above, smaller $ below', shapeOk, JSON.stringify(amountShape));

  // Chain badge overlays the asset icon.
  const badge = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg'));
    for (const svg of svgs) {
      const r = svg.getBoundingClientRect();
      if (Math.round(r.width) !== 10) continue;      // the 10px chain mark
      const parent = svg.parentElement?.getBoundingClientRect();
      if (!parent) continue;
      return { badge: Math.round(r.width), badgeX: Math.round(r.x), badgeY: Math.round(r.y) };
    }
    return null;
  });
  check('chain badge rendered over the asset icon', !!badge, badge ? JSON.stringify(badge) : 'no 10px chain mark found');

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow', noOverflow);

  await page.screenshot({ path: 'scripts/visual/reports/probe-activity-vault.png' });
  await browser.close();
}

await activitySurface('vault pool split 1440', `${BASE}/chains/sepolia/eth?theme=1`, 1440);
await activitySurface('mono studio pool page 1440', `${BASE}/chains/sepolia/eth?theme=4`, 1440);
await activitySurface('vault mobile sheet 390', `${BASE}/?theme=1&panel=activity`, 390);
await activitySurface('transactions page 1440', `${BASE}/transactions?theme=1`, 1440);
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
