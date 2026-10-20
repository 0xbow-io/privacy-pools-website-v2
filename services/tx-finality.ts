// What actually happened to a submitted transaction — including the case the
// receipt alone cannot answer: the wallet REPLACED it.
//
// Verified against the installed viem source (waitForTransactionReceipt.js):
// on a same-nonce replacement viem does NOT throw. It resolves with the
// REPLACEMENT transaction's receipt and fires `onReplaced` with a classified
// reason first. A caller that ignores both signals inherits two lies:
//
//   - REPRICED (speed-up): the same payment landed under a NEW hash, but the
//     caller records/displays the old one — explorer links point at a ghost tx
//     and anything keyed by hash (our paid-request stamp) silently misses.
//   - CANCELLED: the cancel is a 0-value self-send that SUCCEEDS on-chain, so
//     the returned receipt says `success` — and a status check alone reports
//     "Payment sent" for a payment the user cancelled. A revert guard does not
//     catch this, because nothing reverted.
//
// The classifier is pure so every mapping is unit-tested; the wrapper is the
// only part that touches viem. Used by the payment-request wallet-pay flow;
// other flows keep their existing waits deliberately (see the commit message)
// — this module changes nothing unless a caller opts in.

import type { Hex } from '@/services/sdk-types';

/** viem's classification of a same-nonce replacement. */
export type ReplacementReason = 'repriced' | 'cancelled' | 'replaced';

export type PaymentTxOutcome =
  /** The intended call executed successfully — under the original hash, or a
   *  repriced (sped-up) copy of it. `finalHash` is the hash that is REAL. */
  | { kind: 'success'; finalHash: Hex; replacedFrom: Hex | null }
  /** The intended call executed and reverted. */
  | { kind: 'reverted'; finalHash: Hex }
  /** The wallet CANCELLED the tx (a 0-value self-send won the nonce) — the
   *  intended call never executed. Only the cancel heuristic earns this
   *  verdict: it can never match a real payment, which targets the
   *  Entrypoint. A generic 'replaced' is NOT proof of anything (viem labels
   *  it by comparing RPC-rendered to/value/input strings case-sensitively,
   *  so even a byte-identical speed-up can land there) and maps to
   *  'indeterminate' instead — a wrong "not sent" invites paying twice. */
  | { kind: 'not-sent'; reason: 'cancelled'; replacementHash: Hex }
  /** Signals contradict (receipt hash matches neither story). Never claim
   *  success or failure here — the caller must send the user to the explorer. */
  | { kind: 'indeterminate'; submittedHash: Hex; receiptHash: Hex };

const lower = (h: string): string => h.toLowerCase();

/**
 * Pure mapping from (submitted hash, receipt, replacement signal) to an
 * outcome. The rules, and why each direction is the safe one:
 *
 * - `repriced` means viem proved the replacement carries the SAME to/value/
 *   input — it IS the payment, faster. Success/revert follows the receipt,
 *   under the replacement's hash.
 * - `cancelled` means a 0-value self-send won the nonce — the intended call
 *   never ran, regardless of the receipt's `success`. Reporting the receipt
 *   status would celebrate the cancel tx.
 * - `replaced` is viem's catch-all for "same nonce, strings differ". The
 *   strings are RPC-rendered and compared case-sensitively, so this label can
 *   cover anything from an unrelated transaction to OUR payment re-rendered
 *   with different hex casing. It proves nothing either way → indeterminate.
 * - A receipt whose hash matches neither the submission nor the reported
 *   replacement is a contradiction; both "it worked" and "it failed" would be
 *   guesses. `indeterminate` forces the caller to say "check the explorer"
 *   instead of guessing — a wrong "failed" makes the user pay twice, a wrong
 *   "sent" hides that they never paid.
 */
