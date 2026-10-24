// @ts-nocheck - Bun runtime script, same conventions as payment-request.ts.
//
// Mike's 2026-08-25 scenario, end to end, with a FRESH unregistered payee
// every run:
//
//   a brand-new key (no keystore registration, no funds) creates a payment
//   request  ->  B pays it from the shared /pay/ link  ->  the payer's screen
//   shows an EXPLICIT, PERSISTENT success (not a bare reset)  ->  the payee
//   discovers the payment after reload and sync (request flips to FULFILLED).
//
// Why this exists: an unregistered payee's request is SDK-native
// (ppv2-sdk-payment-request) - the note is encrypted to a per-request key the
// payee's device already holds, so there IS no receipt link, by design. Mike
// paid one, watched the output clear, and reasonably read the silence as a
// reset that had eaten his receiving link. The product fix makes the success
// state explicit; this phase pins both halves: the payer-side message and the
// payee-side discovery after reload and sync.
//
// Funds: the payment (PAY_ETH) lands in notes owned by the throwaway payee
// key, and for an SDK-native request the note secrets live ONLY in the payee
// browser context's storage - they are random, NOT derivable from the wallet
// key (codex caught the first version of this script claiming otherwise). So
// before teardown the payee's payment-request/note state is EXPORTED to the
// run log: key + exported state together make the payment recoverable by
// hand (restore storage, register, withdraw). Without the export, closing
// the context would strand the payment permanently.
import {
  accountFromKey, bodyText, clickButton, openApp,
  signIn, sleep, tab, unlockIfPrompted, enterAmount,
  waitForText,
  requestPillSymbol,
  payPrivateRequest, ensurePaymentFunding, selectToken, openTransactionDetail, accountNotes,
  installSavePickerStub, savedBackups,
} from './lib';
import { envValue, mintEphemeral, paymentRequestEth } from './funding';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { decodePaymentRequestPayloadFromUrl } from '../../services/payment-request-codec';

const PAY_ETH = process.argv[2] || envValue('E2E_REQUEST_ETH') || await paymentRequestEth(); // over the request floor, priced as the app does
const payerKey = process.env.E2E_PAYER_PK ?? process.env.DEV_PK2;
if (!payerKey) throw new Error('E2E_PAYER_PK (or DEV_PK2) must be set: it pays the request');

const { privateKey: payeeKey, account: payeeAcct } = mintEphemeral();
console.log(`fresh UNREGISTERED payee: ${payeeAcct.address}`);
console.log(`payee key (needed together with the state export below): E2E_PK=${payeeKey}`);

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`\n>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}\n`);
};

const readLink = (page, marker: string) => page.evaluate((m) => {
  const fromInputs = Array.from(document.querySelectorAll('input'))
    .map((i) => i.value || '')
    .find((v) => v.includes(m));
  if (fromInputs) return fromInputs;
  const text = document.body?.innerText || '';
  const match = text.match(new RegExp(`https?://[^\\s"']*${m.replace(/\//g, '\\/')}[^\\s"']*`));
  return match ? match[0] : null;
}, marker);

