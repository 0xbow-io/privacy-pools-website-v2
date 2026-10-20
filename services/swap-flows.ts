// Swaps SDK flows 1, 3 and the cross-chain bridge poll, per
// swaps_sdk_integration_guide_for_ui.md.
//
// Flow 2 (withdraw + swap to a wallet) already lives in services/intent-swaps.ts
// and drives the swap modal and the withdraw modal's "Receive as" compose.
// This module adds the two the app did not have:
//
//   Flow 1  swapAndDeposit — wallet token X → swap → SHIELDED token Y.
//           Nothing was shielded before; something is after.
//   Flow 3  reshield       — shielded token A → shielded token B, same chain,
//           funds never touch a wallet.
//
//   Flow 4  cross-chain reshield — shielded A here → shielded B in another
//           chain's pool. Implemented below (runReshieldCrosschain); no UI
//           drives it yet, and no route has been proven end to end. See
//           crossChainReshieldSupported in config/intent-swaps.ts for the gate
//           and what it deliberately cannot check.
//
// EVERYTHING below is typed against the shapes in the INSTALLED dist, not the
// guide's prose, because the two already disagree in one place: the guide's
// flow-3 relay snippet passes `depositNote: quote.depositNote`, and neither
// PreparedReshieldQuote nor ReshieldParams has that field in the vendored
// bundle. The guide itself says the integration tests are more trustworthy
// than the doc; the installed types are more trustworthy still.

import { assertIntentDepositTarget, isConfiguredShareTarget } from '@/config/intent-targets';
import { CROSS_CHAIN_DENY_EXCHANGES, NATIVE_ASSET_ADDRESS, swapInputUnits } from '@/config/intent-swaps';
import {
  isLifiApprovalTarget,
  isLifiExecutor,
  lifiAddressesKnownForChain,
} from '@/config/lifi-addresses';
import { displayTokenSymbol, isShareSymbol, tokenAmountLabel, approxUnderlyingText } from '@/services/share-display';
import type { Address, Hash, Hex, SwapStatusLike } from '@/services/sdk-types';
import { prepareSizedAgain } from '@/services/yield-sizing-race';

/**
 * LiFi/relayer swap lifecycle. Derived from the canonical `SwapStatusLike` in
 * services/sdk-types.ts rather than restated, so the two can't drift.
 */
export type SwapFlowStatus = SwapStatusLike['status'];

// ─── Flow 1: swap into a deposit ──────────────────────────────────────────

/**
 * What `prepareSwapAndDeposit` gives back. `approvalTx` is non-null when the
 * input token still needs an allowance for LiFi's router — that is a SEPARATE
 * wallet transaction the UI must send and wait for first.
 */
export interface PreparedSwapDepositLike {
  /**
   * The destination note this deposit will mint, as the SDK prepared it. The
   * SDK persists it PENDING in the destination chain's bucket at prepare time;
   * a cross-chain bridge that delivers but whose deposit call fails leaves it
   * stranded there, so the bridge watcher needs the commitment to remove it.
   */
  pendingNote?: { commitment?: Hash; tokenId?: Address; value?: Hex; label?: Hex; isOwned?: boolean };
  inputToken: Address;
  estimatedInputAmount: Hex;
  inputAmountUSD?: string;
  depositAmountUSD?: string;
  approvalAddress: Address;
  approvalTx: unknown | null;
  /**
   * SDK 4567778d: every approval in order, an approve(0) reset first when the
   * token holds a non-zero, insufficient allowance (Tether-style USDT reverts a
   * non-zero to non-zero approve). `approvalTx` is the last of these, or null.
   */
  approvalTxs?: unknown[];
  transactionData: Hex;
  transactionTo: Address;
  msgValue: Hex;
  /** Seconds. */
  estimatedDuration: number;
}

/**
 * Only `prepareSwapAndDeposit` is used.
 *
 * `executeSwapAndDeposit` is deliberately NOT called, even though it exists and
 * looks like the obvious counterpart. It submits through the SDK's
 * `entrypointInteractor.submitTransaction`, which requires a `walletInteractor`
 * — and ppv2 submits every transaction through wagmi (`sendTransactionAsync`) so
 * the user's connected wallet stays the single signer. (A cross-chain shield
 * does now hand the session a source-chain wallet interactor, because the
 * config's type demands one, but nothing on this path calls it — see
 * services/wallet-interactor.ts.) Calling execute here would also send the
 * input-token approval itself, double-prompting on top of ours.
 *
 * So this flow uses the SDK for the calldata and ppv2's own submit path for the
 * transactions, exactly like the existing deposit flow does with
 * `prepareDeposit`.
 */
/**
 * The note the SDK hands a blind recipient's `noteData` builder once the
 * deposit is fixed (SDK NoteDataBuilderInput): the value is the one actually
 * committed, shares for a yield pool.
 */
export interface SwapDepositNoteLike {
  tokenId: Address;
  value: Hex;
  noteAddressHash: Hex;
  depositSecret: Hex;
  label: Hex;
  commitment: Hex;
}

/**
 * Who the deposit is for, in the SDK's depositFor forms (DEV-489): a
 * registered recipient by address, or a blind one by noteAddressHash with our
 * own announcement. Omitted, the deposit is the session owner's.
 */
export type SwapDepositRecipient =
  | { discoveryData: { evmAddress: Address } }
  | {
      noteAddressHash: Hex;
      depositSecret?: Hex;
      noteData?: { hint: Hex; data: Hex } | ((note: SwapDepositNoteLike) => { hint: Hex; data: Hex });
    };

export interface SwapDepositSessionLike {
  prepareSwapAndDeposit(params: {
    fromChainId: number;
    inputToken: Address;
    depositToken: Address;
    depositAmount: Hex;
    recipient?: SwapDepositRecipient;
  }): Promise<PreparedSwapDepositLike>;
}

/** A prepared transaction as the SDK hands it over, ready for wagmi. */
export interface PreparedTxLike {
  to: Address;
  data: Hex;
  value?: Hex;
}

/** Outcome of submitting one transaction through the wallet. */
export interface SubmittedTx {
  txHash: Hex | null;
  /** From the mined receipt. False means it reverted. */
  success: boolean;
}

export type SubmitSwapTx = (
  tx: PreparedTxLike,
  kind: 'approval' | 'swap' | 'revoke',
  /** Called only after the wallet returned a hash, before waiting for its receipt. */
  onBroadcast?: (hash: Hex) => void,
) => Promise<SubmittedTx>;

/** Raised when a prepared transaction doesn't match what it claims to be. */
export class UnexpectedSwapTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedSwapTxError';
  }
}

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

/**
 * The allowance an already-validated `approve(address,uint256)` calldata grants.
 * Only ever called on calldata `assertSwapApprovalTx` has accepted, so the
 * layout is known: selector, spender word, amount word.
 */
export function approvedAmountOf(data: string): bigint {
  const word = data.slice(74, 138);
  return word.length === 64 ? BigInt(`0x${word}`) : 0n;
}

/**
 * Validate a LiFi-supplied approval before it is put in front of the user.
 *
 * Mirrors the SDK's own `assertApprovalTx`: the transaction must target the
 * INPUT TOKEN, must actually be `approve(address,uint256)`, and must approve
 * the spender the route said it would. This is a real check, not ceremony — the
 * calldata comes from an external quote service, and an approve() to an
 * unexpected spender is precisely how a bad route would drain an allowance.
 */
export function assertSwapApprovalTx(
  approvalTx: unknown,
  inputToken: Address,
  approvalAddress: Address,
): PreparedTxLike {
  const tx = approvalTx as Partial<PreparedTxLike> | null | undefined;
  if (!tx || typeof tx.to !== 'string' || typeof tx.data !== 'string') {
    // No "Nothing was sent" here: this validator also runs on the RETRY
    // top-up, by which time an approval has already mined. It says only what
    // it knows, which is that this approval was refused before signing.
    throw new UnexpectedSwapTxError('The route returned a malformed token approval, so it was not signed.');
  }
  if (tx.to.toLowerCase() !== inputToken.toLowerCase()) {
    throw new UnexpectedSwapTxError(
      `The token approval targets ${tx.to} instead of the token being spent (${inputToken}). Refusing to sign it.`,
    );
  }
  if (!tx.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
    throw new UnexpectedSwapTxError('The token approval is not an approve() call. Refusing to sign it.');
  }
  // approve(address spender, uint256 value): the spender is the first 32-byte
  // word after the 4-byte selector, right-aligned in it.
  const spenderWord = tx.data.slice(10, 74);
  if (spenderWord.length < 64) {
    throw new UnexpectedSwapTxError('The token approval calldata is truncated. Refusing to sign it.');
  }
  const spender = `0x${spenderWord.slice(24)}`;
  if (spender.toLowerCase() !== approvalAddress.toLowerCase()) {
    throw new UnexpectedSwapTxError(
      `The token approval would let ${spender} spend your ${inputToken}, but the route named ${approvalAddress}. Refusing to sign it.`,
    );
  }
  return { to: tx.to as Address, data: tx.data as Hex, ...(tx.value ? { value: tx.value as Hex } : {}) };
}

/**
 * Decide who may receive the input-token allowance, and refuse if that cannot
 * be answered from the route itself.
 *
 * The rule is short on purpose, because the failure it replaces was a long one:
 *
 *   1. The spender is the route's declared `approvalAddress`. Nothing else.
 *   2. That address must be one LiFi publishes as an approval target for this
 *      chain (config/lifi-addresses.ts). Those are access-controlled: the proxy
 *      answers only to the Diamond.
 *   3. If it is missing, or is anything else, the flow stops here with nothing
 *      signed.
 *
 * There is no fourth clause and there must never be one. This app does not get
 * to choose a spender. A route whose declared target cannot be verified is a
 * route that does not run; a standing allowance on a contract anyone may call
 * is worth more than a working conversion.
 *
 * `swapTarget` is taken only so the refusal can be specific when the route
 * pointed at an Executor, which is the shape that produced the loss.
 */
export function assertApprovalSpender(
  chainId: number,
  approvalAddress: Address | undefined | null,
  swapTarget?: Address | null,
  /**
   * What has already gone out, as the caller can honestly state it.
   *
   * This validator also runs on a RE-PREPARED route, by which time an approval
   * may have mined. Its own refusal is local ("this approval was not signed"),
   * so the sentence about the run as a whole is supplied rather than assumed;
   * callers past the first wallet prompt pass '' and let their own accounting
   * append the truth.
   */
  sendsSoFar = 'Nothing was sent.',
): Address {
  const account = sendsSoFar ? ` ${sendsSoFar}` : '';
  if (!lifiAddressesKnownForChain(chainId)) {
    throw new UnexpectedSwapTxError(
      `This app has no verified approval address for chain ${chainId}, so the token approval was not signed.${account} Deposit the token directly instead.`,
    );
  }
  if (!approvalAddress) {
    throw new UnexpectedSwapTxError(
      `The route did not say which contract should be allowed to spend your token, so the token approval was not signed.${account} Try again in a moment, or deposit the token directly.`,
    );
  }
  if (isLifiApprovalTarget(chainId, approvalAddress)) return approvalAddress;
  const executorNote = isLifiExecutor(chainId, approvalAddress) || isLifiExecutor(chainId, swapTarget)
    ? ' That contract can be called by anyone, so an approval to it is not safe to sign.'
    : '';
  throw new UnexpectedSwapTxError(
    `The route asked to let ${approvalAddress} spend your token, which is not one of this chain's verified approval addresses.${executorNote} The token approval was not signed.${account} Try again in a moment, or deposit the token directly.`,
  );
}

/** Display figures for the swap-and-deposit confirmation card. */
export interface SwapDepositDisplay {
  /** Input the wallet is expected to spend, token-denominated. */
  inputAmountText: string;
  inputAmountUSD: string | null;
  depositAmountText: string;
  depositAmountUSD: string | null;
  /** Human duration, e.g. "~45s" / "~2m". */
  durationText: string | null;
  /** True when the wallet must approve the input token first. */
  needsApproval: boolean;
}

/** "~45s" / "~2m" / null when the SDK gave no estimate. */
export function formatSwapDuration(seconds: number | undefined | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}

/**
 * A USD figure the SDK may omit, may send as '0', or may send unparseable.
 * Anything that is not a real positive number becomes null so the UI omits
 * the line rather than rendering "$0" or "$NaN" next to a real amount.
 */
