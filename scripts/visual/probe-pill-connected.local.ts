// @ts-nocheck — local one-off probe
// Tab pill flicker check: click Shield -> Send and sample the pill's
// translateX every ~25ms. A flicker = an early jump to (or towards) the
// destination followed by a snap back near the origin. PASS = motion is
// monotonic (within jitter) from origin to destination.
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { installEvmWallet } from './evm-wallet';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
const page = await context.newPage();
await installEvmWallet(page, mnemonicToAccount(process.env.TEST_PHRASE.trim()));
await page.goto('http://localhost:8080/?theme=4', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
await page.waitForTimeout(12000);

const result = await page.evaluate(async () => {
  const findPill = () => {
    // The tab row contains all the tab labels; the pill is its absolutely
    // positioned, pointer-events:none child.
    const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
      const t = d.textContent || '';
      return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
    });
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return null;
    return Array.from(row.children).find((c) => {
      const s = getComputedStyle(c);
      return s.position === 'absolute' && s.pointerEvents === 'none';
    }) ?? null;
  };
  const pill = findPill();
  if (!pill) return { error: 'pill not found' };
  const xOf = () => {
    const m = new DOMMatrixReadOnly(getComputedStyle(pill).transform);
    return m.m41;
  };
  const x0 = xOf();

  // Click the Send tab (the Pressable whose exact text is 'Send' inside the row).
  const row = pill.parentElement;
  const sendTab = Array.from(row.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Send' && d.children.length <= 1);
  if (!sendTab) return { error: 'send tab not found' };
  const samples = [];
  const t0 = performance.now();
  sendTab.click();
  while (performance.now() - t0 < 1200) {
    samples.push({ t: Math.round(performance.now() - t0), x: Math.round(xOf() * 10) / 10 });
    await new Promise((r) => setTimeout(r, 20));
  }
  return { x0: Math.round(x0 * 10) / 10, samples };
});

if (result.error) { console.log('ERROR:', result.error); process.exit(1); }
const { x0, samples } = result;
const xs = samples.map((s) => s.x);
const xEnd = xs[xs.length - 1];
console.log('origin x =', x0, '→ final x =', xEnd);
console.log('trace:', samples.filter((_, i) => i % 3 === 0).map((s) => `${s.t}ms:${s.x}`).join('  '));
// Flicker detector: after moving >15% of the way, does x ever come back
// within 10% of the origin? And does the very first sample already sit at
// the destination (teleport)?
const span = Math.abs(xEnd - x0) || 1;
let moved = false;
let snapBack = false;
for (const x of xs) {
  if (Math.abs(x - x0) > span * 0.15) moved = true;
  else if (moved && Math.abs(x - x0) < span * 0.1) snapBack = true;
}
const teleport = xs.length > 0 && Math.abs(xs[0] - xEnd) < span * 0.05 && Math.abs(xEnd - x0) > 10;
console.log('moved:', moved, '| snapBack (flicker):', snapBack, '| instant teleport:', teleport);
const pass = moved && !snapBack && !teleport && Math.abs(xEnd - x0) > 10;
console.log(pass ? 'PASS — smooth one-way glide' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
