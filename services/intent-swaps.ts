// Intent-swap (withdraw-and-swap via LiFi) service layer.
//
// Pure, node-testable helpers between the swap modal and the v2.0 SDK's
// PoolSessionWithdrawAndSwap surface (`prepareSwapQuote` /
// `relayWithdrawAndSwap`). Everything here is a plain function over
// structural types so the UI provider stays thin and the fee/mode/routing
// logic is unit-tested (services/__tests__/intent-swaps.test.ts).
//
// Semantics follow docs/tech-design/sdk/withdraw-and-swap.md (v2.0):
//  - `recipient == address(0)` is the canonical sentinel for "no
//    source-chain recipient" — reshield and cross-chain delivery. In that
//    mode the on-chain `minOutputAmount` MUST be 0 (the source chain cannot
//    verify destination output); slippage protection lives in the
//    proof-bound LiFi calldata instead.
//  - `prepareSwapQuote` quotes a GROSS withdrawal (`amount`), but
//    `relayWithdrawAndSwap` spends the NET (`gross − relayer fee`) into the
//    proof — `PreparedSwapQuote.netAmount` must be passed verbatim.
//  - `swapTarget` / `approvalAddress` / `dustRecipient` / `toChainId` from
//    the prepared quote are echoed to relay time so the SDK validates the
//    exact routing tuple the relayer signed.

import type { Address, Hex, Note } from '@/services/sdk-types';
import { tokenKey as noteTokenKey } from '@/services/note-token-id';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// --- Structural mirrors of the SDK types the service consumes -------------
// (Structural typing keeps this module importable in node tests without
// loading the SDK bundle; the real SDK objects satisfy these shapes.)

/** Mirror of the SDK's PreparedSwapQuote (the fields this layer consumes). */
export interface PreparedSwapQuoteLike {
  selectedQuote: unknown;
  swapCalldata: Hex;
  /** On-chain enforced minimum output ("0x0" for cross-chain). */
  minOutputAmount: Hex;
  /** LiFi toAmountMin — informational for cross-chain display. */
  destinationMinOutputAmount: Hex;
  /** Relayer fee in input-token units (decimal string). */
  feeAmount: string;
  /** NET amount (gross − fee), hex — pass verbatim to relayWithdrawAndSwap. */
  netAmount: Hex;
  /** Estimated output from LiFi (decimal string, output-token wei). */
  estimatedOutput: string;
  swapTarget: Address;
  approvalAddress: Address;
  dustRecipient: Address;
  toChainId: number;
}

/** Mirror of the SDK's SwapQuoteResult echo fields (route validation). */
export interface SwapQuoteEchoLike {
  fromTokenAddress: Address;
  toTokenAddress: Address;
  fromChainId: number;
  toChainId: number;
}

// --- Availability ------------------------------------------------------------

/**
 * Pure availability rule (unit-tested here; consumed by
 * config/intent-swaps.ts): the feature needs BOTH the master flag and a
 * configured RelaySwaps processor for the chain. Fail closed.
 */
export function resolveSwapAvailability(
  flagEnabled: boolean,
  processorAddress: `0x${string}` | undefined,
): boolean {
  return flagEnabled && !!processorAddress;
}

// --- Delivery modes --------------------------------------------------------

export type SwapDeliveryMode = 'same-chain' | 'cross-chain';

export function isCrossChainSwap(poolChainId: number, toChainId?: number): boolean {
  return toChainId !== undefined && toChainId !== poolChainId;
}

export interface SwapDelivery {
  mode: SwapDeliveryMode;
  /**
   * The recipient the on-chain SwapRouting carries. For cross-chain swaps
   * this is address(0) — the real recipient lives only inside the
   * proof-bound LiFi calldata (`toAddress`), delivered on the destination
   * chain by LiFi's executor.
   */
  onChainRecipient: Address;
  /**
   * Where the enforced minimum-output lives: on-chain balance-delta check
   * (same-chain) vs LiFi's destination executor via proof-bound calldata
   * (cross-chain, on-chain minOutputAmount must be 0).
   */
  minOutputEnforcement: 'on-chain' | 'destination-executor';
}

/**
 * Resolves how a swap's output is delivered and which recipient the on-chain
 * routing must carry. `recipientAddress` is always the address the USER
 * receives at — on the pool chain (same-chain) or the destination chain
 * (cross-chain).
 */
export function resolveSwapDelivery(params: {
  poolChainId: number;
  toChainId?: number;
  recipientAddress: Address;
}): SwapDelivery {
  if (isCrossChainSwap(params.poolChainId, params.toChainId)) {
    return {
      mode: 'cross-chain',
      onChainRecipient: ZERO_ADDRESS,
      minOutputEnforcement: 'destination-executor',
    };
  }
  return {
    mode: 'same-chain',
    onChainRecipient: params.recipientAddress,
    minOutputEnforcement: 'on-chain',
  };
}