export function normalizeUsd(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed.replace(/[$,]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `$${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Decimal string for a base-unit hex/bigint amount, trailing zeros trimmed. */
export function formatUnitsText(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracText = frac.toString().padStart(decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  if (fracText.length === 0) fracText = '';
  const body = fracText ? `${whole.toString()}.${fracText}` : whole.toString();
  return negative ? `-${body}` : body;
}

/**
 * How many fraction digits an amount needs before the number stops being true.
 *
 * `formatUnitsText`'s flat six digits is right for a 6-decimals stablecoin and
 * wrong for an 18-decimals one on the same screen: a reshield's ETH vetting fee
 * of 0.0000032836 renders as "0.000003", and a slightly smaller one renders as
 * "0" — not a rounding of the fee but a different claim about it. Widen the
 * window until `significant` digits survive the leading zeros, never past the
 * token's own decimals, and never BELOW the six digits every other amount in
 * the app already shows (so a 6-decimals asset is untouched).
 */
export function fractionDigitsFor(value: bigint, decimals: number, significant = 4): number {
  if (decimals <= 6) return decimals;
  const abs = value < 0n ? -value : value;
  const frac = abs % 10n ** BigInt(decimals);
  if (frac === 0n) return 6;
  const leadingZeros = decimals - frac.toString().length;
  return Math.min(decimals, Math.max(6, leadingZeros + significant));
}

/**
 * Round an amount DOWN to the digits `fractionDigitsFor` would show, so a
 * derived figure (a percentage of a cap) is readable and never exceeds the
 * value it was taken from.
 */
export function floorToDisplayPrecision(value: bigint, decimals: number): bigint {
  const drop = decimals - fractionDigitsFor(value, decimals);
  if (drop <= 0 || value <= 0n) return value;
  const step = 10n ** BigInt(drop);
  return value - (value % step);
}

/**
 * Display text for a decimal amount string (the entered or quote-sized amount),
 * cut to the same precision `formatUnitsText` gives base-unit amounts. The
 * string itself stays the exact value the transaction uses.
 */
export function formatAmountText(amount: string, decimals: number): string {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match || (!match[1] && !match[2])) return '0';
  const frac = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const value = BigInt(match[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return formatUnitsText(value, decimals, fractionDigitsFor(value, decimals));
}

/**
 * Shape a prepared swap-and-deposit for the confirmation screen.
 *
 * `estimatedInputAmount` is an ESTIMATE — the wallet may spend slightly more
 * or less within slippage — so the caller should label it as such rather than
 * presenting it as an exact debit.
 */
export function shapeSwapDepositForDisplay(
  prepared: PreparedSwapDepositLike,
  input: { symbol: string; decimals: number },
  deposit: { symbol: string; decimals: number; amountWei: bigint },
): SwapDepositDisplay {
  return {
    inputAmountText: `${formatUnitsText(hexToBigInt(prepared.estimatedInputAmount), input.decimals)} ${displayTokenSymbol(input.symbol)}`,
    inputAmountUSD: normalizeUsd(prepared.inputAmountUSD),
    depositAmountText: `${formatUnitsText(deposit.amountWei, deposit.decimals)} ${displayTokenSymbol(deposit.symbol)}`,
    depositAmountUSD: normalizeUsd(prepared.depositAmountUSD),
    durationText: formatSwapDuration(prepared.estimatedDuration),
    needsApproval: prepared.approvalTx !== null && prepared.approvalTx !== undefined,
  };
}

/**
 * One broadcast approval, or an allowance read from the chain.
 *
 * Kept so that every later failure can say what the user actually paid for.
 */
export interface SentApprovalRecord {
  txHash: Hex | null;
  spender: Address;
  /** Base units the spender may move once this approval is mined. */
  amount: bigint;
  /** True only for a successful receipt or an observed allowance. */
  success: boolean;
  /** A hash exists, but no receipt has resolved. Zero allowance cannot clear it. */
  pending?: boolean;
  /**
   * Where this row came from.
   *
   * 'sent' is a transaction this run put through the wallet. 'observed' is an
   * allowance this run READ from the token and cannot attribute to itself: it
   * may predate the run entirely. Both bear on what is standing and therefore
   * on cleanup; only 'sent' bears on what was broadcast and cost gas, so a
   * reconciliation read can never be quoted back as "an approval was sent".
   * Omitted means 'sent', so an existing record keeps its meaning.
   */
  origin?: 'sent' | 'observed';
}

/** Rows this run actually broadcast, as opposed to allowances it merely read. */
export function broadcastApprovals(sent: readonly SentApprovalRecord[]): SentApprovalRecord[] {
  return sent.filter((record) => record.origin !== 'observed');
}

/**
 * How the swap transaction itself stands when an error is being written.
 *
 * 'reverted' is a resolved receipt that failed. 'unknown' is a submit that
 * threw: the wallet may have broadcast it before losing the tab, the
 * connection or its patience, and this app cannot tell that from a rejection.
 * Either way something may have gone out, so neither may be reported as a run
 * in which nothing was sent.
 */
export type SwapSubmissionState = 'reverted' | 'unknown';

/**
 * The sentence an error may honestly use about what has been broadcast so far.
 *
 * "Nothing was sent." is true only while the wallet has signed nothing. Past
 * the first approval it is a claim the user can check against their own wallet
 * history and it reads as the app having taken their tokens and lied about it
 * (QA, 2026-09-21: "It says 'Nothing was sent', but it took my USDC :S"). So
 * every failure on the post-submit side of this flow reports the approval
 * instead: that it mined, that it cost gas, and what allowance it left behind.
 */
export function describeSwapSendsSoFar(
  sent: readonly SentApprovalRecord[],
  token?: { symbol: string; decimals: number },
  cleanup?: AllowanceCleanup,
  swap?: SwapSubmissionState | null,
): string {
  const symbol = token?.symbol ?? 'your pay token';
  const stillLive = liveAllowancesAfter(sent);
  const broadcast = broadcastApprovals(sent);
  const pending = broadcast.filter((record) => record.pending);
  if (pending.length > 0) {
    const transactions = pending.map((record) => `${record.txHash} (spender ${record.spender})`).join(', ');
    const standing = cleanup?.failed.length
      ? ` A confirmed spending permission also remains. Reset it in your wallet.`
      : '';
    return `Nothing was swapped or deposited. Approval confirmation is still unknown: ${transactions}. Check the transaction in your wallet. If it confirms, reset the ${symbol} spending permission before leaving. Try again here to check its confirmation and reset it.${standing}`;
  }
  if (broadcast.length === 0 && stillLive.size === 0) {
    if (swap === 'unknown') {
      return 'The swap transaction was already sent and this app could not confirm what the swap did. Check it in your wallet before trying again.';
    }
    if (swap === 'reverted') {
      return `No ${symbol} moved, but the swap transaction was sent and cost gas.`;
    }
    return 'Nothing was sent.';
  }
  const many = broadcast.length > 1;
  // An allowance this run only READ is not a transaction it sent. Saying so is
  // the difference between reporting a standing permission and billing the
  // user for gas on a prompt they declined.
  const approvalsPhrase = broadcast.length === 0
    ? null
    : many ? `${broadcast.length} approvals were` : 'an approval was';
  const opening = swap === 'unknown'
    ? `The swap transaction was already sent${approvalsPhrase ? `, after ${many ? `${broadcast.length} approvals` : 'an approval'} that also cost gas` : ''}, and this app could not confirm what the swap did. Check it in your wallet before trying again.`
    : approvalsPhrase === null
      ? `No ${symbol} moved, and this run sent no approval of its own.`
      : swap === 'reverted'
        ? `No ${symbol} moved, but the swap transaction and ${many ? `${broadcast.length} approvals` : 'an approval'} were sent and cost gas.`
        : `No ${symbol} moved, but ${approvalsPhrase} already sent and cost gas.`;
  if (stillLive.size === 0) {
    return `${opening} It left no spending permission behind.`;
  }
  if (cleanup && cleanup.failed.length === 0 && cleanup.revoked.length > 0) {
    return `${opening} The spending permission on your ${symbol} has been set back to zero.`;
  }
  const allowance = [...stillLive.values()].at(-1);
  const allowanceText = allowance !== undefined && token
    ? ` up to ${formatUnitsText(allowance, token.decimals)} ${displayTokenSymbol(token.symbol)}`
    : '';
  if (cleanup && cleanup.failed.length > 0) {
    return `${opening} The swap router can still spend${allowanceText} and setting that back to zero did not go through. Revoke it in your wallet before you leave this page.`;
  }
  return `${opening} That leaves the swap router able to spend${allowanceText}. Revoke it if you are not retrying.`;
}

/**
 * The slippage the swap-deposit route actually executes with.
 *
 * Same-chain 1% is deliberate (QA 2026-08-18, OP tx 0x39d78563…: the SDK's
 * 0.5% default under-delivered often enough to revert the whole transaction).
 * Cross-chain keeps the SDK's own 3%: a bridge leg needs that room, and both
 * services/lifi-quote.ts and the shield preview already assume it.
 */
export function swapDepositSlippage(fromChainId: number, toChainId: number): number {
  return fromChainId === toChainId ? 0.01 : 0.03;
}

/**
 * Deposit targets to try, largest first, when the route under-delivers.
 *
 * The previous ladder shrank 1% per retry over 3 attempts, so the smallest
 * target it ever reached was 0.99² = 98.01% of the original: a 1.99% total
 * reduction against a floor that is 1% same-chain and 3% CROSS-chain. A
 * cross-chain shortfall could therefore never be cleared, which is what QA hit
 * on 2026-09-21 ("haven't been able to make swap on deposit work"). The steps
 * now start just under the executing floor and double from there, so the ladder
 * spans the shortfall the floor permits instead of a fraction of it.
 */
export function swapDepositTargetLadder(target: bigint, slippage: number): bigint[] {
  // The floor plus the same 75bp margin services/cross-pay-sizing.ts uses.
  const firstCut = slippage + 0.0075;
  return [
    target,
    ...[1, 2, 4].map((multiple) => {
      const cut = Math.min(firstCut * multiple, 0.5);
      return (target * BigInt(Math.round((1 - cut) * 10_000))) / 10_000n;
    }),
  ];
}

/** Raised when a swap-deposit precondition fails BEFORE any wallet prompt. */
export class SwapDepositPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapDepositPreflightError';
  }
}

/**
 * The allowances still standing after a run that did not spend them, and what
 * happened when this flow tried to take them back.
 */
export interface AllowanceCleanup {
  /** Spenders that held a non-zero allowance when the flow gave up. */
  live: Address[];
  /** Of those, the ones an approve(0) mined for. */
  revoked: Address[];
  /** Of those, the ones still holding an allowance. */
  failed: Address[];
}

export const EMPTY_CLEANUP: AllowanceCleanup = { live: [], revoked: [], failed: [] };

/**
 * The allowance each spender is left holding, by the LAST approval that mined
 * for it. A reverted approval changed nothing, so it does not count.
 */
export function liveAllowancesAfter(sent: readonly SentApprovalRecord[]): Map<string, bigint> {
  const bySpender = new Map<string, bigint>();
  for (const record of sent) {
    if (record.pending || !record.success) continue;
    bySpender.set(record.spender.toLowerCase(), record.amount);
  }
  for (const [spender, amount] of [...bySpender]) {
    if (amount === 0n) bySpender.delete(spender);
  }
  return bySpender;
}

/**
 * The approve() amounts that take a spender from `current` to `needed`.
 *
 * One place, because there were three and two of them were wrong. Tether-style
 * tokens revert an approve() that moves a NON-ZERO allowance to another
 * non-zero value, so the only sequence that works from a partial allowance is
 * a reset and then the real amount. The SDK's own prepared sequence does this;
 * the two top-ups this file builds for itself did not, and a re-prepared route
 * discarded the SDK's reset along with its calldata.
 *
 * `current === null` means the allowance could not be read. Unknown is not
 * zero: the sequence that is safe for BOTH is the reset-first one, so unknown
 * takes it rather than being guessed down to a single approve().
 */
export function approvalAmountPlan(current: bigint | null, needed: bigint): bigint[] {
  if (current !== null && current >= needed) return [];
  if (current === 0n) return [needed];
  return [0n, needed];
}

/** `approve(spender, amount)` calldata for the token this flow is paying with. */
export function buildApprovalTx(token: Address, spender: Address, amount: bigint): PreparedTxLike {
  return {
    to: token,
    data: `${ERC20_APPROVE_SELECTOR}${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex,
  };
}

/** `approve(spender, 0)` calldata for the token this flow was paying with. */
export function buildRevokeApprovalTx(token: Address, spender: Address): PreparedTxLike {
  return {
    to: token,
    data: `${ERC20_APPROVE_SELECTOR}${spender.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}` as Hex,
  };
}

/**
 * Take back every allowance an abandoned run left behind.
 *
 * A failed swap-deposit used to walk away from a mined approval, and an
 * allowance nobody is going to spend is worth exactly as much to a stranger as
 * to its owner (mainnet, 2026-09-21: an approval this flow left behind was
 * spent 85 seconds after the UI told the user the attempt was over). So every
 * exit past the first mined approval comes through here first.
 *
 * This NEVER throws. It runs while another error is already on its way to the
 * user, and that error is the one they need; a wallet rejection here must not
 * replace it. What it returns is the honest account the message then quotes.
 */
export async function revokeLiveApprovals(
  sent: readonly SentApprovalRecord[],
  token: Address,
  submit: SubmitSwapTx,
  onStep?: (step: 'prepare' | 'approve' | 'submit' | 'revoke', detail?: string) => void,
): Promise<AllowanceCleanup> {
  const outstanding = liveAllowancesAfter(sent);
  // An unresolved approval could mine after a reset. Wait for its receipt
  // before deciding which permission needs resetting.
  for (const record of sent) {
    if (record.pending) outstanding.delete(record.spender.toLowerCase());
  }
  if (outstanding.size === 0) return EMPTY_CLEANUP;
  const cleanup: AllowanceCleanup = { live: [...outstanding.keys()] as Address[], revoked: [], failed: [] };
  for (const spender of cleanup.live) {
    try {
      // Inside the boundary on purpose: `onStep` is a caller's callback, and a
      // callback that throws here would abort the cleanup and replace the
      // error the user actually needs with its own.
      onStep?.('revoke');
      const result = await submit(buildRevokeApprovalTx(token, spender), 'revoke');
      if (result.success) cleanup.revoked.push(spender);
      else cleanup.failed.push(spender);
    } catch {
      cleanup.failed.push(spender);
    }
  }
  return cleanup;
}

/**
 * Flow 1 end to end: validate the route, send the input-token approval only if
 * the route needs one and is already known to work, then submit the swap.
 *
 * The approval is the whole reason this is not a one-liner, and its ORDER is
 * the reason this function is shaped the way it is. It used to go first,
 * because the swap is only simulatable once the executor can pull the token,
 * and a route that then failed simulation left that allowance standing with
 * nothing to spend it on but a stranger. `simulateWithAllowance` closes that:
 * `eth_call` with a state override grants the allowance to the SIMULATION
 * only, so the whole retry ladder runs before the wallet is asked for
 * anything. Only a route that has already simulated clean is approved, and the
 * swap follows immediately.
 *
 * Where the override is not available (the caller could not locate the token's
 * allowance slot, or the node refuses the argument) the old order is still the
 * only one that works, so it remains as a fallback with `revokeLiveApprovals`
 * behind it.
 */
export async function runSwapAndDeposit(
  session: SwapDepositSessionLike,
  params: {
    fromChainId: number;
    /** Destination chain, never inferred from the wallet/source chain. */
    depositChainId: number;
    inputToken: Address;
    depositToken: Address;
    depositAmountWei: bigint;
    /**
     * Permit inputToken === depositToken. True only for a CROSS-CHAIN deposit,
     * where the same address on two chains is a bridge rather than a pointless
     * swap (the native asset shares one sentinel address everywhere).
     */
    allowSameToken?: boolean;
    /**
     * Submit one transaction through the wallet and resolve once it is MINED,
     * reporting whether the receipt says it succeeded. Both the approval and
     * the swap go through this.
     */
    submit: SubmitSwapTx;
    /** Caller-owned recovery rows, retained across retries for this wallet/chain/token. */
    approvalRecovery?: SentApprovalRecord[];
    /** Own-wallet receipts only. Null means the transaction is not confirmed yet. */
    readApprovalReceipt?: (hash: Hex) => Promise<{ success: boolean } | null>;
    /**
     * Read the connected wallet's current ERC-20 allowance for `spender`,
     * which is always the route's declared approval address. Used to
     * second-guess a quote that planned no approval, and to top up a
     * re-prepared route that needs a little more. A read that fails leaves
     * the allowance unknown, and an unknown allowance never changes who the
     * spender is.
     */
    readAllowance?: (token: Address, spender: Address) => Promise<bigint>;
    /**
     * Dry-run a transaction from the connected wallet (eth_call). Used after
     * the approval mines to catch the route under-delivering for the deposit
     * before the user pays gas for a guaranteed revert.
     */
    simulate?: (tx: PreparedTxLike) => Promise<{ ok: boolean; revertData?: string }>;
    /**
     * Dry-run the swap AS IF the listed spenders already held `amount` of the
     * input token, granting nothing on-chain. `supported: false` means the
     * caller could not build that override (unknown allowance slot, or a node
     * that refuses the argument) and the flow falls back to approving first.
     *
     * This is what lets a route be proven before the user grants anything.
     */
    simulateWithAllowance?: (
      tx: PreparedTxLike,
      grant: { token: Address; spenders: Address[]; amount: bigint },
    ) => Promise<{ ok: boolean; supported: boolean; revertData?: string }>;
    onStep?: (step: 'prepare' | 'approve' | 'submit' | 'revoke', detail?: string) => void;
    /**
     * Consent gate, called once the route is known and BEFORE any wallet
     * prompt. Resolve false to abort without sending anything.
     *
     * This exists because the entered amount is the DEPOSIT target: the wallet
     * is about to be asked for an amount of the pay token the user never typed
     * and has not seen. It is also the right place to check that the pay token's
     * balance (and native gas) can actually cover the route — an approval that
     * mines before a doomed swap costs real gas and leaves an allowance behind.
     */
    confirmPrepared?: (
      display: SwapDepositDisplay,
      prepared: PreparedSwapDepositLike,
    ) => Promise<boolean>;
    /**
     * The swap transaction has a hash: the wallet broadcast it, it has not
     * mined yet. Lets the caller show its pending row now rather than after
     * the receipt (DEV-433). Carries the route and the deposit amount it was
     * prepared for, which a refit can make smaller than the one requested.
     * A throw here is swallowed: it must never fail the flow.
     */
    onSwapBroadcast?: (hash: Hex, prepared: PreparedSwapDepositLike, depositAmountWei: bigint) => void;
    /**
     * Deposit for someone else (DEV-489): forwarded to every prepare, so each
     * re-prepared route is the recipient's too. Omitted, nothing changes.
     */
    recipient?: SwapDepositRecipient;
    /**
     * Last step before the swap's wallet prompt, with the route that will be
     * signed. A blind recipient's claim material is made durable here, while
     * nothing has moved yet. A throw stops the flow and hands any approval
     * back, like any other failure after the first prompt.
     */
    beforeSwapSubmit?: (prepared: PreparedSwapDepositLike, depositAmountWei: bigint) => Promise<void>;
    /** Symbols/decimals for shaping `onPrepared`; omit to skip the callback. */
    display?: {
      input: { symbol: string; decimals: number };
      deposit: { symbol: string; decimals: number };
    };
  },
): Promise<{ prepared: PreparedSwapDepositLike; txHash: Hex | null; depositAmountWei: bigint }> {
  // This flow prepares against the DESTINATION chain's session, so a share
  // target is built by that chain's router even when the input token and the
  // LiFi transaction live on another chain. Crossing chains still means the
  // bridge executes the deposit, which a plain native coin cannot take.
  const crossChain = params.fromChainId !== params.depositChainId;
  assertIntentDepositTarget(params.depositToken, params.depositChainId, crossChain);
  if (params.depositAmountWei <= 0n) {
    throw new SwapDepositPreflightError('Enter an amount greater than zero.');
  }
  if (params.inputToken.toLowerCase() === params.depositToken.toLowerCase()
    && !params.allowSameToken) {
    // Same token in and out on ONE chain is an ordinary deposit; routing it
    // through LiFi would pay swap fees for nothing. Across chains it is a
    // bridge, and for the native asset it is unavoidable: ETH is the same
    // sentinel address on every EVM chain, so address equality cannot tell the
    // two ends apart. Callers that really are crossing chains say so.
    throw new SwapDepositPreflightError('Pick a different token to pay with, or deposit it directly.');
  }

  params.onStep?.('prepare');
  // Every approval this flow has put through the wallet. Once it is non-empty
  // no error below may say "Nothing was sent", because something was.
  const sent: SentApprovalRecord[] = [...(params.approvalRecovery ?? [])];
  const recovery = params.approvalRecovery ?? [];
  const forgetRecovered = (record: SentApprovalRecord) => {
    const index = recovery.indexOf(record);
    if (index !== -1) recovery.splice(index, 1);
  };
  const payToken = params.display?.input;
  let cleanup: AllowanceCleanup = EMPTY_CLEANUP;
  let attemptedRouteReset: Address | null = null;
  /**
   * What the swap transaction itself is doing, once one has been put through
   * the wallet. `sent` tracks approvals only, so without this a swap that was
   * submitted and reverted ended its own error with "Nothing was sent."
   */
  let swapState: SwapSubmissionState | null = null;
  const soFar = () => describeSwapSendsSoFar(sent, payToken, cleanup, swapState);
  const cleanUp = async () => {
    // Do not repeat a reset prompt the user just declined or whose wait failed.
    const remaining = sent.filter((record) => record.spender.toLowerCase() !== attemptedRouteReset);
    cleanup = await revokeLiveApprovals(remaining, params.inputToken, params.submit, params.onStep);
    const live = liveAllowancesAfter(sent);
    if (attemptedRouteReset && live.has(attemptedRouteReset)) {
      cleanup = {
        live: [...cleanup.live, attemptedRouteReset],
        revoked: cleanup.revoked,
        failed: [...cleanup.failed, attemptedRouteReset],
      };
    }
    const unresolved = new Set(sent.filter((record) => record.pending).map((record) => record.spender.toLowerCase()));
    for (const spender of cleanup.failed) {
      if (broadcastApprovals(sent).some((record) => record.spender.toLowerCase() === spender)) {
        unresolved.add(spender);
      }
    }
    // Keep the preceding grant too: a pending reset can later revert, and an
    // unavailable allowance read must not erase the grant it failed to clear.
    recovery.splice(0, recovery.length, ...sent.filter((record) => unresolved.has(record.spender.toLowerCase())));
  };
  /**
   * Give up, but hand back every allowance first.
   *
   * Every exit from the point of the first wallet prompt onwards goes through
   * here. `revokeLiveApprovals` cannot throw, so the message the user reads is
   * always the one that describes why the swap stopped, with an accurate line
   * about what is left standing appended by `soFar()` after the fact.
   */
  const abandon = async (
    Kind: typeof SwapDepositPreflightError | typeof UnexpectedSwapTxError,
    lead: string,
    /** What the user can do next. Last, so the account of what happened to the
     * allowance does not sit between the problem and the remedy. */
    tail?: string,
  ): Promise<never> => {
    await reconcileApprovals();
    await cleanUp();
    throw new Kind(`${lead} ${soFar()}${tail ? ` ${tail}` : ''}`.trim());
  };
  /**
   * Run a step that can throw on its own, and hand the allowances back if it
   * does.
   *
   * `abandon` covers the failures this flow decides on. This covers the ones it
   * is handed: the user rejecting the swap prompt, a wallet timing out, the
   * quote service dropping a re-prepare. Every one of them used to walk away
   * from a mined approval exactly like a failed simulation did. Below the first
   * approval it is a pass-through, so a route that fails before any wallet
   * prompt still raises its own error unchanged.
   */
  const guarded = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      await reconcileApprovals();
      // Nothing to add only if nothing is open: no approval on file AND no
      // swap transaction in flight. A submit that threw leaves the swap
      // unresolved, and the raw wallet error would end the message with no
      // account of it at all.
      if (sent.length === 0 && swapState === null) throw err;
      await cleanUp();
      const message = err instanceof Error ? err.message : String(err);
      throw new SwapDepositPreflightError(`${message} ${soFar()}`.trim());
    }
  };
  /**
   * Resolve known broadcasts by receipt before reading standing allowances.
   *
   * A wallet can throw after reporting its hash. Keep that transaction pending
   * until its receipt resolves; the current allowance cannot predict what it
   * will grant. Without a hash, an allowance read can still find a grant that
   * mined despite the wallet throwing, but cannot attribute it to this run.
   *
   * Reading rather than always revoking is what keeps the common case clean:
   * a user who declines the very first approval prompt granted nothing, and
   * must not be handed a second prompt to take back an allowance that does
   * not exist.
   */
  async function reconcileApprovals(): Promise<void> {
    for (const record of sent) {
      if (!record.pending || !record.txHash || !params.readApprovalReceipt) continue;
      try {
        const receipt = await params.readApprovalReceipt(record.txHash);
        if (receipt) {
          record.pending = false;
          record.success = receipt.success;
        }
      } catch { /* Keep the broadcast record until a receipt resolves it. */ }
    }
    if (!params.readAllowance) return;
    for (const spender of new Set(prompted)) {
      // An allowance read before the pending transaction mines cannot resolve
      // it. Do not retain that older observation after its receipt arrives.
      if (sent.some((record) => record.pending && record.spender.toLowerCase() === spender.toLowerCase())) continue;
      let actual: bigint;
      try {
        actual = await params.readAllowance(params.inputToken, spender);
      } catch {
        // An unreadable allowance stays unknown; the copy says nothing it
        // cannot back, and the record already on file stands.
        continue;
      }
      // Read each settled spender, including ones with a record. The record
      // says what this flow broadcast; the token says what is standing now,
      // and a swap that consumed the allowance before failing somewhere else
      // makes those two different. A revoke prompt for an allowance that is
      // already zero is a prompt for nothing.
      const recorded = liveAllowancesAfter(sent).get(spender.toLowerCase()) ?? 0n;
      if (recorded === actual) continue;
      // 'observed': this is what the token reports, not a transaction this run
      // can claim. A non-zero allowance here may predate the run entirely (a
      // declined USDT reset over an older approval reaches exactly this line),
      // and billing the user for gas on a prompt they declined is the same
      // kind of untruth as denying one they accepted.
      sent.push({ txHash: null, spender, amount: actual, success: true, origin: 'observed' });
    }
  }
  /** Every spender this flow has put an approval prompt in front of the user for. */
  const prompted: Address[] = [...new Set(sent.map((record) => record.spender))];
  if (sent.length > 0) {
    await abandon(
      SwapDepositPreflightError,
      'Check the approval from your previous attempt before starting another deposit.',
      'Once it is resolved, start the deposit again.',
    );
  }
  const prepareFor = async (depositAmountWei: bigint) => {
    try {
      return await session.prepareSwapAndDeposit({
        fromChainId: params.fromChainId,
        inputToken: params.inputToken,
        depositToken: params.depositToken,
        // The DEPOSIT amount is the target — the SDK solves backwards for the
        // input, which is why estimatedInputAmount comes back as an estimate.
        depositAmount: toHex(depositAmountWei),
        // Only present for someone else, so an own deposit's request is unchanged.
        ...(params.recipient ? { recipient: params.recipient } : {}),
      });
    } catch (err) {
      // The SDK builds a native-coin deposit as one swap-then-deposit call and
      // refuses when it cannot (no executor on this chain, or a swap that does
      // not guarantee the deposit's exact cost).
      if (!(err instanceof Error) || err.name !== 'NativeSwapDepositUnavailable') throw err;
      const coin = displayTokenSymbol(params.display?.deposit.symbol ?? 'the coin');
      const state = sent.length === 0 && swapState === null ? ` ${soFar()}` : '';
      throw new SwapDepositPreflightError(
        `This route cannot pay for the ${coin} deposit right now.${state} Try again in a moment, pay with another token, or shield ${coin} directly.`,
      );
    }
  };
  // A bridged deposit can cost more than the route guarantees to deliver, and
  // the SDK refuses it before anything is signed, carrying the amount that
  // fits (v2-monorepo#437). Prepare once more at that amount: the user confirms
  // the result below, so the smaller deposit is what they agree to.
  let depositAmountWei = params.depositAmountWei;
  let prepared: PreparedSwapDepositLike;
  try {
    prepared = await prepareSizedAgain(() => prepareFor(depositAmountWei));
  } catch (err) {
    const fits = crossChain ? affordableDepositAmount(err) : null;
    if (fits === null || fits <= 0n || fits >= depositAmountWei) throw err;
    console.log('[SwapDeposit] deposit sized above the bridge guarantee, preparing at', fits.toString());
    depositAmountWei = fits;
    prepared = await prepareSizedAgain(() => prepareFor(depositAmountWei));
  }

  if (params.confirmPrepared && params.display) {
    const approved = await params.confirmPrepared(
      shapeSwapDepositForDisplay(prepared, params.display.input, {
        ...params.display.deposit,
        amountWei: depositAmountWei,
      }),
      prepared,
    );
    if (!approved) {
      throw new SwapDepositPreflightError('Cancelled before anything was sent. No tokens were spent.');
    }
  }

  // ── The ceiling the user agreed to ────────────────────────────────────
  //
  // Everything below may REPLACE this quote: both retry ladders re-prepare
  // against a smaller deposit target when a route cannot deliver. A smaller
  // target is not a smaller bill. The input side is solved backwards by the
  // quote service, so a re-prepare that lands on another path, or simply
  // later prices, can come back wanting MORE of the pay token than the amount
  // on the card the user pressed confirm on, and the consent and affordability
  // checks above run exactly once.
  //
  // So the confirmed input is kept as a ceiling and every replacement is
  // measured against it before anything is approved or submitted. A
  // replacement that costs more is not the deal that was agreed to, and it
  // stops here instead of being signed.
  const confirmedInput = hexToBigInt(prepared.estimatedInputAmount);
  const confirmedValue = hexToBigInt(prepared.msgValue ?? '0x0');
  const overCeiling = (candidate: PreparedSwapDepositLike): string | null => {
    const input = hexToBigInt(candidate.estimatedInputAmount);
    const value = hexToBigInt(candidate.msgValue ?? '0x0');
    if (input <= confirmedInput && value <= confirmedValue) return null;
    // The two figures are denominated in DIFFERENT tokens: the input in the
    // pay token, the msgValue in the chain's native asset. Naming the one that
    // actually went up, in its own units, is the difference between a number
    // the user can check and a number that is simply wrong.
    const overspend = input > confirmedInput
      ? {
        symbol: payToken?.symbol ?? 'your pay token',
        was: payToken ? formatUnitsText(confirmedInput, payToken.decimals) : confirmedInput.toString(),
        now: payToken ? formatUnitsText(input, payToken.decimals) : input.toString(),
      }
      : {
        symbol: 'in native value',
        was: formatUnitsText(confirmedValue, 18),
        now: formatUnitsText(value, 18),
      };
    return `The retry route wants ${overspend.now} ${displayTokenSymbol(overspend.symbol)}, more than the ${overspend.was} you confirmed, so it was not approved or submitted. Start the deposit again to see the new amount before agreeing to it.`;
  };

  // ── Validate the route BEFORE granting anything ───────────────────────
  //
  // The retry ladder used to run after the approval mined, so every rung that
  // failed burned through a live allowance the user had already granted. Here
  // the allowance exists only inside the eth_call: the whole ladder resolves
  // with nothing signed, and the error for an unroutable amount is once again
  // honestly "Nothing was sent".
  const ladder = swapDepositTargetLadder(
    depositAmountWei,
    swapDepositSlippage(params.fromChainId, params.depositChainId),
  );
  let routeValidated = false;
  // A native deposit's call carries a fixed msg.value, and only a full dry run
  // shows the swap can fund it. It is never approved first and checked after.
  const nativeDeposit = !crossChain && params.depositToken.toLowerCase() === NATIVE_ASSET_ADDRESS;
  const uncheckable = () => new SwapDepositPreflightError(
    `This deposit could not be checked before signing. ${soFar()} Try again in a moment.`,
  );
  if (nativeDeposit && !params.simulateWithAllowance) throw uncheckable();
  if (params.simulateWithAllowance) {
    const originalPrepared = prepared;
    const originalAmountWei = depositAmountWei;
    for (let attempt = 0; attempt < ladder.length; attempt++) {
      if (!prepared.transactionTo || !prepared.transactionData) {
        throw new UnexpectedSwapTxError(`The route returned no swap transaction. ${soFar()}`);
      }
      // The override grants the allowance to the DECLARED approval address and
      // to nothing else, because that is the only allowance the wallet will be
      // asked for. Granting it to the swap target as well would prove a route
      // that cannot run: the simulation would pass on an allowance the user is
      // never going to give, and the failure would surface on-chain instead of
      // here, after the money moved.
      const spenders = [assertApprovalSpender(
        params.fromChainId,
        prepared.approvalAddress,
        prepared.transactionTo,
      )];
      const sim = await params.simulateWithAllowance(
        {
          to: prepared.transactionTo,
          data: prepared.transactionData,
          ...(prepared.msgValue ? { value: prepared.msgValue } : {}),
        },
        { token: params.inputToken, spenders, amount: hexToBigInt(prepared.estimatedInputAmount) },
      );
      if (!sim.supported) {
        if (nativeDeposit) throw uncheckable();
        // No usable override on this token or node. Fall back to the old
        // order, from the target the user actually consented to.
        console.log('[SwapDeposit] allowance-override simulation unavailable, falling back to approve-first');
        prepared = originalPrepared;
        depositAmountWei = originalAmountWei;
        break;
      }
      console.log('[SwapDeposit] pre-approval simulation attempt', attempt + 1, sim.ok ? 'OK' : `REVERTS (${sim.revertData ?? 'no data'})`);
      if (sim.ok) {
        routeValidated = true;
        break;
      }
      if (attempt === ladder.length - 1) {
        // Nothing has been signed at this point, and that is the whole point.
        throw new SwapDepositPreflightError(
          'This route cannot deliver the full deposit amount. Nothing was sent. Try a smaller amount.',
        );
      }
      const nextTarget = ladder[attempt + 1]!;
      console.log('[SwapDeposit] re-preparing with smaller deposit target', nextTarget.toString());
      const replacement = await prepareSizedAgain(() => prepareFor(nextTarget));
      const tooDear = overCeiling(replacement);
      // Nothing has been signed on this path, so this refusal is allowed to
      // say so, and it says it before the replacement is ever simulated: a
      // route that costs more than the user agreed to must not be able to
      // become the one that succeeds.
      if (tooDear) throw new SwapDepositPreflightError(`${tooDear} Nothing was sent.`);
      prepared = replacement;
      depositAmountWei = nextTarget;
    }
  }

  // ── Who gets the allowance ────────────────────────────────────────────
  //
  // The route declares it and this flow honours it. That sentence is the
  // whole rule, and it is written here rather than left implicit because the
  // code used to do the opposite: when the declared `approvalAddress` differed
  // from `transactionTo` it approved `transactionTo` instead, on the theory
  // that the contract receiving the tokens must be the one to pull them.
  //
  // The theory was wrong on both halves. `approvalAddress` is LiFi's
  // access-controlled proxy, which only its Diamond can drive; `transactionTo`
  // on those routes was an Executor whose entry point anyone may call with
  // arbitrary instructions. An allowance there belongs to whoever asks first.
  //
  // The symptom that prompted it was real (an OP route that reverted
  // TransferFromFailed), but the diagnosis was not: 0x314bE5fc… is Optimism's
  // published LiFi ERC20Proxy, so the declared address had been right all
  // along and the mismatch was the route being unusable as a direct call.
  // A route like that now stops above, in the pre-approval simulation, which
  // grants the override to this spender and to no one else — so it fails
  // before the wallet is asked for anything rather than after.
  let spender = assertApprovalSpender(
    params.fromChainId,
    prepared.approvalAddress,
    prepared.transactionTo,
  );
  console.log('[SwapDeposit] route', {
    swapTarget: prepared.transactionTo,
    approvalSpender: spender,
    sdkBuiltApproval: prepared.approvalTx != null,
    estimatedInput: prepared.estimatedInputAmount,
  });
  /**
   * Put one approval in front of the wallet, having checked it says what it
   * claims. Returns once it has mined; gives everything back and stops if it
   * did not.
   */
  const approve = async (raw: unknown, kind: 'approval' | 'revoke' = 'approval'): Promise<void> => {
    params.onStep?.(kind === 'revoke' ? 'revoke' : 'approve', kind === 'revoke'
      ? 'The route changed. Reset the previous route’s token approval before continuing (sign in wallet).'
      : undefined);
    const approvalTx = assertSwapApprovalTx(raw, params.inputToken, spender);
    prompted.push(spender);
    const record: SentApprovalRecord = {
      txHash: null, spender, amount: approvedAmountOf(approvalTx.data), success: false,
    };
    if (kind === 'revoke') attemptedRouteReset = spender.toLowerCase() as Address;
    const approval = await guarded(() => params.submit(approvalTx, kind, (hash) => {
      record.txHash = hash;
      record.pending = true;
      if (!sent.includes(record)) sent.push(record);
      if (!recovery.includes(record)) recovery.push(record);
    }));
    Object.assign(record, { txHash: approval.txHash, success: approval.success, pending: false });
    if (!sent.includes(record)) sent.push(record);
    forgetRecovered(record);
    if (approval.success) attemptedRouteReset = null;
    if (!approval.success) {
      // Submitting the swap on a rejected or reverted approval is a guaranteed
      // revert the user pays gas for. An EARLIER approval in this same list
      // may well have mined (the approve(0) reset, or a first leg), so the
      // exit hands those back before it reports.
      await abandon(
        SwapDepositPreflightError,
        'The token approval did not go through, so nothing was swapped or deposited. It still cost gas. Try again.',
      );
    }
  };
  if (prepared.approvalTx !== null && prepared.approvalTx !== undefined) {
    // Every approval the SDK planned, in order: an approve(0) reset comes
    // first for a token that rejects non-zero to non-zero approvals (USDT).
    // Submitting only the last one skipped that reset and reverted the second
    // USDT swap-deposit. Each is validated BEFORE its wallet prompt: the
    // calldata came from LiFi.
    const planned = Array.isArray(prepared.approvalTxs) && prepared.approvalTxs.length > 0
      ? prepared.approvalTxs
      : [prepared.approvalTx];
    for (const raw of planned) await approve(raw);
  } else if (params.readAllowance) {
    // The SDK builds no approval when it believes the allowance already
    // covers the route. That belief has been wrong before, so read the real
    // one where the caller can, and top it up for the SAME spender if it is
    // short. An unreadable allowance is not a licence to invent a spender:
    // it simply leaves this branch alone, and the simulation above has
    // already proved the route against this allowance.
    const needed = hexToBigInt(prepared.estimatedInputAmount);
    // An unreadable allowance leaves this branch alone, as it always has: the
    // SDK planned no approval, and the simulation above already proved the
    // route against whatever the real allowance is. Where it CAN be read, the
    // top-up goes through the shared plan, so a partial allowance on a
    // Tether-style token gets its reset instead of a guaranteed revert.
    let held: bigint | null = null;
    try { held = await params.readAllowance(params.inputToken, spender); } catch { held = null; }
    if (held !== null) {
      for (const amount of approvalAmountPlan(held, needed)) {
        await approve(buildApprovalTx(params.inputToken, spender, amount));
      }
    }
  }

  params.onStep?.('submit');
  if (!prepared.transactionTo || !prepared.transactionData) {
    await abandon(UnexpectedSwapTxError, 'The route returned no swap transaction.');
  }
  // SDK defect (verified on-chain, OP tx 0x39d78563…): the deposit calldata
  // demands the exact TARGET amount, but the route only guarantees its
  // slippage floor — the executor's post-swap balance can land short and the
  // entrypoint's transferFrom reverts 'exceeds balance', rolling everything
  // back. With the approval mined the swap tx is fully simulatable, so:
  // simulate; on revert, RE-PREPARE with a smaller deposit target (the pay
  // side only ever shrinks, so the consented input stays the ceiling and the
  // first approval covers the smaller retries) and try again.
  //
  // The ladder is sized off the slippage the route EXECUTES with, not a flat
  // 1%: see swapDepositTargetLadder.
  if (params.simulate && !routeValidated) {
    for (let attempt = 0; attempt < ladder.length; attempt++) {
      const sim = await guarded(() => params.simulate!({
        to: prepared.transactionTo,
        data: prepared.transactionData,
        ...(prepared.msgValue ? { value: prepared.msgValue } : {}),
      }));
      console.log('[SwapDeposit] simulation attempt', attempt + 1, sim.ok ? 'OK' : `REVERTS (${sim.revertData ?? 'no data'})`);
      if (sim.ok) break;
      if (attempt === ladder.length - 1) {
        await abandon(
          SwapDepositPreflightError,
          'This route cannot deliver the full deposit amount.',
          'Try a smaller amount.',
        );
      }
      const nextTarget = ladder[attempt + 1]!;
      console.log('[SwapDeposit] re-preparing with smaller deposit target', nextTarget.toString());
      const replacement = await guarded(() => prepareSizedAgain(() => prepareFor(nextTarget)));
      // Same ceiling as the pre-approval ladder, and it matters more here: an
      // approval has already mined, so a dearer replacement would be topped up
      // to its own amount and submitted. The comment this replaces asserted
      // that "the pay side only ever shrinks"; the quote service never
      // promised that.
      const tooDear = overCeiling(replacement);
      if (tooDear) await abandon(SwapDepositPreflightError, tooDear);
      prepared = replacement;
      depositAmountWei = nextTarget;
      if (!prepared.transactionTo || !prepared.transactionData) {
        await abandon(UnexpectedSwapTxError, 'The route returned no swap transaction.');
      }
      // A re-prepared route is a new quote and gets asked the same question as
      // the first one: who does it say may spend the token? A smaller target
      // can come back on a different path with a different declared address,
      // and the answer is never assumed to be the one already approved.
      // '' rather than the default: an approval has mined by now, so this
      // validator does not get to state what the run has sent. `guarded`
      // appends the account that is actually true.
      const nextSpender = await guarded(async () => assertApprovalSpender(
        params.fromChainId,
        prepared.approvalAddress,
        prepared.transactionTo,
        '',
      ));
      if (nextSpender.toLowerCase() !== spender.toLowerCase()
        && broadcastApprovals(sent).some((record) => record.success && record.amount > 0n
          && record.spender.toLowerCase() === spender.toLowerCase())) {
        await reconcileApprovals();
        if (liveAllowancesAfter(sent).has(spender.toLowerCase())) {
          // Retire this run's old grant while the user is still signing.
          // Never grant to the replacement until the reset has confirmed.
          await approve(buildRevokeApprovalTx(params.inputToken, spender), 'revoke');
        }
      }
      spender = nextSpender;
      // The smaller route may still need a hair more allowance than the
      // original if LiFi picked a different path, so top up only if short, and
      // through the shared plan. An allowance that cannot be read is UNKNOWN,
      // not zero: reading it as zero dropped the reset a partial allowance
      // needs and sent approve(needed) straight at a token that reverts it.
      const newInput = hexToBigInt(prepared.estimatedInputAmount);
      let allowanceNow: bigint | null = null;
      if (params.readAllowance) {
        try { allowanceNow = await params.readAllowance(params.inputToken, spender); } catch { allowanceNow = null; }
      }
      for (const amount of approvalAmountPlan(allowanceNow, newInput)) {
        await approve(buildApprovalTx(params.inputToken, spender, amount));
      }
      params.onStep?.('submit');
    }
  }
  if (params.beforeSwapSubmit) {
    const final = prepared;
    await guarded(() => params.beforeSwapSubmit!(final, depositAmountWei));
  }
  console.log('[SwapDeposit] submitting swap tx to route target', prepared.transactionTo);
  const swap = await guarded(async () => {
    // Set BEFORE the await, and only cleared by a resolved receipt: a submit
    // that throws proves nothing about whether the wallet broadcast it, and
    // an error written while that is open may not say nothing was sent.
    swapState = 'unknown';
    const result = await params.submit(
      {
        to: prepared.transactionTo,
        data: prepared.transactionData,
        ...(prepared.msgValue ? { value: prepared.msgValue } : {}),
      },
      'swap',
      (hash) => {
        try {
          params.onSwapBroadcast?.(hash, prepared, depositAmountWei);
        } catch {
          // A display hook must not fail the swap.
        }
      },
    );
    swapState = result.success ? null : 'reverted';
    return result;
  });
  if (!swap.success) {
    // A resolved receipt is NOT success. The whole swap+deposit is one atomic
    // transaction, so a revert means nothing was spent and nothing shielded —
    // say that rather than reporting a deposit that never happened. The
    // allowance, however, survived the rollback: it was granted by a separate
    // transaction that did not revert, so it has to be handed back here.
    await abandon(
      SwapDepositPreflightError,
      'The swap transaction reverted on-chain. The swap and deposit rolled back together, so nothing was shielded.',
    );
  }
  return { prepared, txHash: swap.txHash, depositAmountWei };
}