export function interpretPaymentReceipt(params: {
  submittedHash: Hex;
  receiptHash: Hex;
  receiptSucceeded: boolean;
  replacement: { reason: ReplacementReason; hash: Hex } | null;
}): PaymentTxOutcome {
  const { submittedHash, receiptHash, receiptSucceeded, replacement } = params;

  if (replacement) {
    // A "replacement" carrying the SUBMITTED hash is self-contradictory — a tx
    // cannot replace itself. A lagging RPC can produce this shape (viem's block
    // scan does not exclude the original hash), and neither trusting nor
    // inverting it would be honest.
    if (lower(replacement.hash) === lower(submittedHash)) {
      return { kind: 'indeterminate', submittedHash, receiptHash };
    }
    if (lower(receiptHash) !== lower(replacement.hash)) {
      return { kind: 'indeterminate', submittedHash, receiptHash };
    }
    if (replacement.reason === 'repriced') {
      return receiptSucceeded
        ? { kind: 'success', finalHash: receiptHash, replacedFrom: submittedHash }
        : { kind: 'reverted', finalHash: receiptHash };
    }
    if (replacement.reason === 'cancelled') {
      return { kind: 'not-sent', reason: 'cancelled', replacementHash: receiptHash };
    }
    // 'replaced': see the type comment — not proof, never definitive.
    return { kind: 'indeterminate', submittedHash, receiptHash };
  }

  if (lower(receiptHash) !== lower(submittedHash)) {
    // viem always classifies before resolving with a foreign receipt, so this
    // is theoretically unreachable — which is exactly why it must not guess.
    return { kind: 'indeterminate', submittedHash, receiptHash };
  }

  return receiptSucceeded
    ? { kind: 'success', finalHash: receiptHash, replacedFrom: null }
    : { kind: 'reverted', finalHash: receiptHash };
}

/** The slice of a viem PublicClient this module needs — structural, so tests
 *  need no viem client and the module stays portable across wagmi versions. */
export interface ReceiptWaiterClient {
  waitForTransactionReceipt(args: {
    hash: Hex;
    timeout?: number;
    onReplaced?: (replacement: {
      reason: ReplacementReason;
      transaction: { hash: Hex };
    }) => void;
  }): Promise<{ transactionHash: Hex; status: 'success' | 'reverted' }>;
}

/**
 * Wait for a payment-grade transaction and say what ACTUALLY happened.
 *
 * viem invokes `onReplaced` synchronously before resolving with the
 * replacement's receipt (verified in the installed source: `emit.onReplaced?.()
 * ... emit.resolve(receipt)` inside the same `done()`), so the captured signal
 * is always set by the time the await returns.
 */
export async function waitForPaymentTx(
  client: ReceiptWaiterClient,
  hash: Hex,
  options: { timeout?: number } = {},
): Promise<PaymentTxOutcome> {
  let replacement: { reason: ReplacementReason; hash: Hex } | null = null;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: options.timeout ?? 180_000,
    onReplaced: (info) => {
      replacement = { reason: info.reason, hash: info.transaction.hash };
    },
  });
  return interpretPaymentReceipt({
    submittedHash: hash,
    receiptHash: receipt.transactionHash,
    receiptSucceeded: receipt.status === 'success',
    replacement,
  });
}

/** User-facing sentence per outcome, so callers don't each invent copy. */
export function describePaymentTxOutcome(outcome: PaymentTxOutcome): string | null {
  switch (outcome.kind) {
    case 'success':
      return null;
    // Neither of these is "nothing was sent": a revert is a mined transaction
    // and a cancel is a second mined transaction that replaced the first. No
    // payment reached the recipient, but both cost gas, and a user who reads
    // "Nothing was sent" and then finds them in their wallet history concludes
    // the app is lying about their money (QA, 2026-09-21).
    case 'reverted':
      return 'The payment transaction reverted on-chain, so no funds reached the recipient. The gas for it was still spent. You can try again.';
    case 'not-sent':
      return 'You cancelled this payment in your wallet, so no funds reached the recipient. The cancellation still cost gas.';
    case 'indeterminate':
    default:
      return 'Your wallet replaced this transaction and the result could not be confirmed. Check the transaction on the explorer before paying again.';
  }
}
