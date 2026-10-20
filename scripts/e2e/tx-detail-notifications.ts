// @ts-nocheck
// Pack G-e: tx detail deep link and the notification center.
//   - /chains/sepolia/eth?tx=<hash> opens the detail modal with explorer link
//   - the bell (aria-label="Notifications") exists only when connected
//   - opening it shows the "Notifications" panel; "Open full activity" routes
//     to /transactions
// Form-level, nothing moves.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/tx-detail-notifications.ts
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForText, unlockIfPrompted } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
// A real, confirmed relayed withdrawal by this account (2026-08-27).
const TX = '0xb7f063dc65d84689e476554b62dca2ba6d2f02df04dbcd28b705ca3a75183b73';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};
const bellCount = (page) => page.evaluate(() => document.querySelectorAll('[aria-label="Notifications"]').length);

const app = await openApp(acct, { tag: 'tx-detail-notifications' });
const p = app.page;
try {
  // Signed OUT: a fresh wallet-less context must show no bell.
  const ctx = await app.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const anon = await ctx.newPage();
  await anon.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const bellsOut = await bellCount(anon);
  await ctx.close();
  record('G-e bell hidden when not connected', bellsOut === 0, `bells while signed out: ${bellsOut}`);

  // Signed IN.
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  await sleep(3000);
  const bellsIn = await bellCount(p);
  record('G-e bell present when connected', bellsIn > 0, `bells while connected: ${bellsIn}`);

  // Notification center on a CLEAN signed-in home page (before any URL-driven
  // modal is opened and closed): on desktop the bell toggles local state, so
  // press it via its testID; the ?notifications=1 route is mobile-only.
  const bell = p.locator('[data-testid="notification-bell"]').first();
  let panel: string | null = null;
  for (let attempt = 1; attempt <= 3 && !panel; attempt += 1) {
    await bell.click({ force: true }).catch(() => {});
    panel = await waitForText(p, /Open full activity/i, 8_000);
    if (!panel) {
      const box = await bell.boundingBox().catch(() => null);
      if (box) { await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await sleep(60); await p.mouse.up(); }
      panel = await waitForText(p, /Open full activity/i, 8_000);
    }
  }
  await app.shot('notifications');
  const openFull = !!panel && /Open full activity/i.test(panel) && /Notifications/.test(panel);
  record('G-e notification center opens from the bell', openFull, openFull ? 'panel with "Notifications" heading and "Open full activity" rendered' : `panel: ${!!panel}`);
  if (openFull) {
    await p.locator('text=Open full activity').first().click().catch(() => {});
    await sleep(4000);
    const url = p.url();
    record('G-e "Open full activity" routes to /transactions', /\/transactions/.test(url), `url ${url.replace(BASE, '')}`);
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(4000);
  } else {
    record('G-e "Open full activity" routes to /transactions', false, 'panel never opened');
  }

  // Deep link to a real tx.
  await p.goto(`${BASE}/chains/sepolia/eth?tx=${TX}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(9000);
  await unlockIfPrompted(p);
  const detail = await waitForText(p, /View on Etherscan/i, 120_000);
  const body = detail ?? await bodyText(p);
  const hashShown = body.toLowerCase().includes(TX.slice(0, 8).toLowerCase()) && body.toLowerCase().includes(TX.slice(-6).toLowerCase());
  const fields = /Transaction/.test(body) && /Token/.test(body) && /Event #|Deposit #/.test(body);
  await app.shot('tx-detail');
  record('G-e ?tx= deep link opens the detail modal with explorer link', !!detail && hashShown && fields,
    `explorer link: ${!!detail}, hash shown: ${hashShown}, fields: ${fields}`);
  await p.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  // Notification center: open via the bell, then "Open full activity".
} catch (e) {
  record('tx-detail-notifications', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== tx-detail-notifications summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