/**
 * The deposit amount the SDK says fits the bridge's guaranteed delivery, when
 * `err` is its `DestinationDepositUnaffordable`; otherwise null.
 */
export function affordableDepositAmount(err: unknown): bigint | null {
  if (!(err instanceof Error) || err.name !== 'DestinationDepositUnaffordable') return null;
  const carried = (err as Error & { affordableNoteValue?: unknown }).affordableNoteValue;
  if (typeof carried !== 'string' || !/^0x[0-9a-fA-F]+$/.test(carried)) return null;
  return BigInt(carried);
}

/**
 * What a cross-chain deposit must be rebuilt at after the SDK's
 * `DestinationDepositUnaffordable`: the note value it says fits, and the deposit
 * cost that funds it. The cost is the route's guaranteed delivery minus the same
 * 1% drift margin the SDK sized the note with. The SDK carries `destBudget` as a
 * field since v2-monorepo#446; older builds only put it in the message.
 */
export function unaffordableRefit(err: unknown): { noteValue: bigint; totalDepositCost: bigint } | null {
  const noteValue = affordableDepositAmount(err);
  if (noteValue === null || noteValue <= 0n) return null;
  const field = (err as Error & { destBudget?: unknown }).destBudget;
  const fromMessage = /guaranteed delivery (\d+)/.exec((err as Error).message)?.[1];
  const raw = typeof field === 'string' && /^\d+$/.test(field) ? field : fromMessage;
  if (!raw) return null;
  const totalDepositCost = (BigInt(raw) * 9_900n) / 10_000n;
  return totalDepositCost > 0n ? { noteValue, totalDepositCost } : null;
}

