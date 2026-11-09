// @ts-nocheck
// Pack D-c: pay-side verification of a SIGNED payment request.
//
//   1. The payee creates a request with "Display your name" on: the wallet
//      signs it and the /pay link carries the signature.
//   2. A stranger opening the link sees the seller identity (name + verified
//      wallet), so they can check who they are paying.
//   3. A TAMPERED payload (same link, amount bumped, signature kept) must read
//      "Signature failed" with both pay buttons disabled.
//   4. A garbage payload must read "Invalid payment link".
//
// Form-level: nothing is paid, nothing moves. The paying itself is
// payment-request-unregistered.ts's job.
//
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap bun scripts/e2e/pay-verify.ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  openApp, signIn, tab, clickButton, unlockIfPrompted, bodyText, sleep, waitForText, fillByPlaceholder,
  requestPillSymbol,
  enterAmount,
} from './lib';
import { envValue, paymentRequestEth } from './funding';
import {
  decodePaymentRequestPayloadFromUrl,
  encodePaymentRequestPayloadForUrl,
} from '../../services/payment-request-codec';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const SELLER_NAME = 'E2E Verified Seller';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

// The payee signs, so it must be a funded-enough wallet session to build the
// session; the shared DEV account works and costs nothing here.
const payeeKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const payeeAcct = privateKeyToAccount(payeeKey.startsWith('0x') ? payeeKey : `0x${payeeKey}`);
// The verifier is a stranger: a fresh key with no history.
const strangerAcct = privateKeyToAccount(generatePrivateKey());

