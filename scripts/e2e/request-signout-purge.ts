// @ts-nocheck - Bun runtime script, same conventions as payment-request-unregistered.ts.
//
// DEV-497, Mike's exact flow in a real Chromium, once per sign-out path:
//
//   a fresh UNREGISTERED wallet creates a payment request, chooses
//   "Download backup" and saves the file  ->  the request's
//   v1:payment-request-state:<chain>:<address> key exists  ->  the user signs
//   out  ->  the key is gone, and every other localStorage key is untouched.
//
// Paths: header "Sign Out", a disconnect from inside the wallet (empty
// accountsChanged), and an account switch in the wallet.
//
// The save dialog cannot be clicked in a headless browser, so the File System
// Access picker is replaced by one that "saves" into page memory. That keeps
// the app's real proof path (open at the press, write after the request
// exists) and lets the run read back exactly what was written.
//
// No funds needed: an unregistered request is created from a signature only.
//
//   PROBE_URL=https://<preview> bun scripts/e2e/request-signout-purge.ts [header|wallet|switch ...]
import { bodyText, clickButton, openApp, signIn, sleep, tab, unlockIfPrompted, enterAmount, selectToken, installSavePickerStub, savedBackups } from './lib';
import { mintEphemeral } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['header', 'wallet', 'switch'];
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`\n>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}\n`);
};

const storageKeys = (page) => page.evaluate(() => Object.keys(localStorage).sort());

async function runPath(path: string) {
  const { account } = mintEphemeral();
  const owner = account.address.toLowerCase();
  console.log(`[${path}] fresh unregistered wallet ${owner}`);
  const app = await openApp(account, { tag: `purge-${path}` });
  const page = app.page;
  try {
    await installSavePickerStub(page);
    // A protected Vercel preview: send the local development OIDC token
    // (`vercel env run -- bun ...`) to the preview's own origin ONLY, never to
    // the RPCs or the ASP.
    if (process.env.VERCEL_OIDC_TOKEN && /^https:/.test(BASE)) {
      const origin = new URL(BASE).origin;
      await page.route(`${origin}/**`, (route) => route.continue({
        headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN },
      }));
    }
    // The harness wallet lives on Sepolia, i.e. the staging world; the choice
    // persists, so signIn's own navigation stays there.
    await page.goto(`${BASE}/?env=${process.env.E2E_APP_ENV || 'staging'}`, { waitUntil: 'domcontentloaded' });
    await sleep(6000);
    await signIn(page);
    if (!(await tab(page, 'Request'))) throw new Error('Request tab never became active');
    await selectToken(page, 'Request');
    if (!(await enterAmount(page, process.env.E2E_REQUEST_ETH || '0.005'))) throw new Error('request amount field not found');
    await sleep(1500);

    let created = false;
    for (let attempt = 1; attempt <= 4 && !created; attempt += 1) {
      console.log('  create pressed:', await clickButton(page, 'Create request'));
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !created) {
        await unlockIfPrompted(page);
        const backup = page.getByTestId('unregistered-download');
        if (await backup.isVisible().catch(() => false)) await backup.click();
        created = /\/pay#/.test(await bodyText(page))
          || await page.evaluate(() => Array.from(document.querySelectorAll('input')).some((i) => (i.value || '').includes('/pay#')));
        if (!created) await sleep(2000);
      }
    }
    await app.shot('after-create');
    record(`[${path}] request created`, created, created ? 'pay link shown' : `no pay link; screen: ${(await bodyText(page)).slice(0, 600).replace(/\s+/g, ' ')}`);
    if (!created) return;
    await sleep(3000);

    const saved = await savedBackups(page);
    const file = saved.files[0];
    let backupOk = false;
    try {
      const parsed = JSON.parse(file.text);
      backupOk = parsed.kind === 'ppv2-payment-request-backup' && Object.keys(parsed.chains ?? {}).length > 0;
    } catch { /* not a backup */ }
    record(`[${path}] backup saved through the save dialog`, saved.calls === 1 && backupOk,
      `picker calls ${saved.calls}, files ${saved.files.length}, ${file?.name}`);

    const isOwnerKey = (k: string) => k.startsWith('v1:payment-request-state:') && k.toLowerCase().includes(owner);
    const before = await storageKeys(page);
    const ownerKeys = before.filter(isOwnerKey);
    record(`[${path}] request key present before sign-out`, ownerKeys.length > 0, ownerKeys.join(', '));

    if (path === 'header') {
      await page.locator('text=/0x[0-9a-fA-F]{2,6}(…|\\.{3})/').first().click().catch(() => {});
      await sleep(1500);
      await page.locator('text=Sign Out').first().click();
    } else if (path === 'wallet') {
      await page.evaluate(() => window.__hwEvmDisconnect());
    } else {
      await page.evaluate((next) => window.__hwEvmSwitchAddress(next), mintEphemeral().account.address);
    }
    let after = before;
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      after = await storageKeys(page);
      if (!after.some(isOwnerKey)) break;
    }
    record(`[${path}] request key removed on sign-out`, !after.some(isOwnerKey), after.filter(isOwnerKey).join(', ') || 'gone');
    // Everything else survives. The ledger key goes with the records by design,
    // and the app may ADD keys while signing out; it must not drop any.
    const isLedger = (k: string) => k.startsWith('ppv2_payment_request_backups_v1:');
    // The association-set leaf cache replaces its own entry whenever the root
    // moves, signed in or not; that is the cache, not the purge.
    const isSelfRotatingCache = (k: string) => k.startsWith('ppv2_assoc_leaves_v1:');
    const dropped = before.filter((k) => !isOwnerKey(k) && !isLedger(k) && !isSelfRotatingCache(k) && !after.includes(k));
    record(`[${path}] no other key removed`, dropped.length === 0, dropped.join(', ') || 'none');
    await app.shot('after-signout');
  } finally {
    await app.browser.close();
  }
}

for (const path of paths) {
  try {
    await runPath(path);
  } catch (err) {
    record(`[${path}] run`, false, String(err).slice(0, 300));
  }
}
console.log('\n==== summary ====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
