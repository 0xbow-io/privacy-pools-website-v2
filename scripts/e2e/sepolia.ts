// @ts-nocheck - drives a real browser with real playwright types; playwright is a
// local dev tool here, not a declared dependency, so the repo type-checks these
// scripts against a fallback stub (see scripts/visual/playwright-fallback.d.ts).
// On-chain Sepolia e2e through the real UI: shield, withdraw, send.
//
//   safewrap env PROBE_URL=http://localhost:8080 bun scripts/e2e/sepolia.ts all
//   ... probe | shield [amt] | withdraw [amt] | send [amt] | send-disclosed [amt] | send-exact [amt] | send-max-cap
//
// Signing and broadcasting go through the EIP-6963 headless wallet in
// scripts/visual/evm-wallet.ts with { liveSend: true }: no MetaMask, no popups,
// real transactions from the .env accounts.
//
// `all` is the canonical run, and it is ONE browser session on purpose. The
// keystore-unlock gate is raised by the first ACTION, not at page load, so a
// phase started in its own fresh context can never unlock, finds no notes, and
// reports a 0 shielded balance. Shielding first unlocks the session and creates
// the note that withdraw and send then spend, which is also the journey a real
// user takes.
import {
  account, openApp, signIn, tab, enterAmount, clickButton, submit, unlockIfPrompted, forceUnlock,
  acknowledgeFullWithdrawal,
  waitForShieldedBalance, waitForDepositHash, waitForText, fillRecipient,
  registerKeystoreIfPrompted, submitOrPast,
  cardError, bodyText, publicClient, reportBalance, sleep, env, BASE,
  selectToken, awaitNativeDeposit, openTransactionDetail, accountNotes, waitForApprovedDeposit, waitForInitialDiscovery,
} from './lib';
import { fixtureBarrier } from './fixture-barrier';
import { DISCOVERY_GRID, PRICE_GRID, phaseShift } from './window-phase';
import { collectJourneySecrets, resolveHosts, runNetworkPrivacyGate, reportJourneyPrivacy, type TimingWindow } from './privacy-gate';
import { recordPublicState } from './public-state-fixture.mjs';
import type { Page } from 'playwright';
import { parseEther } from 'viem';
import { ACTIVE_ENVIRONMENT } from '../../config/environments';

type Phase = 'probe' | 'privacy' | 'shield' | 'withdraw' | 'send' | 'send-disclosed' | 'send-exact' | 'send-max-cap' | 'ragequit' | 'all';
const phase = (process.argv[2] || 'all') as Phase;
/**
 * Nothing this suite moves may exceed this, per the product owner: no shield, no
 * withdrawal and no send. Enforced here rather than at the call sites so no
 * caller, env override or future phase can quietly ask for more. A run that
 * needs more shielded value repeats a capped deposit instead of growing one.
 */
const MAX_ETH = 0.001;
/**
 * What a relayed spend asks for, leaving fee room inside its capped note.
 *
 * The relayer fee is paid out of the note being spent, and it is not small next
 * to the cap. Measured twice: 0.000713 locally, and 0.000612 in the first real CI
 * run (2026-08-21) — against a 0.0006 spend. That is amount + fee = 0.001212,
 * which no capped 0.001 note can pay, and the withdrawal duly never got past
 * "confirm pressed". The fee tracks gas, so this figure is chosen to survive one
 * of that size rather than to be as large as possible; E2E_SPEND_ETH overrides it
 * if a run ever reports insufficient value anyway.
 */
const SPEND_ETH = process.env.E2E_SPEND_ETH ?? '0.0002';
function capped(value: string, what: string): string {
  if (Number(value) <= MAX_ETH) return value;
  console.log(`  ${what} ${value} exceeds the ${MAX_ETH} ETH cap, using ${MAX_ETH}`);
  return String(MAX_ETH);
}
const amount = process.argv[3] || '';
const WHICH = (process.env.E2E_ACCOUNT as 'DEV_PK' | 'DEV_PK2' | 'TEST_PHRASE') || 'DEV_PK';

const acct = account(WHICH);
// Where withdrawals and private sends go. CI points this at the mother account,
// so everything the run shielded comes back out to the funder.
const other = (process.env.E2E_COUNTERPARTY as `0x${string}` | undefined)
  ?? account(WHICH === 'DEV_PK' ? 'DEV_PK2' : 'DEV_PK').address;
const client = publicClient();
console.log(`phase=${phase} account=${WHICH} ${acct.address}`);
console.log(`counterparty=${other}`);
console.log(`asp=${env().EXPO_PUBLIC_ASP_URL}`);
const startWei = await client.getBalance({ address: acct.address });
reportBalance('wallet balance', startWei);

const { browser, page, shot, sent, appLogs, captured, flushCapture, clearCapture, startCapture, stopCapture } = await openApp(acct, { tag: phase });
const pinPublicState = ['all', 'withdraw', 'privacy'].includes(phase)
  ? recordPublicState(page, env().EXPO_PUBLIC_ASP_URL ?? 'https://api-dev.0xbow.io') : null;
/**
 * Windows in which the user only opened a form or typed, measured against
 * equal-length idle controls taken immediately before with the app in the
 * same state. A request that appears only inside one of these announces the
 * withdrawal by existing, however innocuous its contents.
 */
const privacyWindows: TimingWindow[] = [];
/** Each control and the action window are this long. See measureFormTiming. */
const PRIVACY_WINDOW_MS = Number(process.env.E2E_PRIVACY_WINDOW_MS ?? 65_000);
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`\n>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}\n`);
};
const txLink = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
const formatEth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;

/** The pools-provider tick is 2 minutes; other readers poll faster. */
const SNAPSHOT_SETTLE_MAX_MS = 240_000;
const SNAPSHOT_QUIET_MS = 45_000;
/** SNAPSHOT_TTL_MS in services/snapshot-source.ts. */
const SNAPSHOT_TTL_MS = 5 * 60_000;

