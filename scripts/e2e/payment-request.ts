// @ts-nocheck - drives a real browser with real playwright types; playwright is a
// local dev tool here, not a declared dependency, so the repo type-checks these
// scripts against a fallback stub (see scripts/visual/playwright-fallback.d.ts).
//
// Payment requests, end to end, across TWO accounts on Sepolia:
//
//   A creates a request  ->  B pays it from the shared link  ->  A discovers the note
//
//   bun run e2e:request            # the whole round trip
//   bun run e2e:request 0.0006      # with an amount
//
// Separate browser contexts keep account storage isolated. The payer receives
// only the shared /pay/ link; the payee discovers the resulting note itself.
import { fixtureBarrier } from './fixture-barrier';
import { envValue, paymentRequestEth } from './funding';
import { parseEther } from 'viem';
import {
  account, accountFromKey, openApp, signIn, tab, enterAmount, clickButton,
  unlockIfPrompted, sleep,
  requestPillSymbol,
  payPrivateRequest, ensurePaymentFunding, selectToken, accountNotes,
} from './lib';

const amount = process.argv[2] || envValue('E2E_REQUEST_ETH') || await paymentRequestEth(); // over the request floor, priced as the app does
// CI passes the two fixed accounts as raw keys (GitHub secrets); locally the
// named .env accounts are used.
const PAYEE = (process.env.E2E_PAYEE as 'DEV_PK' | 'DEV_PK2' | 'TEST_PHRASE') || 'DEV_PK';
const PAYER = (process.env.E2E_PAYER as 'DEV_PK' | 'DEV_PK2' | 'TEST_PHRASE') || 'DEV_PK2';
const payeeAccount = () => (process.env.E2E_PAYEE_PK
  ? accountFromKey(process.env.E2E_PAYEE_PK)
  : account(PAYEE));
const payerAccount = () => (process.env.E2E_PAYER_PK
  ? accountFromKey(process.env.E2E_PAYER_PK)
  : account(PAYER));

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`\n>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}\n`);
};

/** Poll for a link: waiting on card TEXT is unreliable, since "Total" is already
 *  on screen ("Total sent amount") and matched instantly, so the first read
 *  happened before the link had rendered. */
async function waitForLink(
  page: Awaited<ReturnType<typeof openApp>>['page'],
  marker: string,
  timeoutMs = 90_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await readLink(page, marker);
    if (found) return found;
    await sleep(2000);
  }
  return null;
}

/** Read a share/receipt link out of the card, which is where the user copies it from. */
const readLink = async (page: Awaited<ReturnType<typeof openApp>>['page'], marker: string) => page.evaluate((m) => {
  const fromInputs = Array.from(document.querySelectorAll('input'))
    .map((i) => (i as HTMLInputElement).value)
    .find((v) => v && v.includes(m));
  if (fromInputs) return fromInputs;
  const text = document.body.innerText || '';
  const hit = text.match(new RegExp(`https?://\\\\S*${m}\\\\S+`));
  return hit ? hit[0] : null;
}, marker);

console.log(`payee=${payeeAccount().address}`);
console.log(`payer=${payerAccount().address}`);
console.log(`amount=${amount} ETH`);

const payee = await openApp(payeeAccount(), { tag: 'req-payee' });
const payer = await openApp(payerAccount(), { tag: 'req-payer' });
// The pay step stalled after "Submitting transfer via SDK relayer" with no error
// and no transaction, which the app's own logs cannot explain: the call it is
// waiting on is an HTTP request. Report the payer's relayer traffic so a stall
// says whether the request was answered, refused or never returned.
const pending = new Map<string, number>();
payer.page.on('request', (req) => {
  if (!/relayer/i.test(req.url())) return;
  pending.set(req.url(), Date.now());
  console.log(`  -> ${req.method()} ${req.url()}`);
});
payer.page.on('response', async (res) => {
  if (!/relayer/i.test(res.url())) return;
  const started = pending.get(res.url());
  const took = started ? `${Date.now() - started}ms` : '?';
  let body = '';
  body = ` body=${(await res.text().catch(() => '')).slice(0, 400)}`;
  pending.delete(res.url());
  console.log(`  <- ${res.status()} ${res.url()} (${took})${body}`);
});
payer.page.on('requestfailed', (req) => {
  if (!/relayer/i.test(req.url())) return;
  pending.delete(req.url());
  console.log(`  !! FAILED ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`);
});
payer.page.on('console', (msg) => {
  if (msg.type() === 'error') console.log(`  [console.error] ${msg.text().slice(0, 300)}`);
});
let payUrl: string | null = null;

