// @ts-nocheck - drives a real browser with real playwright types; playwright is a
// local dev tool here, not a declared dependency, so the repo type-checks these
// scripts against a fallback stub (see scripts/visual/playwright-fallback.d.ts).
// Regression test for the manager's "withdraw shows this double arrow" report.
//
// The hub opens the active tab's inline flow on a 320ms timer. Before 170b86b
// that timer branched on a `requestedAction` captured when it was armed, and
// expo-router hydrates search params asynchronously, so a tab press could re-open
// the flow it had just closed while the params were still catching up. Two flows
// then owned the card: Send's pair arrow and recipient input above Withdraw's.
//
// Switching tabs FAST is what makes that fire, so this cycles the tabs with gaps
// straddling the 320ms window and then counts what the card is showing. The
// invariant is one flow per tab, so: exactly one recipient input, and never both
// a transfer placeholder and a withdraw placeholder at once.
import { account, openApp, signIn, tab, sleep } from './lib';

const acct = account((process.env.E2E_ACCOUNT as 'DEV_PK' | 'DEV_PK2' | 'TEST_PHRASE') || 'DEV_PK');
const { browser, page, shot } = await openApp(acct, { tag: 'tabrace' });

/** Recipient inputs on screen, by placeholder: transfer's wording vs withdraw's. */
const survey = () => page.evaluate(() => {
  const active = document.querySelector('[data-testid^="hub-page-"]:not([aria-hidden="true"])');
  if (!active) throw new Error('No active hub page');
  const ph = Array.from(active.querySelectorAll('input'))
    .map((i) => (i as HTMLInputElement).placeholder || '')
    .filter((p) => /recipient address or ENS/i.test(p));
  return {
    recipients: ph.length,
    transfer: ph.filter((p) => !/^Enter/.test(p)).length,
    withdraw: ph.filter((p) => /^Enter/.test(p)).length,
    // Parked pager pages are intentionally mounted; only the active flow counts.
    ctas: Array.from(active.querySelectorAll('*'))
      .filter((n) => n.children.length === 0)
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t === 'Review transfer').length,
  };
});

const failures: string[] = [];
try {
  await signIn(page);
  // Cycle with gaps on both sides of the 320ms deferred open, and end on
  // Withdraw, which is the tab the manager screenshotted.
  const order: ('Send' | 'Withdraw' | 'Shield')[] = [
    'Send', 'Withdraw', 'Send', 'Withdraw', 'Shield', 'Send', 'Withdraw',
  ];
  for (const [i, name] of order.entries()) {
    await tab(page, name);
    // Alternate immediate switches with a gap inside the 320ms window.
    if (i % 2 === 0) {
      await sleep(150);
    }
    const s = await survey();
    console.log(`after ${name}: ${JSON.stringify(s)}`);
    if (s.recipients !== (name === 'Shield' ? 0 : 1)) failures.push(`${name}: ${s.recipients} recipient inputs`);
    if (s.transfer > 0 && s.withdraw > 0) failures.push(`${name}: transfer AND withdraw flows both mounted`);
    if (s.ctas > 1) failures.push(`${name}: ${s.ctas} flow CTAs`);
  }
  await shot('final');
  await sleep(350);
  const t = await page.locator('[data-testid^="hub-page-"]:not([aria-hidden="true"])').innerText();
  // "Receive on <chain> as" is the withdraw card's own marker (the same one
  // lib.ts uses). It replaced "Your anonymity set", which DEV-367 removed.
  if (/Review transfer/.test(t) && /Receive on .* as/i.test(t)) {
    failures.push('final: send CTA and withdraw panel on screen together');
  }
} catch (e: unknown) {
  failures.push(`threw: ${(e as Error).message}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.log('\nDOUBLE FLOW REGRESSION ❌');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nONE FLOW PER TAB ✅ (no doubled arrow/recipient/CTA across 7 fast switches)');
