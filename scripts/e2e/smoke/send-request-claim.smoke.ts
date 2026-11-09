// @ts-nocheck - drives a real browser with real playwright types.
//
// No share name on the Send, Request and claim-link screens, before the share
// rate has loaded and after:
//
//  1. Requester: the Send and Request tabs, with an amount typed, then a real
//     payment request created through the unregistered path (backup download,
//     no transaction), and the request card it leaves, (i) hints hovered.
//  2. Payer: the pay link from step 1 opened in a second browser with another
//     fresh wallet.
//  3. Claim links (/receive/...) for a USDC and an ETH yield-share note. These
//     are built here: a receipt is a plain JSON payload, and the page renders
//     it before anything is imported or claimed.
//
// Prod world, read-only wallets (./harness.ts): nothing is ever sent, and the
// backup "download" goes to an in-page stub.
import { randomBytes } from 'node:crypto';
import { formatUnits } from 'viem';
import { decodePaymentRequestPayloadFromUrl } from '../../../services/payment-request-codec.ts';
import {
  amountLines, amountShown, check, connect, expectedUnderlyingLabel, finish, hold, hubTab, isShareRateRead, launch, open,
  sleep, trackShareRates, unlockWithWallet, within,
} from './harness.ts';

// The two flows this PR owns, plus anything they raise. The rest of the page
// (other tabs) is guarded by their own smokes.
const SCOPE = [
  '[data-testid="hub-page-send"]:not([aria-hidden="true"])',
  '[data-testid="hub-page-request"]:not([aria-hidden="true"])',
  '[role="dialog"]', '[role="alert"]', '[role="status"]',
].join(', ');