// --- Route validation -------------------------------------------------------

/**
 * Cross-checks a LiFi quote's echoed routing against what was requested.
 * Returns a list of human-readable mismatches (empty = valid). The SDK does
 * its own echo check before hashing; this validates the tuple the UI is
 * about to present so a mismatched route never reaches Review.
 */
export function validateSwapRouteEcho(
  requested: { fromChainId: number; toChainId: number; fromToken: Address; toToken: Address },
  echoed: SwapQuoteEchoLike,
): string[] {
  const problems: string[] = [];
  if (echoed.fromChainId !== requested.fromChainId) {
    problems.push(`route source chain ${echoed.fromChainId} != requested ${requested.fromChainId}`);
  }
  if (echoed.toChainId !== requested.toChainId) {
    problems.push(`route destination chain ${echoed.toChainId} != requested ${requested.toChainId}`);
  }
  if (echoed.fromTokenAddress.toLowerCase() !== requested.fromToken.toLowerCase()) {
    problems.push(`route input token ${echoed.fromTokenAddress} != requested ${requested.fromToken}`);
  }
  if (echoed.toTokenAddress.toLowerCase() !== requested.toToken.toLowerCase()) {
    problems.push(`route output token ${echoed.toTokenAddress} != requested ${requested.toToken}`);
  }
  return problems;
}

// --- Quote shaping for display ----------------------------------------------

/**
 * Formats a bigint token amount as a decimal string (no trailing zeros).
 * Adaptive: a NONZERO value never renders as "0" — when the amount is below
 * the requested display precision, the full-precision fraction is shown
 * instead (1 wei ETH → "0.000000000000000001"), so fees/minimums can't be
 * misrepresented as free/zero.
 */