/** Tolerant hex→bigint: the SDK returns 0x-prefixed base units. */
export function hexToBigInt(value: Hex | string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const text = String(value).trim();
  if (!text) return 0n;
  try {
    return text.startsWith('0x') || text.startsWith('0X') ? BigInt(text) : BigInt(text);
  } catch {
    return 0n;
  }
}

// ─── Flow 3: reshield (shielded A → shielded B) ───────────────────────────

/** `estimateReshieldAmount` result — decimal strings, plus the note size. */
export interface ReshieldEstimateLike {
  feeAmount: string;
  netSwapAmount: string;
  estimatedOutput: string;
  estimatedMinOutput: string;
  /** Base units for the deposit proof the caller must build next. */
  noteValue: Hex;
  vettingFee: string;
  totalDepositCost: string;
}

/** `prepareReshieldQuote` result — the fields the relay call must echo. */
export interface PreparedReshieldQuoteLike {
  selectedQuote: unknown;
  swapCalldata: Hex;
  feeAmount: string;
  /** NET amount — this, never the gross that went into prepare. */
  netAmount: Hex;
  swapTarget: Address;
  approvalAddress: Address;
  dustRecipient: Address;
  /**
   * Set when the swap routes through the configured LiFi Executor: the composed
   * call's pinned amounts. The SDK refuses an executor relay that does not echo
   * it exactly (DEV-538), so it is passed through untouched.
   */
  executorCall?: unknown;
}

