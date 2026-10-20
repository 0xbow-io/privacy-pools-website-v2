// @ts-nocheck — local one-off probe
// Measure pill-vs-selected-tab centering at several widths.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const width of [584, 900, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  await page.goto('http://localhost:8080/?theme=4&action=withdraw', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(6000);
  const d = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
      const t = d.textContent || '';
      return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
    });
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return null;
    const pill = Array.from(row.children).find((c) => {
      const s = getComputedStyle(c);
      return s.position === 'absolute' && s.pointerEvents === 'none';
    });
    const tab = Array.from(row.children).find((c) => c.textContent.trim() === 'Withdraw');
    const p = pill.getBoundingClientRect(); const t = tab.getBoundingClientRect();
    return { pillCenter: p.x + p.width / 2, tabCenter: t.x + t.width / 2, pillW: p.width, tabW: t.width };
  });
  console.log(`w=${width}: delta=${(d.pillCenter - d.tabCenter).toFixed(1)}px (pillW=${d.pillW.toFixed(1)} tabW=${d.tabW.toFixed(1)})`);
  await context.close();
}
await browser.close();
