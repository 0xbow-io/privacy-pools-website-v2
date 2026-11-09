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
import { check, connect, finish, hold, hubTab, isShareRateRead, launch, open, sleep, unlockWithWallet } from './harness.ts';

// The two flows this PR owns, plus anything they raise. The rest of the page
// (other tabs) is guarded by their own smokes.
const SCOPE = [
  '[data-testid="hub-page-send"]:not([aria-hidden="true"])',
  '[data-testid="hub-page-request"]:not([aria-hidden="true"])',
  '[role="dialog"]', '[role="alert"]', '[role="status"]',
].join(', ');

// Yield-share token addresses on Ethereum (config/prod-deployments.ts), and the
// decimals their amounts are in.
const SHARE_TOKENS = [
  { coin: 'USDC', token: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6' },
  { coin: 'ETH', token: '0x66051920D25af4E3596A8a46309F4D045F9D83B7' },
];
const hex32 = () => `0x${randomBytes(32).toString('hex')}`;
function receiptLink(token: string): string {
  const payload = {
    kind: 'ppv2-payment-receipt',
    version: 1,
    requestId: randomBytes(16).toString('hex'),
    chainId: 1,
    recipientAddress: `0x${randomBytes(20).toString('hex')}`,
    tokenId: token,
    amount: `0x${(5n * 10n ** 18n).toString(16)}`,
    noteAddressHash: hex32(),
    commitment: hex32(),
    label: hex32(),
    txHash: hex32(),
    createdAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

async function typeAmount(page, key: string, value: string) {
  const field = page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]) [data-testid="hub-amount-input"]`).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value).catch(() => {});
  await sleep(1500);
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
  await typeAmount(page, 'request', '5');
  await req.guardStep('request, rate loading, amount typed');

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
  await req.guardStep('request created, rate loading');
  check(rate.held() > 0, 'requester: the share-rate reads were held', `${rate.held()} held`);
  rate.release();
  await sleep(8000);
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
const payer = await launch('pay-claim');
try {
  const { page } = payer;
  const rate = await hold(page, isShareRateRead);
  if (payLink) {
    await open(page, payPath(payLink));
    check(await connect(page), 'payer: the read-only wallet connects');
    await sleep(6000);
    check(/5(\.0+)?\s*USDC|USDC/.test(await payer.text()), 'payer: the pay page names the coin');
    await payer.guardStep('pay link, rate loading');
  }
  for (const { coin, token } of SHARE_TOKENS) {
    await open(page, `/receive/${receiptLink(token)}`);
    await sleep(6000);
    const text = await payer.text();
    check(new RegExp(`\\b${coin}\\b`).test(text), `claim link (${coin} share): the page names the coin`);
    await payer.guardStep(`claim link (${coin} share), rate loading`);
  }
  check(rate.held() > 0, 'payer: the share-rate reads were held', `${rate.held()} held`);
  rate.release();
  if (payLink) {
    await open(page, payPath(payLink));
    await sleep(8000);
    await payer.guardStep('pay link, rate loaded');
  }
  for (const { coin, token } of SHARE_TOKENS) {
    await open(page, `/receive/${receiptLink(token)}`);
    await sleep(8000);
    await payer.guardStep(`claim link (${coin} share), rate loaded`);
  }
  await payer.shot('claim');
  check(payer.refusedSends.length === 0, 'payer: nothing asked the wallet to send', payer.refusedSends.join(', '));
} catch (e) {
  check(false, 'payer: the smoke ran to the end', String(e).slice(0, 300));
}
await finish('send, request and claim links', payer.browser);