export interface ReshieldSessionLike {
  estimateReshieldAmount(params: {
    relayerInfo: unknown;
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    dustRecipient?: Address;
    slippage?: number;
  }): Promise<ReshieldEstimateLike>;
  // The result carries the pendingNote for the NEW output note. It must be
  // kept: relayReshield persists the spent inputs and the input-asset change,
  // but not this note, so discarding it loses the reshielded balance locally.
  prepareDeposit(params: { tokenId: Address; value: Hex }): Promise<{
    pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex };
  }>;
  prepareReshieldQuote(params: {
    relayerInfo: unknown;
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    depositResult: unknown;
    totalDepositCost: string;
    dustRecipient?: Address;
    slippage?: number;
  }): Promise<PreparedReshieldQuoteLike>;
  relayReshield(params: {
    inputCommitments: Hash[];
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    swapCalldata: Hex;
    selectedQuote: unknown;
    dustRecipient?: Address;
    swapTarget?: Address;
    approvalAddress?: Address;
    executorCall?: unknown;
    /** SDK #481: runs once with the relayed hash, before the receipt wait. */
    onBroadcast?: (txHash: Hex) => void;
    // The SDK's TxReceipt: `status` is the MINED outcome, not "did the call
    // resolve". A reverted relay resolves normally with status false.
  }): Promise<{ txHash?: Hex; status?: boolean }>;
}

/**
 * Who a reshield-and-transfer note is for (a yield share OR a plain pool asset),
 * in the SDK's depositFor forms:
 * - a REGISTERED account by EVM address, which the SDK resolves to its viewing
 *   key and announces to;
 * - an UNREGISTERED one in the blind form (DEV-511): a pre-computed
 *   noteAddressHash plus our own announcement, the sender-recoverable backup of
 *   services/blind-deposit-backup.ts, built by the SDK's note callback. The
 *   claim link is the recipient's only route to the note, so the caller stores
 *   the claim before the relay (services/swap-send-claim.ts).
 * `allowOutOfBandFallback` is never set: it hands back a secret only after the
 * proof, with no on-chain copy, which is the lost-link route this replaces.
 */
export type ReshieldTransferRecipient = SwapDepositRecipient;

/**
 * The four SDK calls of reshield-and-transfer (v2-monorepo #439), same
 * estimate -> deposit -> quote -> relay order as `ReshieldSessionLike`, with the
 * deposit built FOR the recipient. The relay never takes a `depositNote`: the
 * sender must never persist a note it does not own.
 */
export interface ReshieldTransferSessionLike {
  estimateReshieldTransferAmount: ReshieldSessionLike['estimateReshieldAmount'];
  prepareReshieldTransferDeposit(params: ReshieldTransferRecipient & {
    outputToken: Address;
    totalDepositCost: string;
    /**
     * The estimate's note value. REQUIRED by the SDK for a plain pool asset (the
     * deposit is for exactly this value, the vetting fee rides on top inside
     * `totalDepositCost`) and ignored for a yield share, which sizes from the
     * budget. Always passed, so one call serves both.
     */
    noteValue?: Hex;
  }): Promise<{ pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex } }>;
  prepareReshieldTransferQuote: ReshieldSessionLike['prepareReshieldQuote'];
  relayReshieldTransfer: ReshieldSessionLike['relayReshield'];
}

/** Everything Review needs for a reshield, in display form. */
export interface ReshieldDisplay {
  /** Gross the user asked to move. */
  grossText: string;
  /** Relayer fee, subtracted from the gross. */
  feeText: string;
  /** What actually enters the swap after the fee. */
  netText: string;
  /** Expected swap output, before deposit costs. */
  estimatedOutputText: string;
  /** Worst-case SWAP output after slippage — NOT what gets shielded. */
  minOutputText: string;
  /** Pool vetting fee on the redeposit. */
  vettingFeeText: string;
  /**
   * The new shielded note — the only figure that describes what the user ends
   * up holding.
   *
   * This is strictly smaller than `minOutputText`, and that gap is why it has
   * to be shown separately: the SDK derives the note as
   * `minOutput * 99% / (1 + vettingFeeBPS)`, taking an extra 1% safety cut and
   * then the pool's vetting fee. Presenting the swap minimum as "you'll
   * receive" promises more than the deposit can produce.
   */
  newNoteText: string;
  /** Raw base units of the above, for binding Confirm to what was reviewed. */
  newNoteValueWei: bigint;
}

export function shapeReshieldForDisplay(
  estimate: ReshieldEstimateLike,
  grossWei: bigint,
  input: { symbol: string; decimals: number },
  output: { symbol: string; decimals: number },
  /**
   * The units of `netSwapAmount`, when they are not the note's own. Defaults to
   * `input`, which is correct for a plain note. For a share the swap runs on
   * what the share REDEEMS to, so this is the wrapper's underlying: a different
   * symbol, and on ppUSDC a different scale (18 vs 6). `config/intent-swaps.ts`
   * `swapInputUnits()` resolves it; the SDK reports the same token back as
   * `ReshieldEstimate.swapInputToken`.
   */
  swapInput?: { symbol: string; decimals: number },
): ReshieldDisplay {
  // Symbol and decimals are read off the SAME object as the number, and the
  // precision is chosen per amount: an 18-decimals fee next to a 6-decimals
  // one must not be flattened to "0".
  // The share is named nowhere the user reads. Its COUNT is printed under the
  // underlying's name and marked approximate, which is the rule in
  // services/share-display.ts: the gap is the accrued rate, and it understates
  // rather than overstates. Without this the reshield review read "15 ppUSDC"
  // and "0.163964 ppUSDC" under a header already saying USDC (QA, 2026-09-22).
  const amountText = (value: bigint, units: { symbol: string; decimals: number }) => {
    const figure = formatUnitsText(value, units.decimals, fractionDigitsFor(value, units.decimals));
    const symbol = displayTokenSymbol(units.symbol);
    return isShareSymbol(units.symbol) ? `≈ ${figure} ${symbol}` : `${figure} ${symbol}`;
  };
  const inputText = (raw: string) => amountText(hexToBigInt(raw), input);
  const outputText = (raw: string) => amountText(hexToBigInt(raw), output);
  // Gross and fee are in the NOTE's units: the SDK subtracts the relayer fee
  // from the withdrawn amount and only then redeems. The net is what came out
  // of that redemption, so it alone changes units.
  const netUnits = swapInput ?? input;
  return {
    grossText: amountText(grossWei, input),
    feeText: inputText(estimate.feeAmount),
    netText: amountText(hexToBigInt(estimate.netSwapAmount), netUnits),
    estimatedOutputText: outputText(estimate.estimatedOutput),
    minOutputText: outputText(estimate.estimatedMinOutput),
    vettingFeeText: outputText(estimate.vettingFee),
    newNoteText: outputText(estimate.noteValue),
    newNoteValueWei: hexToBigInt(estimate.noteValue),
  };
}

/**
 * The new note must be worth the route. `noteValue` is the SDK's sizing of the
 * far-side deposit from the swap's minimum output (minus the pool vetting
 * fee). When it comes back as a sliver of that output the estimate is not to
 * be trusted: Pat's 20 USDC@OP -> ETH@mainnet reviewed as "New shielded note
 * (at least) 0 ETH" and the relay then reverted (RelaySwaps_SwapFailed) on a
 * route whose deposit was ~0. Root cause in the SDK (2026-08-30): the
 * cross-chain estimate caps the minimum output with `netSwapAmount`, i.e. it
 * compares ETH wei with USDC base units, so any pair with different decimals
 * or a non-1:1 rate collapses the note. Until the SDK fix is vendored, a note
 * below a tenth of the minimum output is refused at Review and again before
 * relay, with the figures, so nothing is signed for a route that cannot work.
 */
export const RESHIELD_MIN_NOTE_SHARE_BPS = 1000n;
export function assertReshieldNoteWorthIt(
  estimate: { noteValue: Hex; estimatedMinOutput: string; totalDepositCost?: string },
  output: { symbol: string; decimals: number },
  destinationName?: string,
): void {
  const noteValue = hexToBigInt(estimate.noteValue);
  const minOutput = hexToBigInt(estimate.estimatedMinOutput);
  if (minOutput <= 0n) return; // the zero-output cases have their own guards
  if (noteValue * 10_000n >= minOutput * RESHIELD_MIN_NOTE_SHARE_BPS) return;
  const where = destinationName ? ` on ${destinationName}` : '';
  throw new ReshieldPreflightError(
    `This route cannot be sized${where}: the estimate would leave ${tokenAmountLabel(formatUnitsText(noteValue, output.decimals, output.decimals), output.symbol)} of the ${tokenAmountLabel(formatUnitsText(minOutput, output.decimals), output.symbol)} swap output as your new note. Nothing was signed or spent. Try a larger amount or a different pair; if this keeps happening for this pair it is an estimate bug, not a fee.`,
  );
}

/** Raised when a reshield precondition fails BEFORE anything is signed. */
export class ReshieldPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReshieldPreflightError';
  }
}

/**
 * The consent gate specifically. Its own type because the caller has to react
 * differently: the message sends the user back to Review, so the figures behind
 * it have to be re-estimated. A generic preflight refusal leaves the review as
 * it was, and here that would leave the floor the fresh estimate is compared
 * against fixed at a rate that has already passed, so every retry refuses again.
 */
export class ReshieldRateMovedError extends ReshieldPreflightError {
  constructor(message: string) {
    super(message);
    this.name = 'ReshieldRateMovedError';
  }
}

/**
 * Raised when the reshield was submitted and REVERTED on-chain. Distinct from
 * ReshieldPreflightError because the consequences differ: a preflight failure
 * spent nothing at all, while this one spent gas and has a transaction hash the
 * user can look up.
 */
export class ReshieldRevertedError extends Error {
  readonly txHash: Hex | null;
  constructor(message: string, txHash: Hex | null) {
    super(message);
    this.name = 'ReshieldRevertedError';
    this.txHash = txHash;
  }
}

/**
 * Guide §10's first gotcha, enforced rather than trusted: every prepare* takes
 * the GROSS amount and every relay* takes `quote.netAmount`. Passing the gross
 * into the relay is the mistake the doc says trips people up constantly, and it
 * fails late (after proving) with an opaque mismatch — so assert it up front.
 */
export function assertReshieldRelayAmount(
  quote: PreparedReshieldQuoteLike,
  grossWei: bigint,
  /** Units of the FROM token, so a refusal reads as an amount, not as raw base units on the Review screen. */
  units?: { decimals: number; symbol: string },
): void {
  const show = (wei: bigint) => (units ? approxUnderlyingText(`${formatUnitsText(wei, units.decimals)} ${units.symbol}`, units.symbol) : wei.toString());
  const net = hexToBigInt(quote.netAmount);
  const fee = hexToBigInt(quote.feeAmount || '0');
  if (net <= 0n) {
    throw new ReshieldPreflightError('The relayer quote has no net amount. Nothing was signed or spent.');
  }
  if (fee < 0n) {
    throw new ReshieldPreflightError('The relayer quote has a negative fee. Refusing to relay.');
  }
  // `net <= gross` alone is NOT sufficient, which is the whole point of this
  // being an equality. The relay only checks that the signed amountSent equals
  // the net it was handed plus the fee — so a commitment signed for MORE than
  // the user asked for (gross 100, amountSent 110, fee 10, net 100) satisfies
  // both that check and a `net <= gross` bound, while the proof spends 110.
  // Requiring net + fee === gross is what pins the spend to the reviewed
  // amount. This mirrors validatePreparedSwapQuote's gross binding for flow 2.
  if (net + fee !== grossWei) {
    throw new ReshieldPreflightError(
      `The relayer quote covers ${show(net + fee)} but you asked to reshield ${show(grossWei)}. Refusing to relay.`,
    );
  }
  // And the SIGNED commitment must say the same thing. The fields above are
  // the relayer's top-level report; `feeCommitment` is what it actually signed
  // and what the contract enforces, so a mismatch between them is the exact
  // shape of a quote that spends more than it admits to.
  const signed = (quote.selectedQuote as {
    quote?: { feeCommitment?: { amountSent?: string }; feeAmount?: string };
  } | null | undefined)?.quote;
  const amountSent = signed?.feeCommitment?.amountSent;
  if (amountSent !== undefined && hexToBigInt(amountSent) !== grossWei) {
    throw new ReshieldPreflightError(
      `The signed relayer commitment spends ${show(hexToBigInt(amountSent))}, not the ${show(grossWei)} you reviewed. Refusing to relay.`,
    );
  }
  if (signed?.feeAmount !== undefined && hexToBigInt(signed.feeAmount) !== fee) {
    throw new ReshieldPreflightError(
      'The relayer quote fee disagrees with the fee it signed. Refusing to relay.',
    );
  }
}

