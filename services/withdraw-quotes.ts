// Withdraw-modal quote identity + route helpers (pure, node-testable).
//
// The withdraw modal serves three quote-backed EVM routes — the plain
// relayer withdrawal, the flag-gated full-balance batch, and the "Receive
// as" swap exit — plus the Sui path. All three EVM routes share ONE async
// request guard (services/intent-swaps createSwapRequestGuard); this module
// defines the canonical identity of a quote request across the modes and
// the route-specific availability rules, so that:
//
//  - the modal registers a request (guard.begin) with its FULL canonical
//    key BEFORE the first await and re-checks after every await — an edit
//    of any key field (recipient, amount, token, receive-asset, gas-token,
//    chain, session, modal epoch) while ANY quote is in flight invalidates
//    it and the stale continuation can never commit Review state;
//  - a response for one mode can never be presented as another
//    (mode + output token are part of the key), so a pending plain/batch
//    quote can't enter Review after the user switched "Receive as";
//  - batch-only "100% / Max" semantics are never offered to the
//    single-proof swap route (one proof, at most 5 notes of any label);
//  - Confirm executes only the operation that was reviewed, in the context
//    it was reviewed in (chain / session / mode / modal-operation epoch).

import { tokenKey } from '@/services/note-token-id';

export type WithdrawQuoteMode = 'plain' | 'batch' | 'swap' | 'sui';

/**
 * Canonical identity of a withdraw quote request. Any change to any field
 * means an in-flight quote for the old key must be discarded, never shown.
 * Built BEFORE the first await of the review handler.
 */
export function buildWithdrawQuoteKey(params: {
  /** Owner identity (session address) + pool chain, lowercased by caller or here. */
  sessionKey: string;
  /** Modal-operation epoch — bumped on every open/close. */
  epoch: number;
  mode: WithdrawQuoteMode;
  poolChainId: number;
  inputToken: string;
  /** Raw entered amount string (mode-independent representation). */
  amount: string;
  /** Output token: the pool asset for plain/batch, the picked token for swap. */
  outputToken: string;
  recipient: string;
  gasToken: boolean;
  /** Whether the entered amount is net (fee added on top) for a plain route. */
  receiveExact: boolean;
  /** Exact chain/account/note/approval topology used for admission. */
  spendabilityKey: string;
  /** Only meaningful for the swap mode. */
  slippage?: number;
  /**
   * Destination chain for a cross-chain swap exit. Part of the key because
   * switching destination redefines the whole route: the same token symbol is a
   * different address on another chain, and for the native asset it is the SAME
   * address, so without this a pending same-chain quote could be accepted for a
   * cross-chain selection.
   */
  destinationChainId?: number;
}): string {
  return [
    params.sessionKey.trim().toLowerCase(),
    params.epoch,
    params.mode,
    params.poolChainId,
    params.inputToken.trim().toLowerCase(),
    params.amount,
    params.outputToken.trim().toLowerCase(),
    params.recipient.trim().toLowerCase(),
    params.gasToken ? 1 : 0,
    params.receiveExact ? 1 : 0,
    params.spendabilityKey,
    params.slippage ?? '',
    params.destinationChainId ?? '',
  ].join('|');
}

/**
 * What Review committed to — captured when the modal advances to the review
 * step and verified again at Confirm. Review renders its recipient from
 * this snapshot (never live form state), and Confirm refuses to run when
 * the live context no longer matches (chain switch, account switch, modal
 * reopen), clearing the quote and returning to input instead.
 */
export interface WithdrawReviewContext {
  mode: WithdrawQuoteMode;
  poolChainId: number;
  /** Owner identity the quote was prepared for (lowercased address:chain). */
  sessionKey: string;
  /** Modal-operation epoch at review time. */
  epoch: number;
  /** Resolved recipient the quote was prepared for ('' = connected wallet on Sui). */
  recipient: string;
  /** Exact spendable-note topology that was reviewed. */
  spendabilityKey: string;
}

/**
 * True iff the reviewed operation may execute in the live context.
 *
 * Sui reviews are held to the SAME identity check as EVM (codex round 1,
 * P0): they used to short-circuit `return true` after the routing bit, so a
 * withdrawal reviewed as Sui account A stayed confirmable after switching
 * the connected Sui account to B — Confirm reloaded B's notes and sent them
 * to A's reviewed recipient. The review context already stores a real Sui
 * sessionKey (`suiAddress:chainId`); callers must supply the live one.
 */
export function reviewContextMatches(
  ctx: WithdrawReviewContext | null,
  live: {
    isSui: boolean;
    poolChainId: number;
    sessionKey: string;
    epoch: number;
    spendabilityKey: string;
  },
): boolean {
  if (!ctx) return false;
  if (ctx.epoch !== live.epoch) return false;
  if ((ctx.mode === 'sui') !== live.isSui) return false;
  return (
    ctx.poolChainId === live.poolChainId
    && ctx.sessionKey.toLowerCase() === live.sessionKey.toLowerCase()
    && ctx.spendabilityKey === live.spendabilityKey
  );
}

/**
 * Route resolution, in the same priority order the review handler branches:
 * Sui first, then the swap exit (a picked receive-asset always wins), then
 * the batch route (explicit full-balance intent), else plain. Encoding the
 * order here pins that a swap exit can NEVER take the batch branch even
 * when both flags are on and a full balance is requested.
 */
