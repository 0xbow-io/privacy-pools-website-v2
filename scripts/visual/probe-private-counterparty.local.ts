// @ts-nocheck
// Visual check for the private-counterparty row (Pat, 2026-08-26):
//   - a transfer whose payee we cannot know shows the privacy SHIELD in the
//     counterparty slot, never a bare "?";
//   - a stranger's transfer, whose value is equally undecryptable, reads
//     "Private" where the figure would be, with an empty fiat line.
// Strangers' transfers live on the ALL tab, so the probe shoots both tabs.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/visual/probe-private-counterparty.local.ts
import { accountFromKey, bodyText, clickButton, openApp, sleep, unlockIfPrompted } from '../e2e/lib';
import { envValue } from '../e2e/funding';

const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
const BASE = process.env.PROBE_URL || 'http://localhost:8081';

/** Scroll the table until a leaf node matching `re` is centred on screen. */
async function scrollToRow(app, re: RegExp): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    const seen = await app.page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const leaves = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0);
      const row = leaves.find((el) => rx.test((el.textContent || '').trim()));
      if (row) { row.scrollIntoView({ block: 'center' }); return true; }
      window.scrollBy(0, 900);
      return false;
    }, re.source);
    await sleep(1200);
    if (seen) return true;
  }
  return false;
}

const app = await openApp(acct, { tag: 'private-counterparty' });
try {
  await app.page.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded' });
  await sleep(9000);
  await unlockIfPrompted(app.page);
  // Notes and reconstructed rows need a sync pass before any Transfer row exists.
  await sleep(45000);

  // --- Mine: our own transfers, which must NAME their payee ----------------
  const foundMine = await scrollToRow(app, /^Transfer (Out|In)$/);
  const mineBody = await bodyText(app.page);
  console.log(`mine tab: transfer row on screen=${foundMine}`);
  console.log(`  bare "?" counterparty occurrences: ${(mineBody.match(/·\s*\?/g) ?? []).length}`);
  await app.shot('mine-transfers');

  // --- All: strangers' transfers, which must read Private ------------------
  await app.page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1500);
  if (await clickButton(app.page, 'All')) {
    await sleep(8000);
    const foundPrivate = await scrollToRow(app, /^Private$/);
    const allBody = await bodyText(app.page);
    console.log(`all tab: "Private" amount row on screen=${foundPrivate}`);
    console.log(`  "Private" occurrences: ${(allBody.match(/\bPrivate\b/g) ?? []).length}`);
    console.log(`  bare "?" occurrences: ${(allBody.match(/(^|·|\s)\?(\s|$)/g) ?? []).length}`);
    await app.shot('all-transfers-private');
  } else {
    console.log('all tab: the All toggle was not found (scope pinned?)');
  }
} finally {
  await app.browser.close();
}