/** Resolve the share capability locally, including after an awaited estimate. */
function redepositYieldTarget(
  session: { yieldFor?: (token: string) => unknown },
  outputToken: Address,
  requireShareRoute = false,
) {
  const target = session.yieldFor?.(outputToken) as
    | { chainId?: number; deployment?: { ppUSDC?: string } }
    | undefined;
  const canFundShare = target?.deployment?.ppUSDC?.toLowerCase() === outputToken.toLowerCase();
  if (requireShareRoute && !canFundShare) {
    throw new ReshieldPreflightError(
      'This session cannot deposit into that vault on the destination network. Reload and try again.',
    );
  }
  return canFundShare ? target : undefined;
}

/**
 * The redeposit leg a reshield hands the relayer.
 *
 * A plain pool takes the note value straight into `Entrypoint.deposit`. A yield
 * pool cannot: its notes are shares minted by a PPRouter, so the swap buys the
 * underlying (or the coin, in native mode) and the deposit call is the router's
 * `depositExactShares` / `depositExactSharesNative`, sized from the budget the
 * estimate already computed. `totalDepositCost` is that budget for a share
 * target and `noteValue` is in shares, which is why the two are read from
 * different fields here.
 *
 * `yieldFor` answers for a share OR its underlying, so the share address is
 * checked explicitly: a USDC output must keep its plain deposit even though the
 * ppUSDC namespace would answer for it.
 *
 * The router leg re-sizes at today's rate, so the shares can differ from the
 * estimate by the rate headroom the SDK reserves. The caller's consent gate
 * (`minNoteValueWei`) runs against the fresh estimate just above, so the drift
 * a user can experience is bounded by that reserve.
 */
async function buildRedeposit(
  session: Pick<ReshieldSessionLike, 'prepareDeposit'> & { yieldFor?: (token: string) => unknown },
  outputToken: Address,
  estimate: { noteValue: Hex; totalDepositCost: string },
  options: { requireShareRoute?: boolean; crossChain?: boolean } = {},
): Promise<{ pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex } }> {
  const target = redepositYieldTarget(session, outputToken, options.requireShareRoute);
  if (!target) {
    return session.prepareDeposit({ tokenId: outputToken, value: estimate.noteValue });
  }
  const { prepareYieldSwapDeposit, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM } = await import('@privacy-pools-v2/sdk');
  // One structural cast at the SDK boundary, like the other opaque SDK values
  // in this file: the namespace object comes from the session that owns it.
  // Keep the bridge estimate's rate reserve. The same-chain default can spend
  // that reserve on extra shares whose cost grows beyond the budget in transit.
  return prepareYieldSwapDeposit(
    target as never,
    BigInt(estimate.totalDepositCost),
    options.crossChain ? CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM : undefined,
  );
}

/**
 * Review-step half of flow 3: the estimate only, shaped for display.
 *
 * Deliberately stops before `prepareDeposit`. The relayer's fee commitment is
 * short-lived and proving takes tens of seconds, so a quote fetched now would
 * be dead by the time the user pressed Confirm — the guide's ordering puts the
 * quote AFTER the proof for exactly that reason. Review therefore shows an
 * estimate and Confirm runs the whole four-step sequence against fresh numbers.
 */
export async function estimateReshieldForReview(
  session: Pick<ReshieldSessionLike, 'estimateReshieldAmount'> & Partial<Pick<ReshieldTransferSessionLike, 'estimateReshieldTransferAmount'>>,
  params: {
    chainId: number;
    relayerInfo: unknown;
    grossWei: bigint;
    inputToken: Address;
    outputToken: Address;
    input: { symbol: string; decimals: number };
    output: { symbol: string; decimals: number };
    slippage?: number;
    /**
     * The note is FOR someone else (reshield-and-transfer). Priced by the
     * transfer estimate, which also refuses an output that is not a configured
     * yield share before any number is shown.
     */
    transfer?: boolean;
  },
): Promise<{ estimate: ReshieldEstimateLike; display: ReshieldDisplay }> {
  assertIntentDepositTarget(params.outputToken, params.chainId);
  if (params.grossWei <= 0n) {
    throw new ReshieldPreflightError('Enter an amount greater than zero.');
  }
  if (params.inputToken.toLowerCase() === params.outputToken.toLowerCase()) {
    throw new ReshieldPreflightError('Pick a different asset to reshield into.');
  }
  // Review only needs the estimate; the other three calls are Confirm's, and it
  // checks them (requireTransferSession) before anything is proved.
  if (params.transfer && typeof session.estimateReshieldTransferAmount !== 'function') {
    throw new ReshieldPreflightError(PRIVATE_SWAP_SEND_UNAVAILABLE);
  }
  const estimateCall = params.transfer && session.estimateReshieldTransferAmount
    ? session.estimateReshieldTransferAmount.bind(session)
    : session.estimateReshieldAmount.bind(session);
  const estimate = await estimateCall({
    relayerInfo: params.relayerInfo,
    amount: toHex(params.grossWei),
    tokenId: params.inputToken,
    outputToken: params.outputToken,
    ...(params.slippage !== undefined ? { slippage: params.slippage } : {}),
  });
  if (hexToBigInt(estimate.noteValue) <= 0n) {
    throw new ReshieldPreflightError(
      'The swap would produce nothing to redeposit at this amount. Try a larger amount.',
    );
  }
  // The relayer fee comes off the gross; a fee at or above it leaves the swap
  // with nothing and would otherwise only surface as a confusing revert.
  if (hexToBigInt(estimate.netSwapAmount) <= 0n) {
    throw new ReshieldPreflightError(
      'The relayer fee is at least the whole amount at this size. Try a larger amount.',
    );
  }
  return {
    estimate,
    display: shapeReshieldForDisplay(
      estimate,
      params.grossWei,
      params.input,
      params.output,
      swapInputUnits(params.chainId, params.inputToken, params.input),
    ),
  };
}

/**
 * The whole of flow 3, in the guide's four steps, with the ordering that
 * matters kept in one place:
 *
 *   1. estimate      → how big a deposit proof to build
 *   2. prepareDeposit → the proof, sized off estimate.noteValue
 *   3. prepareReshieldQuote → the real quote, with that proof embedded
 *   4. relayReshield  → submit, echoing swapTarget/approvalAddress/
 *                       dustRecipient so relay-time validation checks the
 *                       same values the relayer signed (guide §10)
 *
 * `onStep` exists because step 2 is a full proof generation — several seconds
 * — and a silent UI there reads as a hang.
 */
async function runReshieldOnce(
  session: ReshieldSessionLike,
  params: {
    chainId: number;
    relayerInfo: unknown;
    grossWei: bigint;
    inputToken: Address;
    outputToken: Address;
    inputCommitments: Hash[];
    slippage?: number;
    /**
     * The `newNoteValueWei` the user actually reviewed. Confirm re-estimates
     * from scratch, so without this a route that deteriorated between Review
     * and Confirm would execute at the worse rate with no consent — the
     * reviewed figure would just have been decoration.
     */
    minNoteValueWei?: bigint;
    /**
     * Runs on the FRESH estimate's note value before proving (launch deposit
     * cap: the reshield redeposits the swap output as a new note, so it is a
     * deposit for the ASP's purposes). Throw to abort; nothing is signed yet.
     */
    assertNoteValue?: (noteValueWei: bigint) => Promise<void> | void;
    /** Checked immediately before the relayer submission — the estimate/proof
     *  work above can outlive the caller's modal session (codex). */
    shouldContinue?: () => boolean;
    onStep?: (step: 'estimate' | 'proving' | 'quote' | 'relay', detail?: string) => void;
    /** Units of the FROM token for human-readable refusals (services/swap-flows.ts assertReshieldRelayAmount). */
    inputUnits?: { decimals: number; symbol: string };
    /**
     * Reshield-and-transfer: the new note is FOR this account, not the caller.
     * Everything else (estimate guards, consent floor, cap, proof, quote check,
     * receipt check) is the same code as a reshield of your own, which is the
     * point: one copy of the gates. The differences are the four SDK calls, and
     * that no output note is returned to store, because the sender must never
     * persist a note it does not own.
     */
    recipient?: ReshieldTransferRecipient;
    /**
     * The relayer returned the hash; the receipt is not in yet (DEV-433). Lets
     * the caller write its local records now, so a receipt that times out or a
     * closed tab still leaves them. Local only: never a request keyed on the
     * hash. A throw is swallowed by the SDK.
     */
    onBroadcast?: (txHash: Hex, ctx: { quote: PreparedReshieldQuoteLike }) => void;
  },
): Promise<{
  receipt: { txHash?: Hex; status?: boolean };
  estimate: ReshieldEstimateLike;
  quote: PreparedReshieldQuoteLike;
  /** The new output note, for the caller to register locally after success. */
  pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex };
}> {
  assertIntentDepositTarget(params.outputToken, params.chainId);
  const gross = toHex(params.grossWei);
  if (params.inputCommitments.length === 0) {
    throw new ReshieldPreflightError('No spendable notes were selected for this reshield.');
  }
  if (params.inputToken.toLowerCase() === params.outputToken.toLowerCase()) {
    throw new ReshieldPreflightError('Pick a different asset to reshield into.');
  }

  const transfer = params.recipient ? requireTransferSession(session) : null;

  params.onStep?.('estimate');
  const estimate = await (transfer
    ? transfer.estimateReshieldTransferAmount.bind(transfer)
    : session.estimateReshieldAmount.bind(session))({
    relayerInfo: params.relayerInfo,
    amount: gross,
    tokenId: params.inputToken,
    outputToken: params.outputToken,
    ...(params.slippage !== undefined ? { slippage: params.slippage } : {}),
  });

  // Both guards run here as well as in estimateReshieldForReview, because
  // Confirm re-estimates from scratch: a fee spike between Review and Confirm
  // (or a hostile relayer returning a positive noteValue with a non-positive
  // net) must not slip through just because Review was fine.
  if (hexToBigInt(estimate.noteValue) <= 0n) {
    throw new ReshieldPreflightError(
      'The swap would produce nothing to redeposit at this amount. Try a larger amount.',
    );
  }
  if (hexToBigInt(estimate.netSwapAmount) <= 0n) {
    throw new ReshieldPreflightError(
      'The relayer fee now covers the whole amount. Nothing was signed or spent. Try a larger amount.',
    );
  }
  // Consent gate: the fresh estimate must be at least as good as the one the
  // user agreed to. Checked before proving so a worse route costs nothing.
  if (params.minNoteValueWei !== undefined && hexToBigInt(estimate.noteValue) < params.minNoteValueWei) {
    throw new ReshieldRateMovedError(
      'The rate moved against you since you reviewed. Nothing was signed or spent. Review again for current numbers.',
    );
  }
  if (params.assertNoteValue) await params.assertNoteValue(hexToBigInt(estimate.noteValue));

  params.onStep?.('proving');
  assertIntentDepositTarget(params.outputToken, params.chainId);
  const depositResult = transfer && params.recipient
    ? await transfer.prepareReshieldTransferDeposit({
      ...params.recipient,
      outputToken: params.outputToken,
      totalDepositCost: estimate.totalDepositCost,
      noteValue: estimate.noteValue,
    })
    : await buildRedeposit(session, params.outputToken, estimate);

  params.onStep?.('quote');
  const quote = await (transfer
    ? transfer.prepareReshieldTransferQuote.bind(transfer)
    : session.prepareReshieldQuote.bind(session))({
    relayerInfo: params.relayerInfo,
    amount: gross,
    tokenId: params.inputToken,
    outputToken: params.outputToken,
    depositResult,
    totalDepositCost: estimate.totalDepositCost,
    ...(params.slippage !== undefined ? { slippage: params.slippage } : {}),
  });

  assertReshieldRelayAmount(quote, params.grossWei, params.inputUnits);

  if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded: the reshield was cancelled before submission. Nothing was sent.');
  params.onStep?.('relay');
  const receipt = await (transfer
    ? transfer.relayReshieldTransfer.bind(transfer)
    : session.relayReshield.bind(session))({
    inputCommitments: params.inputCommitments,
    // NET, not the gross above — see assertReshieldRelayAmount.
    amount: quote.netAmount,
    tokenId: params.inputToken,
    outputToken: params.outputToken,
    swapCalldata: quote.swapCalldata,
    selectedQuote: quote.selectedQuote,
    // Echoed so the relayer validates against what it actually signed.
    swapTarget: quote.swapTarget,
    approvalAddress: quote.approvalAddress,
    dustRecipient: quote.dustRecipient,
    // Echoed byte for byte: the SDK validates it against the composed executor call.
    ...(quote.executorCall !== undefined ? { executorCall: quote.executorCall } : {}),
    ...(params.onBroadcast ? { onBroadcast: (txHash: Hex) => params.onBroadcast?.(txHash, { quote }) } : {}),
  });

  // A resolved receipt is NOT success: the SDK returns a TxReceipt whose
  // `status` is the mined outcome, and it does not persist note updates for a
  // reverted transaction. Reporting "reshielded" on a revert would tell the
  // user their asset changed when their original note is still there.
  //
  // LITERAL true required (codex round 1): the project's canonical rule
  // (services/sdk-types.ts, intent-swaps assertReceiptSuccess) is that only
  // status === true is success — the old `=== false` check let an
  // absent/undefined status through as "reshielded" without confirmation.
  if (receipt?.status !== true) {
    throw new ReshieldRevertedError(
      receipt?.status === false
        ? 'The reshield transaction reverted on-chain. The exit, swap and redeposit rolled back together, so your notes were NOT spent.'
        : `The reshield transaction status could not be confirmed${receipt && receipt.txHash ? ` (tx ${receipt.txHash})` : ''}. Do not retry until your balance reflects the outcome.`,
      receipt?.txHash ?? null,
    );
  }

  return {
    receipt,
    estimate,
    quote,
    // Never for a transfer: that note belongs to the recipient, and storing it
    // here would put someone else's funds in the sender's balance.
    ...(!transfer && depositResult?.pendingNote ? { pendingNote: depositResult.pendingNote } : {}),
  };
}