const payee = await openApp(payeeAcct, { tag: 'unreg-payee' });
// "Download backup" saves through the File System Access dialog (DEV-497),
// which headless Chromium cannot click; the stub saves into page memory.
await installSavePickerStub(payee.page);
const payer = await openApp(accountFromKey(payerKey), { tag: 'unreg-payer' });
let failed = false;
let paymentHash: string | undefined;
try {
  // ---- The unregistered payee creates a request ------------------------------
  await payee.page.goto(process.env.PROBE_URL || 'http://localhost:8081', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(payee.page);
  // No session priming: pressing Create on a locked virgin session must
  // itself raise the SeedDerivationModal (DEV-383 - it used to hang at
  // "Creating..." forever instead). The unlock check riding the poll below
  // clicks that modal's Sign; this phase therefore also guards the DEV-383
  // fix on the exact persona that hit it: a broke, unregistered payee.
  if (!(await tab(payee.page, 'Request'))) throw new Error('Request tab never became active for the payee');
  await selectToken(payee.page, 'Request');
  const reqSym = await requestPillSymbol(payee.page);
  if (reqSym !== 'ETH') throw new Error(`request pill reads "${reqSym}", expected ETH`);
  if (!(await enterAmount(payee.page, PAY_ETH))) throw new Error('request amount field not found');
  await sleep(1500);
  // Creating derives session keys on a virgin account: the first press raises
  // the signature gate; clear it and press again if the link has not appeared.
  let payUrl: string | null = null;
  for (let attempt = 1; attempt <= 4 && !payUrl; attempt += 1) {
    await clickButton(payee.page, 'Create request');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !payUrl) {
      // The signature gate appears SECONDS after the press on a virgin
      // account (the session bootstrap has to start first), so the unlock
      // check must ride the poll - a single early check missed it and the
      // modal then covered the button for every retry (run 3).
      await unlockIfPrompted(payee.page);
      const backup = payee.page.getByTestId('unregistered-download');
      if (await backup.isVisible()) {
        await backup.click();
        let written = await savedBackups(payee.page);
        for (let i = 0; i < 90 && written.files.length === 0; i += 1) {
          await unlockIfPrompted(payee.page);
          await sleep(1000);
          written = await savedBackups(payee.page);
        }
        assert.ok(written.files.length > 0, 'the backup was written through the save dialog');
        const path = `.e2e-shots/unregistered-${payeeAcct.address}.json`;
        writeFileSync(path, written.files[0].text, { mode: 0o600 });
        chmodSync(path, 0o600);
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(saved.kind, 'ppv2-payment-request-backup');
        // The writer has been at version 2 since 6b8f63e3 (session requests
        // travel with the SDK records); the reader still accepts 1.
        assert.equal(saved.version, 2);
        assert.ok(saved.chains?.['11155111'], 'backup includes Sepolia recovery state');
        record('unregistered backup', true, `download saved to ${path}`);
      }
      payUrl = await readLink(payee.page, '/pay#');
      if (!payUrl) await sleep(2000);
    }
  }
  await payee.shot('unreg-request-created');
  record('create request (unregistered)', !!payUrl, payUrl ? `link ${payUrl}` : 'no /pay/ link appeared');
  if (!payUrl) throw new Error('no pay link');
  const shared = decodePaymentRequestPayloadFromUrl(payUrl.split('/pay#')[1]);
  assert.equal(shared.recipientAddress, undefined, 'unsigned request keeps the payee private');

  // ---- B pays it via private transfer ----------------------------------------
  await payer.page.goto(process.env.PROBE_URL || 'http://localhost:8081', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(payer.page);
  await ensurePaymentFunding(payer.page, payer.appLogs, accountFromKey(payerKey).address, PAY_ETH);
  await payer.page.goto(payUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await payer.page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 120_000 });
  await sleep(8000);
  await unlockIfPrompted(payer.page);
  await payer.shot('unreg-pay-opened');

  await payPrivateRequest(payer.page, payer.appLogs);
  await payer.shot('unreg-pay-after');
  record('pay request (to unregistered)', true, `paid ${PAY_ETH} ETH`);

  // ---- THE MIKE ASSERTION: explicit, persistent success on the payer --------
  // An SDK-native payment has no receipt link BY DESIGN. What must never
  // happen again is the payer staring at a screen that looks like a reset.
  // The success message has to (a) exist, (b) say the recipient discovers the
  // note automatically, and (c) still be there ten seconds later.
  const successRe = /discover the note automatically|No receipt link is needed/i;
  const t1 = await bodyText(payer.page);
  const shownNow = successRe.test(t1);
  await sleep(10_000);
  const t2 = await bodyText(payer.page);
  const shownStill = successRe.test(t2);
  await payer.shot('unreg-pay-success-visible');
  record('payer success message', shownNow && shownStill,
    shownNow && shownStill
      ? 'auto-discovery success message shown and still visible 10s later'
      : `shownNow=${shownNow} still=${shownStill} - the payer screen reads as a reset (Mike's bug)`);
  if (!(shownNow && shownStill)) failed = true;

  // Terminal means TERMINAL: the Pay controls must not come back to life
  // (a re-enabled button reads as a reset and invites paying twice), and an
  // SDK-native payment must not offer any recovery link - there is none.
  const terminal = await payer.page.evaluate(() => {
    const t = document.body?.innerText || '';
    const leaves = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0);
    return {
      payCta: leaves.some((n) => /^Pay via (Private Transfer|Wallet)$/.test((n.textContent || '').trim())),
      bogusLink: /\/receive[/#]|\/import-note[/#]/.test(t),
    };
  });
  record('terminal paid state', !terminal.payCta && !terminal.bogusLink,
    !terminal.payCta && !terminal.bogusLink
      ? 'Pay controls are gone and no phantom recovery link is offered'
      : `payCta=${terminal.payCta} bogusLink=${terminal.bogusLink}`);
  if (terminal.payCta || terminal.bogusLink) failed = true;

  // ---- THE ACCOUNTING ASSERTIONS: the payer can find what he paid ----------
  // Mike, 2026-08-26: "I am missing 0.01 ETH, I think I paid it through a
  // payment request but it's not in my history." It WAS in his history — as a
  // reconstructed row with "?" for the counterparty, which reads as someone
  // else's transaction — and the pool page's own counters said "Transfers 0"
  // while the table listed three. Both are asserted here, on the payer, so
  // neither can come back.
  {
    // Assert on the POOL PAGE, which is where the transactions table lives: the
    // home surface renders no table at all, so asserting there reported a
    // missing row while the same run's counter — read on the pool page — had
    // counted it. Navigating also forces a fresh load, so the row comes from
    // persisted state and reconstruction exactly as it would on a later visit.
    await payer.page.goto(`${process.env.PROBE_URL || 'http://localhost:8081'}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await payer.page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 120_000 });
    await unlockIfPrompted(payer.page);
    await sleep(6000);
    if (/Sign in to sync/i.test(await bodyText(payer.page))) {
      await payer.page.getByRole('button', { name: 'Sync full activity', exact: true }).click();
      await sleep(2000);
      await unlockIfPrompted(payer.page);
    }
    // Give discovery/reconstruction time to rebuild the outgoing row.
    let rowText: string | null = null;
    const until = Date.now() + 300_000;
    while (Date.now() < until) {
      const body = (await bodyText(payer.page)).toLowerCase();
      if (body.includes('transfer out')) {
        rowText = body;
        break;
      }
      await sleep(5000);
    }
    await payer.shot('unreg-payer-history');
    const hasRow = !!rowText;
    record('payer history has the payment', hasRow,
      hasRow ? 'a Transfer Out row for the payment is present' : 'no Transfer Out row within 5 min (the payment would look missing)');
    if (!hasRow) failed = true;
    // Unsigned SDK requests are deliberately double-blind: their paid
    // record and history must not invent or disclose the recipient address.
    const paid = await payer.page.evaluate(() => JSON.parse(localStorage.getItem('ppv2_paid_requests_v1') || '[]').at(-1));
    paymentHash = paid?.txHash;
    const privatePayee = paid?.requestKind === 'sdk' && paid.recipient === '';
    record('payment preserves payee privacy', privatePayee, 'unsigned SDK request retains an undisclosed recipient');
    if (!privatePayee) failed = true;
    // And the pool page's own counter must agree with the table it sits above.
    // Already on that page from the row assertion above.
    let counted = false;
    const countUntil = Date.now() + 180_000;
    while (Date.now() < countUntil) {
      // "Transfers" sits above its figure in the stat strip.
      const n = await payer.page.evaluate(() => {
        const leaves = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0);
        const idx = leaves.findIndex((el) => (el.textContent || '').trim() === 'Transfers');
        if (idx === -1) return null;
        for (const el of leaves.slice(idx + 1, idx + 4)) {
          const m = (el.textContent || '').trim().match(/^\d+$/);
          if (m) return Number(m[0]);
        }
        return null;
      });
      if (typeof n === 'number' && n > 0) { counted = true; break; }
      await sleep(5000);
    }
    await payer.shot('unreg-payer-pool-counters');
    record('pool page counts the transfer', counted,
      counted
        ? 'the Transfers counter agrees with the table'
        : 'the Transfers counter still reads 0 while the table lists the payment (Mike\'s bug)');
    if (!counted) failed = true;

    // The relayer fee the payer paid. Paying a request leaves no
    // sent-transfers stamp, so the row's direction comes from the
    // paid-requests record; if that precedence breaks, the payment reads as
    // "Transfer In" and the fee rows disappear with it. That is the whole
    // reason a payer's history could not be summed to their balance.
    const feeRow = await payer.page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem('ppv2_withdraw_fees_v1') || '[]');
      if (!Array.isArray(rows)) return null;
      const hit = rows.find((r: { kind?: string }) => r?.kind === 'transfer');
      return hit ?? null;
    });
    let feeWei = 0n;
    try { feeWei = BigInt(feeRow?.feeAmount ?? '0'); } catch { feeWei = 0n; }
    record('payment stamps its relayer fee', feeWei > 0n,
      feeWei > 0n
        ? `paid-request fee of ${Number(feeWei) / 1e18} ETH stamped for ${feeRow.txHash}`
        : 'the payment stamped no relayer fee, so the payer cannot reconcile their history');
    if (feeWei <= 0n) failed = true;
    if (feeWei > 0n) {
      // …and it has to be VISIBLE on the payer's own row, opened by deep link.
      await openTransactionDetail(payer.page, feeRow.txHash);
      let panel = '';
      const feeUntil = Date.now() + 240_000;
      while (Date.now() < feeUntil) {
        panel = (await bodyText(payer.page)).toLowerCase();
        if (panel.includes('relayer fee')) break;
        await sleep(5000);
      }
      await payer.shot('unreg-payer-fee-detail');
      const head = String(feeRow.txHash).slice(0, 8).toLowerCase();
      const tail = String(feeRow.txHash).slice(-6).toLowerCase();
      const shown = panel.includes('relayer fee') && panel.includes('total spent')
        && panel.includes(head) && panel.includes(tail);
      record('payment shows the fee in its detail', shown,
        shown
          ? 'the payment\'s row detail names the relayer fee and the total spent'
          : 'the payment\'s row detail does not show the relayer fee (a paid request reads as an incoming transfer)');
      if (!shown) failed = true;
    }
  }

  // Reload the persisted request and explicitly unlock the visible balances
  // panel. Hidden hero text is not evidence that the panel is open or syncing.
  const ensureBalancesOpen = async () => {
    if (new URL(payee.page.url()).searchParams.get('panel') !== 'balances') {
      await payee.page.getByTestId('home-door-mine').click();
    }
  };
  await payee.page.goto(`${process.env.PROBE_URL || 'http://localhost:8081'}/?panel=balances`, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await unlockIfPrompted(payee.page);
  const syncBalances = payee.page.getByRole('button', { name: 'Sync balances', exact: true }).filter({ visible: true }).first();
  if (await syncBalances.isVisible()) await syncBalances.click();
  await unlockIfPrompted(payee.page);
  let fulfilled = false;
  const deadline = Date.now() + 720_000;
  while (Date.now() < deadline && !fulfilled) {
    const paymentNote = (await accountNotes(payee.page, payeeAcct.address)).find(n =>
      n.txHash?.toLowerCase() === paymentHash?.toLowerCase() && BigInt(n.value) === parseEther(PAY_ETH));
    fulfilled = !!paymentNote && await payee.page.evaluate(({ owner, id, commitment }) => {
      const state = JSON.parse(localStorage.getItem(`v1:payment-request-state:11155111:${owner.toLowerCase()}`) ?? '{}');
      const request = state.requests?.find(r => r.paymentId.toLowerCase() === id.toLowerCase());
      return request?.status === 'FULFILLED' && request.fulfilledByCommitments.some(c => c.toLowerCase() === commitment.toLowerCase());
    }, { owner: payeeAcct.address, id: shared.paymentId, commitment: paymentNote.commitment });
    if (!fulfilled) await sleep(5000);
  }
  await payee.shot('unreg-payee-discovery');
  record('payee discovery after reload and sync', fulfilled, fulfilled
    ? 'persisted request is FULFILLED and the payee owns the exact payment note'
    : 'request or owned payment note did not reconcile within 12 minutes');
  if (!fulfilled) failed = true;

  // ---- Claim: the unregistered payee is told what to do next -----------------
  // The callout must lead to registration. Open it without submitting.
  let claimSeen = false;
  let claimModal = false;
  if (fulfilled) {
    const claimDeadline = Date.now() + 180_000;
    while (Date.now() < claimDeadline && !claimSeen) {
      await ensureBalancesOpen();
      const callout = payee.page.getByTestId('claim-callout');
      if (await callout.isVisible() && /Register.*spend/i.test(await callout.innerText())) { claimSeen = true; break; }
      await sleep(5000);
    }
    if (claimSeen) {
      await payee.page.getByTestId('claim-callout').getByRole('button', { name: 'Claim', exact: true }).click();
      claimModal = !!(await waitForText(payee.page, /Claim your funds/i, 20_000));
      await payee.shot('unreg-payee-claim');
      await payee.page.keyboard.press('Escape').catch(() => {});
      await sleep(800);
      await clickButton(payee.page, 'Not now').catch(() => false);
    }
  }
  record('claim affordance (unregistered payee)', claimSeen && claimModal,
    !claimSeen ? 'My balances never offered Claim for the received funds'
      : !claimModal ? 'Claim did not open the registration modal'
      : 'Claim callout shown and opens the registration modal');
  if (!(claimSeen && claimModal)) failed = true;
} catch (e) {
  record('payment request (unregistered payee)', false, (e as Error).message);
  failed = true;
  await payee.shot('unreg-threw').catch(() => {});
  await payer.shot('unreg-threw').catch(() => {});
} finally {
  // Export the payee's payment-request/note state BEFORE the context dies.
  // For SDK-native requests this storage holds the ONLY copy of the note
  // secrets (random, not key-derived), so without this dump every run's
  // payment would be stranded the moment the browser closes.
  try {
    const stateDump = await payee.page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/payment-request-state|account|note/i.test(k)) out[k] = localStorage.getItem(k) ?? '';
      }
      return out;
    });
    console.log(`PAYEE STATE EXPORT (recovery = restore these localStorage keys + the payee key above):`);
    console.log(JSON.stringify(stateDump));
  } catch (dumpErr) {
    console.log(`payee state export FAILED: ${(dumpErr as Error).message} - this run's payment may be unrecoverable`);
  }
  await payee.browser.close();
  await payer.browser.close();
}

console.log('\n===== payment-request-unregistered summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);
