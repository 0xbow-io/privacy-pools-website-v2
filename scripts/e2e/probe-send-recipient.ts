// @ts-nocheck
// Mike's 2026-08-25 repro: "clicked in between all the options a bunch of
// times" -> Send tab with NO recipient field. Clicks through every tab
// rapidly, lands on Send, and asserts the inline flow (recipient input +
// "Recipient receives" card) is present and FAST.
import { account, clickButton, openApp, signIn, sleep, unlockIfPrompted } from './lib';

const acct = account('DEV_PK');
const { browser, page, appLogs } = await openApp(acct, { tag: 'sendfield' });
let failures = 0;
try {
  await page.goto(process.env.PROBE_URL || 'http://localhost:8081', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(page);
  await unlockIfPrompted(page);

  const hasSendForm = () => page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const recipient = inputs.some((i) => /recipient address or ens/i.test(i.placeholder || ''));
    const receives = (document.body.innerText || '').includes('Recipient receives');
    return { recipient, receives };
  });

  // A press that REGISTERS: click, then wait until the router param actually
  // moved (the machine-gun version of this probe fired 36 clicks and not one
  // of them landed - requestedAction never changed - so it "reproduced"
  // nothing). A human's rapid clicking registers each press; this presses
  // again after 1.2s exactly like a human whose click did nothing.
  const pressTab = async (t: string) => {
    const want = t.toLowerCase();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Same press lib.tab() uses: a synthetic el.click() on the exact-text
      // leaf. clickButton's coordinate press never registered on the tab bar
      // in this probe (36 presses, zero param changes).
      await page.evaluate((want) => {
        const el = Array.from(document.querySelectorAll('*')).find(
          (n) => n.textContent?.trim() === want && n.children.length === 0,
        );
        (el as HTMLElement | undefined)?.click();
      }, t);
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const search = await page.evaluate(() => location.search);
        if (search.includes(`action=${want}`)) return true;
        await sleep(80);
      }
    }
    return false;
  };

  for (let round = 1; round <= 3; round += 1) {
    for (const t of ['Withdraw', 'Send', 'Swap', 'Shield', 'Send', 'Request', 'Withdraw', 'Send']) {
      await pressTab(t);
    }
    // Ended on Send. How long until the full form is there?
    const t0 = Date.now();
    let state = { recipient: false, receives: false };
    while (Date.now() - t0 < 5000) {
      state = await hasSendForm();
      if (state.recipient && state.receives) break;
      await sleep(100);
    }
    const ms = Date.now() - t0;
    const diag = await page.evaluate(() => ({
      search: location.search,
      sendCta: (document.body.innerText || '').includes('Send privately'),
      activeTabGuess: ['Into', 'Recipient receives', 'You receive'].map((m) => (document.body.innerText || '').includes(m)),
    }));
    console.log(`round ${round}: recipient=${state.recipient} receives=${state.receives} after ~${ms}ms url=${diag.search} sendCta=${diag.sendCta}`);
    console.log('  transfer log tail:', appLogs.filter((l) => /Transfer modal (opened|closed)|Withdraw modal/.test(l)).slice(-6).join(' || '));
    if (!state.recipient || !state.receives) { failures += 1; console.log(`round ${round}: SEND FORM MISSING`); }
    else if (ms > 2000) { failures += 1; console.log(`round ${round}: form took ${ms}ms (>2s)`); }
  }
} finally {
  await browser.close();
}
console.log(failures === 0 ? 'SEND FORM ALWAYS PRESENT ✅' : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
