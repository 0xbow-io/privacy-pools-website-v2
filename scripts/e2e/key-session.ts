// @ts-nocheck
// Pack J-a / A-f: an ACCOUNT-KEY session (no wallet).
//
// The account key is the EIP-712 secret-derivation signature, base64-JSON
// wrapped (services/account-key.ts). Derived here offline exactly as the export
// modal would, so no wallet ever connects in this run.
//   - balances visible after signing in with the key
//   - the relayed flows (Withdraw, Send, Request) render their forms
//   - Shield (a deposit needs a wallet tx) is refused with specific copy
// Form-level: nothing moves.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/key-session.ts
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex } from 'viem';
import { APP_IDENTIFIER } from '@privacy-pools-v2/sdk';
import { openApp, tab, clickButton, bodyText, sleep, waitForText, fillByPlaceholder, waitForShieldedBalance, enterAmount, submitOrPast, cardError } from './lib';
import { envValue } from './funding';
import { encodeAccountKey } from '../../services/account-key';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const owner = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

// The same typed data the app signs at export time.
const addressHash = keccak256(toBytes(owner.address));
const signature = await owner.signTypedData({
  domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)) },
  types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'SecretDerivation',
  message: { purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.', addressHash },
});
const accountKey = encodeAccountKey({ address: owner.address, signature });