const PRIVATE_SWAP_SEND_UNAVAILABLE = 'Private swap-send is not available on this network yet.';

/**
 * The transfer calls on a session, or a refusal. A session without them is a
 * build or chain with no configured yield-share target, so this says so
 * instead of failing later on `undefined is not a function`.
 */
function requireTransferSession<T extends object>(session: T): ReshieldTransferSessionLike {
  const candidate = session as Partial<ReshieldTransferSessionLike>;
  if (
    typeof candidate.estimateReshieldTransferAmount !== 'function'
    || typeof candidate.prepareReshieldTransferDeposit !== 'function'
    || typeof candidate.prepareReshieldTransferQuote !== 'function'
    || typeof candidate.relayReshieldTransfer !== 'function'
  ) {
    throw new ReshieldPreflightError(PRIVATE_SWAP_SEND_UNAVAILABLE);
  }
  return candidate as ReshieldTransferSessionLike;
}

// ─── Flow 4: cross-chain reshield (shielded A here → shielded B over there) ──
//
// Same shape as flow 3 with one structural difference that drives the whole
// design: the deposit proof must be built against the DESTINATION chain's
// Entrypoint, so this needs TWO sessions. The source session (this chain, with
// the destination attached via reshieldDestination) estimates, quotes and
// relays; a destination-scoped session proves the deposit.
//
// Success here means RELAYED, not delivered. The bridge leg settles minutes
// later, and if the destination deposit cannot execute LiFi pays out to
// `fallbackAddress` on the destination chain instead of reverting — so the
// caller must track delivery (getSwapStatus) rather than treat a good receipt
// as "shielded over there".

export interface ReshieldCrosschainEstimateLike {
  feeAmount: string;
  netSwapAmount: string;
  estimatedOutput: string;
  estimatedMinOutput: string;
  noteValue: Hex;
  vettingFee: string;
  totalDepositCost: string;
}

export interface PreparedReshieldCrosschainQuoteLike {
  selectedQuote: unknown;
  swapCalldata: Hex;
  feeAmount: string;
  netAmount: Hex;
  swapTarget: Address;
  approvalAddress: Address;
  dustRecipient: Address;
  dustRescue?: unknown;
  /**
   * B2 gas-swap leg, set by the SDK only for an Ethereum-destination reshield.
   * Bound into the relayer-signed routing and re-checked at relay, so it must
   * travel from prepare to relay unchanged.
   */
  swapValue?: bigint;
  gasSwapMaxInput?: bigint;
  gasSwapCalldata?: Hex;
}

/** Estimate, proof and prepare passes before a stale quote is reported as a failure. */
export const RESHIELD_CROSSCHAIN_MAX_ATTEMPTS = 4;

/**
 * Did the SDK refuse this cross-chain quote only because it went stale between
 * the estimate and the prepare? These four are thrown before anything is signed
 * (v2-monorepo#437, frontend guide "re-quote on transient errors"), so sizing
 * again from a fresh estimate is the whole remedy. Everything else is final
 * for this input, including `NativeDestinationDepositUnsupported` and
 * `DepositBelowMinimum`.
 */
export function isStaleCrosschainQuote(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // The guarantee drifted under the sized deposit. A fresh estimate probes the
  // route again and sizes under the new guarantee, which is the refit.
  if (err.name === 'DestinationDepositUnaffordable') return true;
  const message = err.message;
  // The relayer fee moved between the preliminary and the committed quote.
  if (message.includes('LiFi needs') && message.includes('available after fee')) return true;
  // A share's rate accrued between the two reads that size it.
  if (message.includes('moved while sizing')) return true;
  // LiFi's own transient on contractCalls quotes.
  if (message.includes('422') && message.includes('Market conditions have changed')) return true;
  return false;
}

/**
 * The chain type of a cross-chain reshield's destination. The SDK is
 * chain-agnostic now and every cross-chain call must echo the session's
 * destination type next to `toChainId`, or it refuses with "Destination chain
 * undefined:<id> does not match the configured destination" (DEV-507). The app
 * only reshields into EVM pools, and the session defaults to the same value.
 */
export const RESHIELD_DESTINATION_CHAIN_TYPE = 'evm';

/** The SOURCE-chain session, built with reshieldDestination attached. */
export interface ReshieldCrosschainSessionLike {
  estimateReshieldCrosschainAmount(params: {
    relayerInfo: unknown;
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    toChainId: number;
    toChainType: string;
    fallbackAddress?: Address;
    slippage?: number;
    denyExchanges?: string[];
  }): Promise<ReshieldCrosschainEstimateLike>;
  prepareReshieldCrosschainQuote(params: {
    relayerInfo: unknown;
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    toChainId: number;
    toChainType: string;
    fallbackAddress?: Address;
    depositResult: unknown;
    totalDepositCost: string;
    slippage?: number;
    denyExchanges?: string[];
  }): Promise<PreparedReshieldCrosschainQuoteLike>;
  relayReshieldCrosschain(params: {
    inputCommitments: Hash[];
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    toChainId: number;
    toChainType: string;
    fallbackAddress: Address;
    swapCalldata: Hex;
    selectedQuote: unknown;
    swapTarget?: Address;
    approvalAddress?: Address;
    dustRecipient?: Address;
    depositNote?: unknown;
    dustRescue?: unknown;
    swapValue?: bigint;
    gasSwapMaxInput?: bigint;
    gasSwapCalldata?: Hex;
    /** SDK #481: runs once with the relayed hash, before the receipt wait. */
    onBroadcast?: (txHash: Hex) => void;
  }): Promise<{ txHash?: Hex; status?: boolean }>;
}

/** A session scoped to the DESTINATION chain, used only for the deposit proof. */
export interface DestinationDepositSessionLike {
  prepareDeposit(params: { tokenId: Address; value: Hex }): Promise<{
    pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex };
  }>;
  /**
   * The destination chain's yield namespace for an asset, when it has one.
   * Present on a real session built for that chain; absent on the test doubles
   * and on an older SDK, which is why `buildRedeposit` treats it as optional
   * and falls back to the plain deposit.
   */
  yieldFor?: (tokenAddress: string) => unknown;
}

/**
 * The cross-chain reshield-and-transfer calls on a SOURCE session (v2-monorepo,
 * `IPoolSessionReshieldTransferCrosschain`). Same estimate -> deposit -> quote ->
 * relay order as flow 4, with the deposit built FOR a registered recipient
 * against the destination chain's keystore. The SDK only builds this when the
 * session was given the destination's share targets, and it only serves a
 * yield-share output: a plain token has no private cross-chain route to a third
 * party. The relay never takes a `depositNote`.
 */
export interface ReshieldTransferCrosschainSessionLike {
  estimateReshieldTransferCrosschainAmount: ReshieldCrosschainSessionLike['estimateReshieldCrosschainAmount'];
  prepareReshieldTransferCrosschainDeposit(params: ReshieldTransferRecipient & {
    outputToken: Address;
    totalDepositCost: string;
  }): Promise<{ pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex } }>;
  prepareReshieldTransferCrosschainQuote: ReshieldCrosschainSessionLike['prepareReshieldCrosschainQuote'];
  relayReshieldTransferCrosschain(
    params: Omit<Parameters<ReshieldCrosschainSessionLike['relayReshieldCrosschain']>[0], 'depositNote'>,
  ): ReturnType<ReshieldCrosschainSessionLike['relayReshieldCrosschain']>;
}

const PRIVATE_CROSSCHAIN_SEND_UNAVAILABLE = 'Private swap-send to that network is not available yet.';

/** The cross-chain transfer calls on a source session, or a refusal before anything is spent. */
export function requireTransferCrosschainSession<T extends object>(session: T): ReshieldTransferCrosschainSessionLike {
  const candidate = session as Partial<ReshieldTransferCrosschainSessionLike>;
  if (
    typeof candidate.estimateReshieldTransferCrosschainAmount !== 'function'
    || typeof candidate.prepareReshieldTransferCrosschainDeposit !== 'function'
    || typeof candidate.prepareReshieldTransferCrosschainQuote !== 'function'
    || typeof candidate.relayReshieldTransferCrosschain !== 'function'
  ) {
    throw new ReshieldPreflightError(PRIVATE_CROSSCHAIN_SEND_UNAVAILABLE);
  }
  const real = candidate as ReshieldTransferCrosschainSessionLike;
  // A real PoolSession always HAS these methods; without the destination's
  // share targets they throw on call. Map that to the same refusal, so Review
  // says "not available" instead of an SDK configuration message.
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (isTransferCrosschainUnconfigured(err)) throw new ReshieldPreflightError(PRIVATE_CROSSCHAIN_SEND_UNAVAILABLE);
      throw err;
    }
  };
  return {
    estimateReshieldTransferCrosschainAmount: guard(real.estimateReshieldTransferCrosschainAmount.bind(real)),
    prepareReshieldTransferCrosschainDeposit: guard(real.prepareReshieldTransferCrosschainDeposit.bind(real)),
    prepareReshieldTransferCrosschainQuote: guard(real.prepareReshieldTransferCrosschainQuote.bind(real)),
    relayReshieldTransferCrosschain: real.relayReshieldTransferCrosschain.bind(real),
  };
}

/** The SDK's "delegate not configured" / "share target not configured" refusals. */
export function isTransferCrosschainUnconfigured(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'YieldTargetNotConfigured'
    || err.message.includes('ReshieldTransferCrosschain is not available');
}

/**
 * Can a cross-chain swap-send deliver this output privately? Only a configured
 * yield share on the destination chain (the SDK's constraint). Anything else to
 * a third party stays the public Withdraw payout.
 */
export function crossChainSendOutputSupported(outputToken: string, toChainId: number): boolean {
  return isConfiguredShareTarget(outputToken, toChainId);
}