/**
 * Put the event-snapshot backstop refetch outside the measured windows.
 *
 * services/snapshot-source.ts refetches every pool's ~900KB payload once its
 * 5-minute TTL lapses, on the next 2-minute tick of the pools-provider query.
 * That is a fixed background cadence (about every 6 minutes), not a reaction
 * to the form, but it is longer than the two 65s controls together, so the
 * controls cannot measure it and its phase alone decided whether it landed in
 * the action window (runs 37762743974, 37734049317: GET
 * /4114/ and /56/public/event-snapshot/payload flagged as caused by "open the
 * Withdraw tab").
 *
 * Same answer as the price tick below: move the phase, never exempt the URL.
 * Marking every pool due and waiting until the refetches that follow go
 * quiet restarts every pool's TTL, so no backstop refetch can fall inside the next 5 minutes, which
 * covers both controls and the action. A payload request the form causes
 * still lands in the action window with no control to excuse it.
 */
async function settleSnapshotBackstop(p: Page): Promise<number | null> {
  const expired = await p.evaluate(() => {
    const cache = (globalThis as Record<string, unknown>).__ppv2SnapshotCache as { expire?: (prefix: string) => void } | undefined;
    if (!cache?.expire) return false;
    cache.expire('');
    return true;
  });
  if (!expired) {
    console.log('  snapshot backstop: no shared snapshot cache on the page, nothing to align');
    return null;
  }
  // Every consumer that finds its pool due refetches on its own next read,
  // and they do not all read on the same tick. So wait for the refetches to
  // stop, not for the first one: done once a payload GET has been seen and
  // none has followed for SNAPSHOT_QUIET_MS.
  const seen = new Set<string>();
  let last = 0;
  let first = 0;
  const onRequest = (r: { url(): string; method(): string }) => {
    const m = /\/(\d+)\/public\/event-snapshot\/payload\b/.exec(r.url());
    if (!m || r.method() !== 'GET') return;
    seen.add(m[1]);
    last = Date.now();
    if (!first) first = last;
  };
  p.on('request', onRequest);
  const deadline = Date.now() + SNAPSHOT_SETTLE_MAX_MS;
  try {
    while (Date.now() < deadline && !(last && Date.now() - last >= SNAPSHOT_QUIET_MS)) await sleep(1000);
  } finally {
    p.off('request', onRequest);
  }
  if (!first) throw new Error(`snapshot backstop: no payload refetch within ${SNAPSHOT_SETTLE_MAX_MS / 1000}s after marking every pool due, so the TTL phase is unknown`);
  console.log(`  snapshot backstop: refetched chains ${[...seen].join(',')}, quiet for ${SNAPSHOT_QUIET_MS / 1000}s, TTL restarted before the controls`);
  // The earliest refetch is the first TTL to lapse again.
  return first;
}

/**
 * Measure "what happens when the user opens the withdraw form".
 *
 * Two idle controls, then the action, all the same length. Controls come
 * first, from the SAME prepared state, so the background polling the gate has
 * to tolerate is measured rather than guessed — and measured twice, because a
 * minute poll must occur in each control to establish its request shape.
 *
 * This is a separate step from doWithdraw and it runs BEFORE it: the point is
 * to observe the form being opened with nothing else going on, not to
 * instrument the withdrawal itself.
 */
async function measureFormTiming(p: Page, amt: string): Promise<void> {
  const restoreSnapshots = await pinPublicState();
  try {
    // This policy covers preparation, before consent to disclose a transaction.
    await tab(p, 'Shield');
    // Price feeds run on a five-minute wall-clock grid and the background
    // discovery pass on the event snapshot's two-minute one (window-phase.ts).
    // Shift the start so no instant of either falls in the action window: the
    // controls keep equal length and measured budgets, nothing is exempted.
    // The shift can wait a few minutes, so it is checked against the snapshot
    // TTL restarted just before: both controls and the action must end before
    // the earliest refetched pool is due again, or the settle runs again.
    const actionOffset = 2 * PRIVACY_WINDOW_MS;
    const gridShift = () => {
      const s = phaseShift(Date.now(), actionOffset, PRIVACY_WINDOW_MS, [PRICE_GRID, DISCOVERY_GRID]);
      if (s === null) throw new Error('no start keeps the price tick and the discovery pass out of the action window');
      return s;
    };
    let aligned = false;
    for (let round = 0; round < 3 && !aligned; round += 1) {
      const ttlStart = await settleSnapshotBackstop(p);
      const shift = gridShift();
      const windowsEnd = Date.now() + shift + 3 * PRIVACY_WINDOW_MS + 10_000;
      if (ttlStart === null || windowsEnd - ttlStart < SNAPSHOT_TTL_MS) {
        if (shift) await sleep(shift);
        aligned = true;
      } else {
        console.log(`  snapshot backstop: a ${Math.round(shift / 1000)}s grid shift would outlast the snapshot TTL, settling again`);
        await sleep(shift);
      }
    }
    if (!aligned) throw new Error('privacy windows could not be aligned clear of the price tick, the discovery pass and the snapshot TTL');
    await startCapture();
    const controls: { start: number; end: number }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const start = Date.now();
      await sleep(PRIVACY_WINDOW_MS);
      controls.push({ start, end: Date.now() });
    }
    const start = Date.now();
    if (!(await tab(p, 'Withdraw'))) {
      console.log('  privacy window skipped: Withdraw tab never became active');
      return;
    }
    await enterAmount(p, amt, 'Withdraw');
    // Drain: the leak we are hunting was debounced behind typing, so the window
    // has to outlast the debounce or it would see nothing and pass.
    const elapsed = Date.now() - start;
    if (elapsed < PRIVACY_WINDOW_MS) await sleep(PRIVACY_WINDOW_MS - elapsed);
    privacyWindows.push({
      action: 'open the Withdraw tab and type an amount',
      baselines: controls,
      start,
      end: Date.now(),
    });
    await stopCapture();
    const report = await reportJourneyPrivacy({
      page: p, captured, flush: flushCapture, windows: privacyWindows,
      amountsWei: [parseEther(amt)],
      addresses: [acct.address, other], aspUrl: env().EXPO_PUBLIC_ASP_URL,
      rpcUrl: env().EXPO_PUBLIC_RPC_URL, ownOrigin: BASE,
      rpcUrls: ACTIVE_ENVIRONMENT.deployments.flatMap(chain => chain.rpcUrls ?? [chain.rpcUrl]),
    });
    console.log(report.text);
    record('withdraw-preparation-privacy', report.ok, report.detail);
    clearCapture();
  } finally { await restoreSnapshots(); }
}