export function formatTokenUnits(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fullFrac = (abs % base).toString().padStart(decimals, '0');
  let frac = maxFractionDigits < decimals ? fullFrac.slice(0, maxFractionDigits) : fullFrac;
  frac = frac.replace(/0+$/, '');
  // Nonzero money must never display as zero: fall back to full precision.
  if (abs > 0n && whole === 0n && !frac) {
    frac = fullFrac.replace(/0+$/, '');
  }
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

export interface SwapQuoteDisplay {
  /** Estimated output, formatted in output-token units. */
  estimatedOutput: string;
  /**
   * The minimum the user can receive, formatted. Same-chain: the on-chain
   * enforced minOutputAmount. Cross-chain: LiFi's destinationMinOutputAmount
   * (the on-chain value is 0 by protocol rule and would be misleading).
   */
  minReceived: string;
  /** Relayer fee, formatted in input-token units. */
  relayerFee: string;
  /** Net amount actually swapped (gross − fee), formatted in input tokens. */
  netSwapped: string;
  /** Effective rate: estimated output per 1 input token ('' if no input). */
  rate: string;
  mode: SwapDeliveryMode;
}

export function shapeSwapQuoteForDisplay(
  prepared: PreparedSwapQuoteLike,
  params: { poolChainId: number; inputDecimals: number; outputDecimals: number },
): SwapQuoteDisplay {
  const crossChain = isCrossChainSwap(params.poolChainId, prepared.toChainId);
  const minWei = crossChain
    ? BigInt(prepared.destinationMinOutputAmount)
    : BigInt(prepared.minOutputAmount);
  const netWei = BigInt(prepared.netAmount);
  const estWei = BigInt(prepared.estimatedOutput || '0');
  let rate = '';
  if (netWei > 0n) {
    // est / net, scaled into output-token decimals for formatting.
    const rateScaled = (estWei * 10n ** BigInt(params.inputDecimals)) / netWei;
    rate = formatTokenUnits(rateScaled, params.outputDecimals);
  }
  return {
    estimatedOutput: formatTokenUnits(estWei, params.outputDecimals),
    minReceived: formatTokenUnits(minWei, params.outputDecimals),
    relayerFee: formatTokenUnits(BigInt(prepared.feeAmount || '0'), params.inputDecimals),
    netSwapped: formatTokenUnits(netWei, params.inputDecimals),
    rate,
    mode: crossChain ? 'cross-chain' : 'same-chain',
  };
}

// --- Prepared-quote validation ------------------------------------------------

export function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

/** Reads the signed fee-commitment expiration (ms epoch) off a prepared quote. */
export function getPreparedQuoteExpiration(prepared: PreparedSwapQuoteLike): number | undefined {
  const expiration = (prepared.selectedQuote as { quote?: { feeCommitment?: { expiration?: number } } })
    ?.quote?.feeCommitment?.expiration;
  return typeof expiration === 'number' && Number.isFinite(expiration) ? expiration : undefined;
}

/**
 * Minimum remaining commitment lifetime required at Review AND Confirm time:
 * the p99 proof-generation budget (~60s on typical devices; 30–60s observed)
 * plus a submission margin (~15s for relay POST + queueing). The SDK only
 * re-checks expiry when posting to the relayer — AFTER proving — so entering
 * proving with less lifetime than this deterministically burns the whole
 * proof on a commitment that can't be submitted. The relayer's swap-quote
 * TTL must exceed this window (plus expected review dwell time) or every
 * confirm will be rejected up front — that requirement lives on the
 * enablement checklist in config/intent-swaps.ts.
 */
/**
 * Minimum commitment lifetime left before we start proving.
 *
 * Was 75s. The relayer's fee commitments live `quote_expiration_ms`, which
 * defaults to 60_000 and is what every deployed instance uses: measured
 * 59.9s on chain 10 (2026-08-29, swap AND transfer quotes alike). A 75s
 * floor therefore refused EVERY swap quote the relayer ever issued —
 * "The relayer quote expires too soon to complete proving" on each attempt,
 * with the relayer answering 201 the whole time (Pat, withdrawing USDC
 * OP → ETH). 50s is Pat's call: enough to start proving on a fresh quote.
 * The commitment is REFRESHED at confirm when the reviewed one has run down
 * (`validateRefreshedSwapQuote`), so review dwell time no longer eats it.
 *
 * This decides whether a REVIEWED quote is reused or refreshed. It never
 * judges a quote fetched moments ago (`isFreshCommitmentLive`): that one
 * reads about 59.9s, so the 10s margin left by this window only absorbs
 * latency and clock skew, and a device clock 15s fast refused every fresh
 * quote (measured on Sepolia, 2026-10-02).
 */
export const SWAP_PROVING_SAFETY_WINDOW_MS = 50_000;

export function hasUsableCommitmentLifetime(
  expiration: number | undefined,
  nowMs: number,
  safetyWindowMs = SWAP_PROVING_SAFETY_WINDOW_MS,
): boolean {
  if (!expiration) return false;
  return expiration - nowMs > safetyWindowMs;
}

/**
 * Whether a commitment fetched moments ago can still be proved against. Only
 * an already expired one is refused: running out during proving is caught by
 * the SDK before the relay POST, with nothing sent.
 */
export function isFreshCommitmentLive(expiration: number | undefined, nowMs: number): boolean {
  return hasUsableCommitmentLifetime(expiration, nowMs, 0);
}

/**
 * Mode-aware invariant check on a prepared quote, run BEFORE Review is shown
 * and again inside the relay-params builder. Returns human-readable
 * problems (empty = valid).
 *
 * - gross binding: the committed gross (netAmount + feeAmount) must equal
 *   the wei amount the user reviewed — a hostile/malformed commitment with a
 *   larger amountSent must never reach proof generation (the 71263ca8 SDK
 *   asserts this too; this is app-side defense in depth).
 * - same-chain: nonzero recipient, on-chain minOutputAmount > 0 (zero would
 *   skip RelaySwaps' balance-delta protection), and it must equal LiFi's
 *   destinationMinOutputAmount.
 * - cross-chain: on-chain minOutputAmount must be 0 (protocol rule), the
 *   informational destination minimum must be positive, and destination
 *   recipient + fallback must be real addresses (a zero destination burns
 *   or strands delivery).
 */
/**
 * Largest fee/output drift a confirm-time refresh may carry over silently.
 *
 * A refreshed quote is the SAME order (same gross, tokens, recipient,
 * destination) re-priced seconds later. The user reviewed the old numbers, so
 * the fresh ones must stay close: the fee may not rise, and the estimated
 * output may not fall, by more than this, or the user re-reviews. 1% mirrors
 * the route slippage tolerance already accepted at review.
 */
export const REFRESH_DRIFT_BPS = 100n;

/**
 * Is a confirm-time refresh of the commitment still the order the user
 * reviewed? Returns the problems; empty means the fresh quote may replace it.
 *
 * Structural fields (tokens, destination, recipient, gross) are checked by
 * `validatePreparedSwapQuote` on the fresh quote itself; this compares the two
 * PRICED fields the user actually saw. Only movement AGAINST the user counts:
 * a lower fee or a higher output is simply better.
 */
export function validateRefreshedSwapQuote(
  reviewed: Pick<PreparedSwapQuoteLike, 'feeAmount' | 'estimatedOutput' | 'toChainId'>,
  fresh: Pick<PreparedSwapQuoteLike, 'feeAmount' | 'estimatedOutput' | 'toChainId'>,
  driftBps = REFRESH_DRIFT_BPS,
): string[] {
  const problems: string[] = [];
  if (fresh.toChainId !== reviewed.toChainId) {
    problems.push(`refreshed quote targets chain ${fresh.toChainId}, reviewed ${reviewed.toChainId}`);
  }
  const parseRequiredAmount = (value: string, field: string): bigint => {
    if (value.trim() === '') throw new Error(`${field} is empty`);
    return BigInt(value);
  };
  let oldFee: bigint; let newFee: bigint; let oldOut: bigint; let newOut: bigint;
  try {
    oldFee = BigInt(reviewed.feeAmount || '0'); newFee = BigInt(fresh.feeAmount || '0');
    oldOut = parseRequiredAmount(reviewed.estimatedOutput, 'reviewed estimated output');
    newOut = parseRequiredAmount(fresh.estimatedOutput, 'refreshed estimated output');
  } catch {
    return [...problems, 'refreshed quote carries an unreadable amount'];
  }
  // Fee may not rise more than drift. On a zero reviewed fee any rise is drift.
  const feeCeiling = oldFee + (oldFee * driftBps) / 10_000n;
  if (newFee > feeCeiling) problems.push(`refreshed relayer fee ${newFee} exceeds reviewed ${oldFee} by more than ${driftBps} bps`);
  // Output may not fall more than drift. A zero/missing estimate makes that
  // comparison vacuous, so require the user to review again instead.
  if (oldOut <= 0n || newOut <= 0n) {
    problems.push('refreshed quote carries a non-positive estimated output');
  } else {
    const outFloor = oldOut - (oldOut * driftBps) / 10_000n;
    if (newOut < outFloor) problems.push(`refreshed estimated output ${newOut} is below reviewed ${oldOut} by more than ${driftBps} bps`);
  }
  return problems;
}

export function validatePreparedSwapQuote(
  prepared: PreparedSwapQuoteLike,
  params: {
    poolChainId: number;
    grossWei: bigint;
    recipientAddress: Address;
    fallbackAddress?: Address;
  },
): string[] {
  const problems: string[] = [];
  const net = BigInt(prepared.netAmount);
  const fee = BigInt(prepared.feeAmount || '0');
  if (net <= 0n) problems.push('committed net amount is not positive');
  if (fee < 0n) problems.push('committed fee is negative');
  if (net + fee !== params.grossWei) {
    problems.push(`committed gross ${net + fee} does not equal the reviewed amount ${params.grossWei}`);
  }
  if (isZeroAddress(params.recipientAddress)) problems.push('recipient is the zero address');
  if (params.fallbackAddress !== undefined && isZeroAddress(params.fallbackAddress)) {
    problems.push('fallback address is the zero address');
  }
  if (isZeroAddress(prepared.dustRecipient)) problems.push('dust recipient is the zero address');
  const crossChain = isCrossChainSwap(params.poolChainId, prepared.toChainId);
  const minOut = BigInt(prepared.minOutputAmount);
  const destMin = BigInt(prepared.destinationMinOutputAmount);
  if (crossChain) {
    if (minOut !== 0n) problems.push(`cross-chain on-chain minOutputAmount must be 0, got ${minOut}`);
    if (destMin <= 0n) problems.push('cross-chain destination minimum output must be positive');
    if (params.fallbackAddress === undefined) problems.push('cross-chain swap requires an explicit fallback address');
  } else {
    if (minOut <= 0n) problems.push('same-chain minOutputAmount must be positive (zero disables the on-chain output check)');
    if (destMin !== minOut) {
      problems.push(`same-chain minOutputAmount ${minOut} does not equal destination minimum ${destMin}`);
    }
  }
  return problems;
}

// --- Prepare + validate (shared quote orchestration core) ---------------------

/**
 * The one SDK surface the quote step needs. Structural so both modals (swap,
 * withdraw "Receive as") and node tests can drive the same orchestration
 * without loading the SDK bundle.
 */
export interface SwapQuoteSessionLike {
  prepareSwapQuote(params: {
    relayerInfo: unknown;
    amount: Hex;
    tokenId: Address;
    outputToken: Address;
    recipientAddress: Address;
    slippage: number;
    toChainId?: number;
    fallbackAddress?: Address;
  }): Promise<unknown>;
}

/** Thrown when a relayer-prepared quote fails the app-side invariants. */
export class InvalidSwapQuoteError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The relayer returned an invalid quote. Nothing was signed or spent. (${problems[0] ?? 'unknown problem'})`);
    this.name = 'InvalidSwapQuoteError';
    this.problems = problems;
  }
}

/**
 * The shared quote core both the swap modal and the withdraw modal's
 * "Receive as" compose path run: call the SDK's `prepareSwapQuote` for the
 * GROSS amount, re-validate the returned commitment app-side
 * (validatePreparedSwapQuote — gross binding, zero addresses, mode-aware
 * minimums; defense in depth over the SDK's own asserts), and shape the
 * display figures. Throws InvalidSwapQuoteError instead of ever returning a
 * quote that must not reach Review.
 */
export async function prepareValidatedSwapQuote(
  session: SwapQuoteSessionLike,
  params: {
    relayerInfo: unknown;
    poolChainId: number;
    grossWei: bigint;
    inputToken: { address: Address; decimals: number };
    outputToken: { address: Address; decimals: number };
    recipientAddress: Address;
    slippage: number;
    /** Omit for same-chain delivery (destination = pool chain). */
    toChainId?: number;
    /** Required for cross-chain (validatePreparedSwapQuote enforces it). */
    fallbackAddress?: Address;
    /** Exchanges to keep out of the route (see SWAP_DENY_EXCHANGES). */
    denyExchanges?: readonly string[];
  },
): Promise<{ prepared: PreparedSwapQuoteLike; display: SwapQuoteDisplay }> {
  const crossChain = isCrossChainSwap(params.poolChainId, params.toChainId);
  const prepared = (await session.prepareSwapQuote({
    relayerInfo: params.relayerInfo,
    amount: `0x${params.grossWei.toString(16)}` as Hex,
    tokenId: params.inputToken.address,
    outputToken: params.outputToken.address,
    recipientAddress: params.recipientAddress,
    slippage: params.slippage,
    ...(params.denyExchanges && params.denyExchanges.length > 0
      ? { denyExchanges: [...params.denyExchanges] }
      : {}),
    ...(crossChain
      ? {
          toChainId: params.toChainId as number,
          ...(params.fallbackAddress !== undefined ? { fallbackAddress: params.fallbackAddress } : {}),
        }
      : {}),
  })) as PreparedSwapQuoteLike;
  const problems = validatePreparedSwapQuote(prepared, {
    poolChainId: params.poolChainId,
    grossWei: params.grossWei,
    recipientAddress: params.recipientAddress,
    ...(crossChain && params.fallbackAddress !== undefined ? { fallbackAddress: params.fallbackAddress } : {}),
  });
  if (problems.length > 0) {
    throw new InvalidSwapQuoteError(problems);
  }
  const display = shapeSwapQuoteForDisplay(prepared, {
    poolChainId: params.poolChainId,
    inputDecimals: params.inputToken.decimals,
    outputDecimals: params.outputToken.decimals,
  });
  return { prepared, display };
}

// --- Withdraw "Receive as" (compose a swap into the exit) ----------------------

/**
 * Gate for the withdraw modal's "Receive as" selector (Mike's spec C5): the
 * exact swap availability rule (master flag AND a configured RelaySwaps
 * processor, fail closed) plus the EVM-only restriction — intent swaps are
 * LiFi-routed and never exist on Sui. When this is false the withdraw modal
 * must render byte-for-byte its plain behavior.
 */
export function resolveReceiveAsAvailability(
  flagEnabled: boolean,
  processorAddress: `0x${string}` | undefined,
  isSui: boolean,
): boolean {
  return !isSui && resolveSwapAvailability(flagEnabled, processorAddress);
}

/**
 * Whether the current "Receive as" selection composes a swap into the exit.
 * `null`/undefined or the pool asset itself = plain withdrawal (the default,
 * UNCHANGED behavior); only a genuinely different output token routes
 * through prepareSwapQuote/relayWithdrawAndSwap. Address comparison is
 * case-insensitive so a checksummed pick can't masquerade as a swap.
 */
export function isSwapExitSelection(
  receiveTokenAddress: string | null | undefined,
  poolTokenAddress: string,
): boolean {
  if (!receiveTokenAddress) return false;
  return receiveTokenAddress.toLowerCase() !== poolTokenAddress.toLowerCase();
}

/**
 * Same-chain Send: whether "Recipient receives" asks for a different asset.
 * A yield share and its plain underlying are the SAME asset here (ppUSDC and
 * USDC both read "USDC"), so picking either one is the plain private
 * transfer. Comparing raw addresses called USDC-to-USDC a swap-send and handed
 * it to Withdraw with a dead button (DEV-530). `sameAssetAddresses` is the
 * pool token's share/underlying pair when it has one.
 */
export function isSwapSendSelection(
  receiveTokenAddress: string | null | undefined,
  poolTokenAddress: string,
  sameAssetAddresses: readonly (string | null | undefined)[] = [],
): boolean {
  if (!isSwapExitSelection(receiveTokenAddress, poolTokenAddress)) return false;
  const receive = receiveTokenAddress!.toLowerCase();
  return !sameAssetAddresses.some((a) => !!a && a.toLowerCase() === receive);
}

const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * The addresses that are the SAME asset as the pool token on its own chain:
 * the token, and for a yield pool its share and plain underlying. A native
 * share (ppETH, nativeMode) holds WETH but is delivered as native ETH, so the
 * native sentinel joins its set.
 */
export function sameAssetAddressesFor(
  poolTokenAddress: string,
  deployment: { ppUSDC: string; underlying: string; nativeMode?: boolean } | undefined,
): string[] {
  const out = [poolTokenAddress.toLowerCase()];
  if (deployment) {
    out.push(deployment.ppUSDC.toLowerCase(), deployment.underlying.toLowerCase());
    if (deployment.nativeMode === true) out.push(NATIVE_SENTINEL);
  }
  return [...new Set(out)];
}

// --- Quote request guard --------------------------------------------------------

/**
 * Canonical identity of a quote request. Any change to any field means an
 * in-flight quote for the old key must be discarded, never shown.
 */
export function buildSwapQuoteRequestKey(params: {
  sessionKey: string;
  poolChainId: number;
  inputToken: string;
  grossWei: bigint;
  destinationChainId: number;
  outputToken: string;
  recipient: string;
  fallback?: string;
  slippage: number;
}): string {
  return [
    params.sessionKey,
    params.poolChainId,
    params.inputToken.toLowerCase(),
    params.grossWei.toString(),
    params.destinationChainId,
    params.outputToken.toLowerCase(),
    params.recipient.trim().toLowerCase(),
    (params.fallback ?? '').trim().toLowerCase(),
    params.slippage,
  ].join('|');
}

export interface SwapRequestGuard {
  /** Registers a new in-flight request; returns its token. */
  begin(key: string): number;
  /** True iff `token` is the latest request AND its key is unchanged. */
  isCurrent(token: number, key: string): boolean;
  /** Invalidates every in-flight request (edit / close / reset / reopen). */
  invalidate(): void;
}

/**
 * Monotonic-generation guard for async quote requests: only the newest
 * request (with an unchanged canonical key) may commit state. Pure and
 * unit-tested; the modal stores one instance in a ref.
 */
export function createSwapRequestGuard(): SwapRequestGuard {
  let generation = 0;
  let activeKey: string | null = null;
  return {
    begin(key: string): number {
      generation += 1;
      activeKey = key;
      return generation;
    },
    isCurrent(token: number, key: string): boolean {
      return token === generation && activeKey === key;
    },
    invalidate(): void {
      generation += 1;
      activeKey = null;
    },
  };
}

// --- Relay-params builder -----------------------------------------------------

export interface RelayWithdrawAndSwapParamsShape {
  inputCommitments: Hex[];
  amount: Hex;
  tokenId: Address;
  recipientAddress: Address;
  fallbackAddress?: Address;
  outputToken: Address;
  minOutputAmount: Hex;
  swapCalldata: Hex;
  selectedQuote: unknown;
  toChainId: number;
  dustRecipient: Address;
  swapTarget: Address;
  approvalAddress: Address;
}

/**
 * Maps a prepared quote into the exact ExecuteWithdrawAndSwapRelayerParams
 * shape `relayWithdrawAndSwap` expects. Centralized so the gross/net rule
 * (`amount` = prepared.netAmount, never the user's gross input) and the
 * routing echoes (swapTarget / approvalAddress / dustRecipient / toChainId)
 * can't silently drift in the UI. Re-runs validatePreparedSwapQuote and
 * THROWS on any violation — the builder is the last line before proving, so
 * an invalid quote must never pass it even if the UI skipped validation.
 */
export function buildRelayWithdrawAndSwapParams(params: {
  prepared: PreparedSwapQuoteLike;
  poolChainId: number;
  grossWei: bigint;
  inputCommitments: Hex[];
  tokenId: Address;
  outputToken: Address;
  recipientAddress: Address;
  fallbackAddress?: Address;
}): RelayWithdrawAndSwapParamsShape {
  const { prepared } = params;
  const problems = validatePreparedSwapQuote(prepared, {
    poolChainId: params.poolChainId,
    grossWei: params.grossWei,
    recipientAddress: params.recipientAddress,
    ...(params.fallbackAddress !== undefined ? { fallbackAddress: params.fallbackAddress } : {}),
  });
  if (problems.length > 0) {
    throw new Error(`Refusing to relay an invalid swap quote: ${problems.join('; ')}`);
  }
  return {
    inputCommitments: params.inputCommitments,
    // NET amount (gross − relayer fee) — prepareSwapQuote quoted the gross.
    amount: prepared.netAmount,
    tokenId: params.tokenId,
    recipientAddress: params.recipientAddress,
    ...(params.fallbackAddress ? { fallbackAddress: params.fallbackAddress } : {}),
    outputToken: params.outputToken,
    minOutputAmount: prepared.minOutputAmount,
    swapCalldata: prepared.swapCalldata,
    selectedQuote: prepared.selectedQuote,
    toChainId: prepared.toChainId,
    dustRecipient: prepared.dustRecipient,
    swapTarget: prepared.swapTarget,
    approvalAddress: prepared.approvalAddress,
  };
}

// --- Input-note selection ------------------------------------------------------

const noteValue = (n: Note) => BigInt(n.value);

/**
 * Selects the notes a swap withdrawal spends: up to five inputs sharing ONE
 * exact raw SDK tokenId, from ANY labels. Labels are per-input circuit
 * signals and the SDK mints one change note per input label, so a single
 * transact proof carries mixed labels (services/withdraw-quotes.ts
 * topNAcrossLabels; the plain withdraw has spent two labels in one proof on
 * chain). What a swap cannot do is span several proofs: RelaySwaps.execute
 * takes one TransactProof and the relayer has no batch swap route, so the cap
 * is the 5-input circuit limit. Until 2026-09-04 this selector pinned itself
 * to one label, a policy inherited from an old codex note about batching,
 * which refused a 0.005 ETH swap over two 0.004 ETH deposits (Pat, prod).
 *
 * Within a token group, prefer smallest-first (consolidation); when the
 * smallest `maxInputs` notes cannot reach the target, fall back to
 * largest-first so a covering selection is never missed ([1,1,1,1,1,100]
 * target 100 must pick the 100 note). Consolidation is the priority: a
 * covering smallest-first set wins even when one big note would do (fewer,
 * larger notes left behind). Otherwise returns the closest total so the
 * caller can surface an accurate max.
 */
export function selectSwapInputNotes(
  notes: Note[],
  targetWei: bigint,
  maxInputs = 5,
): { notes: Note[]; total: bigint; covered: boolean } {
  const inputLimit = Number.isFinite(maxInputs)
    ? Math.min(5, Math.max(0, Math.trunc(maxInputs)))
    : 5;
  const accumulate = (sorted: Note[]) => {
    const picked: Note[] = [];
    let total = 0n;
    for (const note of sorted) {
      if (picked.length >= inputLimit) break;
      picked.push(note);
      total += noteValue(note);
      if (total >= targetWei) break;
    }
    return { notes: picked, total };
  };
  const selectWithinGroup = (group: Note[]) => {
    const smallestFirst = accumulate(
      [...group].sort((a, b) => (noteValue(a) < noteValue(b) ? -1 : noteValue(a) > noteValue(b) ? 1 : 0)),
    );
    if (smallestFirst.total >= targetWei) return smallestFirst;
    // Consolidation failed to cover — largest-first maximizes coverage
    // within the input cap (same fallback the withdrawal flow uses).
    const largestFirst = accumulate(
      [...group].sort((a, b) => (noteValue(a) > noteValue(b) ? -1 : noteValue(a) < noteValue(b) ? 1 : 0)),
    );
    return largestFirst.total > smallestFirst.total ? largestFirst : smallestFirst;
  };
  const byToken = new Map<string, Note[]>();
  for (const note of notes) {
    // Case-insensitive: two spellings of one address are one token, and the
    // SDK accepts them together (services/note-token-id.ts).
    const key = noteTokenKey(note);
    const group = byToken.get(key);
    if (group) group.push(note);
    else byToken.set(key, [note]);
  }
  let best: { notes: Note[]; total: bigint } = { notes: [], total: 0n };
  for (const group of byToken.values()) {
    const sel = selectWithinGroup(group);
    const selCovers = sel.total >= targetWei;
    const bestCovers = best.total >= targetWei;
    if (selCovers && !bestCovers) best = sel;
    else if (selCovers && bestCovers) {
      if (sel.notes.length < best.notes.length) best = sel;
    } else if (!selCovers && !bestCovers) {
      if (sel.total > best.total) best = sel;
    }
  }
  return { ...best, covered: best.total >= targetWei };
}

// --- Receipt classification -----------------------------------------------------

/**
 * A RESOLVED receipt is NOT success: the SDK returns failed receipts
 * (status false/undefined) without persisting note updates, so only a
 * literal `status === true` means the exit/swap/payout executed. Truthy
 * look-alikes ('success', 1) must not pass — fail closed.
 */
export function isSuccessfulSwapReceipt(
  receipt: { status?: unknown } | null | undefined,
): boolean {
  return receipt?.status === true;
}

// --- Error classification --------------------------------------------------------

function collectErrorText(err: unknown, depth = 0): string {
  if (err == null || depth > 4) return '';
  const parts: string[] = [];
  if (typeof err === 'string') parts.push(err);
  if (typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (typeof e.name === 'string') parts.push(e.name);
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.status === 'number') parts.push(String(e.status));
    if (typeof e.statusCode === 'number') parts.push(String(e.statusCode));
    if (e.cause) parts.push(collectErrorText(e.cause, depth + 1));
  }
  return parts.join(' | ');
}

/**
 * HTTP statuses that mean "this relayer cannot quote a swap on this chain".
 * 404 is the route not being deployed; a 5xx is the route being deployed and
 * broken. Both are the same thing to a user standing in front of the quote
 * step, and both happen BEFORE any signature.
 */
const SWAP_UNAVAILABLE_STATUSES: readonly number[] = [404, 500, 502, 503, 504];

function hasSwapUnavailableStatus(err: unknown, depth = 0): boolean {
  if (err == null || depth > 4 || typeof err !== 'object') return false;
  const e = err as { status?: unknown; statusCode?: unknown; cause?: unknown };
  if (typeof e.status === 'number' && SWAP_UNAVAILABLE_STATUSES.includes(e.status)) return true;
  if (typeof e.statusCode === 'number' && SWAP_UNAVAILABLE_STATUSES.includes(e.statusCode)) return true;
  return hasSwapUnavailableStatus(e.cause, depth + 1);
}

/**
 * True when the failure means the relayer cannot quote a swap on this chain —
 * either the route is not deployed (404) or it is deployed and failing (5xx).
 * The UI fails closed with an honest "swaps aren't available on this network"
 * state instead of a raw error.
 *
 * The 5xx half is not hypothetical: the testing relayer answers HTTP 500 for
 * EVERY quote type on chain 10 while serving chain 1 normally (probed
 * 2026-08-18), so with cross-chain destinations now advertised, an Optimism user
 * hit a generic error where the honest "not available here" state belongs (found
 * independently by two reviewers).
 *
 * Deliberately strict: only a TYPED status (the SDK's HTTPResponseError carries
 * `status: number`), or a message that literally embeds one of those codes
 * alongside HTTP/quote/route context, qualifies. Arbitrary "not found" or
 * "internal error" text must NOT match — a local "leaf not found" Merkle/proof
 * error would otherwise be misreported as the route being unavailable. Callers
 * should also only apply this to the QUOTE phase, never to proof/confirm
 * failures, where the same status means something entirely different.
 */
export function isSwapUnavailableError(err: unknown): boolean {
  // "No route for this pair" is never "this network has no swap endpoint", and
  // LiFi reports the former with a 404. Every caller checks this predicate
  // first, so without this clause a missing route for one pair was announced
  // as the whole network being unserved: withdrawing USDT as AAVE on Ethereum
  // said "Swaps aren't available on this network" while the relayer answered
  // that exact quote with 201 (2026-09-22). Specific signal wins.
  if (isNoRouteError(err)) return false;
  if (hasSwapUnavailableStatus(err)) return true;
  const text = collectErrorText(err).toLowerCase();
  if (!text) return false;
  // Fallback for errors that stringified the status away: require a literal
  // code AND http/route context in the same error chain.
  return /\b(404|500|502|503|504)\b/.test(text) && /(http|status|quote|route|swap)/.test(text);
}

/** True when the failure is LiFi finding no route for the requested pair. */
export function isNoRouteError(err: unknown): boolean {
  const text = collectErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    text.includes('no_quote')
    || text.includes('no quote')
    || text.includes('no route')
    || text.includes('no available quotes')
    || text.includes('swapquotefailed')
    // LiFi code 1003: the executable route cannot deliver the exact output
    // asked for — in practice, the amount is too small after bridge fees.
    || text.includes('unable to find quote to match expected output')
    // The SDK's typed refusal when the executor route has no quote or no size
    // fits the budget (v2-monorepo#480): "No swap route from X to Y on chain N".
    || text.includes('swaprouteunavailable')
    || text.includes('no swap route')
  );
}
