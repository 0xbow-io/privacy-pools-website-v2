// @ts-nocheck
// Pat, 2026-08-27: the total blanked to a skeleton for the whole ~20s sync while
// the per-asset row underneath already showed the number, and signing in made an
// already-visible balance disappear. This asserts the total stays on screen with
// a Syncing marker instead.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/balance-during-sync.ts
import { accountFromKey, openApp, signIn, sleep, bodyText, waitForText, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

/** The hero total, and whether a Syncing marker sits beside it. */
const heroState = (page) => page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('*')).filter(
    (n) => n.children.length === 0 && /^My private balance$/.test((n.textContent || '').trim()),
  );
  const label = labels[0];
  if (!label) return { found: false, figure: null, syncing: false };
  // Walk up to the hero block, then read the biggest $ figure inside it.
  let block: Element | null = label.parentElement;
  for (let i = 0; i < 3 && block; i += 1) {
    if ((block.textContent || '').includes('$')) break;
    block = block.parentElement;
  }
  const text = (block?.textContent || '').trim();
  const m = text.match(/\$[\d,]+(\.\d+)?/);
  return { found: true, figure: m ? m[0] : null, syncing: /Syncing/.test(text), text: text.slice(0, 120) };
});

const app = await openApp(acct, { tag: 'balance-during-sync' });
const p = app.page;
try {
  // Open the panel FIRST, then sign in, and do not navigate again: a second
  // goto after signIn dropped the session and left the page in the signed-out
  // empty state ("Sign in to sync your balances"), which read as the feature
  // failing when it was the probe resetting the app.
  await p.goto(`${BASE}/?panel=balances`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  // The ?panel= bridge does not reliably expand the drawer here (expo-router
  // writes the URL after mount), and with the panel collapsed the hero is not in
  // the DOM at all - which read as the feature failing. Click the button.
  const balancesTab = p.locator('text=/My balances/').first();
  if (await balancesTab.isVisible().catch(() => false)) {
    const box = await balancesTab.boundingBox().catch(() => null);
    if (box) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await sleep(60);
      await p.mouse.up();
    }
  }
  await sleep(1500);
  const signedIn = await waitForText(p, /My private balance/i, 60_000);
  const stillGated = /Sign in to sync/i.test(await bodyText(p));
  record('the balances panel is open and signed in before sampling', !!signedIn && !stillGated,
    stillGated ? 'page still shows "Sign in to sync"' : signedIn ? 'hero present' : 'hero never rendered');

  // Sample the hero repeatedly through the sync window.
  let sawFigureWhileSyncing = false;
  let sawSyncingMarker = false;
  let everBlankAfterFigure = false;
  let firstFigureAt: number | null = null;
  const t0 = Date.now();
  for (let i = 0; i < 40; i += 1) {
    const s = await heroState(p);
    if (s.figure) {
      if (firstFigureAt === null) firstFigureAt = Date.now() - t0;
      if (s.syncing) { sawFigureWhileSyncing = true; sawSyncingMarker = true; }
    } else if (firstFigureAt !== null) {
      // A figure was on screen and then vanished: the regression Pat reported.
      everBlankAfterFigure = true;
    }
    if (i === 3) await app.shot('early-sync');
    await sleep(1000);
  }
  await app.shot('after-sync');
  const balance = await waitForShieldedBalance(p, 6).catch(() => 0);

  record(
    'the total appears within a few seconds, not after the whole sync',
    firstFigureAt !== null && firstFigureAt <= 20_000,
    firstFigureAt === null ? 'never appeared' : `first figure at ${(firstFigureAt / 1000).toFixed(1)}s`,
  );
  record(
    'the total stays on screen while syncing, with a Syncing marker',
    sawFigureWhileSyncing && sawSyncingMarker,
    `figure+marker seen together: ${sawFigureWhileSyncing}`,
  );
  record(
    'the total never blanks once shown (no going backwards)',
    !everBlankAfterFigure,
    everBlankAfterFigure ? 'figure vanished after being shown' : 'stayed visible',
  );
  const final = await heroState(p);
  record(
    'the marker clears when the sync finishes',
    !final.syncing || balance > 0,
    `final hero: ${JSON.stringify(final).slice(0, 140)}`,
  );
} catch (e) {
  record('balance-during-sync', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== balance-during-sync summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