// openApp injects the headless wallet and the app auto-reconnects it, which
// un-flips the connect card (`wantsFlip` requires !isConnected) - a key
// session must start in a browser with NO wallet at all. So: open the harness
// browser for its plumbing, then run the whole leg in a fresh, shim-less
// context.
const harness = await openApp(owner, { tag: 'key-session-harness' });
const ctx = await harness.browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();
let shotN = 0;
const app = {
  page,
  browser: harness.browser,
  shot: async (name: string) => { shotN += 1; await page.screenshot({ path: `.e2e-shots/key-session-${shotN}-${name}.png` }).catch(() => {}); },
};
try {
  await harness.page.close().catch(() => {});
  await app.page.goto(`${BASE}/?connect=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const flipped = await waitForText(app.page, /Pick how you want to connect/i, 30_000);
  if (!flipped) throw new Error('connect card never flipped');
  // The key input sits behind a reveal link on the flipped face.
  await app.shot('flipped-face');
  const face = await bodyText(app.page);
  console.log(`  flipped face excerpt: ${face.slice(face.indexOf('Connect a wallet'), face.indexOf('Connect a wallet') + 400).replace(/\n/g, ' | ')}`);
  let revealed = await clickButton(app.page, 'Or sign in with an account key (no wallet)');
  if (!revealed) {
    // clickButton matches whole controls; the link is a Pressable around a
    // Text, and a synthesized DOM click on the Text does not fire RNW's
    // responder. Press it with the real mouse at its box instead.
    const box = await app.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find((n) => n.children.length === 0 && /sign in with an account key/i.test(n.textContent || ''));
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (box) {
      await app.page.mouse.move(box.x, box.y);
      await app.page.mouse.down();
      await sleep(60);
      await app.page.mouse.up();
      revealed = true;
    }
  }
  if (!revealed) throw new Error('account-key reveal link not found');
  await sleep(1500);
  await app.shot('after-reveal');
  await sleep(1200);
  // The key field is a multiline TextInput, which RNW renders as a <textarea>;
  // the shared fillByPlaceholder helper only looks at <input>. Fill it directly.
  const field = app.page.locator('textarea[placeholder*="account key"], input[placeholder*="account key"]').first();
  if (!(await field.isVisible().catch(() => false))) throw new Error('account-key input not found');
  await field.click();
  await field.fill(accountKey);
  await sleep(500);
  if (!(await clickButton(app.page, 'Sign In'))) throw new Error('Sign In button not found');
  await sleep(6000);
  await app.shot('signed-in');
  // A key carries no chain, so a wallet-less session defaults to Ethereum
  // mainnet - correct for production, but the fixture's notes live on Sepolia.
  // The pool page hosts the same hub scoped to its chain.
  const keyBadge = /· key/i.test(await bodyText(app.page));
  record('J-a key sign-in establishes a key-mode session', keyBadge, keyBadge ? 'header shows the address with the key badge' : 'no key-mode badge in the header');
  await app.page.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  await app.shot('sepolia-pool-key-mode');

  // ---- balances visible ----------------------------------------------------
  const spendable = await waitForShieldedBalance(app.page, 12);
  record('J-a key session shows balances', spendable > 0, spendable > 0 ? `${spendable} ETH shielded visible without a wallet` : 'no shielded balance rendered');

  // ---- relayed flows render their forms --------------------------------------
  // The shared tab() helper confirms a switch by a card marker that assumes a
  // wallet session (e.g. the swap-exit "Receive on … as" card), so press the
  // tab with the real mouse and look for each form's own signals instead.
  const pressText = async (label: string) => {
    const box = await app.page.evaluate((want) => {
      // Several nodes can carry the label (hidden pager copy, the tab itself);
      // take the first one that is actually laid out on screen.
      const els = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0 && (n.textContent || '').trim() === want);
      for (const el of els) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, label);
    if (!box) return false;
    await app.page.mouse.move(box.x, box.y);
    await app.page.mouse.down();
    await sleep(60);
    await app.page.mouse.up();
    return true;
  };
  const formCheck = async (label: string, signal: RegExp, name: string) => {
    const pressed = await pressText(label);
    const seen = pressed ? await waitForText(app.page, signal, 25_000) : null;
    await app.shot(`tab-${label.toLowerCase()}`);
    if (!seen) {
      const b = await bodyText(app.page);
      const i = b.indexOf(label);
      console.log(`  ${label} tab: pressed=${pressed}; excerpt: ${b.slice(Math.max(0, i), i + 260).replace(/\n/g, ' | ')}`);
    }
    record(name, !!seen, seen ? `${label} form rendered for the key session` : `${label} form signal (${signal.source}) not found`);
  };
  // Key-mode forms are the compact variants (no recipient field or exact-amount
  // toggle until an amount is typed), so the signals are their own first lines.
  await formCheck('Withdraw', /Exit to any address with a private proof|Shielded balance/i, 'J-a Withdraw form available to a key session');
  await formCheck('Send', /Hide my wallet|Amount to send|Review transfer|Recipient receives|Send privately/i, 'J-a Send form available to a key session');
  await formCheck('Request', /Create Request|Display your name|Get paid without an address|Share a link, get paid privately/i, 'J-a Request form available to a key session');

  // ---- Shield refused: a deposit needs a wallet tx, so pressing the CTA in a
  // key session hands the user to the connect card (the intended refusal),
  // or names the owner wallet in copy. Either is specific; the header's bare
  // "Connect Wallet" button is not and must never satisfy this.
  const shieldTab = await tab(app.page, 'Shield');
  let refusal: string | null = null;
  if (shieldTab) {
    await enterAmount(app.page, '0.0001', 'Shield').catch(() => false);
    await sleep(1500);
    // In a key session the CTA now names the requirement ("Connect a wallet to
    // shield ETH") instead of the onboarding wording, which is the state this
    // script drives. The older labels stay listed so the press still lands if
    // the session happens to have a wallet attached.
    await submitOrPast(app.page, ['Connect a wallet to shield ETH', 'Get Started Shielding ETH', 'Shield ETH', 'Shield']).catch(() => 'stuck');
    // NOT a bare /Connect a wallet to/: the key-session Shield CTA itself now
    // reads "Connect a wallet to shield ETH", so that fragment would be
    // satisfied by the BUTTON and this would pass without any refusal at all.
    // Match the refusal sentences in full instead.
    const REFUSAL = /Pick how you want to connect|account key's keystore|owner wallet|Connect a wallet to shield from another network|sign in with an account key first/i;
    const said = await waitForText(app.page, REFUSAL, 20_000);
    const m = said?.match(new RegExp(`[^\\n]*(${REFUSAL.source})[^\\n]*`, 'i'));
    refusal = m ? m[0] : null;
  }
  await app.shot('shield-refusal');
  const refused = !!refusal && refusal.trim().length > 20;
  record('J-a Shield (deposit) refused in a key session', refused,
    refused ? `handed to: "${refusal!.trim().slice(0, 120)}"` : 'no refusal: neither the connect card nor owner-wallet copy appeared');
} catch (e) {
  record('key-session', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== key-session summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
