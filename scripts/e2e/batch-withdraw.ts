// @ts-nocheck
// SEEDS approved ETH deposits (one proof each), multiple proofs, one confirmed batch withdrawal.
// Three by default to keep the fixture cheap; a plain withdrawal spends one
// deposit's notes only, so three still needs a batch. Six work too
// (E2E_BATCH_SEEDS=6): when the proofs outlast the 60 s relayer quote the app
// now splits the batch itself (services/batch-withdrawals.ts).
// Each run has a fresh fixture, recoverable from A and its logged fixture ID.
import { fixtureBarrier } from './fixture-barrier';
import { waitForApproval } from './approval-wait';
import assert from 'node:assert/strict';
import { formatEther, keccak256, parseEther, stringToBytes } from 'viem';
import { randomUUID } from 'node:crypto';
import {
  accountNotes, acknowledgeFullWithdrawal, awaitNativeDeposit, clickButton,
  enterAmount, fillRecipient, forceUnlock, waitForInitialDiscovery, openApp, publicClient, registerKeystoreIfPrompted,
  selectToken, signIn, sleep, submit, tab, waitForDepositHash, waitForText,
} from './lib';
import { accountFromKey, envValue, fundAccount, sweepTo } from './funding';

const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
if (!key) throw new Error('E2E_ACCOUNT_A_PK or DEV_PK is required');
const normalized = `0x${key.replace(/^0x/, '')}`;
const funder = accountFromKey(normalized);
const SEEDS = Number(envValue('E2E_BATCH_SEEDS') ?? 3);
const fixtureId = envValue('E2E_BATCH_FIXTURE_ID') ?? randomUUID();
const account = accountFromKey(keccak256(stringToBytes(`${normalized}:ppv2-batch-e2e:${fixtureId}`)));
console.log(`batch fixture ID: ${fixtureId} (retain with account A for recovery)`);
const client = publicClient();
const have = await client.getBalance({ address: account.address });
if (have < parseEther('0.007')) await fundAccount(funder, account.address, formatEther(parseEther('0.009') - have));
console.log(`batch account: ${account.address} (derived from funder)`);
const app = await openApp(account, { tag: 'batch' });
const { page } = app;
const eth = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const liveNotes = async () => (await accountNotes(page, account.address))
  .filter(n => n.tokenId?.toLowerCase() === eth && ['ACTIVE', 'PENDING'].includes(n.status) && BigInt(n.value) > 0n);

try {
  await signIn(page);
  await forceUnlock(page);
  await waitForInitialDiscovery(page, account.address);
  await tab(page, 'Shield');
  await selectToken(page, 'Shield');
  // Existing pending seeds count too: approval lag must not cause over-seeding.
  const existing = (await liveNotes()).length;
  // A resumed older fixture (E2E_BATCH_FIXTURE_ID) can hold more deposits than
  // fit one quote window; Max would batch them all and expire every attempt.
  assert.ok(existing <= SEEDS, `fixture holds ${existing} deposits, more than E2E_BATCH_SEEDS=${SEEDS}; raise it or use a new fixture ID`);
  for (let i = existing; i < SEEDS; i++) {
    await tab(page, 'Shield');
    await selectToken(page, 'Shield');
    await enterAmount(page, '0.001', 'Shield');
    const from = app.appLogs.length;
    assert.ok(await submit(page, ['Shield ETH']), 'seed deposit is actionable');
    await registerKeystoreIfPrompted(page);
    const hash = await waitForDepositHash(app.appLogs, 300_000, from);
    assert.ok(hash, `seed ${i + 1} broadcasts`);
    assert.equal(await awaitNativeDeposit(hash, '0.001', account.address), 'success');
    console.log(`seed ${i + 1}/${SEEDS} confirmed`);
  }
  await tab(page, 'Withdraw');
  await selectToken(page, 'Withdraw');
  let approved = [];
  // Two approved deposits already need a batch. api-dev has left one of three
  // seeds pending for 45+ minutes in two runs (37829645991, 37836361646) while
  // every other seed cleared in minutes, so after 15 minutes the batch goes
  // with what is approved: a pending note is not ACTIVE, so it is not batched.
  const waitStarted = Date.now();
  let reportedPending = false;
  await fixtureBarrier(() => waitForApproval(
    () => `Batch fixture (${approved.length}/${SEEDS} notes approved)`, async () => {
      const live = await liveNotes();
      approved = live.filter(n => n.status === 'ACTIVE');
      if (approved.length >= SEEDS) return true;
      if (approved.length < 2 || Date.now() - waitStarted < 15 * 60_000) return false;
      if (!reportedPending) {
        reportedPending = true;
        console.log(`batch fixture: going with ${approved.length} approved; still pending at the ASP: ${live.filter(n => n.status === 'PENDING').map(n => n.label).join(', ')}`);
      }
      return true;
    },
  ));
  await tab(page, 'Withdraw');
  await selectToken(page, 'Withdraw');
  const before = await client.getBalance({ address: funder.address });
  await fillRecipient(page, funder.address, 'Withdraw');
  const form = page.locator('[data-testid="hub-page-withdraw"]:not([aria-hidden="true"])');
  await form.getByRole('button', { name: /^Shielded balance\s/ }).click();
  assert.ok(Number(await form.locator('input[placeholder="0.0"], input[placeholder="0"]').inputValue()) > 0, 'Max fills the exact balance');
  await acknowledgeFullWithdrawal(page);
  let succeeded = false;
  for (let attempt = 0; attempt < 3 && !succeeded; attempt++) {
    const from = app.appLogs.length;
    // After Try Again the old failure screen can still be up for a moment, and
    // its "Withdrawal failed" would end this attempt before it started.
    for (let i = 0; i < 30 && /Withdrawal failed/i.test(await page.locator('body').innerText()); i++) await sleep(1000);
    assert.ok(await submit(page, ['Withdraw']), 'batch review is actionable');
    assert.ok(await waitForText(page, /Confirm Withdrawal/i, 120_000), 'batch review appears');
    const quote = app.appLogs.slice(from).join('\n').match(/Batch quote received.*?groups: (\d+)/);
    assert.ok(quote && Number(quote[1]) >= 2, 'review quotes multiple proof groups');
    assert.ok(await clickButton(page, 'Confirm Withdrawal'), 'batch confirmation is actionable');
    const until = Date.now() + 1_200_000;
    while (true) {
      if (Date.now() >= until) throw new Error('Batch outcome is unknown after 20 minutes; refusing to submit again');
      const logs = app.appLogs.slice(from).join('\n');
      // A fresh quote is the user-visible recovery from a changed fee ceiling.
      if (/Batch changed between review and confirm/.test(logs)) break;
      const text = await page.locator('body').innerText();
      if (/Withdrawal Successful|Withdrawal complete/i.test(text)) { succeeded = true; break; }
      if (/Withdrawal failed|transaction reverted|FeeCommitmentExpired/i.test(text + logs)) throw new Error('batch withdrawal failed');
      await sleep(3000);
    }
  }
  assert.ok(succeeded, 'batch must confirm; relayer failures are not soft passes');
  const after = await client.getBalance({ address: funder.address });
  assert.ok(after > before, 'batch pays the funder');
  assert.ok(app.appLogs.some(l => /Submitting batch withdrawal/.test(l)), 'used the batch submission path');
  console.log(`PASS: ${approved.length} notes batched; funder received ${formatEther(after - before)} ETH`);
  await app.shot('confirmed');
  await sweepTo(account, funder.address);
} catch (error) {
  await app.shot('failed').catch(() => {});
  throw error;
} finally { await app.browser.close(); }
