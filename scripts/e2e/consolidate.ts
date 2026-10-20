// @ts-nocheck
// A dedicated recoverable account creates MIN_CONSOLIDATION_INPUTS (2) or more notes in ONE lineage, then
// consolidates them through the UI. Existing treasury dust is not a fixture.
import { fixtureBarrier } from './fixture-barrier';
import { waitForApproval } from './approval-wait';
import assert from 'node:assert/strict';
import { formatEther, keccak256, parseEther, stringToBytes } from 'viem';
import { MIN_CONSOLIDATION_INPUTS, consolidationCandidates } from '../../services/consolidate-notes';
import {
  accountFromKey, accountNotes, awaitNativeDeposit, clickButton, enterAmount, fillRecipient, forceUnlock, openApp,
  publicClient, registerKeystoreIfPrompted, waitForInitialDiscovery, waitForApprovedDeposit, selectToken, signIn, sleep, submit,
  tab, waitForDepositHash, waitForText,
} from './lib';
import { envValue, fundAccount } from './funding';

const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
if (!key) throw new Error('E2E_ACCOUNT_A_PK or DEV_PK is required');
const funder = accountFromKey(key);
const account = accountFromKey(keccak256(stringToBytes(`0x${key.replace(/^0x/, '')}:consolidation-e2e-v1`)));
const client = publicClient();
const balance = await client.getBalance({ address: account.address });
if (balance < parseEther('0.007')) await fundAccount(funder, account.address, formatEther(parseEther('0.01') - balance));
console.log(`consolidation account: ${account.address} (derived from funder; retained between runs)`);
const app = await openApp(account, { tag: 'consolidate' });
const { page } = app;

const notes = () => accountNotes(page, account.address);
// The app offers a lineage from MIN_CONSOLIDATION_INPUTS (2) notes. Since
// 87b0fa6c a private send also spends every other note of the deposits it
// draws from, so a self-transfer leaves exactly two notes in its lineage (the
// recipient note and the change) and three can no longer be built through the
// app: run 37783830307 sent two self-transfers, each spent 2 inputs, and the
// old "three notes" wait timed out.
const candidate = async () => consolidationCandidates(await notes()).find(c => c.notes.length >= MIN_CONSOLIDATION_INPUTS);
async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean, message: string) {
  const until = Date.now() + 480_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await sleep(3000);
  } while (Date.now() < until);
  throw new Error(message);
}
async function confirmTransfer() {
  assert.ok(await submit(page, ['Review transfer']), 'transfer review is actionable');
  assert.ok(await waitForText(page, /Confirm transfer/i, 60_000), 'review appears');
  assert.ok(await clickButton(page, 'Confirm transfer'), 'confirm is actionable');
  const terminal = await waitForText(page, /Transfer Successful|Transfer failed|Transfer outcome unknown|too small to cover|would not submit/i, 900_000);
  assert.match(terminal ?? '', /Transfer Successful/i, 'self-transfer must succeed');
  // The success panel has had no Done button since the hub redesign: the hub's
  // tabs are the exit, and the next step navigates by tab. Dismiss it when a
  // Done exists, otherwise carry on; the pass criterion is the text above and
  // the spent-inputs check that follows, not the dismissal.
  if (!(await clickButton(page, 'Done'))) await page.keyboard.press('Escape').catch(() => {});
}
try {
  await signIn(page);
  await forceUnlock(page);
  await waitForInitialDiscovery(page, account.address);
  // Finish retained setup before deciding whether another deposit is needed.
  await waitForApproval('Retained consolidation notes', async () => (await notes()).every(n => n.status !== 'PENDING'));
  let hash: string | null = null;
  if (!(await candidate())) {
    // Two self-transfers need fee room; 0.004 is a bounded fixture deposit, not
    // a change to the 0.001 cap on the ordinary journey's user actions.
    await tab(page, 'Shield');
    await selectToken(page, 'Shield');
    await enterAmount(page, '0.004', 'Shield');
    const from = app.appLogs.length;
    await submit(page, ['Shield ETH']);
    await registerKeystoreIfPrompted(page);
    hash = await waitForDepositHash(app.appLogs, 300_000, from);
    assert.ok(hash, 'fixture deposit broadcasts');
    assert.equal(await awaitNativeDeposit(hash, '0.004', account.address), 'success');
  }
  await tab(page, 'Send');
  await selectToken(page, 'Send');
  await fixtureBarrier(async () => {
    if (hash) await waitForApprovedDeposit(page, account.address, hash);
    await waitForApproval('Consolidation notes', async () => (await notes()).every(n => n.status !== 'PENDING'));
  });
  if (!(await candidate())) {
    for (let i = 0; i < 2; i++) {
      await tab(page, 'Send');
      await selectToken(page, 'Send');
      await fillRecipient(page, account.address, 'Send');
      await enterAmount(page, '0.0005', 'Send');
      await confirmTransfer();
    }
  }
  const expected = await poll(candidate, Boolean, `${MIN_CONSOLIDATION_INPUTS} approved notes of one lineage were not discovered`);
  const before = (await notes()).filter(n => n.status === 'ACTIVE').length;
  if (new URL(page.url()).searchParams.get('panel') !== 'balances') await page.getByTestId('home-door-mine').click();
  const link = page.locator('[data-testid^="consolidate-"]:visible').first();
  await link.waitFor();
  assert.equal(await link.innerText(), 'Consolidate notes');
  const logFrom = app.appLogs.length;
  await link.click();
  await page.getByTestId('consolidation-select').waitFor();
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), expected.notes.length);
  await page.getByTestId('consolidation-review').click();
  await page.getByTestId('consolidation-confirmation').waitFor();
  await page.getByTestId('consolidation-confirm').click();
  const terminal = await waitForText(page, /Notes consolidated|Consolidation complete|Transfer failed|Consolidation outcome unknown|must be worth more|would not submit/i, 900_000);
  assert.match(terminal ?? '', /Notes consolidated|Consolidation complete/i);
  await clickButton(page, 'Done');
  const prepared = app.appLogs.slice(logFrom).join('\n').match(/Preparing transact \{"inputCommitments":\[([^\]]*)\]/);
  const used = prepared?.[1].match(/0x[0-9a-fA-F]{64}/g) ?? [];
  assert.deepEqual(used.map(v => v.toLowerCase()).sort(), expected.notes.map(n => n.commitment.toLowerCase()).sort(), 'exact pinned inputs');
  await poll(notes, ns => expected.notes.every(n => ns.some(x => x.commitment === n.commitment && x.status === 'SPENT'))
    && ns.filter(n => n.status === 'ACTIVE').length < before, 'pinned inputs must be spent and live note count must shrink');
  console.log('PASS: consolidation confirmed, exact pinned inputs spent, live note count decreased');
  await app.shot('consolidated');
} catch (error) {
  await app.shot('failed').catch(() => {});
  throw error;
} finally { await app.browser.close(); }
