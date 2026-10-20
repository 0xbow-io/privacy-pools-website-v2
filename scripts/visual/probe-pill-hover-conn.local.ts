// @ts-nocheck — local one-off probe
// Real-mouse variant: click the Send tab with an actual pointer and KEEP the
// cursor hovering it (playwright leaves the mouse where it clicked). Sample
// the pill transform; then move the mouse away and sample again.
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

const pillX = () => page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  const pill = Array.from(row.children).find((c) => {
    const s = getComputedStyle(c);
    return s.position === 'absolute' && s.pointerEvents === 'none';
  });
  return new DOMMatrixReadOnly(getComputedStyle(pill).transform).m41;
});

// Click the Send tab INSIDE the tab row (the balances panel also contains
// a 'Send' text in the connected split view).
const box = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div')).filter((d) => {
    const t = d.textContent || '';
    return t.includes('Shield') && t.includes('Withdraw') && t.includes('Request') && d.children.length >= 5;
  });
  const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  const tab = Array.from(row.querySelectorAll('div')).find((d) => d.textContent.trim() === 'Send');
  const r = tab.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
// Dismiss the auto-opened unlock modal — its backdrop swallows real pointer
// events (DOM .click() bypasses hit-testing, so earlier probes missed this).
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
console.log('pill before click:', await pillX());
// Real pointer: move, click, and LEAVE the cursor hovering the tab.
console.log('send tab box:', JSON.stringify(box));
await page.screenshot({ path: '/tmp/ppv2-nativewind/scripts/visual/reports/hover-pre-click.png' });
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.up();
const samples = [];
for (let i = 0; i < 30; i++) {
  samples.push(Math.round((await pillX()) * 10) / 10);
  await page.waitForTimeout(50);
}
console.log('while hovering (50ms steps):', samples.join(' '));
// Now move the mouse away.
await page.mouse.move(50, 700);
await page.waitForTimeout(600);
console.log('after mouse-out:', await pillX());
const movedWhileHover = Math.abs(samples[samples.length - 1] - samples[0]) > 10 && samples[samples.length - 1] > 100;
console.log(movedWhileHover ? 'PASS — pill moved while hovering' : 'FAIL — pill FROZEN while hovering (repro)');
await browser.close();
process.exit(movedWhileHover ? 0 : 1);