/** Keep content coverage through proving, relay submission and post-transaction discovery. */
async function captureSpend(name: string, run: () => Promise<unknown>) {
  const extra = { addresses: [acct.address, other], amountsWei: [parseEther(amount || SPEND_ETH)] };
  const before = await collectJourneySecrets(page, extra);
  await startCapture();
  try { return await run(); } finally {
    try {
      await sleep(PRIVACY_WINDOW_MS);
      await stopCapture();
      const after = await collectJourneySecrets(page, extra);
      const secrets = Object.fromEntries(Object.keys(after).map(key =>
        [key, [...new Set([...(before[key] ?? []), ...(after[key] ?? [])])]]));
      const submittedCommitments = (after.commitments ?? []).filter(c =>
        !(before.commitments ?? []).some(old => BigInt(old) === BigInt(c)));
      const report = runNetworkPrivacyGate({ captured, secrets, submittedCommitments, hosts: resolveHosts({
        aspUrl: env().EXPO_PUBLIC_ASP_URL, rpcUrl: env().EXPO_PUBLIC_RPC_URL, ownOrigin: BASE,
        rpcUrls: ACTIVE_ENVIRONMENT.deployments.flatMap(chain => chain.rpcUrls ?? [chain.rpcUrl]),
      }) });
      console.log(report.text);
      record(`${name}-content-privacy`, report.ok, report.detail);
      clearCapture();
    } catch (error) {
      record(`${name}-content-privacy`, false, `capture failed: ${String(error)}`);
    }
  }
}

/** Shield: spends the connected wallet, so it works from a 0 shielded balance. */
async function doShield(p: Page, requested: string): Promise<string | null> {
  const amt = capped(requested, 'shield');
  if (!(await tab(p, 'Shield'))) { record('shield', false, 'Shield tab never became active'); return null; }
  await selectToken(p, 'Shield');
  if (!(await enterAmount(p, amt, 'Shield'))) { record('shield', false, 'amount did not stick'); return null; }
  await shot('shield-amount');
  console.log(`shielding ${amt} ETH`);
  const sentBefore = sent.length;
  // Only logs from here on describe THIS deposit.
  const logFrom = appLogs.length;
  // The CTA names its asset ("Shield ETH") and walks the unlock gate first.
  const used = await submit(p, ['Shield ETH']);
  // A broadcast outranks the button: judge the flow by whether a tx went out.
  if (!used && sent.length === sentBefore) {
    record('shield', false, `CTA not clickable: ${(await cardError(p)) ?? 'unknown'}`);
    return null;
  }
  // A first-time account registers its keystore on-chain before the deposit can
  // go out, so a press can produce two or three transactions. Identify the
  // deposit by its own hash rather than by counting: a run whose registration
  // and deposit both landed before the count was sampled was reported as having
  // broadcast nothing, while the deposit was on-chain the whole time.
  if (await registerKeystoreIfPrompted(p)) {
    await shot('shield-registered');
    // The modal resumes the parked deposit itself. Press again only if nothing
    // moved, which is the case when the form was left sitting there.
    if (!(await waitForDepositHash(appLogs, 30_000, logFrom))) {
      console.log('  deposit did not resume on its own, pressing the CTA again');
      await submit(p, ['Shield ETH']);
    }
  }
  // The card can refuse silently even after a successful press (the amount is
  // over the cap it reserves for fees and gas), so say what it says.
  const capMessage = await cardError(p);
  if (capMessage) console.log(`  card says: ${capMessage}`);
  const depositHash = await waitForDepositHash(appLogs, 300_000, logFrom);
  await shot('shield-after');
  if (!depositHash) {
    record('shield', false, `the deposit never went out within 300s${capMessage ? ` — ${capMessage}` : ''}`);
    return null;
  }
  const status = await awaitNativeDeposit(depositHash, amt, acct.address);
  const after = await client.getBalance({ address: acct.address });
  reportBalance('wallet after', after);
  const ok = status === 'success';
  record('shield', ok, `${amt} ETH, receipt ${status}, ${txLink(depositHash)}`);
  return ok ? depositHash : null;
}

/**
 * Withdraw: relayed, so the payout arrives from the relayer.
 *
 * The recipient is OUR OWN address by default, which is both the ordinary case
 * and the cleanest assertion: we pay no gas on a relayed withdrawal, so our
 * balance can only move one way. E2E_WITHDRAW_TO overrides it, and CI's drain
 * sends the leftovers to the mother instead.
 */
