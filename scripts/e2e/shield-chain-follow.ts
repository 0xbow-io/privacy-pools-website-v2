// @ts-nocheck
// Does the shield widget follow the header's network selection?
// Pat, 2026-08-28: "if I select OP, it still shows me ETH on sepolia".
// Reads the widget's chain chip label and its offered token list BEFORE and
// AFTER switching the header chain, so the answer is observed, not reasoned.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/shield-chain-follow.ts
import { accountFromKey, openApp, sleep, bodyText } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
const TARGET = process.env.E2E_TARGET_CHAIN || 'Optimism';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

/** The shield widget's selected-token row: its symbol and its chain chip. */
const widgetState = (page) => page.evaluate(() => {
  const row = document.querySelector('[data-testid="deposit-token-selected"]');
  if (!row) return { found: false, text: '' };
  return { found: true, text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) };
});

/** Press an element by exact visible text (RNW needs real mouse events). */
const pressText = async (page, re: RegExp) => {
  const loc = page.locator(`text=${re}`).first();
  if (!(await loc.isVisible().catch(() => false))) return false;
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(1200);
  return true;
};

const app = await openApp(acct, { tag: 'shield-chain-follow' });
const p = app.page;
try {
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);

  const before = await widgetState(p);
  record('shield widget is on screen', before.found, `row: "${before.text}"`);
  await app.shot('before-switch');

  // Open the header chain selector. Its trigger shows the CURRENT chain name,
  // so press whatever chain we are on, then pick the target from the menu.
  const opened = (await pressText(p, /Sepolia/i)) || (await pressText(p, /Ethereum/i));
  record('header chain selector opens', opened, opened ? 'menu opened' : 'no chain trigger found');
  await app.shot('chain-menu');

  const picked = await pressText(p, new RegExp(`^${TARGET}$`, 'i'));
  record(`selected ${TARGET} in the header`, picked, picked ? 'pressed' : `no "${TARGET}" row`);
  await sleep(4000);
  await app.shot('after-switch');

  const after = await widgetState(p);
  record('shield widget still rendered after the switch', after.found, `row: "${after.text}"`);

  // The chip must NAME the selected chain, and must not still name the old one.
  const namesTarget = new RegExp(TARGET, 'i').test(after.text);
  const namesSepolia = /sepolia/i.test(after.text);
  record(`widget chain chip says ${TARGET}`, namesTarget && !namesSepolia,
    `chip text: "${after.text}"`);

  // And the offered token list must be the target chain's.
  const sheetOpened = await pressText(p, /^ETH$/);
  if (sheetOpened) {
    await sleep(1500);
    await app.shot('token-sheet');
    const body = await bodyText(p);
    record('token sheet lists the target chain assets', /USDC/i.test(body),
      `sheet mentions USDC: ${/USDC/i.test(body)}`);
  } else {
    record('token sheet opened', false, 'could not press the token row');
  }
} catch (e) {
  record('shield-chain-follow', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== shield-chain-follow summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