// Yield-share token addresses on Ethereum (config/prod-deployments.ts), and the
// decimals their amounts are in.
const SHARE_DECIMALS = 18;
const SHARE_TOKENS = [
  { coin: 'USDC', token: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', decimals: 6, stable: true },
  { coin: 'ETH', token: '0x66051920D25af4E3596A8a46309F4D045F9D83B7', decimals: 18, stable: false },
];
const shareToken = (address: string) => SHARE_TOKENS.find((t) => t.token.toLowerCase() === address.toLowerCase());
const RECEIPT_SHARES = 5n * 10n ** 18n;

/**
 * The line the app must print for `shares` of a share token, from the rate the
 * page itself received (undefined until one arrived): the underlying value, with
 * the coin's own decimals and never the share count under the coin's name.
 */
function expectedFor(rates: ReturnType<typeof trackShareRates>, tokenAddress: string, shares: bigint): string | undefined {
  const t = shareToken(tokenAddress);
  const rate = t && rates.rateOf(t.token);
  return t && rate ? expectedUnderlyingLabel(shares, rate, SHARE_DECIMALS, { symbol: t.coin, decimals: t.decimals, stable: t.stable }) : undefined;
}
/** What a raw share count would read as if it were printed under the coin's name. */
const countLabel = (tokenAddress: string, shares: bigint) => `${formatUnits(shares, SHARE_DECIMALS)} ${shareToken(tokenAddress)?.coin}`;
const hex32 = () => `0x${randomBytes(32).toString('hex')}`;
function receiptLink(token: string): string {
  const payload = {
    kind: 'ppv2-payment-receipt',
    version: 1,
    requestId: randomBytes(16).toString('hex'),
    chainId: 1,
    recipientAddress: `0x${randomBytes(20).toString('hex')}`,
    tokenId: token,
    amount: `0x${RECEIPT_SHARES.toString(16)}`,
    noteAddressHash: hex32(),
    commitment: hex32(),
    label: hex32(),
    txHash: hex32(),
    createdAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

// Strict: a field that never shows, a fill that throws, or a field that does not
// end up holding the typed figure fails the smoke (the throw is caught by the
// section's try/catch and recorded as a failed check).
async function typeAmount(page, key: string, value: string) {
  const field = page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]) [data-testid="hub-amount-input"]`).first();
  await field.waitFor({ state: 'visible', timeout: 30_000 });
  await field.fill(value);
  let held = '';
  for (let i = 0; i < 20; i++) {
    held = await field.inputValue();
    if (Number(held.replace(/,/g, '')) === Number(value)) break;
    await sleep(250);
  }
  const ok = check(held !== '' && Number(held.replace(/,/g, '')) === Number(value), `${key}: the amount field holds the typed ${value}`, JSON.stringify(held));
  if (!ok) throw new Error(`${key}: the amount field holds ${JSON.stringify(held)}, not ${value}`);
}

// The app's pay link is /pay#<payload> (older ones /pay/<payload>): the path
// AND the fragment are the request, so keep both and drop the origin.
const payPath = (link: string) => { const u = new URL(link); return `${u.pathname}${u.hash}`; };

// ---------------------------------------------------------------- 1. requester
let payLink = '';
const req = await launch('send-request', { guardScope: SCOPE });
try {
  const { page } = req;
  await page.addInitScript(() => {
    // The backup "download": a save-picker stub, so nothing touches the disk.
    (window as any).showSaveFilePicker = async () => ({
      async createWritable() { return { async write() {}, async close() { (window as any).__backupSaved = true; } }; },
    });
  });
  const rates = trackShareRates(page);
  const rate = await hold(page, isShareRateRead);
  await open(page, '/?action=send');
  check(await connect(page), 'requester: the read-only wallet connects');
  await sleep(3000);

  check(await hubTab(page, 'send'), 'requester: the Send tab opens');
  await req.guardStep('send, rate loading');
  await typeAmount(page, 'send', '5');
  await req.guardStep('send, rate loading, amount typed');

  check(await hubTab(page, 'request'), 'requester: the Request tab opens');
  const chip = ((await page.locator('[data-testid="hub-page-request"]:not([aria-hidden="true"]) [data-testid="hub-request-token"]').first().innerText().catch(() => '')) ?? '').match(/[A-Za-z0-9]+/g)?.join(' ') ?? '';
  check(chip === 'USDC', 'requester: the Request chip names the coin', JSON.stringify(chip));
  await req.guardStep('request, rate loading');
  // The Request amount is an amount of the COIN: the app converts it to shares at
  // creation from the share rate. With the rate held the field waits (shimmer, no
  // input to type a figure into), so nothing can be converted or sent without it.
  const requestFace = '[data-testid="hub-page-request"]:not([aria-hidden="true"])';
  check(
    await page.locator(`${requestFace} [data-testid="hub-amount-loading"]`).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false),
    'requester: the Request amount waits for the rate (shimmer)',
  );
  check((await page.locator(`${requestFace} [data-testid="hub-amount-input"]`).count()) === 0, 'requester: no amount field to type into before the rate');
  check(rate.held() > 0, 'requester: the share-rate reads were held', `${rate.held()} held`);
  rate.release();
  // Wait for the rate answer itself, not a fixed time: the "rate loaded" steps
  // must run after the page has the rate.
  for (let i = 0; i < 120 && rates.seen() === 0; i++) await sleep(500);
  check(rates.seen() > 0, 'requester: the page received a share rate', `${rates.seen()} vault(s)`);
  await req.guardStep('request, rate loaded');
  await typeAmount(page, 'request', '5');
  await req.guardStep('request, rate loaded, amount typed');

  await page.locator('[data-testid="hub-page-request"]:not([aria-hidden="true"])').getByText('Create Request', { exact: true }).last().click();
  await sleep(3000);
  await unlockWithWallet(page);
  const backup = page.getByText('Download backup', { exact: true }).last();
  await backup.waitFor({ timeout: 60_000 }).catch(() => {});
  await req.guardStep('request, register-or-backup choice');
  await backup.click().catch(() => {});
  for (let i = 0; i < 60 && !payLink; i++) {
    await sleep(1000);
    payLink = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('input,textarea,*'))) {
        const v = (el as HTMLInputElement).value || (el.children.length === 0 ? el.textContent : '') || '';
        const m = /https?:\/\/[^\s]+\/pay[#\/][A-Za-z0-9_.-]+/.exec(v);
        if (m) return m[0];
      }
      return '';
    });
  }
  check(!!payLink, 'requester: an unregistered request gives a pay link, with no transaction');
  // The link keeps the shares converted from the typed 5 USDC (rounded up), so
  // they are worth 5.00 USDC at the rate, not 5 shares' worth (5.02 at 1.0042).
  if (payLink) {
    const u = new URL(payLink);
    const asked: any = decodePaymentRequestPayloadFromUrl(u.hash.slice(1) || u.pathname.split('/').pop()!);
    const worth = expectedFor(rates, String(asked.tokenId), BigInt(asked.amount));
    check(worth === '5.00 USDC', 'requester: the 5 USDC typed is what the link is worth (shares converted at the rate)', `link worth ${worth ?? 'no rate seen'}, ${BigInt(asked.amount)} base units`);
  }
  await req.guardStep('request created, rate loaded');
  await hubTab(page, 'send');
  await req.guardStep('send, rate loaded, amount typed');
  await req.shot('request');
  check(req.refusedSends.length === 0, 'requester: nothing asked the wallet to send', req.refusedSends.join(', '));
} catch (e) {
  check(false, 'requester: the smoke ran to the end', String(e).slice(0, 300));
}
await req.browser.close().catch(() => {});

// ---------------------------------------------------------------- 2. payer + 3. claim links
// The pay page and the claim page each print the amount as a whole line twice
// (the item and the Total). Before the rate: never the share count under the
// coin's name. After it: the underlying value from the rate the page received,
// 2 decimals for a stablecoin, rounded down.
const payer = await launch('pay-claim');
try {
  const { page } = payer;
  const rates = trackShareRates(page);
  const rate = await hold(page, isShareRateRead);
  // The link's own amount and token, read with the app's decoder.
  const requested = payLink ? (() => {
    const u = new URL(payLink);
    const decoded: any = decodePaymentRequestPayloadFromUrl(u.hash.slice(1) || u.pathname.split('/').pop()!);
    return { token: String(decoded.tokenId), shares: BigInt(decoded.amount) };
  })() : null;
  const pages = [
    ...(payLink && requested ? [{ name: 'pay link', path: payPath(payLink), ...requested, coin: shareToken(requested.token)?.coin }] : []),
    ...SHARE_TOKENS.map((t) => ({ name: `claim link (${t.coin} share)`, path: '', token: t.token, shares: RECEIPT_SHARES, coin: t.coin })),
  ];
  if (payLink && requested) check(!!shareToken(requested.token), 'payer: the pay link names a known yield-share token', requested.token);
  // `waitMs` bounds the wait for an amount line: while the rate is held the page
  // may print the loading figure as a shimmer (no text at all), so that wait is
  // short; after the release the line is real and the wait is the full minute.
  const openPage = async (p: (typeof pages)[number], waitMs: number) => {
    await open(page, p.path || `/receive/${receiptLink(p.token)}`);
    // An amount line is on screen: the page rendered the figure (or its loading form).
    for (let i = 0; i < waitMs / 500 && amountLines(await payer.text()).length === 0; i++) await sleep(500);
  };
  for (const p of pages) {
    await within(`payer: ${p.name}, rate held`, 150_000, async () => {
      await openPage(p, 15_000);
      if (p.name === 'pay link') check(await connect(page), 'payer: the read-only wallet connects');
      const lines = amountLines(await payer.text());
      check(!lines.includes(countLabel(p.token, p.shares)), `${p.name}: before the rate, no share count under the coin's name`, lines.join(' | '));
      await payer.guardStep(`${p.name}, rate loading`);
    });
  }
  check(rate.held() > 0, 'payer: the share-rate reads were held', `${rate.held()} held`);
  // Reads parked for the pages already left are dropped on release (see hold):
  // only the page on screen asks again, so its own rate read is not queued
  // behind a burst of stale ones.
  rate.release();
  for (const p of pages) {
    await within(`payer: ${p.name}, rate released`, 180_000, async () => {
      await openPage(p, 60_000);
      const shown = await amountShown(page, () => expectedFor(rates, p.token, p.shares));
      const want = expectedFor(rates, p.token, p.shares);
      check(shown.ok, `${p.name}: the amount is the underlying value at the rate the page received`, `want ${want ?? 'no rate seen'}, page printed ${shown.lines.join(' | ') || 'no amount'}`);
      await payer.guardStep(`${p.name}, rate loaded`);
    });
  }
  await payer.shot('claim');
  check(payer.refusedSends.length === 0, 'payer: nothing asked the wallet to send', payer.refusedSends.join(', '));
} catch (e) {
  check(false, 'payer: the smoke ran to the end', String(e).slice(0, 300));
}
await finish('send, request and claim links', payer.browser);