async function doWithdraw(p: Page, requested: string, capRetriesLeft = 1): Promise<boolean> {
  const amt = capped(requested, 'withdrawal');
  const to = (process.env.E2E_WITHDRAW_TO as `0x${string}` | undefined) ?? acct.address;
  if (!(await tab(p, 'Withdraw'))) { record('withdraw', false, 'Withdraw tab never became active'); return false; }
  await selectToken(p, 'Withdraw');
  const spendable = await waitForShieldedBalance(p);
  if (spendable === 0) { record('withdraw', false, 'no spendable shielded balance (note not synced/accepted)'); return false; }
  if (spendable < Number(amt)) { record('withdraw', false, `shielded balance ${spendable} < ${amt}`); return false; }
  // Fee rows that already exist, so the assertion after the withdrawal can only
  // be satisfied by a NEW one (see assertRelayerFeeStamped).
  const feesBefore: string[] = await p.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('ppv2_withdraw_fees_v1') || '[]');
    return Array.isArray(rows) ? rows.map((r: { txHash?: string }) => String(r?.txHash ?? '').toLowerCase()) : [];
  });
  // Recipient first: typing the amount kicks off a quote, and the recipient
  // field is briefly disabled while that lands.
  if (!(await fillRecipient(p, to, 'Withdraw'))) { record('withdraw', false, 'recipient field not filled'); return false; }
  if (!(await enterAmount(p, amt, 'Withdraw'))) { record('withdraw', false, 'amount did not stick'); return false; }
  await shot('withdraw-filled');
  // Whatever the card thinks is wrong, said out loud BEFORE pressing: a
  // withdrawal under the relayer fee, or over the single-lineage cap, disables
  // the CTA, and a press then looks like it worked while nothing happens.
  const pre = await cardError(p);
  if (pre) console.log(`  card says: ${pre}`);
  // A full-balance selection blocks the CTA behind a privacy acknowledgment.
  await acknowledgeFullWithdrawal(p);
  console.log(`withdrawing ${amt} ETH to ${to}${to === acct.address ? ' (self)' : ''}`);
  const beforeTo = await client.getBalance({ address: to });
  // The relayer re-quotes at submit time, and its quote is short-lived: this
  // suite has seen one arrive with 22s left while proving alone takes ~40s. So
  // two guards in the app fire legitimately and send the flow BACK to the form,
  // each telling the user to review again:
  //   "The relayer fee went up since you reviewed this withdrawal…"
  //   "Fee quote has expired. Please request a new quote."
  // Neither is a product failure and neither will ever produce a payout, so
  // waiting out the 10-minute payout loop after one (as this did, twice) burns
  // the run and then blames the chain. Do what the app asks instead: review and
  // confirm again, a couple of times, before calling it.
  const REQUOTE = /relayer fee went up|Fee quote has expired/i;
  // Either the app is working, or it has bounced us back to re-quote. Waiting
  // for only the bounce meant paying its full timeout on every healthy run.
  const SETTLED = /relayer fee went up|Fee quote has expired|Processing Withdrawal|Confirming|Generating|Preparing|Submitting|Building|Withdrawal Successful|transaction reverted|Withdrawal failed/i;
  let reviewed = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const logMark = appLogs.length;
    const form = p.locator('[data-testid="hub-page-withdraw"]:not([aria-hidden="true"])');
    await form.getByRole('button', { name: 'Withdraw', exact: true }).click({ timeout: 120_000 });
    // Wait for the actual review control; a second Withdraw click only opens
    // the review and must never be mistaken for transaction confirmation.
    await p.getByRole('button', { name: 'Confirm Withdrawal', exact: true })
      .filter({ visible: true }).click({ timeout: 120_000 });
    const settled = await waitForText(p, SETTLED, 90_000);
    // The fee-increase abort surfaces its copy only briefly before resetting
    // the form, so the on-screen check alone missed it in three runs
    // (2026-08-27, quotes expire in 59s while proving takes longer than that
    // under gas volatility). The app LOG is the durable signal - key on it.
    const aborted = appLogs.slice(logMark).some((l) => /fee increased between review/i.test(l));
    if (!aborted && settled && !REQUOTE.test(settled)) { reviewed = true; break; }
    if (!aborted && !settled) { record('withdraw', false, 'review/confirmation did not advance within 90s'); return false; }
    console.log(`  relayer re-quoted between review and submit (${aborted ? 'fee-increase abort in app log' : (settled ?? '').trim().slice(0, 60)}), reviewing again (attempt ${attempt}/5)`);
    await sleep(4000);
  }
  if (!reviewed) {
    record('withdraw', false, 'the relayer kept re-quoting between review and confirm across 5 attempts');
    return false;
  }
  // Wait for the flow to reach a terminal state, then prove it on-chain. The
  // relayer posts the withdrawal, so there is no local broadcast to watch and
  // the recipient's balance is the real assertion.
  const panel = await waitForText(
    p,
    /Withdrawal Successful|transaction reverted|Withdrawal failed|Withdrawal outcome unknown|most you can withdraw right now is/i,
    900_000,
  );
  // A balance split across many small deposits caps a single withdrawal (up to
  // 5 notes from ONE deposit), and the app says exactly what that cap is. The
  // phase used to fail on the cap and then wait out the full 10-minute payout
  // loop for a transaction that was never broadcast: take the app at its word
  // and retry once under the stated cap instead.
  const capped_msg = (panel ?? '').match(/most you can withdraw right now is ([\d.]+) ETH/i);
  if (capped_msg && !/Withdrawal Successful/i.test(panel ?? '')) {
    const room = Number(capped_msg[1]);
    // 10% under the stated cap: the relayer re-quotes at submit time and a
    // slightly higher fee would trip the same guard again.
    const retry = (Math.floor(room * 0.9 * 1e6) / 1e6).toFixed(6);
    console.log(`  the balance is fragmented: a single withdrawal caps at ${room} ETH, retrying with ${retry}`);
    if (Number(retry) <= 0) {
      record('withdraw', false, `no single deposit holds enough for a withdrawal (cap ${room} ETH)`);
      return false;
    }
    if (capRetriesLeft <= 0) {
      record('withdraw', false, `still over the single-withdrawal cap (${room} ETH) after retrying`);
      return false;
    }
    await clickButton(p, 'Try Again');
    await sleep(2000);
    return doWithdraw(p, retry, capRetriesLeft - 1);
  }
  if (!/Withdrawal Successful/i.test(panel ?? '')) {
    record('withdraw', false, (await cardError(p)) ?? 'withdrawal did not report success; no payout polling or resubmission');
    return false;
  }
  let afterTo = await client.getBalance({ address: to });
  for (let i = 0; i < 24 && afterTo <= beforeTo; i++) {
    await sleep(5000);
    afterTo = await client.getBalance({ address: to });
  }
  await shot('withdraw-after');
  reportBalance('recipient before', beforeTo);
  reportBalance('recipient after', afterTo);
  const ok = afterTo > beforeTo;
  record('withdraw', ok, ok ? `${amt} ETH delivered to ${to}` : 'successful withdrawal reported but recipient balance never increased');
  // The withdrawal side of the fee record: it has been stamped since the
  // accounting export was built, but nothing ever displayed it, so nothing
  // ever asserted it either.
  if (ok) await assertRelayerFeeStamped(p, 'withdraw', 'withdrawal', feesBefore);
  return ok;
}

