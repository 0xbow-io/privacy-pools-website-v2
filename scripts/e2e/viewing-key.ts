// @ts-nocheck
// Sepolia e2e: the viewing-key overview (priority item 5, MVP).
//
// Header account menu -> Privacy & keys -> Viewing Key opens the Viewing key
// modal (its own since 2026-08-29; it used to be a section of the accounting
// export). Asserts: the public key shown
// is the one published on-chain for this wallet (Keystore.viewingKeys(owner)),
// the status reads "Published", the copy discipline is present (static, whole
// history, private key stays local), and no private key material is rendered
// (no 64-hex value other than the public key's short form appears in the text).
//
// Env: DEV_PK (A) or E2E_ACCOUNT_A_PK. A is registered on Sepolia.
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { accountFromKey, bodyText, clickButton, openApp, signIn, sleep, unlockIfPrompted, waitForText } from './lib';
import { envValue } from './funding';

const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
if (!aKey) throw new Error('need E2E_ACCOUNT_A_PK or DEV_PK');
const A = accountFromKey(aKey.startsWith('0x') ? aKey : `0x${aKey}`);
const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const KEYSTORE = (envValue('EXPO_PUBLIC_SEPOLIA_KEYSTORE_ADDRESS') ?? '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73') as `0x${string}`;

const results: { name: string; ok: boolean; detail: string }[] = [];
let failed = false;
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failed = true;
};

const client = createPublicClient({ chain: sepolia, transport: http(envValue('EXPO_PUBLIC_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com') });
const onChain = String(await client.readContract({
  address: KEYSTORE,
  abi: [{ name: 'viewingKeys', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bytes32' }] }],
  functionName: 'viewingKeys',
  args: [A.address],
})).toLowerCase();
console.log(`A: ${A.address}\non-chain viewing key: ${onChain}`);

const app = await openApp(A, { tag: 'viewkey' });
try {
  await app.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(app.page);
  // The overview needs the derived key: raise the unlock via a gated action.
  await clickButton(app.page, 'My balances');
  await sleep(1500);
  if (/Sign in to sync/i.test(await bodyText(app.page))) { await clickButton(app.page, 'Sign in'); await sleep(1500); }
  await unlockIfPrompted(app.page);
  const built = Date.now() + 120_000;
  while (Date.now() < built && !/session built/.test(app.appLogs.join('\n'))) await sleep(2000);

  // Header account menu (the address pill) -> Privacy & keys -> Viewing Key.
  // Header account pill renders truncateAddress(): 6 + "..." + 4, checksum case.
  const pill = `${A.address.slice(0, 6)}...${A.address.slice(-4)}`;
  let opened = await clickButton(app.page, pill);
  if (!opened) {
    // Fallback: any button whose text contains the address prefix.
    opened = await app.page.evaluate((prefix) => {
      const el = Array.from(document.querySelectorAll('[role="button"],button')).find((b) => (b.textContent || '').includes(prefix));
      if (!el) return false; (el as HTMLElement).click(); return true;
    }, A.address.slice(0, 6));
  }
  await sleep(800);
  const privacy = await clickButton(app.page, 'Privacy & keys');
  await sleep(600);
  const item = await clickButton(app.page, 'Viewing Key');
  record('menu path opens the overview', opened && privacy && item, `menu=${opened} privacy=${privacy} item=${item}`);

  const shown = await waitForText(app.page, /public viewing key/i, 20_000);
  const key = await app.page.getByTestId('viewing-key-public').innerText().catch(() => '');
  const fullFromLabel = ((await app.page.getByTestId('viewing-key-public').getAttribute('aria-label').catch(() => '')) ?? '').match(/0x[0-9a-fA-F]{64}/)?.[0]?.toLowerCase() ?? '';
  // The published-key read is an RPC round trip: wait for it to settle.
  let status = '';
  const statusDeadline = Date.now() + 30_000;
  while (Date.now() < statusDeadline) {
    status = (await app.page.getByTestId('viewing-key-status').innerText().catch(() => '')).trim();
    if (status && !/Checking the published key/i.test(status)) break;
    await sleep(1000);
  }
  await app.shot('viewing-key');
  const short = key.trim();
  const matches = fullFromLabel ? fullFromLabel === onChain : (onChain.startsWith(short.slice(0, 10).toLowerCase()) && onChain.endsWith(short.slice(-6).toLowerCase()));
  record('shows the on-chain published public key', !!shown && matches, `shown "${short}" full=${fullFromLabel ? 'exact match' : 'n/a'} vs on-chain ${onChain.slice(0, 12)}…${onChain.slice(-6)}`);
  record('status says published', /Published on-chain/i.test(status), status || 'no status text');

  const t = await app.page.getByTestId('viewing-key-overview').innerText();
  record('copy discipline present', /cannot rotate it today/i.test(t) && /past and future/i.test(t) && /shows only the public key/i.test(t) && !/auto-rotate|revoke/i.test(t),
    'static + whole-history + public-only wording present, no rotation/revocation promise');
  // No full 32-byte hex (a private key) is rendered anywhere in the section.
  const fullHexes = (t.match(/0x[0-9a-fA-F]{64}/g) ?? []).filter((h) => h.toLowerCase() !== onChain && h.toLowerCase() !== fullFromLabel);
  record('no private key material rendered', fullHexes.length === 0, fullHexes.length ? `unexpected 32-byte hex on screen: ${fullHexes[0].slice(0, 14)}…` : 'only the short public key form is shown');
} catch (e) {
  record('viewing-key', false, (e as Error).message);
} finally {
  await app.browser.close();
}

console.log('\n===== viewing-key summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
process.exit(failed ? 1 : 0);
