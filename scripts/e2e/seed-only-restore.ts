// @ts-nocheck
// Pack M-a: seed-only restore on a fresh browser (no backups). A brand-new
// context has zero ppv2 storage; signing in with the same wallet signature
// re-derives the keys and rediscovers own deposits + change notes purely via
// the ASP/chain sync. (V3 payment-request notes do NOT come back this way -
// accepted risk DEV-301 - so this asserts the OWN-funds balance only.)
// Form-level, nothing moves.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/seed-only-restore.ts
import { accountFromKey, openApp, signIn, sleep, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

const app = await openApp(acct, { tag: 'seed-only-restore' });
const p = app.page;
try {
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  // Prove the starting point is truly bare: no ppv2 note cache in either store.
  const preStorage = await p.evaluate(() => {
    let n = 0;
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) if (/ppv2_account_export/.test(store.key(i)!)) n += 1;
    }
    return n;
  });
  record('M-a fresh browser has no note cache before sign-in', preStorage === 0, `account-export buckets before sign-in: ${preStorage}`);

  // Sign in = the wallet signature only; no import, no backup.
  await signIn(p);
  const spendable = await waitForShieldedBalance(p, 40);
  record('M-a own funds reappear from discovery alone (no backup)', spendable > 0, `${spendable} ETH shielded, rebuilt from the seed`);

  // And the rebuilt notes were persisted to the cache by that discovery.
  await sleep(6000);
  const cached = await p.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i)!;
      if (/ppv2_account_export/.test(k)) return (sessionStorage.getItem(k) || '').length;
    }
    return 0;
  });
  record('M-a discovery repopulated the note cache', cached > 100, `export bucket size after restore: ${cached}`);
} catch (e) {
  record('seed-only-restore', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== seed-only-restore summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