/**
 * Send: a private transfer, so success is the flow's own receipt, not a balance.
 *
 * `disclosed` used to uncheck "Hide my wallet" (DEV-237) and submit from the
 * user's own wallet with no relayer. That toggle was removed 2026-08-29 (every
 * send is relayed), so the phase now records itself as retired.
 */
/**
 * Pack C-c (max-sendable): a balance fragmented across lineages caps a single
 * transfer below the total, and the form must SAY so with the real figure.
 * Form-level only - nothing is sent. The typed 100 ETH never moves (the cap
 * message replaces the CTA path), so the suite's MAX_ETH movement cap is not
 * in play; the send phase already proves a real transfer end to end.
 */
async function doSendMaxCap(p: Page): Promise<boolean> {
  if (!(await tab(p, 'Send'))) { record('send-max-cap', false, 'Send tab never became active'); return false; }
  await selectToken(p, 'Send');
  const spendable = await waitForShieldedBalance(p, 6);
  if (spendable === 0) { record('send-max-cap', false, 'no spendable shielded balance'); return false; }
  if (!(await fillRecipient(p, other, 'Send'))) { record('send-max-cap', false, 'recipient field not filled'); return false; }
  if (!(await enterAmount(p, '100', 'Send'))) { record('send-max-cap', false, 'amount did not stick'); return false; }
  const seen = await waitForText(p, /Maximum sendable in one transfer is [0-9.]+ /i, 30_000);
  await shot('send-max-cap');
  if (!seen) {
    record('send-max-cap', false, 'the max-sendable message never rendered for an over-cap amount');
    return false;
  }
  const m = seen.match(/Maximum sendable in one transfer is ([0-9.]+) /i);
  const cap = m ? Number(m[1]) : NaN;
  // The cap must be a real, plausible figure: above zero (a 0.0000 cap would
  // be the vacuous-message trap) and no more than the spendable balance.
  const ok = Number.isFinite(cap) && cap > 0 && cap <= spendable + 1e-9;
  record('send-max-cap', ok, ok
    ? `over-cap amount refused; the form names the single-transfer cap (${cap} of ${spendable} ETH spendable)`
    : `cap message rendered but its figure is implausible (${m?.[1] ?? 'none'} vs ${spendable} spendable)`);
  return ok;
}

async function doSend(p: Page, requested: string, opts: { disclosed?: boolean; sendExact?: boolean } = {}): Promise<boolean> {
  const disclosed = opts.disclosed === true;
  const sendExact = opts.sendExact === true;
  const name = disclosed ? 'send-disclosed' : sendExact ? 'send-exact' : 'send';
  const amt = capped(requested, name);
  if (!(await tab(p, 'Send'))) { record(name, false, 'Send tab never became active'); return false; }
  await selectToken(p, 'Send');
  const spendable = await waitForShieldedBalance(p, 6);
  if (spendable === 0) { record(name, false, 'no spendable shielded balance'); return false; }
  if (spendable < Number(amt)) { record(name, false, `shielded balance ${spendable} < ${amt}`); return false; }
  if (!(await fillRecipient(p, other, 'Send'))) { record(name, false, 'recipient field not filled'); return false; }
  if (!(await enterAmount(p, amt, 'Send'))) { record(name, false, 'amount did not stick'); return false; }
  if (sendExact) {
    // Uncheck "Recipient receives the exact amount" so the typed figure is the
    // whole debit. Proven by the explanation the form reveals only while
    // unchecked — the checkbox is a drawn square with no accessible state, so a
    // missed click would otherwise run the fee-on-top path and report a pass.
    if (!(await clickButton(p, 'Recipient receives the exact amount'))) {
      record(name, false, '"Recipient receives the exact amount" checkbox not found');
      return false;
    }
    const flipped = await waitForText(p, /Sends exactly what you entered/i, 15_000);
    if (!flipped) {
      record(name, false, 'checkbox click did not switch to send-exact (explanation never appeared)');
      return false;
    }
    // The recipient card must now show LESS than the typed amount: that is the
    // whole behaviour under test. The fee line appears only once the debounced
    // relayer quote lands, so WAIT for it rather than sampling the body once.
    if (!(await waitForText(p, /recipient receives ~[0-9.]+/i, 60_000))) {
      record(name, false, 'send-exact fee line never stated the net the recipient receives');
      return false;
    }
    const body = await bodyText(p);
    const netLine = body.match(/leaves your balance[\s\S]*?recipient receives ~([0-9.]+)/i);
    if (!netLine) {
      record(name, false, 'send-exact fee line appeared but its net figure could not be read');
      return false;
    }
    // BOTH bounds matter. "Below the entered amount" alone is satisfied by a
    // net of 0, which is what a too-small amount produces (the fee reserve
    // exceeds it) — that passed this check on the first live run while the flow
    // was actually blocked. A send-exact that delivers nothing is not a pass.
    const net = parseFloat(netLine[1]!);
    if (!(net > 0 && net < Number(amt))) {
      record(name, false, `send-exact net ${netLine[1]} must be >0 and <${amt} (a 0 net means the amount is under the relayer fee)`);
      return false;
    }
    console.log(`  send-exact: ${amt} ETH leaves the balance, recipient receives ~${netLine[1]} ETH`);
  }
  if (disclosed) {
    // The "Hide my wallet" toggle was removed 2026-08-29: every send is
    // relayed, so there is no disclosed path left to exercise.
    record(name, false, 'retired: every send is relayed now (no "Hide my wallet" toggle); drop this phase');
    return false;
  }
  await shot(`${name}-filled`);
  // Snapshot the fee rows that already exist so the assertion after the send
  // can only be satisfied by a NEW one (an earlier run's row must not count).
  const feesBefore: string[] = await p.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('ppv2_withdraw_fees_v1') || '[]');
    return Array.isArray(rows) ? rows.map((r: { txHash?: string }) => String(r?.txHash ?? '').toLowerCase()) : [];
  });
  console.log(`sending ${amt} ETH ${disclosed ? 'from my own wallet' : 'privately'} to ${other}`);
  // Same distinction as the withdrawal: a null from submit() can mean the form
  // has already advanced. Latent here rather than observed, but it is the same
  // shape that failed the withdrawal twice, so it is not worth leaving armed.
  const got = await submitOrPast(p, ['Review transfer', 'Send privately', 'Send']);
  if (got === 'stuck') { record(name, false, `CTA not clickable: ${(await cardError(p)) ?? 'unknown'}`); return false; }
  if (got === 'past') console.log('  already past the form, going straight to Confirm');
  await sleep(3000);
  await unlockIfPrompted(p);
  for (const label of ['Confirm transfer', 'Confirm', 'Send privately', 'Send']) {
    if (await clickButton(p, label)) { console.log(`  clicked: ${label}`); break; }
  }
  // A private transfer pays no one publicly, and the shielded balance is not a
  // usable signal either: it can RISE mid-flight as older pending deposits get
  // accepted, masking the spend. The flow's own success panel is the honest one.
  // "Transfer outcome unknown" is a deliberate third state in the provider and
  // must never be read as success.
  const settled = await waitForText(
    p,
    /Transfer Successful|Transfer outcome unknown|transaction reverted|Transfer failed/i,
    900_000,
  );
  await shot(`${name}-after`);
  const t = await bodyText(p);
  const ok = /Transfer Successful/i.test(t);
  const unknown = /Transfer outcome unknown/i.test(t);
  // Name the relayer refusal explicitly when it shows up. On the disclosed path
  // no relayer is involved at all, so a relayer message there means the quote
  // the SDK used to fetch unconditionally is back (DEV-370).
  let why = settled ? 'flow surfaced an error' : 'no terminal state within 900s';
  if (!ok && !unknown) {
    const m = t.match(/All configured relayers failed to quote[^\n]{0,200}|PoolVault_[A-Za-z]+|Transfer failed:[^\n]{0,300}|No relayer quote available[^\n]{0,120}/i);
    if (m) why = m[0].replace(/\s+/g, ' ').trim();
    else {
      const said = await cardError(p);
      if (said) why = said;
    }
  }
  record(name, ok, ok
    ? `${amt} ETH sent ${disclosed ? 'from the wallet directly, no relayer' : 'privately'} (flow reported Transfer Successful)`
    : unknown
      ? 'flow reported "Transfer outcome unknown" - treated as a failure on purpose'
      : why);
  // Only the relayed paths pay a relayer, so only they owe a fee record; the
  // disclosed path pays gas from the wallet and correctly stamps nothing.
  if (ok && !disclosed) await assertRelayerFeeStamped(p, name, 'transfer', feesBefore);
  return ok;
}


