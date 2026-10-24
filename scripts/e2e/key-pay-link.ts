// @ts-nocheck
// Pack J-d: a key-only session opens a /pay link.
//   - "Pay via Wallet" is HIDDEN for key sessions (no wallet to pay from);
//   - "Pay via Private Transfer" stays available;
//   - the same link in a wallet session (as a non-seller) offers both.
// Form-level: nothing is paid.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/key-pay-link.ts
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, toHex } from 'viem';
import { APP_IDENTIFIER } from '@privacy-pools-v2/sdk';
import {
  openApp, signIn, tab, clickButton, bodyText, sleep, waitForText, fillByPlaceholder, unlockIfPrompted,
  requestPillSymbol,
  enterAmount,
} from './lib';
import { envValue, mintEphemeral, paymentRequestEth } from './funding';
import { encodeAccountKey } from '../../services/account-key';
import { decodePaymentRequestPayloadFromUrl } from '../../services/payment-request-codec';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const ownerKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const owner = privateKeyToAccount(ownerKey.startsWith('0x') ? ownerKey : `0x${ownerKey}`);
const { account: sellerAcct } = mintEphemeral();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

// ---- 1. an ephemeral SELLER creates an unsigned request -------------------
const seller = await openApp(sellerAcct, { tag: 'key-pay-seller' });
let payUrl: string | null = null;
try {
  await seller.page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(seller.page);
  if (!(await tab(seller.page, 'Request'))) throw new Error('Request tab never became active');
  const sellerSym = await requestPillSymbol(seller.page);
  if (sellerSym !== 'ETH') throw new Error(`request pill reads "${sellerSym}", expected ETH`);
  if (!(await enterAmount(seller.page, (envValue('E2E_REQUEST_ETH') ?? await paymentRequestEth())))) throw new Error('amount field not found');
  for (let attempt = 1; attempt <= 4 && !payUrl; attempt += 1) {
    await clickButton(seller.page, 'Create request');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !payUrl) {
      await unlockIfPrompted(seller.page);
      payUrl = await seller.page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
          const v = (el as HTMLInputElement).value || '';
          if (/https?:\/\/[^\s"']*\/pay#/.test(v)) return v.trim();
        }
        const m = (document.body?.innerText || '').match(/https?:\/\/[^\s"']*\/pay#[^\s"']*/);
        return m ? m[0] : null;
      });
      if (!payUrl) await sleep(2000);
    }
  }
  record('J-d seller created a pay link', !!payUrl, payUrl ? 'link created' : 'no /pay link');
} catch (e) {
  record('J-d seller created a pay link', false, `threw: ${(e as Error).message}`);
} finally {
  await seller.browser.close().catch(() => {});
}

if (payUrl) {
  // ---- 2. wallet session (owner, NOT the seller): both pay buttons ------------
  const wallet = await openApp(owner, { tag: 'key-pay-wallet' });
  try {
    await wallet.page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(6000);
    await signIn(wallet.page);
    await wallet.page.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(8000);
    await unlockIfPrompted(wallet.page);
    const b = await waitForText(wallet.page, /Pay via Private Transfer/i, 60_000) ?? await bodyText(wallet.page);
    const walletBtn = /Pay via Wallet/i.test(b);
    const privBtn = /Pay via Private Transfer/i.test(b);
    await wallet.shot('wallet-session');
    // "Pay via Wallet" exists only for legacy (v1/v2) requests; an SDK-native
    // request is private-transfer only BY DESIGN, so the control expectation
    // follows the payload kind rather than assuming both buttons.
    const encoded = payUrl.slice(payUrl.indexOf('/pay#') + 5).replace(/[?#].*$/, '');
    const kind = (() => { try { return decodePaymentRequestPayloadFromUrl(decodeURIComponent(encoded)).kind; } catch { return 'undecodable'; } })();
    const expectWallet = kind !== 'ppv2-sdk-payment-request';
    record('J-d wallet session offers the pay paths its request kind allows', privBtn && walletBtn === expectWallet,
      `kind ${kind}: private ${privBtn}, wallet ${walletBtn} (expected ${expectWallet})`);
  } catch (e) {
    record('J-d wallet session offers both pay paths', false, `threw: ${(e as Error).message}`);
  } finally {
    await wallet.browser.close().catch(() => {});
  }

  // ---- 3. key-only session: wallet pay hidden, private transfer available -------
  const addressHash = keccak256(toBytes(owner.address));
  const signature = await owner.signTypedData({
    domain: { name: 'Standardized Secret Derivation', version: '1', verifyingContract: '0x0000000000000000000000000000000000000000', salt: keccak256(toHex(APP_IDENTIFIER)) },
    types: { SecretDerivation: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
    primaryType: 'SecretDerivation',
    message: { purpose: 'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.', addressHash },
  });
  const accountKey = encodeAccountKey({ address: owner.address, signature });
  const harness = await openApp(owner, { tag: 'key-pay-harness' });
  const ctx = await harness.browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const p = await ctx.newPage();
  try {
    await harness.page.close().catch(() => {});
    await p.goto(`${BASE}/?connect=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(6000);
    if (!(await waitForText(p, /Pick how you want to connect/i, 30_000))) throw new Error('connect card never flipped');
    const box = await p.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0 && /sign in with an account key/i.test(n.textContent || ''));
      for (const el of els) { const r = (el as HTMLElement).getBoundingClientRect(); if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
      return null;
    });
    if (!box) throw new Error('reveal link not found');
    await p.mouse.move(box.x, box.y); await p.mouse.down(); await sleep(60); await p.mouse.up();
    await sleep(1500);
    const field = p.locator('textarea[placeholder*="account key"], input[placeholder*="account key"]').first();
    await field.click(); await field.fill(accountKey); await sleep(500);
    if (!(await clickButton(p, 'Sign In'))) throw new Error('Sign In not found');
    await sleep(6000);
    if (!/· key/i.test(await bodyText(p))) throw new Error('key badge missing');
    await p.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await sleep(8000);
    const kb = await waitForText(p, /Pay via Private Transfer/i, 60_000) ?? await bodyText(p);
    const walletBtn = /Pay via Wallet/i.test(kb);
    const privBtn = /Pay via Private Transfer/i.test(kb);
    await p.screenshot({ path: '.e2e-shots/key-pay-link-key-session.png' }).catch(() => {});
    record('J-d key session hides "Pay via Wallet"', !walletBtn, walletBtn ? 'Pay via Wallet is offered to a wallet-less session' : 'wallet pay hidden');
    record('J-d key session keeps "Pay via Private Transfer"', privBtn, privBtn ? 'private-transfer path available' : 'private-transfer button missing');
  } catch (e) {
    record('key-pay-link (key session)', false, `threw: ${(e as Error).message}`);
  } finally {
    await ctx.close().catch(() => {});
    await harness.browser.close().catch(() => {});
  }
}
console.log('\n===== key-pay-link summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
