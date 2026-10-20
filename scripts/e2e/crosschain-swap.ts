// @ts-nocheck - drives a real browser with real playwright types; playwright is a
// local dev tool here, not a declared dependency, so the repo type-checks these
// scripts against a fallback stub (see scripts/visual/playwright-fallback.d.ts).
// A real cross-chain private swap through the UI: shielded ETH on Optimism into
// a shielded USDC note on the destination, on the STAGING deployments.
//
// This is the flow that had no automated coverage. A cross-chain swap can fail
// at the far end after the source leg has already relayed and bridged, and the
// bridge then pays the fallback address in the open instead of depositing. Only
// a run that waits for the destination and reads the verdict can tell those
// apart, so this one does: it passes on "Deposited on the destination" and fails on
// both the recovery ("the bridge paid your address") and an outright failure.
//
// Runs against account A, the journey's funder, with ETH on OP. It shields
// SHIELD_AMOUNT once and swaps SWAP_AMOUNT per run, reusing the approved change
// note until it runs out, so the 1% vetting fee and the approval wait are paid
// only every few runs.
//
// Env: E2E_PK (or DEV_PK in .env), EXPO_PUBLIC_ALCHEMY_KEY, PROBE_URL.
// Staging has no ppAssets yet; a vault target is added here once they are
// deployed on OP.
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from 'viem';
import { base, mainnet, optimism } from 'viem/chains';

import { STAGING_CHAINS } from '../../config/staging-deployments';
import { rpcUrlForChain } from '../visual/evm-wallet';
import {
  account, bodyText, openApp, registerKeystoreIfPrompted, signIn, sleep, submit,
} from './lib';

const SOURCE_CHAIN = 10; // Optimism
const SOURCE_NAME = 'Optimism';
// Destination: Base by default (cheaper and faster than Ethereum),
// E2E_DEST_CHAIN=1 for Ethereum.
const DESTINATIONS = { 1: { name: 'Ethereum', viem: mainnet }, 8453: { name: 'Base', viem: base } } as const;
const DEST_CHAIN = Number(process.env.E2E_DEST_CHAIN ?? '8453') as keyof typeof DESTINATIONS;
if (!DESTINATIONS[DEST_CHAIN]) throw new Error(`E2E_DEST_CHAIN ${DEST_CHAIN} is not one of ${Object.keys(DESTINATIONS).join(', ')}`);
const DEST_NAME = DESTINATIONS[DEST_CHAIN].name;
const DEST_KEYSTORE = STAGING_CHAINS.find((c) => c.chainId === DEST_CHAIN)?.keystore as `0x${string}` | undefined;
if (!DEST_KEYSTORE) throw new Error(`no staging deployment for chain ${DEST_CHAIN}`);
const OUTPUT = process.env.E2E_XSWAP_OUTPUT ?? 'USDC';
const SWAP_AMOUNT = process.env.E2E_XSWAP_AMOUNT ?? '0.001';
const SHIELD_AMOUNT = process.env.E2E_XSWAP_SHIELD ?? '0.003';
const SLIPPAGE = '3.0%';
// Gas for a shield, a keystore registration and slack, on OP. Deliberately
// generous: running dry mid-run is worse than refusing up front.
const GAS_RESERVE = parseEther('0.0008');
// Same budget as the Sepolia journey (approval-wait.ts): ten minutes is healthy,
// a bounded service delay is tolerated.
const APPROVAL_TIMEOUT_MS = Number(process.env.E2E_APPROVAL_TIMEOUT_MINUTES ?? '45') * 60_000;
const DELIVERY_TIMEOUT_MS = 30 * 60_000;
// The destination deposit needs the account registered on the destination, and that
// registration is a wallet transaction there (the swap turns gasless off). With
// less than this on the destination the run first bridges BRIDGE_AMOUNT from OP.
const DEST_GAS_MIN = parseEther('0.0002');
const BRIDGE_AMOUNT = parseEther('0.001');
// The bridge transaction must go to LiFi's own diamond, never a quote-supplied
// address the run has not checked.
const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const NATIVE = '0x0000000000000000000000000000000000000000';