/**
 * A relayed spend's fee is invisible in the ASP feed, so the app stamps it
 * on-device (services/withdraw-fees-store) and the row detail reads it back.
 * That is the whole reason a user's history can be summed to their balance
 * (Mike, 2026-08-26), so the e2e proves BOTH halves for real:
 *   1. the app wrote a NEW fee row for this spend, of the right kind;
 *   2. the row detail, opened by its ?tx= deep link, names the fee.
 * `before` must be the fee hashes captured BEFORE the spend, so a leftover row
 * from an earlier run can never stand in for the one we just made.
 */
async function assertRelayerFeeStamped(
  p: Page,
  name: string,
  kind: 'transfer' | 'withdrawal',
  before: string[],
): Promise<void> {
  const seen = new Set(before.map((h) => h.toLowerCase()));
  let fresh: { txHash: string; feeAmount: string; kind?: string } | null = null;
  // The stamp happens after confirmation, which the flow has already reported;
  // still poll briefly rather than assuming the same tick.
  for (let i = 0; i < 12 && !fresh; i++) {
    fresh = await p.evaluate((known: string[]) => {
      const rows = JSON.parse(localStorage.getItem('ppv2_withdraw_fees_v1') || '[]');
      if (!Array.isArray(rows)) return null;
      const k = new Set(known);
      const hit = rows.find((r: { txHash?: string }) => r?.txHash && !k.has(String(r.txHash).toLowerCase()));
      return hit ?? null;
    }, [...seen]);
    if (!fresh) await sleep(5000);
  }
  if (!fresh) {
    record(`${name}-fee`, false, 'the spend stamped no relayer-fee record, so its fee stays invisible in history');
    return;
  }
  let feeWei = 0n;
  try { feeWei = BigInt(fresh.feeAmount); } catch { feeWei = 0n; }
  if (feeWei <= 0n || fresh.kind !== kind) {
    record(`${name}-fee`, false, `fee record is wrong: kind=${fresh.kind ?? 'none'} (want ${kind}) amount=${fresh.feeAmount}`);
    return;
  }
  record(`${name}-fee`, true, `app stamped a ${kind} relayer fee of ${Number(feeWei) / 1e18} ETH for ${fresh.txHash}`);

  // Now the visible half, and it is a recorded PASS/FAIL either way: a stamped
  // fee the user cannot see is the bug this work exists to remove, so a page
  // that never rendered it must not slip through as "logged and returned".
  await openTransactionDetail(p, fresh.txHash);
  const detail = p.getByRole('dialog').filter({
    has: p.getByRole('button', { name: 'Close transaction details', exact: true }),
  });
  try {
    const hash = `${fresh.txHash.slice(0, 8)}…${fresh.txHash.slice(-6)}`;
    await detail.getByRole('link', { name: hash, exact: true }).waitFor({ state: 'visible', timeout: 300_000 });
    await detail.getByText('Relayer fee', { exact: true }).waitFor();
    await detail.getByText(kind === 'transfer' ? 'Total spent' : 'Net after fee', { exact: true }).waitFor();
    await shot(`${name}-fee-detail`);
    record(`${name}-fee-shown`, true, `the detail for ${fresh.txHash} shows the relayer fee and reconciled amount`);
  } catch {
    await shot(`${name}-fee-detail-failed`);
    record(`${name}-fee-shown`, false, 'the requested transaction detail did not show its fee and reconciled amount');
  }
  const close = detail.getByRole('button', { name: 'Close transaction details', exact: true });
  if (await close.isVisible()) await close.click();
  await p.waitForFunction(() => !new URL(location.href).searchParams.has('tx'));

}