const payee = await openApp(payeeAcct, { tag: 'pay-verify-seller' });
const stranger = await openApp(strangerAcct, { tag: 'pay-verify-stranger' });
try {
  // ---- 1. create a SIGNED request -----------------------------------------
  await payee.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(payee.page);
  if (!(await tab(payee.page, 'Request'))) throw new Error('Request tab never became active');
  const paySym = await requestPillSymbol(payee.page);
  if (paySym !== 'ETH') throw new Error(`request pill reads "${paySym}", expected ETH`);
  if (!(await enterAmount(payee.page, (envValue('E2E_REQUEST_ETH') ?? await paymentRequestEth())))) throw new Error('amount field not found'); // over the request floor
  if (!(await clickButton(payee.page, 'Display your name'))) throw new Error('display-name toggle not found');
  await sleep(800);
  // The display-name input mounts next to the toggle once it is on.
  await fillByPlaceholder(payee.page, /name/i, SELLER_NAME).catch(() => {});
  let payUrl: string | null = null;
  for (let attempt = 1; attempt <= 4 && !payUrl; attempt += 1) {
    await clickButton(payee.page, 'Create request');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !payUrl) {
      await unlockIfPrompted(payee.page); // the signature prompt rides the same gate
      payUrl = await payee.page.evaluate(() => {
        // The success panel renders the link as a TextInput VALUE, which never
        // appears in innerText (cost one full red run to learn). Check inputs
        // first, body text as a fallback.
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
          const v = (el as HTMLInputElement).value || '';
          if (/https?:\/\/[^\s"']*\/pay#/.test(v)) return v.trim();
        }
        const text = document.body?.innerText || '';
        const m = text.match(/https?:\/\/[^\s"']*\/pay#[^\s"']*/);
        return m ? m[0] : null;
      });
      if (!payUrl) await sleep(2000);
    }
    if (!payUrl) {
      await payee.shot(`create-attempt-${attempt}`);
      const around = await payee.page.evaluate(() => {
        const t = document.body?.innerText || '';
        const i = t.indexOf('/pay#');
        return i === -1 ? `(no /pay/ substring; ${t.length} chars)` : t.slice(Math.max(0, i - 120), i + 160);
      });
      console.log(`  attempt ${attempt}: link not matched; context: ${around.replace(/\n/g, ' | ').slice(0, 300)}`);
    }
  }
  record('create signed request', !!payUrl, payUrl ? 'signed /pay link created' : 'no /pay link appeared');
  if (!payUrl) throw new Error('no pay link');

  const encoded = payUrl.slice(payUrl.indexOf('/pay#') + 5).replace(/[?#].*$/, '');
  const payload = decodePaymentRequestPayloadFromUrl(decodeURIComponent(encoded));
  const signed = 'signature' in payload && !!payload.signature;
  record('link carries the signature', signed, signed ? `signer ${payload.signature.signer}` : 'payload has no signature - toggle did not take');
  if (!signed) throw new Error('unsigned');

  // ---- 2. the stranger sees the seller identity ---------------------------
  await stranger.page.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  const namesSeller = !!(await waitForText(stranger.page, new RegExp(SELLER_NAME.replace(/ /g, '\\s+'), 'i'), 60_000));
  // The verified-wallet line renders only after the ASYNC signature check
  // resolves ('checking' -> 'valid'), later than the seller name - wait for it
  // separately. formatRequestCode renders exactly `first5...last4` (three
  // dots), so match that shape verbatim - an 8-hex fragment can never appear.
  const signer = payload.signature.signer;
  const shortCode = new RegExp(`${signer.slice(0, 5)}\\.{3}${signer.slice(-4)}`, 'i');
  const namesWallet = !!(await waitForText(stranger.page, shortCode, 45_000));
  await stranger.shot('valid-signed');
  record('stranger sees the seller identity', namesSeller && namesWallet,
    namesSeller && namesWallet
      ? `page shows "${SELLER_NAME}" and the verified wallet ${signer.slice(0, 5)}...${signer.slice(-4)}`
      : `seller shown: ${namesSeller}, wallet shown: ${namesWallet}`);

  // ---- 3. tampered payload: Signature failed + buttons disabled -----------
  const tampered = { ...payload, amount: `0x${(BigInt(payload.amount) + 1n).toString(16)}` };
  const tamperedUrl = `${BASE}/pay/${encodePaymentRequestPayloadForUrl(tampered)}`;
  await stranger.page.goto(tamperedUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  const failedShown = await waitForText(stranger.page, /Signature failed/i, 60_000);
  const disabled = await stranger.page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*')).filter((el) =>
      el.children.length === 0 && /Pay via (Private Transfer|Wallet)/.test(el.textContent || ''));
    if (nodes.length === 0) return { found: 0, disabled: 0 };
    let off = 0;
    for (const n of nodes) {
      let el = n;
      for (let d = 0; d < 6 && el; d++) {
        const aria = el.getAttribute?.('aria-disabled');
        const op = el instanceof HTMLElement ? Number(getComputedStyle(el).opacity) : 1;
        if (aria === 'true' || op < 0.6) { off += 1; break; }
        el = el.parentElement;
      }
    }
    return { found: nodes.length, disabled: off };
  });
  await stranger.shot('tampered');
  const tamperOk = !!failedShown && disabled.found > 0 && disabled.disabled === disabled.found;
  record('tampered payload refused', tamperOk,
    tamperOk
      ? `"Signature failed" shown and all ${disabled.found} pay button(s) disabled`
      : `failed-copy=${!!failedShown}, buttons found=${disabled.found}, disabled=${disabled.disabled}`);

  // ---- 4. garbage payload: Invalid payment link ---------------------------
  await stranger.page.goto(`${BASE}/pay/AAAAAAAAAAAA`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  const invalid = await waitForText(stranger.page, /Invalid payment link/i, 30_000);
  await stranger.shot('garbage');
  record('garbage payload refused', !!invalid,
    invalid ? '"Invalid payment link" shown, no pay controls' : 'the invalid-link copy never rendered');
} catch (e) {
  record('pay-verify', false, `threw: ${(e as Error).message}`);
} finally {
  await payee.browser.close().catch(() => {});
  await stranger.browser.close().catch(() => {});
}

console.log('\n===== pay-verify summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
