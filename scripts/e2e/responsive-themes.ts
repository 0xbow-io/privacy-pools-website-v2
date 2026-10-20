// @ts-nocheck
// Pack N-b (partial) + N-a + N-g(reduced-motion): themes and responsive render.
// Pure UI verification - no wallet, no funds, no storage wipe.
//   - dark mode + each live design variant (1..4) renders home and the pool
//     page with real text and no error overlay;
//   - a stale ?theme=0 (retired Classic) falls back rather than blanking;
//   - mobile width renders the pool page with the bottom bar;
//   - prefers-reduced-motion loads cleanly.
// Theme PRECEDENCE itself is unit-tested (services/theme-precedence-fixtures);
// this leg proves the variants actually paint.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/responsive-themes.ts
import { openApp, sleep } from './lib';
import { accountFromKey } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

/** A page is "painted" if it has real text and shows no bundler/JS error overlay. */
const health = (page) => page.evaluate(() => {
  const html = document.documentElement.innerHTML || '';
  const bodyLen = (document.body?.innerText || '').trim().length;
  const err = /TypeError|ReferenceError|SyntaxError|is not defined|is not a function|Unable to resolve|Bundling failed/.test(html);
  return { bodyLen, err };
});

const app = await openApp(acct, { tag: 'responsive-themes' });
try {
  const errs: string[] = [];
  app.page.on('pageerror', (e) => errs.push(e.message));

  for (const variant of ['1', '2', '3', '4']) {
    for (const [where, path] of [['home', '/'], ['pool', '/chains/sepolia/eth']]) {
      const before = errs.length;
      await app.page.goto(`${BASE}${path}?theme=${variant}&color=dark`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await sleep(5000);
      const h = await health(app.page);
      const stored = await app.page.evaluate(() => ({
        variant: localStorage.getItem('ppv2_theme_preference'),
        scheme: (() => { try { return document.documentElement.getAttribute('data-theme') || getComputedStyle(document.body).colorScheme; } catch { return '?'; } })(),
      }));
      await app.shot(`v${variant}-${where}-dark`);
      record(`N-b variant ${variant} renders ${where} in dark mode`, h.bodyLen > 200 && !h.err && errs.length === before,
        `text ${h.bodyLen} chars, error overlay ${h.err}, new page errors ${errs.length - before}`);
    }
  }

  // Stale ?theme=0 (retired Classic) must fall back, not blank.
  await app.page.goto(`${BASE}/?theme=0`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(5000);
  const h0 = await health(app.page);
  await app.shot('theme0-fallback');
  record('N-b stale ?theme=0 falls back and still renders', h0.bodyLen > 200 && !h0.err, `text ${h0.bodyLen} chars, error overlay ${h0.err}`);

  // Mobile width: pool page renders with the bottom bar.
  const mctx = await app.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const mBody = await mp.evaluate(() => document.body?.innerText || '');
  const bottomBar = /\bMore\b/.test(mBody) && /All activity|My balances/.test(mBody);
  await mp.screenshot({ path: '.e2e-shots/responsive-themes-mobile.png' }).catch(() => {});
  record('N-a pool page renders at mobile width with the bottom bar', mBody.trim().length > 200 && bottomBar,
    `text ${mBody.trim().length} chars, bottom bar ${bottomBar}`);
  await mctx.close();

  // Reduced motion: the app loads cleanly with prefers-reduced-motion.
  const rctx = await app.browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  const rErrs: string[] = [];
  rp.on('pageerror', (e) => rErrs.push(e.message));
  await rp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const rh = await rp.evaluate(() => ({ bodyLen: (document.body?.innerText || '').trim().length }));
  record('N-g app loads cleanly under prefers-reduced-motion', rh.bodyLen > 200 && rErrs.length === 0,
    `text ${rh.bodyLen} chars, page errors ${rErrs.length}`);
  await rctx.close();
} catch (e) {
  record('responsive-themes', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== responsive-themes summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