/**
 * Return the run's remaining shielded value to the funder.
 *
 * CI throws its key away at the end, so anything still shielded would be lost
 * for good. The relayer's fee is charged ON TOP of the amount, so asking for the
 * whole balance is rejected: step down until one is accepted. A remainder too
 * small to cover that fee is not a failure, just dust.
 */
async function doDrain(p: Page): Promise<boolean> {
  const DUST_ETH = 0.0006;
  if (!(await tab(p, 'Withdraw'))) { record('drain', false, 'Withdraw tab never became active'); return false; }
  await selectToken(p, 'Withdraw');
  const left = await waitForShieldedBalance(p, 6);
  if (left === 0) { record('drain', true, 'nothing left to withdraw'); return true; }
  const before = await client.getBalance({ address: other as `0x${string}` });
  for (const frac of [0.95, 0.8, 0.5]) {
    // Capped like every other amount, so a drain of a larger balance walks it
    // out in capped withdrawals rather than one big one.
    const amt = capped((Math.floor(left * frac * 1e6) / 1e6).toFixed(6), 'drain');
    if (Number(amt) <= 0) continue;
    console.log(`drain: trying ${amt} ETH of the ${left} ETH left`);
    if (!(await fillRecipient(p, other, 'Withdraw'))) continue;
    if (!(await enterAmount(p, amt, 'Withdraw'))) continue;
    await acknowledgeFullWithdrawal(p);
    if (await submitOrPast(p, ['Review withdrawal', 'Withdraw', 'Review']) === 'stuck') continue;
    await sleep(3000);
    await unlockIfPrompted(p);
    for (const label of ['Confirm withdrawal', 'Confirm', 'Withdraw']) {
      if (await clickButton(p, label)) break;
    }
    await waitForText(p, /Withdrawal Successful|transaction reverted|Withdrawal failed/i, 900_000);
    let after = before;
    for (let i = 0; i < 24 && after <= before; i++) {
      await sleep(15_000);
      after = await client.getBalance({ address: other as `0x${string}` });
    }
    await shot('drain-after');
    if (after > before) { record('drain', true, `returned about ${amt} ETH to ${other}`); return true; }
    console.log(`drain: ${amt} ETH did not land, stepping down`);
  }
  if (left <= DUST_ETH) { record('drain', true, `left ${left} ETH behind, under the relayer fee`); return true; }
  record('drain', false, `could not return the remaining ${left} ETH to ${other}`);
  return false;
}

/**
 * Ragequit: exit a deposit back to the depositing address.
 *
 * No ASP approval needed, unlike a withdrawal, which is what makes it the right
 * way to return a brand-new account's deposit inside the same run. It is reached
 * from an activity row's menu, not from the hub tabs.
 */
async function doRagequit(p: Page): Promise<boolean> {
  const before = await client.getBalance({ address: acct.address });
  await p.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded' });
  const sync = p.getByRole('button', { name: 'Sync full activity', exact: true });
  await sync.waitFor({ timeout: 60_000 });
  await sync.click();
  await unlockIfPrompted(p);
  const deadline = Date.now() + 180_000;
  while (!(await accountNotes(p, acct.address)).some(n => n.status !== 'SPENT' && BigInt(n.value) > 0n)) {
    if (Date.now() >= deadline) {
      record('ragequit', false, 'the deposit was not discovered after unlocking activity');
      return false;
    }
    await sleep(3000);
  }
  const kebab = p.getByRole('button', { name: 'Transaction actions', exact: true }).first();
  await kebab.waitFor({ timeout: 60_000 });
  // The menu keeps its open state in component state, so a row that re-renders
  // while it is up closes it. Note sync lands moments after the drawer opens and
  // does exactly that, which is why a single press found an empty menu. Retry
  // until the menu is actually on screen, then take the Exit entry from it.
  //
  // Scope the entry to role=menuitem: "Exit" also appears in hidden pager copy
  // ("Exit to any address with a private proof"), and the hub mounts every tab.
  const menuItems = p.locator('[role="menuitem"]');
  const exit = menuItems.filter({ hasText: /^Exit$/ });
  let menuUp = false;
  let offered: string[] = [];
  // Two different things look identical from outside: a menu that never opened,
  // and a menu that opened without an Exit entry. Ragequit eligibility rides on
  // data that arrives after the row does, so right after a deposit the entry can
  // be missing from a menu that opened perfectly well, and pressing again only
  // TOGGLES it shut. So: open it if it is closed, read what it offers, and if
  // Exit is not there yet close it and give the data time to land.
  for (let attempt = 1; attempt <= 20 && !menuUp; attempt += 1) {
    const isOpen = await menuItems.first().isVisible().catch(() => false);
    if (!isOpen) {
      await kebab.click().catch(() => {});
      await sleep(1500);
    }
    for (let i = 0; i < 8 && !menuUp; i += 1) {
      menuUp = await exit.first().isVisible().catch(() => false);
      if (!menuUp) await sleep(400);
    }
    if (menuUp) break;
    const items = await menuItems.allTextContents().catch(() => []);
    if (items.length) {
      if (!offered.length) console.log(`  row menu offered: ${items.join(' | ')} (no Exit yet, waiting)`);
      offered = items;
      // Close it so the next open re-reads the row's current eligibility.
      await p.keyboard.press('Escape').catch(() => {});
    } else if (attempt === 1) {
      console.log('  row menu did not open on the first press, retrying');
    }
    await sleep(6000);
  }
  await shot('ragequit-menu');
  if (!menuUp) {
    record('ragequit', false, offered.length
      ? `Exit not offered for this deposit, the row menu only had: ${offered.join(' | ')}`
      : 'the row menu never opened');
    return false;
  }
  await exit.first().click();
  await sleep(4000);
  await shot('ragequit-modal');
  // The modal explains that exiting returns everything to the depositing address.
  if (!(await clickButton(p, 'Accept and exit')) && !(await clickButton(p, 'Exit pool'))) {
    record('ragequit', false, `no "Accept and exit" button: ${(await cardError(p)) ?? 'unknown state'}`);
    return false;
  }
  const settled = await waitForText(p, /Exit Successful|Ragequit failed|transaction reverted/i, 900_000);
  await shot('ragequit-after');
  if (!/Exit Successful/i.test(settled ?? '')) {
    record('ragequit', false, settled ? 'flow reported a failed exit' : 'no terminal state within 900s');
    return false;
  }
  // The successful receipt includes gas, so verify a net wallet increase.
  let after = await client.getBalance({ address: acct.address });
  for (let i = 0; i < 24 && after <= before; i += 1) {
    await sleep(5000);
    after = await client.getBalance({ address: acct.address });
  }
  const ok = after > before;
  record('ragequit', ok, ok
    ? `exited to ${acct.address}, wallet ${formatEth(before)} -> ${formatEth(after)}`
    : 'successful exit reported but wallet balance never increased');
  return ok;
}

