// One-off verification probe: connect -> balances-panel landing.
// Needs a dev server on :8081.
//
// SCOPE LIMIT, read this before trusting the result: the harness wallet holds no
// shielded balance (notes require a signed keystore session), and nothing in the
// app fabricates pool balances. So the POSITIVE case — a funded account being
// redirected — cannot be produced here. What this probe covers is the set of
// guarantees that stop the feature misbehaving: it must not redirect when there
// is no balance, must not redirect on a restored session, must not touch
// every variant, and must never trap navigation. The redirect decision itself is
// covered by services/__tests__/connect-landing.test.ts.
import { chromium, type Page } from 'playwright';
import { installEvmWallet, loadDevAccount } from './evm-wallet';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function boot(width: number, url: string, connected: boolean) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  if (connected) await installEvmWallet(page, loadDevAccount());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  if (connected) {
    for (let i = 0; i < 30; i++) {
      if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText))) break;
      await page.waitForTimeout(1000);
    }
  }
  // Well past the 600ms settle and any balance load.
  await page.waitForTimeout(6000);
  return { browser, page };
}

const panelOf = (page: Page) => page.evaluate(() => new URL(location.href).searchParams.get('panel'));

async function zeroBalanceConnect() {
  console.log('\n=== connect with NO balance (vault) ===');
  const { browser, page } = await boot(1440, `${BASE}/?theme=1`, true);
  check('connected', /0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText)));
  check('empty account is NOT redirected to the panel', (await panelOf(page)) === null, String(await panelOf(page)));
  check('no crash on the landing path', await page.evaluate(() => document.body.innerText.length > 200));
  await browser.close();
}

async function restoredSessionDoesNotReopen() {
  console.log('\n=== restored session must not reopen the panel ===');
  // Land directly on the panel, then reload: the reload restores a connected
  // session, which must NOT re-arm. (With the panel already open the guard also
  // short-circuits, so this covers both.)
  const { browser, page } = await boot(1440, `${BASE}/?theme=1&panel=balances`, true);
  check('panel open as deep-linked', (await panelOf(page)) === 'balances');

  // Navigate away — with an already-connected session this must stick.
  await page.evaluate(() => history.pushState({}, '', '/'));
  await page.waitForTimeout(4000);
  check('navigating away from the panel STICKS (not re-opened)', (await panelOf(page)) === null,
    String(await panelOf(page)));
  await browser.close();
}

async function navigationNotTrapped() {
  console.log('\n=== navigation is never trapped ===');
  const { browser, page } = await boot(1440, `${BASE}/?theme=1`, true);
  // Go to another route and stay there.
  await page.goto(`${BASE}/stats?theme=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForTimeout(6000);
  const url = page.url();
  check('a connected user stays on /stats', new URL(url).pathname === '/stats', url);
  check('no panel param was forced onto it', (await panelOf(page)) === null);
  await browser.close();
}


async function disconnectedIdle() {
  console.log('\n=== signed out: nothing happens ===');
  const { browser, page } = await boot(1440, `${BASE}/?theme=1`, false);
  check('no redirect while signed out', (await panelOf(page)) === null);
  await browser.close();
}

await zeroBalanceConnect();
await restoredSessionDoesNotReopen();
await navigationNotTrapped();
await disconnectedIdle();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
console.log('NOTE: the funded-account redirect itself is NOT covered here — see the scope limit at the top.');
process.exit(R.fail ? 1 : 0);