export async function runReshieldCrosschain(
  sourceSession: ReshieldCrosschainSessionLike,
  destinationSession: DestinationDepositSessionLike,
  params: {
    relayerInfo: unknown;
    grossWei: bigint;
    inputToken: Address;
    outputToken: Address;
    toChainId: number;
    /**
     * Where the destination chain pays out if its deposit cannot execute.
     * REQUIRED by the relay call, and it must be an address the user controls
     * on the destination chain — this is the only recourse when the far leg
     * fails, so it is never defaulted here.
     */
    fallbackAddress: Address;
    inputCommitments: Hash[];
    slippage?: number;
    /** The note value the user reviewed; a worse route must not execute silently. */
    minNoteValueWei?: bigint;

    /**
     * Runs on the FRESH estimate's note value before proving (launch deposit
     * cap: the reshield redeposits the swap output as a new note, so it is a
     * deposit for the ASP's purposes). Throw to abort; nothing is signed yet.
     */
    assertNoteValue?: (noteValueWei: bigint) => Promise<void> | void;
    /** Output units + destination name for the too-small-note refusal message. */
    outputUnits?: { symbol: string; decimals: number };
    destinationName?: string;
    shouldContinue?: () => boolean;
    onStep?: (step: 'estimate' | 'proving' | 'quote' | 'relay', detail?: string) => void;
    /** Units of the FROM token for human-readable refusals (services/swap-flows.ts assertReshieldRelayAmount). */
    inputUnits?: { decimals: number; symbol: string };
    /**
     * Swap-send: the new note is FOR this registered account on the destination
     * chain (reshield-and-transfer-crosschain). The output must be a configured
     * yield share there. No `pendingNote` is returned: it is not the sender's.
     */
    recipient?: ReshieldTransferRecipient;
    /**
     * The source leg's hash is back from the relayer, before its receipt
     * (DEV-433). Carries the quote and the destination note the record names.
     * Local only: never a request keyed on the hash.
     */
    onBroadcast?: (
      txHash: Hex,
      ctx: { quote: PreparedReshieldCrosschainQuoteLike; pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex } },
    ) => void;
  },
): Promise<{
  receipt: { txHash?: Hex; status?: boolean };
  estimate: ReshieldCrosschainEstimateLike;
  quote: PreparedReshieldCrosschainQuoteLike;
  /**
   * The new note on the DESTINATION chain. The caller MUST persist it against
   * that chain's session: relayReshieldCrosschain records the spent inputs and
   * the source-side change, but nothing on the destination side, so dropping
   * this loses the reshielded balance locally until a rescan finds it — and a
   * note received out of band would not be rediscoverable at all (kimi).
   */
  pendingNote?: { isOwned?: boolean; commitment?: Hash; value?: Hex };
}> {
  // Both checks run HERE, before any SDK call, so a direct caller cannot spend
  // an estimate or a proof on a target this session cannot serve.
  //
  // The share capability is bound to THIS session: `assertIntentDepositTarget` only
  // knows whether the chain has a router for the share, while the session knows
  // whether it was built with that chain's yield targets. Without them
  // buildRedeposit falls through to a plain Entrypoint deposit, which no share
  // pool accepts, and the failure would land at the END of a bridged transfer.
  // Only a share target is probed. A plain one needs nothing from the session,
  // and asking anyway would touch it for no reason, which is also what the
  // builder-refusal tests assert by handing in a session that throws on any
  // access.
  assertIntentDepositTarget(params.outputToken, params.toChainId, true);
  const needsShareRoute = isConfiguredShareTarget(params.outputToken, params.toChainId);
  // A swap-send is served by the SDK's transfer calls on the SOURCE session,
  // which resolve the share target and the recipient themselves. Refused here,
  // before any estimate, when the output is not a share or the build lacks them.
  const transfer = params.recipient ? requireTransferCrosschainSession(sourceSession) : null;
  if (transfer && !needsShareRoute) {
    throw new ReshieldPreflightError('This asset cannot be sent privately to that network. Pick a pool share, or use Withdraw.');
  }
  if (needsShareRoute && !transfer) redepositYieldTarget(destinationSession, params.outputToken, true);
  const gross = toHex(params.grossWei);
  if (params.inputCommitments.length === 0) {
    throw new ReshieldPreflightError('No spendable notes were selected for this reshield.');
  }
  // Unlike flow 3, the SAME asset across two chains is a legitimate move (send
  // shielded USDC on this chain to shielded USDC over there), so only the
  // same-chain case is refused — and the caller's gate has already done that.
  if (params.toChainId === undefined) {
    throw new ReshieldPreflightError('Pick a destination network for this reshield.');
  }

  // The SDK re-quotes LiFi between the estimate and the prepare, and several
  // things can move in those seconds (v2-monorepo#437): LiFi's guaranteed
  // delivery drifts below the deposit the estimate sized, the relayer fee
  // moves, a share's rate accrues between two reads, LiFi answers 422. Each is
  // thrown before anything is signed, so the answer is to size again from a
  // fresh estimate and a fresh proof, not to fail. Bounded, and the consent
  // floor and the cap below are asked again on every pass.
  const denyExchanges = [...CROSS_CHAIN_DENY_EXCHANGES];
  let estimate!: ReshieldCrosschainEstimateLike;
  let depositResult!: Awaited<ReturnType<typeof buildRedeposit>>;
  let quote!: PreparedReshieldCrosschainQuoteLike;
  // Set by a DestinationDepositUnaffordable: the SDK already told us what fits.
  // A fresh estimate sizes from the same preview route and lands above the
  // guarantee again, so every retry failed the same way (BSC -> Ethereum,
  // 2026-09-27). Cap the next estimate at the carried value instead; the
  // consent floor below still decides whether the user must review again.
  let refit: { noteValue: bigint; totalDepositCost: bigint } | null = null;
  for (let attempt = 1; ; attempt++) {
    params.onStep?.('estimate', attempt > 1 ? 'resize' : undefined);
    try {
      estimate = await (transfer
        ? transfer.estimateReshieldTransferCrosschainAmount.bind(transfer)
        : sourceSession.estimateReshieldCrosschainAmount.bind(sourceSession))({
        relayerInfo: params.relayerInfo,
        amount: gross,
        tokenId: params.inputToken,
        outputToken: params.outputToken,
        toChainId: params.toChainId,
        toChainType: RESHIELD_DESTINATION_CHAIN_TYPE,
        fallbackAddress: params.fallbackAddress,
        denyExchanges,
        ...(params.slippage !== undefined ? { slippage: params.slippage } : {}),
      });
      if (refit && hexToBigInt(estimate.noteValue) > refit.noteValue) {
        const plainVettingFee = BigInt(estimate.vettingFee || '0') > 0n;
        estimate = {
          ...estimate,
          noteValue: `0x${refit.noteValue.toString(16)}` as Hex,
          totalDepositCost: refit.totalDepositCost.toString(),
          // A plain output pays its vetting fee on top of the note; a share output has none here.
          ...(plainVettingFee ? { vettingFee: (refit.totalDepositCost > refit.noteValue ? refit.totalDepositCost - refit.noteValue : 0n).toString() } : {}),
        };
      }

      if (hexToBigInt(estimate.noteValue) <= 0n) {
        throw new ReshieldPreflightError(
          'The route would produce nothing to redeposit at this amount. Try a larger amount.',
        );
      }
      if (BigInt(estimate.netSwapAmount || '0') <= 0n) {
        throw new ReshieldPreflightError(
          'The relayer fee now covers the whole amount. Nothing was signed or spent. Try a larger amount.',
        );
      }
      if (params.outputUnits) assertReshieldNoteWorthIt(estimate, params.outputUnits, params.destinationName);
      if (params.minNoteValueWei !== undefined && hexToBigInt(estimate.noteValue) < params.minNoteValueWei) {
        throw new ReshieldRateMovedError(
          'The rate moved against you since you reviewed. Nothing was signed or spent. Review again for current numbers.',
        );
      }
      if (params.assertNoteValue) await params.assertNoteValue(hexToBigInt(estimate.noteValue));

      // The proof belongs to the DESTINATION chain's Entrypoint — that is the whole
      // reason this flow takes two sessions.
      params.onStep?.('proving');
      // A SHARE destination is funded through its router, exactly as the same-chain
      // reshield does it: `buildRedeposit` asks the destination session for the
      // asset's yield namespace and uses `prepareYieldSwapDeposit` when it is one.
      //
      // Re-check both the configured gate and the session capability after the
      // awaited estimate. Losing the namespace must refuse before proving rather
      // than fall through to a plain deposit at the far end of the bridge.
      assertIntentDepositTarget(params.outputToken, params.toChainId, true);
      depositResult = transfer && params.recipient
        ? await transfer.prepareReshieldTransferCrosschainDeposit({
          ...params.recipient,
          outputToken: params.outputToken,
          totalDepositCost: estimate.totalDepositCost,
        })
        : await buildRedeposit(destinationSession, params.outputToken, estimate, {
          requireShareRoute: needsShareRoute,
          crossChain: true,
        });
      // The SDK refuses a self-owned deposit at quote time too. Checked here so
      // a wrong owner never reaches the relayer through any other build.
      if (transfer && depositResult?.pendingNote?.isOwned) {
        throw new ReshieldPreflightError('The deposit was built for this account, not the recipient. Nothing was sent.');
      }

      params.onStep?.('quote');
      quote = await (transfer
        ? transfer.prepareReshieldTransferCrosschainQuote.bind(transfer)
        : sourceSession.prepareReshieldCrosschainQuote.bind(sourceSession))({
        relayerInfo: params.relayerInfo,
        amount: gross,
        tokenId: params.inputToken,
        outputToken: params.outputToken,
        toChainId: params.toChainId,
        toChainType: RESHIELD_DESTINATION_CHAIN_TYPE,
        fallbackAddress: params.fallbackAddress,
        depositResult,
        totalDepositCost: estimate.totalDepositCost,
        denyExchanges,
        ...(params.slippage !== undefined ? { slippage: params.slippage } : {}),
      });
      break;
    } catch (err) {
      if (attempt >= RESHIELD_CROSSCHAIN_MAX_ATTEMPTS || !isStaleCrosschainQuote(err)) throw err;
      refit = unaffordableRefit(err) ?? refit;
      console.log('[ReshieldCrosschain] quote went stale before signing, sizing again', {
        attempt,
        reason: err instanceof Error ? err.name : String(err),
      });
      if (params.shouldContinue && !params.shouldContinue()) {
        throw new Error('Superseded: the reshield was cancelled before submission. Nothing was sent.');
      }
    }
  }

  assertReshieldRelayAmount(quote, params.grossWei, params.inputUnits);

  if (params.shouldContinue && !params.shouldContinue()) {
    throw new Error('Superseded: the reshield was cancelled before submission. Nothing was sent.');
  }
  params.onStep?.('relay');
  const relayCrosschain = transfer
    ? transfer.relayReshieldTransferCrosschain.bind(transfer)
    : sourceSession.relayReshieldCrosschain.bind(sourceSession);
  const receipt = await relayCrosschain({
    inputCommitments: params.inputCommitments,
    // NET, never the gross that went into prepare — same rule as flow 3.
    amount: quote.netAmount,
    tokenId: params.inputToken,
    outputToken: params.outputToken,
    toChainId: params.toChainId,
    toChainType: RESHIELD_DESTINATION_CHAIN_TYPE,
    fallbackAddress: params.fallbackAddress,
    swapCalldata: quote.swapCalldata,
    selectedQuote: quote.selectedQuote,
    swapTarget: quote.swapTarget,
    approvalAddress: quote.approvalAddress,
    dustRecipient: quote.dustRecipient,
    // Never for a transfer: the sender must not persist the recipient's note.
    ...(!transfer && depositResult?.pendingNote ? { depositNote: depositResult.pendingNote } : {}),
    ...(quote.dustRescue ? { dustRescue: quote.dustRescue } : {}),
    // B2: without these, relay compares the signed gas swap against "0x".
    ...(quote.gasSwapCalldata !== undefined
      ? {
          swapValue: quote.swapValue,
          gasSwapMaxInput: quote.gasSwapMaxInput,
          gasSwapCalldata: quote.gasSwapCalldata,
        }
      : {}),
    ...(params.onBroadcast
      ? {
          onBroadcast: (txHash: Hex) => params.onBroadcast?.(txHash, {
            quote,
            ...(!transfer && depositResult?.pendingNote ? { pendingNote: depositResult.pendingNote } : {}),
          }),
        }
      : {}),
  });

  // Only a literal true is success (project rule): the SDK returns the MINED
  // outcome and does not persist note updates for a reverted transaction.
  if (receipt?.status !== true) {
    throw new ReshieldRevertedError(
      receipt?.status === false
        ? 'The cross-chain reshield reverted on-chain. The exit, swap and bridge dispatch rolled back together, so your notes were NOT spent.'
        : `The cross-chain reshield status could not be confirmed${receipt && receipt.txHash ? ` (tx ${receipt.txHash})` : ''}. Do not retry until your balance reflects the outcome.`,
      receipt?.txHash ?? null,
    );
  }

  return {
    receipt,
    estimate,
    quote,
    ...(!transfer && depositResult?.pendingNote ? { pendingNote: depositResult.pendingNote } : {}),
  };
}

/** Base-unit bigint → 0x hex, the form every SDK amount param takes. */
export function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

// ─── Cross-chain bridge status (guide §9) ─────────────────────────────────

export interface SwapStatusSessionLike {
  getSwapStatus(params: { txHash: Hex; fromChainId: number; toChainId: number }): Promise<SwapStatusLike>;
}

export type { SwapStatusLike };

// The schedule lives in its own module so tests can import it: this file pulls
// React Native in transitively and cannot be loaded from bun test.
export {
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_POLL_MAX_MS,
  BRIDGE_POLL_FAST_WINDOW_MS,
  BRIDGE_POLL_SLOW_INTERVAL_MS,
  BRIDGE_RESYNC_AFTER_MS,
  BRIDGE_RESYNC_EVERY_MS,
  bridgePollIntervalFor,
  bridgeResyncDue,
} from '@/services/bridge-poll-schedule';


/**
 * Human line for a bridge-in-progress banner. NOT_FOUND is deliberately
 * optimistic: LiFi has not indexed the source tx yet, which is normal for the
 * first few seconds and must not read as a failure.
 */
/**
 * What actually happened to the funds once a bridge reports a terminal state.
 *
 * LiFi's `DONE` covers two very different outcomes for a contract-call route:
 * the destination call ran (`COMPLETED`), or it FAILED and the receiver
 * delivered the bridged tokens to the fallback wallet instead (`PARTIAL`, or
 * `REFUNDED` when they went back to the source). The bridge is "done" either
 * way — Pat's ETH → OP shield showed a completed LayerZero link while the pool
 * had nothing and the ETH sat in his OP wallet (2026-08-29). The UI must read
 * the substatus, not the status.
 */
export type BridgeDeliveryOutcome = 'pending' | 'deposited' | 'recovered' | 'failed';

export function bridgeDeliveryOutcome(status: SwapStatusLike | null): BridgeDeliveryOutcome {
  if (!status) return 'pending';
  if (status.status === 'FAILED') return 'failed';
  if (status.status !== 'DONE') return 'pending';
  const sub = (status.substatus ?? '').toUpperCase();
  if (sub === 'PARTIAL' || sub === 'REFUNDED') return 'recovered';
  return 'deposited';
}

export function describeSwapStatus(status: SwapStatusLike | null): {
  tone: 'pending' | 'done' | 'failed';
  text: string;
} {
  if (!status) return { tone: 'pending', text: 'Checking bridge status…' };
  switch (status.status) {
    case 'DONE': {
      if (bridgeDeliveryOutcome(status) === 'recovered') {
        const where = (status.substatus ?? '').toUpperCase() === 'REFUNDED'
          ? 'refunded to your wallet on the source chain'
          : 'delivered to your wallet on the destination chain';
        return {
          tone: 'failed',
          text: `Bridged, but the deposit did not execute. Your funds were ${where} instead. Nothing was shielded.`,
        };
      }
      return { tone: 'done', text: 'Bridged and delivered.' };
    }
    case 'FAILED':
      return {
        tone: 'failed',
        text: status.substatusMessage?.trim()
          ? `Bridge failed: ${status.substatusMessage.trim()}`
          : 'The bridge leg failed. Funds went to your fallback address.',
      };
    case 'NOT_FOUND':
      return { tone: 'pending', text: 'Waiting for the bridge to pick up the transaction…' };
    case 'PENDING':
    default:
      return {
        tone: 'pending',
        text: status.substatus === 'WAIT_DESTINATION_TRANSACTION'
          ? 'Bridged. Waiting for the destination transaction…'
          : 'Bridging…',
      };
  }
}

/** True once polling should stop. */
export function isTerminalSwapStatus(status: SwapStatusLike | null): boolean {
  return status?.status === 'DONE' || status?.status === 'FAILED';
}

/** Attempts for a same-chain reshield whose committed relayer fee outgrew the estimate. */
export const RESHIELD_FEE_DRIFT_MAX_ATTEMPTS = 3;

/**
 * The relayer fee moved between the estimate and the committed quote, so the
 * swap no longer fits what is left after it. The SDK refuses before anything
 * is signed, so a fresh estimate (and proof) is the whole remedy.
 */
export function isReshieldFeeDrift(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('LiFi needs') && err.message.includes('available after fee');
}

/**
 * Flow 3 with the retry the cross-chain flow already had. On Ethereum the
 * relayer fee is several dollars and moves between the estimate and the
 * committed quote, so "This route needs 18.5243 USDT but only 18.2191 USDT is
 * left after the fee" hit a 25 USDT swap repeatedly (Mike, 2026-09-28). Each
 * attempt re-estimates against the current fee, and the consent floor still
 * refuses a result worse than the one reviewed.
 */
export async function runReshield(
  session: ReshieldSessionLike,
  params: Parameters<typeof runReshieldOnce>[1],
): ReturnType<typeof runReshieldOnce> {
  for (let attempt = 1; ; attempt += 1) {
    // Retry only what ran before the relay, like the cross-chain loop: once the
    // relayer submission started, the same error must never send it twice.
    let relayStarted = false;
    try {
      return await runReshieldOnce(session, {
        ...params,
        onStep: (step, detail) => {
          if (step === 'relay') relayStarted = true;
          params.onStep?.(step, detail);
        },
      });
    } catch (err) {
      if (relayStarted || attempt >= RESHIELD_FEE_DRIFT_MAX_ATTEMPTS || !isReshieldFeeDrift(err)) throw err;
      // A cancelled or superseded modal gets the refusal, not another proof.
      if (params.shouldContinue && !params.shouldContinue()) throw err;
    }
  }
}