export function resolveWithdrawMode(params: {
  isSui: boolean;
  isSwapExit: boolean;
  batchEligible: boolean;
}): WithdrawQuoteMode {
  if (params.isSui) return 'sui';
  if (params.isSwapExit) return 'swap';
  if (params.batchEligible) return 'batch';
  return 'plain';
}

/**
 * The largest amount ONE withdrawal transaction can move for the current
 * route, in token base units (route-specific availability — codex P2):
 *
 *  - swap exit: a single proof over at most `maxInputs` notes of any label,
 *    NEVER the batch-eligible whole balance (the swap route has no batch
 *    shape);
 *  - batch enabled (plain route): the whole active balance is reachable via
 *    the batch route;
 *  - otherwise: the single-proof mixed-label cap.
 */
export function resolveDisplayAvailableWei(params: {
  isSwapExit: boolean;
  batchEnabled: boolean;
  spendableWei: bigint;
  singleProofCapWei: bigint;
}): bigint {
  if (params.isSwapExit) return params.singleProofCapWei;
  return params.batchEnabled ? params.spendableWei : params.singleProofCapWei;
}

/**
 * The per-transaction cap for MIXED-LABEL single-proof withdrawals: the sum of
 * the largest `maxInputs` notes regardless of label. The transact circuit
 * takes mixed labels natively (labels are per-input signals; conservation is
 * global with a per-label outputs<=inputs inequality, and the SDK emits one
 * change note per label). Inputs must additionally be one token, grouped by
 * the lowercased address (services/note-token-id.ts): the vendored SDK takes
 * mixed casing in one proof (v2-monorepo#436), and grouping by the raw string
 * capped a two-note balance at one note (DEV-408). Since 2026-09-04 the
 * swap-exit route uses this cap too.
 */
export function topNAcrossLabels(
  notes: readonly { value: string | bigint; tokenId?: unknown }[],
  maxInputs = 5,
): bigint {
  const inputLimit = Number.isFinite(maxInputs)
    ? Math.min(5, Math.max(0, Math.trunc(maxInputs)))
    : 5;
  if (inputLimit === 0) return 0n;
  const byTokenId = new Map<string, bigint[]>();
  for (const note of notes) {
    const key = tokenKey(note);
    const group = byTokenId.get(key);
    const value = BigInt(note.value);
    if (group) group.push(value);
    else byTokenId.set(key, [value]);
  }
  let max = 0n;
  for (const values of byTokenId.values()) {
    const top = values
      .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))
      .slice(0, inputLimit)
      .reduce((sum, v) => sum + v, 0n);
    if (top > max) max = top;
  }
  return max;
}


/** Gross value that leaves the pool for a plain quote. */
export function resolveGrossLeavingWei(params: {
  enteredWei: bigint;
  feeWei: bigint;
  receiveExact: boolean;
}): bigint {
  return params.receiveExact ? params.enteredWei + params.feeWei : params.enteredWei;
}

/** Total shielded balance left after the reviewed gross leaves the pool. */
export function resolveRemainingBalanceWei(params: {
  totalBalanceWei: bigint;
  grossLeavingWei: bigint;
}): bigint {
  return params.totalBalanceWei > params.grossLeavingWei
    ? params.totalBalanceWei - params.grossLeavingWei
    : 0n;
}

/** Largest value the amount input may contain under a one-proof cap. */
export function resolveSingleProofMaxInputWei(params: {
  singleProofCapWei: bigint;
  feeWei: bigint;
  receiveExact: boolean;
}): bigint {
  if (!params.receiveExact) return params.singleProofCapWei;
  return params.singleProofCapWei > params.feeWei
    ? params.singleProofCapWei - params.feeWei
    : 0n;
}

/**
 * Max selections are gross by construction: there is no room above either the
 * whole balance or a one-proof cap for a receive-exact fee. Other entries keep
 * the user's explicit net/gross choice.
 */
export function resolveEffectiveReceiveExact(params: {
  requestedReceiveExact: boolean;
  enteredWei: bigint;
  totalBalanceWei: bigint;
  singleProofCapWei: bigint;
}): boolean {
  if (!params.requestedReceiveExact || params.enteredWei <= 0n) return false;
  if (params.enteredWei === params.totalBalanceWei) return false;
  if (params.enteredWei === params.singleProofCapWei) return false;
  return true;
}

/**
 * Exact EVM percent-tab selection for a destination route. This is also used
 * while changing routes, when the render's current cap still belongs to the
 * route being left.
 */
export function resolveWithdrawPercentSelection(params: {
  pct: number;
  isSwapExit: boolean;
  batchEnabled: boolean;
  spendableWei: bigint;
  singleProofCapWei: bigint;
}): { amountWei: bigint; maxSelected: boolean } {
  const pct = Number.isFinite(params.pct)
    ? Math.max(0, Math.min(100, Math.trunc(params.pct)))
    : 0;
  if (pct === 100 && params.batchEnabled && !params.isSwapExit) {
    return { amountWei: params.spendableWei, maxSelected: true };
  }
  return {
    amountWei: params.singleProofCapWei > 0n
      ? (params.singleProofCapWei * BigInt(pct)) / 100n
      : 0n,
    maxSelected: false,
  };
}
