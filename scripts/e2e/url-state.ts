// @ts-nocheck
// Pack K: URL state & deep links. Form-level, nothing moves.
//   K-b  ?action= aliases: deposit -> Shield; swap degrades when hidden;
//        browser-back restores the previous tab's inline form
//   K-c  ?panel=balances / ?panel=activity on desktop and mobile (the mobile
//        bottom bar hides while a panel is open)
//   K-d  ?tx= with an unknown hash is a graceful no-op; ?connect=1 shows the
//        connect picker
//   K-f  /stats -> /explore, /explore/pools -> /explore, unknown explore
//        section -> /   (invalid /pay payload is covered by pay-verify.ts)
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/url-state.ts
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForText, clickButton } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};
const go = async (page, path: string, settle = 6000) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(settle);
};

const app = await openApp(acct, { tag: 'url-state' });
const pageErrors: string[] = [];
app.page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  // ---- K-d: connect picker via ?connect=1 (still signed out) -------------
  await go(app.page, '/?connect=1');
  const picker = await waitForText(app.page, /Pick how you want to connect/i, 30_000);
  record('K-d ?connect=1 shows the connect picker', !!picker, picker ? 'picker copy rendered' : 'no picker copy');

  await go(app.page, '/', 3000);
  await signIn(app.page);

  // ---- K-b: aliases ---------------------------------------------------------
  await go(app.page, '/?action=deposit');
  const shieldBody = await waitForText(app.page, /Shield ETH/i, 30_000);
  record('K-b ?action=deposit lands on Shield', !!shieldBody && !/Review transfer/i.test(shieldBody ?? ''),
    shieldBody ? 'Shield CTA on screen, no Send form' : 'Shield CTA never rendered');

  await go(app.page, '/?action=swap');
  const swapBody = await bodyText(app.page);
  const swapTab = /Swap/i.test(swapBody);
  const shieldFallback = /Shield ETH/i.test(swapBody);
  record('K-b ?action=swap lands on a real tab', swapTab || shieldFallback,
    swapTab ? 'Swap tab is visible on this build (demo), so the alias lands there' : shieldFallback ? 'swap hidden: degraded to Shield' : 'neither Swap nor Shield rendered');

  // Back-navigation: two history entries (?action=send, then ?action=withdraw);
  // browser-back must land on the Send URL AND restore its inline form. Tab
  // clicks deliberately do not push history (only the connect flow does), so
  // this is exercised with navigations, which is also how a user gets here.
  await go(app.page, '/?action=send');
  const sendForm = await waitForText(app.page, /Review Transfer|Continue in Withdraw/i, 30_000);
  await go(app.page, '/?action=withdraw');
  const wd = await waitForText(app.page, /Recipient receives the exact amount/i, 30_000);
  await app.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4000);
  const back = await waitForText(app.page, /Review Transfer|Continue in Withdraw/i, 20_000);
  const backUrl = app.page.url();
  record('K-b browser-back restores the previous tab', !!sendForm && !!wd && !!back && /action=send/.test(backUrl),
    `send form ${!!sendForm} -> withdraw form ${!!wd} -> back: ${back ? 'Send form restored' : 'not restored'} (url ${backUrl.replace(BASE, '')})`);

  // ---- K-c: panels on desktop --------------------------------------------------
  await go(app.page, '/?panel=balances');
  const bal = await waitForText(app.page, /My private balance/i, 30_000);
  record('K-c ?panel=balances opens the balances panel (desktop)', !!bal, bal ? 'hero rendered' : 'hero never rendered');
  await go(app.page, '/?panel=activity');
  const act = await waitForText(app.page, /My transactions|All activity|My activity/i, 30_000);
  record('K-c ?panel=activity opens the activity panel (desktop)', !!act, act ? 'activity panel rendered' : 'activity panel never rendered');

  // ---- K-c: mobile: panel open hides the bottom bar ---------------------------
  const mobile = await app.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mobile.newPage();
  await mp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  // The bar is UNMOUNTED while a sheet is open (mobile-nav.tsx: `!sheetOpen &&`).
  // Key on its "More" label: "All activity" also appears on the home screen
  // behind the sheet, which made the first version of this check read the bar
  // as still visible.
  const barHome = /\bMore\b/.test(await bodyText(mp));
  await mp.goto(`${BASE}/?panel=balances`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const mBody = await bodyText(mp);
  const sheetOpen = /My balances|My private balance/i.test(mBody);
  const barHidden = !/\bMore\b/.test(mBody);
  await mp.screenshot({ path: '.e2e-shots/url-state-mobile-panel.png' }).catch(() => {});
  record('K-c mobile panel opens as a sheet and hides the bottom bar', barHome && sheetOpen && barHidden,
    `bar on home: ${barHome}, sheet open: ${sheetOpen}, bar hidden while open: ${barHidden}`);
  await mobile.close();

  // ---- K-d: unknown ?tx= is a graceful no-op ---------------------------------
  const errsBefore = pageErrors.length;
  await go(app.page, '/chains/sepolia/eth?tx=0x' + 'de'.repeat(32), 12_000);
  const poolBody = await bodyText(app.page);
  const noDetail = !/Event #/i.test(poolBody);
  const poolShown = /ETH Pool/i.test(poolBody);
  record('K-d unknown ?tx= renders the pool page with no detail and no error',
    poolShown && noDetail && pageErrors.length === errsBefore,
    `pool page: ${poolShown}, detail modal: ${!noDetail}, new page errors: ${pageErrors.length - errsBefore}`);

  // ---- K-f: redirects ------------------------------------------------------------
  const redirect = async (from: string, expected: RegExp, label: string) => {
    await go(app.page, from, 5000);
    const u = app.page.url().replace(BASE, '') || '/';
    record(`K-f ${label}`, expected.test(u), `${from} -> ${u}`);
  };
  await redirect('/stats', /^\/explore\/?(\?.*)?$/, '/stats redirects to /explore');
  await redirect('/explore/pools', /^\/explore\/?(\?.*)?$/, '/explore/pools redirects to /explore');
  await redirect('/explore/definitely-not-a-section', /^\/(\?.*)?$/, 'unknown explore section redirects to /');
} catch (e) {
  record('url-state', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== url-state summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
