// @ts-nocheck
// The "My private balance" hero across an account boundary. Two regressions
// from the last-figure bridge (show the cached total during a sync instead of a
// skeleton), both reported by Pat on 2026-08-27:
//   1. Sign out -> the hero kept a skeleton forever, as if something were about
//      to load. Signed out, nothing is: the resting state is a dash.
//   2. Switch to a fresh 0 ETH wallet -> the hero showed the PREVIOUS wallet's
//      total for the seconds the new account's pools list was empty.
// Run against a dev server (or PROBE_URL) with an account that holds a balance:
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/hero-account-switch.ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForText } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
// A wallet nobody has ever funded: the strongest possible "previous balance
// must not leak" check, since its true total is exactly $0.
const fresh = privateKeyToAccount(generatePrivateKey());

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

/**
 * The hero block: its $ figure, whether a Syncing marker or a skeleton sits in
 * it, and whether it rests on the dash. The skeleton has no test id, so it is
 * recognised the way a user sees it: a hero with the label but neither a
 * figure nor a dash inside it.
 */
const heroState = (page) => page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('*')).filter(
    (n) => n.children.length === 0 && /^My private balance$/.test((n.textContent || '').trim()),
  );
  const label = labels[0];
  if (!label) return { found: false, figure: null, dash: false, skeleton: false, syncing: false, text: '' };
  // The label's parent is the hero column (label + figure row); read that block.
  const block = label.parentElement;
  const raw = (block?.textContent || '').trim();
  let body = raw.replace(/^My private balance/, '').trim();
  // Strip anything after a ▲ line so a second $ figure is never mistaken for
  // the BALANCE figure, which always precedes it.
  body = body.split('▲')[0].trim();
  const m = body.match(/\$[\d,]+(\.\d+)?/);
  const dash = /^[—–-]/.test(body);
  // A block whose balance area is empty (no $ figure, no dash) is the skeleton
  // (a View with no text). The yield line, stripped above, does not count.
  const skeleton = !m && !dash && body.replace(/Syncing/, '').length === 0;
  return { found: true, figure: m ? m[0] : null, dash, skeleton, syncing: /Syncing/.test(body), text: raw.slice(0, 140) };
});

/** Open the My balances door, RNW-style (a real press, not a click). */
const openBalances = async (p) => {
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
};

/** Poll the hero until it shows a real non-zero figure, or give up. */
const waitForFigure = async (p, timeoutMs: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await heroState(p);
    if (s.figure && s.figure !== '$0' && s.figure !== '$0.00') return s;
    await sleep(1000);
  }
  return heroState(p);
};

const app = await openApp(acct, { tag: 'hero-account-switch' });
const p = app.page;
// The hero logs every sync-flag transition; openApp's filter does not keep
// [perf] lines, and on a failure "which flag was still true" is the answer.
p.on('console', (m) => {
  const t = m.text();
  if (t.includes('balance-hero')) console.log('  [hero]', t.slice(0, 200));
});
try {
  await p.goto(`${BASE}/?panel=balances`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  await openBalances(p);
  await waitForText(p, /My private balance/i, 60_000);
  const withFunds = await waitForFigure(p, 120_000);
  await app.shot('signed-in');
  const figureA = withFunds.figure;
  record('signed in with a balance to protect', !!figureA && figureA !== '$0',
    `hero: ${withFunds.text}`);

  // ---- 1. Sign out: the hero must rest on a dash, not a skeleton. ----------
  const chip = p.locator('text=/0x[0-9a-fA-F]{2,6}(…|\\.{3})/').first();
  await chip.click().catch(() => {});
  await sleep(1500);
  const signOut = p.locator('text=Sign Out').first();
  const hadSignOut = await signOut.isVisible().catch(() => false);
  await signOut.click().catch(() => {});
  // Past the latch grace (2.5s) and the sync flags settling.
  await sleep(6000);
  await app.shot('signed-out');
  const body = await bodyText(p);
  const signedOut = /Connect Wallet|Sign in/i.test(body) && !/Sign Out/i.test(body);
  record('Sign Out returns to the signed-out state', hadSignOut && signedOut,
    `Sign Out control: ${hadSignOut}; body shows connect/sign-in: ${/Connect Wallet|Sign in/i.test(body)}`);
  const out = await heroState(p);
  if (out.found) {
    record('signed out: the hero shows a dash, not a skeleton', out.dash && !out.skeleton && !out.figure,
      `hero: "${out.text}" dash=${out.dash} skeleton=${out.skeleton} figure=${out.figure}`);
    // A spinner labelled Syncing beside the dash reads exactly like the endless
    // skeleton it replaced: nothing is landing, so nothing should claim to be.
    record('signed out: no Syncing marker beside the dash', !out.syncing,
      out.syncing ? `hero still says Syncing: "${out.text}"` : 'no marker');
    record('signed out: no stale figure from the previous account', out.figure === null,
      out.figure ? `still showing ${out.figure}` : 'no figure');
  } else {
    // The panel may collapse to its gate copy on sign-out; that is also a
    // legitimate "nothing is loading" state, and the skeleton check is then moot.
    record('signed out: hero collapsed to the gate (no skeleton possible)', /Sign in to sync|Connect/i.test(body),
      `body: ${body.slice(0, 120)}`);
  }

  // ---- 2. The dash must HOLD, and the wallet reporting a different address
  // must not resurrect anything. ---------------------------------------------
  // Deliberately NOT a reload: a reload re-arms this harness's wallet as
  // account A, which auto-reconnects and legitimately restores A's cached
  // balance - that is the "instant balance from cache" behaviour, not a bug.
  // The regression was a figure that persisted or came BACK while signed out,
  // so sample the signed-out state over time instead. The switcher emits
  // accountsChanged like a real extension, proving a reported-address change
  // alone brings nothing back either.
  await p.evaluate((next) => (window as any).__hwEvmSwitchAddress?.(next), fresh.address);
  let sawFigureA = false;
  let sawOtherFigure: string | null = null;
  let dashSamples = 0;
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const s = await heroState(p);
    samples += 1;
    if (s.dash) dashSamples += 1;
    if (s.figure) {
      if (s.figure === figureA) sawFigureA = true;
      else sawOtherFigure = s.figure;
    }
    await sleep(500);
  }
  await app.shot('signed-out-held');
  const finalState = await heroState(p);
  record(`signed out: the previous wallet's ${figureA} never came back over 15s`, !sawFigureA,
    `${samples} samples, ${dashSamples} on the dash; final hero: "${finalState.text}"`);
  record('signed out: no balance figure appeared at all', sawOtherFigure === null && !sawFigureA,
    sawOtherFigure ? `saw ${sawOtherFigure}` : 'only dash / skeleton seen');
  record('signed out: the dash is the steady state, not a flash', dashSamples >= samples - 2,
    `${dashSamples}/${samples} samples showed the dash`);

  // The teardown-render leak itself - a live manager built for A answering
  // getNotes() during the one render sessionAddress has already flipped to B -
  // is sub-render and cannot be sampled from the browser; worse, this harness
  // signs every request with one key, so it cannot derive a genuinely second
  // wallet's (empty) keystore. That case is covered faithfully and directly by
  // services/__tests__/note-source.test.ts (managerOwnsAccount).
} catch (e) {
  record('hero-account-switch', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== hero-account-switch summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