try {
  await signIn(page);
  await shot('signed-in');

  if (phase === 'probe') {
    for (const name of ['Shield', 'Withdraw', 'Send'] as const) {
      await tab(page, name);
      await shot(`tab-${name.toLowerCase()}`);
      const info = await page.evaluate(() => ({
        inputs: Array.from(document.querySelectorAll('input')).map((i) => (i as HTMLInputElement).placeholder),
        text: (document.body.innerText || '').slice(0, 600),
      }));
      console.log(`\n=== ${name} tab ===\ninputs: ${JSON.stringify(info.inputs)}\n${info.text}`);
    }
    record('probe', true, 'tabs dumped');
  }

  if (phase === 'privacy') {
    await forceUnlock(page);
    await waitForInitialDiscovery(page, acct.address);
    await measureFormTiming(page, amount || SPEND_ETH);
  }

  if (phase === 'shield') await doShield(page, amount || '0.002');
  if (phase === 'withdraw' || phase === 'send' || phase === 'send-disclosed' || phase === 'send-exact' || phase === 'send-max-cap') {
    await forceUnlock(page);
    if (phase === 'withdraw') {
      await measureFormTiming(page, amount || '0.001');
      await captureSpend('withdraw', () => doWithdraw(page, amount || '0.001'));
    }
    else if (phase === 'send-max-cap') await captureSpend('send', () => doSendMaxCap(page));
    // send-exact spends the typed amount INCLUSIVE of the relayer fee, so it
    // needs an amount comfortably above that fee to leave the recipient
    // anything: at SPEND_ETH the reserve alone exceeds it. The cap still binds.
    else await captureSpend('send', () => doSend(page, amount || (phase === 'send-exact' ? String(MAX_ETH) : '0.001'), {
      disclosed: phase === 'send-disclosed',
      sendExact: phase === 'send-exact',
    }));
  }

  if (phase === 'ragequit') await doRagequit(page);

  if (phase === 'all') {
    // Every amount is capped, so the two spends are bankrolled by one capped
    // deposit each rather than a single larger one. Each deposit is its own
    // lineage, and the withdrawal cap is per-lineage, so one deposit per spend
    // is also the shape that keeps the withdrawal inside its own note.
    const shielded = await doShield(page, amount || String(MAX_ETH));
    const secondShield = shielded ? await doShield(page, String(MAX_ETH)) : false;
    if (shielded) {
      // Finish fixture approval before proving spends: these deposits can
      // otherwise trigger an ASP root rotation while a spend is in flight.
      await fixtureBarrier(() => Promise.all([shielded, secondShield].filter(Boolean).map(hash =>
        waitForApprovedDeposit(page, acct.address, hash))));
      // Spend below the deposited value: the relayer fee comes out of the note,
      // so asking for the whole note leaves nothing to pay it with.
      await measureFormTiming(page, SPEND_ETH);
      await captureSpend('withdraw', () => doWithdraw(page, SPEND_ETH));
      if (secondShield) await captureSpend('send', () => doSend(page, SPEND_ETH));
      else record('send', false, 'skipped: the second capped deposit did not land');
      // The disclosed send (E2E_DISCLOSED) was retired 2026-08-29 with the
      // "Hide my wallet" toggle: every send is relayed now.
      // CI asks for this: nothing may be left in a key that is about to be
      // discarded.
      if (process.env.E2E_DRAIN) await doDrain(page);
    } else {
      record('withdraw', false, 'skipped: shield did not land');
      record('send', false, 'skipped: shield did not land');
    }
  }
} catch (e: unknown) {
  record(phase, false, `threw: ${(e as Error).message}`);
  await shot('threw').catch(() => {});
} finally {
  if ((phase === 'all' || phase === 'withdraw') && !results.some((r) => r.name === 'withdraw-preparation-privacy')) {
    record('withdraw-preparation-privacy', false, 'preparation window was not successfully measured and assessed');
  }
  await browser.close();
}

console.log('=== SUMMARY ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (sent.length) console.log(`broadcast:\n  ${sent.map(txLink).join('\n  ')}`);
// A phase that recorded nothing ran nothing, and `every` on an empty array is
// true: that is how an unwired phase reported a pass while doing no work.
if (!results.length) {
  console.log(`FAIL  ${phase}  the phase recorded no result, so it never ran`);
  process.exit(1);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
