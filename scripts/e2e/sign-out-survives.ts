// @ts-nocheck
// Pack J-f: disconnect/sign out must not lose session data. The account export
// (notes + history) is keyed to the address in localStorage
// (ppv2_account_export_v2_<addr>_<chain>), so signing out (which clears the
// wagmi connection, sessionStorage identity, and in-memory session) must leave
// that persisted bucket intact - it is re-read on the next connect. Form-level.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/sign-out-survives.ts
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};
const exportKeys = (page) => page.evaluate(() => {
  // Web writes the account-export cache to sessionStorage (sdk-provider
  // storageSetItem), not localStorage - it is per-tab, survives reload and a
  // plain Sign Out, and only the explicit "wipe local notes" opt-in clears it.
  const out: Record<string, number> = {};
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i)!;
    if (k.startsWith('ppv2_account_export_')) out[k] = (sessionStorage.getItem(k) || '').length;
  }
  return out;
});

const app = await openApp(acct, { tag: 'sign-out-survives' });
const p = app.page;
try {
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  const spendable = await waitForShieldedBalance(p, 12);
  record('J-f signed in with a balance to protect', spendable > 0, `${spendable} ETH shielded`);
  // The export is written by the discovery pass that produced the balance;
  // give that write a beat to land before snapshotting.
  await sleep(6000);
  // Dump every ppv2 key so the real persistence surface is visible, then treat
  // ANY substantial ppv2 note/session bucket as the data to protect (the export
  // key may carry a pool suffix, or the notes may live under a note-manager key).
  const allKeys = await p.evaluate(() => {
    const out: Record<string, number> = {};
    const scan = (store: Storage, tag: string) => {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i)!;
        if (/ppv2/i.test(k)) out[`${tag}:${k}`] = (store.getItem(k) || '').length;
      }
    };
    scan(localStorage, 'local');
    scan(sessionStorage, 'session');
    return out;
  });
  console.log(`  ppv2 localStorage keys: ${JSON.stringify(allKeys)}`);
  const before = await exportKeys(p);
  // The data-to-protect: an export bucket if present, else any sizable ppv2 key
  // that plausibly holds notes/session (export / note / session / snapshot).
  // The account export is the note/history cache; it lives in sessionStorage.
  const beforeKeys = Object.keys(before);
  record('J-f session data persisted while signed in', beforeKeys.length > 0,
    `${beforeKeys.length} data bucket(s): ${beforeKeys.map((k) => `${k}(${allKeys[k] ?? before[k]})`).join(', ').slice(0, 300)}`);

  // Open the account dropdown (the chip shows the address) and Sign Out.
  const chip = p.locator('text=/0x[0-9a-fA-F]{2,6}(…|\\.{3})/').first();
  await chip.click().catch(() => {});
  await sleep(1500);
  const signOut = p.locator('text=Sign Out').first();
  const hadSignOut = await signOut.isVisible().catch(() => false);
  await signOut.click().catch(() => {});
  await sleep(4000);
  await app.shot('after-sign-out');
  const body = await bodyText(p);
  const signedOut = /Connect Wallet/i.test(body) && !/Sign Out/i.test(body);
  record('J-f Sign Out returns to the signed-out state', hadSignOut && signedOut,
    `Sign Out control present: ${hadSignOut}; now shows Connect Wallet: ${/Connect Wallet/i.test(body)}`);

  // The persisted export must survive the sign-out.
  const readKeys = async () => p.evaluate((keys) => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = (sessionStorage.getItem(k) || '').length;
    return out;
  }, beforeKeys);
  const after = await readKeys();
  const survived = beforeKeys.length > 0 && beforeKeys.every((k) => (after[k] ?? 0) > 0);
  record('J-f session data survives Sign Out (not lost)', survived, `after ${JSON.stringify(after)}`);

  // A reload while signed out must still keep it (nothing clears it lazily).
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const afterReload = await readKeys();
  const keptOnReload = beforeKeys.length > 0 && beforeKeys.every((k) => (afterReload[k] ?? 0) > 0);
  record('J-f session data still present after a signed-out reload', keptOnReload, `after reload ${JSON.stringify(afterReload)}`);
} catch (e) {
  record('sign-out-survives', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== sign-out-survives summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
