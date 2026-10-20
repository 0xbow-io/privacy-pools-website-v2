// @ts-nocheck
// Pack H-b / H-c: export a transaction proof from a row and verify it as a
// third party at /verify; a tampered or truncated link is refused.
// Form-level: nothing moves.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/verify-proof.ts
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForText, unlockIfPrompted, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

const app = await openApp(acct, { tag: 'verify-proof' });
const p = app.page;
try {
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  await waitForShieldedBalance(p, 12);
  await p.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  await unlockIfPrompted(p);

  // Walk the rows until one offers "Export transaction proof".
  const kebabs = p.locator('[aria-label="Transaction actions"]');
  const until = Date.now() + 120_000;
  while (Date.now() < until && !(await kebabs.first().isVisible().catch(() => false))) await sleep(3000);
  let verifyUrl: string | null = null;
  let rowKind = '';
  const rowCount = Math.min(await kebabs.count().catch(() => 0), 14);
  for (let i = 0; i < rowCount && !verifyUrl; i += 1) {
    const kebab = kebabs.nth(i);
    await kebab.scrollIntoViewIfNeeded().catch(() => {});
    // The row menu keeps its open state in component state, so a row that
    // re-renders while it is up (note sync lands, prices refresh) closes it.
    // Retry the open, and log what the menu offered so a miss is diagnosable.
    let offered: string[] = [];
    let item = p.locator('[role="menuitem"]').filter({ hasText: 'Export transaction proof' }).first();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const isOpen = await p.locator('[role="menuitem"]').first().isVisible().catch(() => false);
      if (!isOpen) { await kebab.click().catch(() => {}); await sleep(900); }
      offered = await p.locator('[role="menuitem"]').allTextContents().catch(() => []);
      if (await item.isVisible().catch(() => false)) break;
      if (offered.length) break; // menu is up and simply lacks the item
      await sleep(600);
    }
    if (offered.length) console.log(`  row ${i + 1} menu: ${offered.join(' | ')}`);
    if (await item.isVisible().catch(() => false)) {
      await item.click().catch(() => {});
      await sleep(3000);
      await unlockIfPrompted(p);
      const body = await waitForText(p, /\/verify\//, 60_000) ?? await bodyText(p);
      const m = body.match(/https?:\/\/[^\s"']*\/verify\/[^\s"']*/);
      if (m) { verifyUrl = m[0]; rowKind = /Partial viewing key|viewing key/i.test(body) ? 'viewing-key bundle' : /origin/i.test(body) ? 'proof of origin' : 'proof'; console.log(`  row ${i + 1}: ${rowKind} exported`); }
      else { await p.keyboard.press('Escape').catch(() => {}); await sleep(800); }
    } else {
      await p.keyboard.press('Escape').catch(() => {});
      await sleep(800);
    }
  }
  await app.shot('export-modal');
  record('H-b a transaction row exports a proof with a /verify link', !!verifyUrl, verifyUrl ? `${rowKind} link produced` : 'no row offered a proof export, or no link rendered');
  if (!verifyUrl) throw new Error('no verify link');

  // Third party: fresh, wallet-less context.
  const ctx = await app.browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const v = await ctx.newPage();
  await v.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  // The single-key proof renders the on-chain verdict banner plus the value
  // rows; "ASP status" belongs to the bundle layout only.
  const vb = await waitForText(v, /Verified onchain/i, 90_000) ?? await bodyText(v);
  const heading = /Verify a payment/i.test(vb);
  const kindShown = /Partial viewing key|Proof of origin|viewing-key bundle/i.test(vb);
  const verified = /Verified onchain\. The transaction values below are confirmed/i.test(vb);
  const rows = /Amount/.test(vb) && /Owner/.test(vb) && /Network/.test(vb) && /Transaction/.test(vb);
  const amount = /\d+(\.\d+)?\s*ETH/i.test(vb);
  await v.screenshot({ path: '.e2e-shots/verify-proof-valid.png' }).catch(() => {});
  record('H-b /verify verifies the proof on-chain for a third party', heading && kindShown && verified && rows && amount,
    `heading ${heading}, kind ${kindShown}, verified banner ${verified}, value rows ${rows}, amount ${amount}`);

  // Tampered: flip one character deep inside the payload.
  const idx = verifyUrl.indexOf('/verify/') + 8;
  const enc = verifyUrl.slice(idx).replace(/[?#].*$/, '');
  const mid = Math.floor(enc.length / 2);
  const flipped = enc.slice(0, mid) + (enc[mid] === 'A' ? 'B' : 'A') + enc.slice(mid + 1);
  await v.goto(`${BASE}/verify/${flipped}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const REFUSED = /not a valid (partial viewing key|viewing-key bundle|proof of origin)|does not match its commitment|tampered/i;
  const tb = await waitForText(v, REFUSED, 60_000);
  await v.screenshot({ path: '.e2e-shots/verify-proof-tampered.png' }).catch(() => {});
  record('H-b a tampered proof link is refused with specific copy', !!tb, tb ? `copy: "${(tb.match(/[^\n]*(not a valid|does not match|tampered)[^\n]*/i)?.[0] ?? '').slice(0, 140)}"` : 'no refusal copy');

  // Truncated: drop the tail.
  await v.goto(`${BASE}/verify/${enc.slice(0, Math.floor(enc.length / 3))}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const cb = await waitForText(v, REFUSED, 60_000);
  record('H-b a truncated proof link is refused with specific copy', !!cb, cb ? 'refusal copy rendered' : 'no refusal copy');
  // ---- H-c: "Prove origin" on a withdrawal row -> /verify ---------------------
  try {
    await p.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(8000);
    await unlockIfPrompted(p);
    const kebabs2 = p.locator('[aria-label="Transaction actions"]');
    const until2 = Date.now() + 120_000;
    while (Date.now() < until2 && !(await kebabs2.first().isVisible().catch(() => false))) await sleep(3000);
    let originUrl: string | null = null;
    let sawProvable = false;
    let sawUnavailable = false;
    const n2 = Math.min(await kebabs2.count().catch(() => 0), 16);
    for (let i = 0; i < n2 && !originUrl; i += 1) {
      const kebab = kebabs2.nth(i);
      await kebab.scrollIntoViewIfNeeded().catch(() => {});
      let offered: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const isOpen = await p.locator('[role="menuitem"]').first().isVisible().catch(() => false);
        if (!isOpen) { await kebab.click().catch(() => {}); await sleep(900); }
        offered = await p.locator('[role="menuitem"]').allTextContents().catch(() => []);
        if (offered.length) break;
        await sleep(600);
      }
      const provable = p.locator('[role="menuitem"]').filter({ hasText: 'Prove origin' }).first();
      const isUnavail = offered.some((t) => /Prove origin\. Unavailable/i.test(t));
      const isProvable = offered.some((t) => /Prove origin$/i.test(t.trim()));
      if (isUnavail) sawUnavailable = true;
      if (isProvable && await provable.isVisible().catch(() => false)) {
        sawProvable = true;
        await provable.click().catch(() => {});
        await sleep(3000);
        await unlockIfPrompted(p);
        const body = await waitForText(p, /\/verify\//, 60_000) ?? await bodyText(p);
        const m = body.match(/https?:\/\/[^\s"']*\/verify\/[^\s"']*/);
        if (m) { originUrl = m[0]; console.log(`  row ${i + 1}: origin proof exported`); }
        else { await p.keyboard.press('Escape').catch(() => {}); await sleep(800); }
      } else {
        await p.keyboard.press('Escape').catch(() => {});
        await sleep(700);
      }
    }
    // "Prove origin. Unavailable" appears only for a withdrawal/exit whose change
    // note this device does not hold; a fully-synced fixture may hold them all,
    // so its ABSENCE is not a failure. Core assertion: a provable row offers the
    // action; the unavailable variant is documented when present.
    record('H-c a withdrawal row offers "Prove origin"', sawProvable,
      `provable rows seen: ${sawProvable}; "Prove origin. Unavailable" rows seen this run: ${sawUnavailable}`);
    if (originUrl) {
      const ctx2 = await app.browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const w = await ctx2.newPage();
      await w.goto(originUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await sleep(8000);
      const ob = await waitForText(w, /Verified onchain\. The sender controls a note/i, 90_000) ?? await bodyText(w);
      const verified = /Verified onchain\. The sender controls a note tied to this/i.test(ob);
      const aspStatus = /Approved|Pending review|Rejected|Proof of Innocence required/i.test(ob);
      await w.screenshot({ path: '.e2e-shots/verify-origin.png' }).catch(() => {});
      record('H-c /verify confirms the proof of origin with the ASP verdict', verified && aspStatus,
        `origin banner ${verified}, ASP verdict ${aspStatus}`);
      await ctx2.close();
    } else {
      record('H-c /verify confirms the proof of origin with the ASP verdict', false, 'no provable withdrawal row produced an origin link');
    }
  } catch (e) {
    record('H-c prove-origin', false, `threw: ${(e as Error).message}`);
  }

  await ctx.close();
} catch (e) {
  record('verify-proof', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== verify-proof summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
