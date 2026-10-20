// @ts-nocheck
// The footer must sit at the BOTTOM of the viewport on a short page, not
// directly under the content with empty space beneath it (Pat, 2026-08-28).
//
// Asserts geometrically, not by screenshot: on a page whose content is shorter
// than the viewport, the footer's bottom edge should be near the viewport
// bottom. On a page taller than the viewport nothing is claimed — the footer
// correctly follows the content there.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/footer-bottom.ts
import { accountFromKey, openApp, sleep } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

/** Footer geometry vs the viewport and the document. */
const footerGeometry = (page) => page.evaluate(() => {
  // The footer row: the SMALLEST element whose text spans White Paper..Newsletter.
  const candidates = Array.from(document.querySelectorAll('*')).filter((n) => {
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
    return t.includes('White Paper') && t.includes('Newsletter');
  });
  // Pages render BOTH a web and a native <Footer/> branch; the inactive one is
  // present but unlaid-out (zero height). Only a real, laid-out box counts.
  const laidOut = candidates.filter((n) => n.getBoundingClientRect().height > 0);
  const el = laidOut.length
    ? laidOut.reduce((best, n) => ((n.textContent || '').length < (best.textContent || '').length ? n : best))
    : undefined;
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return {
    found: true,
    footerBottom: Math.round(r.bottom),
    viewportHeight: window.innerHeight,
    documentHeight: Math.round(document.documentElement.scrollHeight),
    gapBelowFooter: Math.round(window.innerHeight - r.bottom),
  };
});

const app = await openApp(acct, { tag: 'footer-bottom' });
const p = app.page;
try {
  // Signed out, /transactions is a short page — the reported case.
  // A TALL viewport makes each page genuinely shorter than the fold, which is
  // the condition the fix is about. The default 1200px viewport left
  // /transactions (100 rows) taller than the screen, where the footer
  // correctly follows content and there is nothing to assert.
  await p.setViewportSize({ width: 1440, height: 2600 });
  for (const path of ['/portfolio', '/ecosystem']) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(7000);
    // The unlock prompt overlays the page and pins scrollHeight to the
    // viewport, so dismiss it before measuring anything.
    await p.keyboard.press('Escape').catch(() => {});
    const closeX = p.locator('text=/^\\u00d7$/').first();
    if (await closeX.isVisible().catch(() => false)) await closeX.click().catch(() => {});
    await sleep(1500);
    const g = await footerGeometry(p);
    await app.shot(`footer${path.replace(/\//g, '-')}`);
    if (!g.found) {
      record(`${path}: footer present`, false, 'no footer element matched');
      continue;
    }
    const contentShorterThanViewport = g.documentHeight <= g.viewportHeight + 4;
    if (!contentShorterThanViewport) {
      record(`${path}: page is taller than the viewport, nothing to assert`, true,
        `doc ${g.documentHeight}px > viewport ${g.viewportHeight}px`);
      continue;
    }
    // Short page: the footer should be parked at the bottom. Allow the
    // container's own bottom padding (pb-[20px]/pb-[24px] plus a little).
    const parked = g.gapBelowFooter <= 48;
    record(`${path}: footer parks at the viewport bottom on a short page`, parked,
      `footer bottom ${g.footerBottom}px, viewport ${g.viewportHeight}px, gap below ${g.gapBelowFooter}px`);
  }
} catch (e) {
  record('footer-bottom', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== footer-bottom summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