try {
  await signIn(payer.page);
  await ensurePaymentFunding(payer.page, payer.appLogs, payerAccount().address, amount,
    process.argv.includes('--prepare-next-payment') ? 2 : 1, fixtureBarrier);
  // ---- A creates the request -------------------------------------------------
  await signIn(payee.page);
  if (!(await tab(payee.page, 'Request'))) {
    record('create request', false, 'Request tab never became active');
  } else {
    // The request card names its amount field after the asset ("0.01 ETH"), not "0".
    await selectToken(payee.page, 'Request');
    const requestSym = await requestPillSymbol(payee.page);
    if (requestSym !== 'ETH') throw new Error(`request pill reads "${requestSym}", expected ETH`);
    const amountFilled = await enterAmount(payee.page, amount);
    console.log('request amount filled:', amountFilled);
    if (!amountFilled) {
      record('create request', false, 'amount field not found on the request card');
    } else {
      await sleep(1500);
      if (!(await clickButton(payee.page, 'Create request'))) {
        record('create request', false, 'Create request not pressable');
      } else {
        payUrl = await waitForLink(payee.page, '/pay#');
        await payee.shot('request-created');
        record('create request', !!payUrl, payUrl ? `link ${payUrl}` : 'no /pay/ link appeared on the card');
      }
    }
  }

  // ---- B pays it -------------------------------------------------------------
  if (payUrl) {
    await payer.page.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await payer.page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 120_000 });
    await sleep(8000);
    await unlockIfPrompted(payer.page);
    await sleep(4000);
    await payer.shot('pay-opened');

    await payPrivateRequest(payer.page, payer.appLogs);
    await payer.shot('pay-after');
    record('pay request', true, `paid ${amount} ETH`);
  } else {
    record('pay request', false, 'skipped: no link to pay');
  }

  // Explicit user refresh discovers the payment. Assert ownership of THIS payment's
  // exact note, not a balance increase from an unrelated pending deposit.
  if (results.find((r) => r.name === 'pay request')?.ok) {
    const paid = await payer.page.evaluate(() => JSON.parse(localStorage.getItem('ppv2_paid_requests_v1') || '[]').at(-1));
    if (!paid?.txHash || paid.recipient.toLowerCase() !== payeeAccount().address.toLowerCase()
      || BigInt(paid.rawAmount) !== parseEther(amount)) throw new Error('payment record does not match this request');
    await tab(payee.page, 'Send');
    await selectToken(payee.page, 'Send');
    await payee.page.getByRole('button', { name: 'Refresh balances and activity', exact: true }).filter({ visible: true }).first().click();
    let received = false;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !received) {
      received = (await accountNotes(payee.page, payeeAccount().address)).some(n =>
        n.txHash?.toLowerCase() === paid.txHash.toLowerCase() && BigInt(n.value) === parseEther(amount));
      if (!received) await sleep(3000);
    }
    await payee.shot('received');
    record('discover payment after refresh', received, received ? 'payee owns the exact payment note' : 'payment note not discovered within 300s');
  } else {
    record('discover payment after refresh', false, 'skipped: the payment did not go through');
  }
} catch (e: unknown) {
  record('payment request', false, `threw: ${(e as Error).message}`);
  await payee.shot('threw').catch(() => {});
  await payer.shot('threw').catch(() => {});
} finally {
  await payee.browser.close();
  await payer.browser.close();
}

console.log('=== SUMMARY ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (payUrl) console.log(`pay link:     ${payUrl}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