const DELIVERED = new RegExp(`Deposited on ${DEST_NAME}\\.`);
const RECOVERED = /did not run, so the bridge paid your address there instead/;
const FAILED = new RegExp(`The deposit on ${DEST_NAME} did not complete`);

class E2EFail extends Error {}
// Throws, never exits: an exit here skipped the finally that closes the browser
// (cubic, #133). The top-level catch reports it and sets the exit code.
function fail(message: string): never {
  throw new E2EFail(message);
}

const acct = account('DEV_PK');
const op = createPublicClient({ chain: optimism, transport: http(rpcUrlForChain(SOURCE_CHAIN)) });
const eth = createPublicClient({ chain: DESTINATIONS[DEST_CHAIN].viem, transport: http(rpcUrlForChain(DEST_CHAIN)) });

// --- Funds, before anything is signed ---
const balance = await op.getBalance({ address: acct.address });
const destBalance = await eth.getBalance({ address: acct.address });
console.log(`account ${acct.address} holds ${formatEther(balance)} ETH on ${SOURCE_NAME}, ${formatEther(destBalance)} on ${DEST_NAME}`);
// the destination gas is only for the one-time registration there: an account already
// registered needs none, however low its balance (review of #133).
const destViewingKey = await eth.readContract({
  address: DEST_KEYSTORE,
  abi: [{ type: 'function', name: 'viewingKeys', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bytes32' }] }],
  functionName: 'viewingKeys',
  args: [acct.address],
}).catch(() => null);
const registeredOnDest = destViewingKey !== null && BigInt(destViewingKey) !== 0n;
const needsBridge = !registeredOnDest && destBalance < DEST_GAS_MIN;
// A bridge is irreversible, so it is only sent when the shield after it can
// also be paid; otherwise the run would bridge and then fail at the shield.
const opNeeded = GAS_RESERVE + (needsBridge ? BRIDGE_AMOUNT + parseEther(SHIELD_AMOUNT) : 0n);
if (balance < opNeeded) {
  fail(`OUT OF FUNDS ON ${SOURCE_NAME.toUpperCase()}: ${acct.address} holds ${formatEther(balance)} ETH, `
    + `the run needs at least ${formatEther(opNeeded)} (gas${needsBridge ? `, a bridge for ${DEST_NAME} gas and a shield` : ''}). Top it up on OP and re-run.`);
}

/**
 * Put a little ETH on the destination for the registration there, bridged from OP with
 * a plain LiFi route. Native to native, so there is no approval, and the one
 * transaction is checked against LiFi's diamond and this account before signing.
 */
async function bridgeGasToDestination() {
  const q = new URLSearchParams({
    fromChain: String(SOURCE_CHAIN), toChain: String(DEST_CHAIN), fromToken: NATIVE, toToken: NATIVE,
    fromAmount: BRIDGE_AMOUNT.toString(), fromAddress: acct.address, toAddress: acct.address,
  });
  const res = await fetch(`https://li.quest/v1/quote?${q}`);
  const quote = await res.json().catch(() => null);
  const tx = quote?.transactionRequest;
  if (!res.ok || !tx) fail(`no LiFi route to bridge ETH to ${DEST_NAME}: ${res.status} ${quote?.message ?? ''}`);
  if (String(tx.to).toLowerCase() !== LIFI_DIAMOND) fail(`LiFi bridge tx targets ${tx.to}, expected the LiFi diamond`);
  if (BigInt(tx.value) !== BRIDGE_AMOUNT) fail(`LiFi bridge tx value ${tx.value} != ${BRIDGE_AMOUNT}`);
  if (Number(tx.chainId) !== SOURCE_CHAIN) fail(`LiFi bridge tx is for chain ${tx.chainId}`);
  const out = BigInt(quote.estimate?.toAmountMin ?? 0);
  if (out < (BRIDGE_AMOUNT * 8n) / 10n) fail(`LiFi bridge would deliver only ${formatEther(out)} ETH`);

  const wallet = createWalletClient({ account: acct, chain: optimism, transport: http(rpcUrlForChain(SOURCE_CHAIN)) });
  console.log(`bridging ${formatEther(BRIDGE_AMOUNT)} ETH ${SOURCE_NAME} -> ${DEST_NAME} via ${quote.tool}`);
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  const receipt = await op.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') fail(`bridge tx ${hash} reverted on ${SOURCE_NAME}`);
  const until = Date.now() + 20 * 60_000;
  for (;;) {
    const now = await eth.getBalance({ address: acct.address });
    if (now >= DEST_GAS_MIN) { console.log(`bridged: ${formatEther(now)} ETH on ${DEST_NAME}`); return; }
    if (Date.now() > until) fail(`bridge ${hash} did not arrive on ${DEST_NAME} within 20 minutes`);
    await sleep(15_000);
  }
}
if (needsBridge) await bridgeGasToDestination();

const { browser, page, shot, sent, appLogs } = await openApp(acct, { tag: 'xswap', initialChainId: SOURCE_CHAIN });

/**
 * The swap's own error box, or null. Read from its element rather than from the
 * page text, because the page always carries explanatory copy ("if the far side
 * cannot complete…") that a text match would take for a refusal.
 */
async function swapError(): Promise<string | null> {
  const el = page.locator('[data-testid="swap-error"]:visible').first();
  if (!(await el.count())) return null;
  const text = (await el.innerText().catch(() => '')).trim();
  return text || null;
}

/** Move the app (and the wallet with it) to a chain from the header. */
async function selectChain(id: number) {
  await page.getByTestId('header-chain-selector').click();
  await page.getByTestId(`header-chain-option-${id}`).click();
  await sleep(6000);
}

/**
 * Make sure the account is registered on the destination before the swap asks.
 *
 * The destination deposit needs it. The swap's own "Register on the destination first"
 * prompt registers from the source chain, and that path does not complete today
 * (the wallet's switch moves the whole app, which resets the swap and leaves the
 * modal without a session for the target), so the run registers from the destination
 * itself, through the Chain registration card, where it is an ordinary
 * same-chain registration. Paid from the ETH bridged above. One time per account.
 */
async function ensureRegisteredOnDestination() {
  await selectChain(DEST_CHAIN);
  const card = page.getByTestId('registration-status-card').filter({ visible: true }).first();
  await card.getByTestId('registration-status-toggle').click();
  const row = card.getByTestId(`registration-row-${DEST_CHAIN}`);
  await row.waitFor({ timeout: 60_000 });
  const until = Date.now() + 90_000;
  let text = '';
  while (!/Registered|Not registered|Different unlock|Retry/.test((text = await row.innerText()))) {
    if (Date.now() > until) fail(`could not read the ${DEST_NAME} registration status`);
    await sleep(1500);
  }
  if (/Different unlock/.test(text)) fail(`account is registered on ${DEST_NAME} with a different unlock`);
  if (/Retry/.test(text)) fail(`the ${DEST_NAME} registration check failed`);
  if (/Not registered/.test(text)) {
    console.log(`account is not registered on ${DEST_NAME}; registering there`);
    await row.getByTestId(`registration-register-${DEST_CHAIN}`).click();
    await sleep(1500);
    await shot('dest-register-modal');
    if (/can't pay for registration/i.test(await bodyText(page))) {
      fail(`the wallet cannot pay the registration on ${DEST_NAME}: ${formatEther(await eth.getBalance({ address: acct.address }))} ETH there`);
    }
    // The card's own Register button carries the same accessible name and sits
    // under the modal's overlay, so press the modal's button by its visible
    // text. The modal title reads the same, and the button comes after it.
    await page.getByText(`Register on ${DEST_NAME}`, { exact: true }).last().click();
    const regBy = Date.now() + 5 * 60_000;
    while (!/Registered/.test((text = await row.innerText().catch(() => ''))) || /Not registered/.test(text)) {
      const body = await bodyText(page);
      if (/Could not reach|reverted|did not answer/i.test(body)) { await shot('dest-register-failed'); fail(`registration on ${DEST_NAME} failed`); }
      if (Date.now() > regBy) { await shot('dest-register-stuck'); fail(`registration on ${DEST_NAME} did not finish in 5 minutes`); }
      await sleep(3000);
    }
  }
  console.log(`registered on ${DEST_NAME}`);
}

/** The hub page for a tab, visible and not hidden behind another. */
const hubPage = (key: string) => page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]):visible`);

async function openTab(key: 'shield' | 'swap') {
  const again = page.getByRole('button', { name: 'New deposit', exact: true });
  if (await again.isVisible().catch(() => false)) await again.click();
  await page.getByTestId(`hub-tab-${key}`).filter({ visible: true }).click();
  await hubPage(key).waitFor({ timeout: 90_000 });
}

/**
 * The Swap tab's "Shielded balance", in ETH. This counts notes still waiting for
 * ASP approval too, so it only says whether there is ENOUGH shielded, never
 * whether it can be spent; see waitUntilSpendable for that.
 */
async function shieldedOnSwapTab(): Promise<number> {
  const text = await hubPage('swap').innerText();
  const m = /Shielded balance\s*≈?\s*([\d.,]+)\s*ETH/i.exec(text);
  return m ? Number(m[1]!.replace(/,/g, '')) : 0;
}

/**
 * Wait until the Swap tab stops refusing the amount for want of approval.
 *
 * With the amount entered, the tab says so outright while the notes are still
 * pending ("None of your ETH notes are approved yet", "... is waiting for
 * approval"). The shielded total cannot tell pending from approved, and keying
 * on it declared a fresh deposit spendable a minute before the ASP had seen it.
 */
// The approval refusal only appears once Review is pressed (it comes from the
// quote's note selection), so the wait lives in the review loop below: a refusal
// matching this is retried until APPROVAL_TIMEOUT_MS (review of #133).
const NOT_APPROVED = /approved yet|waiting for approval/i;

async function enterAmount(key: 'shield' | 'swap', amount: string) {
  const input = hubPage(key).getByTestId('hub-amount-input');
  await input.click();
  await input.fill('');
  await input.fill(amount);
}

try {
  await signIn(page);

  await ensureRegisteredOnDestination();
  // The staging build starts on Sepolia; the header selector moves it.
  await selectChain(SOURCE_CHAIN);

  // --- Make sure there is an approved shielded note to swap from ---
  await openTab('swap');
  const pool = await hubPage('swap').getByTestId('hub-withdraw-pool').getAttribute('aria-label');
  if (!pool?.includes(`ETH on ${SOURCE_NAME}`)) fail(`Swap source is ${pool}, expected ETH on ${SOURCE_NAME}`);

  const shielded = await shieldedOnSwapTab();
  console.log(`shielded on ${SOURCE_NAME}: ${shielded} ETH (need ${SWAP_AMOUNT})`);
  if (shielded < Number(SWAP_AMOUNT)) {
    // A shield is needed, so it has to be paid for too; fail before touching
    // the UI rather than halfway through the shield (cubic, #133).
    const nowOp = await op.getBalance({ address: acct.address });
    if (nowOp < parseEther(SHIELD_AMOUNT) + GAS_RESERVE) {
      fail(`OUT OF FUNDS ON ${SOURCE_NAME.toUpperCase()}: ${acct.address} holds ${formatEther(nowOp)} ETH, a shield of ${SHIELD_AMOUNT} ETH plus gas needs ${formatEther(parseEther(SHIELD_AMOUNT) + GAS_RESERVE)}. Top it up on OP and re-run.`);
    }
    console.log(`shielding ${SHIELD_AMOUNT} ETH on ${SOURCE_NAME}`);
    await openTab('shield');
    // The Shield tab on OP opens on USDC; pay with ETH into the ETH pool.
    const payPill = hubPage('shield').getByTestId('hub-shield-pay-token');
    // The pay pill names the token ("Pay token: ETH"); the pool pill names the chain.
    if (!/\bETH\b/.test((await payPill.getAttribute('aria-label')) ?? '')) {
      await payPill.click();
      const tokens = page.getByTestId('token-select-sheet');
      await tokens.waitFor({ timeout: 30_000 });
      await tokens.getByRole('button', { name: `ETH on ${SOURCE_NAME}`, exact: true }).click();
      await tokens.waitFor({ state: 'hidden', timeout: 30_000 });
    }
    const payLabel = await payPill.getAttribute('aria-label');
    const poolLabel = await hubPage('shield').getByTestId('hub-shield-pool').getAttribute('aria-label');
    console.log(`shield: pay ${payLabel}, into ${poolLabel}`);
    if (!/\bETH\b/.test(payLabel ?? '') || !poolLabel?.includes(`ETH on ${SOURCE_NAME}`)) {
      fail(`could not set up an ETH shield on ${SOURCE_NAME} (pay ${payLabel}, pool ${poolLabel})`);
    }
    await enterAmount('shield', SHIELD_AMOUNT);
    await shot('shield-form');
    const before = sent.length;
    await submit(page, ['Shield ETH']);
    await registerKeystoreIfPrompted(page);
    // The shield can send more than one transaction: the first run on a chain
    // also registers the account's keystore there. Wait for the flow's own end
    // ("Deposit submitted"), not a quiet period, which could fall between the
    // registration and the deposit (cubic, #133). Then require EVERY broadcast
    // to have succeeded rather than guessing which hash is the deposit.
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const body = await bodyText(page);
      if (/Deposit submitted/i.test(body)) break;
      if (/Deposit failed|Shield failed/i.test(body)) { await shot('shield-failed'); fail(`the shield failed: ${body.slice(0, 300)}`); }
      if (Date.now() > deadline) { await shot('shield-no-end'); fail('the shield flow never reached "Deposit submitted" within 5 minutes'); }
      await sleep(3000);
    }
    const shieldTxs = sent.slice(before);
    if (shieldTxs.length === 0) fail('the shield never broadcast');
    for (const hash of shieldTxs) {
      const receipt = await op.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') fail(`a shield transaction reverted: ${hash}`);
    }
    console.log(`shield step mined ${shieldTxs.length} transaction(s): ${shieldTxs.join(', ')}`);
  }

  // --- The swap itself ---
  // Enough is shielded; it also has to be APPROVED. Review says so when it is
  // not, and the loop below goes back and presses Review again until it is.
  const approvalBy = Date.now() + APPROVAL_TIMEOUT_MS;
  let reviewText = '';
  for (;;) {
  await openTab('swap');
  await enterAmount('swap', SWAP_AMOUNT);
  await hubPage('swap').getByTestId('hub-swap-out-token').click();
  const sheet = page.getByTestId('token-select-sheet');
  await sheet.waitFor({ timeout: 30_000 });
  await sheet.getByRole('button', { name: DEST_NAME, exact: true }).click();
  await sheet.getByRole('button', { name: `${OUTPUT} on ${DEST_NAME}`, exact: true }).click();
  await sheet.waitFor({ state: 'hidden', timeout: 30_000 });
  // The chip's label is fixed ("Choose the token to receive"); its text names the pick.
  const out = (await hubPage('swap').getByTestId('hub-swap-out-token').innerText()).trim();
  if (!out.includes(OUTPUT)) fail(`receive token is ${out}, expected ${OUTPUT}`);
  console.log(`receive: ${OUTPUT} on ${DEST_NAME}`);
  // Confirm re-quotes and refuses anything below the reviewed output less the
  // slippage. At this size the bridge's fixed fee moves the quote by more than
  // the 0.5% default between Review and Confirm, so allow 3%.
  await hubPage('swap').getByText(SLIPPAGE, { exact: true }).click();
  await shot('swap-form');

  await submit(page, ['Review swap']);
  await registerKeystoreIfPrompted(page);
  // Pricing a cross-chain route takes a while; wait for review or a refusal.
  const reviewBy = Date.now() + 3 * 60_000;
  reviewText = await bodyText(page);
  let notApproved: string | null = null;
  while (!/Confirm swap/i.test(reviewText)) {
    // Registered on the destination up front, so this prompt means that step lied.
    if (new RegExp(`Register on ${DEST_NAME} first`).test(reviewText)) {
      await shot('swap-dest-unregistered');
      fail(`the swap still asks to register on ${DEST_NAME} after the preflight registered there`);
    }
    const refusal = await swapError();
    if (refusal && NOT_APPROVED.test(refusal)) { notApproved = refusal; break; }
    if (refusal) { await shot('swap-refused'); fail(`review refused: ${refusal}`); }
    if (Date.now() > reviewBy) { await shot('swap-no-review'); fail(`never reached review: ${reviewText.slice(0, 300)}`); }
    await sleep(3000);
    reviewText = await bodyText(page);
  }
  if (!notApproved) break;
  if (Date.now() > approvalBy) { await shot('swap-not-approved'); fail(`the shielded ETH on ${SOURCE_NAME} was not approved within ${APPROVAL_TIMEOUT_MS / 60_000} minutes: ${notApproved}`); }
  console.log(`not approved yet, retrying in 30s: ${notApproved}`);
  await page.reload();
  // A reload locks the session again: sign back in and return to OP before
  // the next Review, or the retry would stall on the unlock prompt (cubic, #133).
  await signIn(page);
  await selectChain(SOURCE_CHAIN);
  await sleep(30_000);
  }
  console.log('approved and priced');
  await shot('swap-review');
  await submit(page, ['Confirm swap']);

  // --- Source leg submitted ---
  const submittedBy = Date.now() + 10 * 60_000;
  let text = await bodyText(page);
  while (!/Swap submitted/.test(text)) {
    const refusal = await swapError();
    if (refusal) { await shot('swap-confirm-failed'); fail(`the swap failed at confirm: ${refusal}`); }
    if (Date.now() > submittedBy) { await shot('swap-not-submitted'); fail(`the swap never submitted. Last screen: ${text.slice(0, 400)}`); }
    await sleep(5000);
    text = await bodyText(page);
  }
  await shot('swap-submitted');
  console.log('source leg relayed; waiting for the destination');

  // --- The destination verdict ---
  const deliveredBy = Date.now() + DELIVERY_TIMEOUT_MS;
  for (;;) {
    text = await bodyText(page);
    if (DELIVERED.test(text)) { console.log(`PASS: deposited on ${DEST_NAME}`); break; }
    if (RECOVERED.test(text)) { await shot('recovered'); fail(`the ${DEST_NAME} deposit did not run and the bridge paid the fallback address instead`); }
    if (FAILED.test(text)) { await shot('failed'); const at = text.search(FAILED); fail(`the ${DEST_NAME} deposit did not complete: ${text.slice(Math.max(0, at - 100), at + 300)}`); }
    if (Date.now() > deliveredBy) { await shot('no-verdict'); fail(`no delivery verdict within ${DELIVERY_TIMEOUT_MS / 60_000} minutes`); }
    await sleep(15_000);
  }
  await shot('delivered');
  const after = await op.getBalance({ address: acct.address });
  console.log(`account now holds ${formatEther(after)} ETH on ${SOURCE_NAME} (spent ${formatEther(balance - after)} this run, gas included)`);
} catch (err) {
  await shot('error').catch(() => {});
  console.error(appLogs.slice(-20).join('\n'));
  console.error(`\nFAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
