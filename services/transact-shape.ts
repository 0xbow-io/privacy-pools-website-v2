// What kind of thing a Transacted log was - decided in ONE place.
//
// Why this module exists: the app had three different answers to "is this a
// withdrawal or a transfer", and all three were wrong in different ways.
//
//  - components/pools-provider.tsx called `outputCommitments.length >= 2` a
//    transfer, and relabelled ASP withdrawal rows on that basis.
//  - services/audit-receipt.ts called `length === 1 && withdrew` a real
//    withdrawal.
//  - services/outgoing-transfers.ts ignored arity entirely and asked only
//    whether any output was owned by someone else.
//
// The third one produced the bug this module was written for (Pat, 2026-09-01):
// he anchored a link-received note - a self-transfer, so EVERY output is his -
// and the classifier fell into "all outputs owned and value left the pool =>
// withdrawal", reporting the relayer's 0.000539 ETH fee as money he had
// withdrawn, with fee = 0. It also reached the Koinly export as a phantom
// disposal. Meanwhile the FIRST rule had already labelled the very same
// transaction a Transfer in the global feed, so the All tab and the My tab
// disagreed about one transaction.
//
// THE KEY FACT, and the reason the obvious fix is wrong: `outputCommitments`
// is the proof dimension M, not an intent. The SDK emits ONE change note per
// distinct input label (dist/index.js:5354-5388), so this app's own
// mixed-label withdrawals produce 2..5 outputs - services/withdraw-note-selection.ts
// permits them deliberately and there are pinned tests for two-label and
// five-label withdrawals. A bare `M >= 2 => transfer` rule therefore retypes
// genuine withdrawals. It fails the other way too: the protocol allows a 1x1
// transfer with a single output and no withdrawal at all
// (v2-monorepo packages/circuits docs: every 1x1..5x5 configuration is
// precompiled; Transact.t.sol:650-689 exercises exactly that shape).
//
// What DOES separate them, for transactions this SDK built, is M compared with
// the number of distinct input labels:
//
//   plain withdrawal  -> one change note per label      => M === labels
//   transfer/anchor   -> one change per label + recipient => M  >  labels
//
// That is a versioned client fingerprint, not a protocol proof, so the
// asymmetry below is deliberate: a shape that matches the withdrawal builder is
// reported as withdrawal-shaped (that is the status quo for every real
// withdrawal and must keep working), while a shape that does NOT match is
// reported as anchor-shaped - a fact about arity, not a claim about intent.
// There is one important SDK counterexample in this app: the gasless claim path
// anchors through relayWithdraw, so its anchor is withdrawal-shaped (M ===
// labels). Only a positively confirmed local anchor stamp can override that
// case. Callers must render shape-only fee cases neutrally ("public outflow"),
// never as "you withdrew"; absence of a stamp must not become proof either way.
//
// Arity cannot see a note consolidation, which is withdrawal-shaped too: one
// owned note per deposit and no recipient output (services/consolidate-notes.ts),
// so M === labels. The log's caller can. The relayer submits its TRANSFER route
// from its signer EOA, the proof's bound processor there and never the
// withdrawal processor, and on that route withdrawnValue is the relayer's fee.
// So a log on the transfer route paid nothing out, whatever its arity.

export type TransactShape =
  /** An output commitment belongs to someone else: value left this user. */
  | 'transfer'
  /** Value left the pool and the output arity matches the SDK's withdrawal builder. */
  | 'withdrawal'
  /**
   * All outputs are owned and value left the pool, either with MORE outputs
   * than distinct input labels - the shape a self-transfer (anchor, dust
   * consolidation) makes, and one the withdrawal builder cannot produce - or
   * on the relayer's transfer route. The outflow is a fee, not a payout. Not
   * proof of intent on its own.
   */
  | 'anchor-shaped'
  /**
   * Value left the pool with all outputs owned, but the input labels are not
   * known, so withdrawal and anchor cannot be told apart. Say so; do not guess.
   */
  | 'ambiguous-outflow'
  /** Nothing left the pool and every output is owned: a self merge/split. */
  | 'internal';

export interface TransactShapeInput {
  /** M: how many output commitments the Transacted log carried. */
  outputCount: number;
  /** How many of those outputs are NOT owned by this viewer. */
  nonOwnedOutputs: number;
  /** withdrawnValue from the log: what left the pool publicly. */
  withdrawnValue: bigint;
  /**
   * Distinct labels across the INPUT notes this viewer matched by nullifier,
   * or null when unknown (the global feed cannot see a stranger's input
   * labels). null yields 'ambiguous-outflow' rather than a guess.
   */
  distinctInputLabels: number | null;
  /** The log's caller is the relayer's TRANSFER-route processor (see the header). */
  transferRoute?: boolean;
}

export function classifyTransactShape(input: TransactShapeInput): TransactShape {
  const { outputCount, nonOwnedOutputs, withdrawnValue, distinctInputLabels } = input;

  // Someone else holds an output: value genuinely left this user, and any
  // withdrawnValue alongside it is the relayer's fee on that route.
  if (nonOwnedOutputs > 0) return 'transfer';

  // Nothing left the pool, so whatever this was, it moved no money outward.
  if (withdrawnValue <= 0n) return 'internal';

  // All outputs owned AND value left the pool. This is the branch that used to
  // assert "withdrawal" and was wrong for every self-transfer.
  // Before the arity test below, which a consolidation passes.
  if (input.transferRoute) return 'anchor-shaped';

  if (distinctInputLabels === null || distinctInputLabels <= 0) return 'ambiguous-outflow';

  // More outputs than input labels: the withdrawal builder cannot make this,
  // a recipient output can. The outflow is a fee.
  if (outputCount > distinctInputLabels) return 'anchor-shaped';

  // One change note per label, value out: the withdrawal builder's own shape.
  return 'withdrawal';
}

// ---------------------------------------------------------------------------
// Arity-only heuristics, for the two callers that CANNOT see input labels.
//
// The global ASP feed shows other people's transactions, and an audit receipt
// checks a single disclosed commitment; neither can enumerate the spender's
// input labels, so neither can run classifyTransactShape's sound rule. They are
// gathered here anyway so the arity assumption lives in ONE file with its
// counterexamples written down, instead of being re-derived - differently, and
// wrongly - at each call site, which is how this bug class started.
//
// Both are HEURISTICS. Neither is safe to build a money figure on. Where input
// labels are available, use classifyTransactShape instead; it is strictly
// better and it is what the personal rows use.

/**
 * Feed heuristic: does this log LOOK like a transfer purely from its arity?
 *
 * KNOWN WRONG in both directions, and deliberately left behaviour-identical to
 * what components/pools-provider.tsx has always done, because the alternative
 * (returning "unknown") would strip the correct Transfer label from the many
 * ordinary transfers in the feed to fix the rarer mixed-label case:
 *
 *  - false TRANSFER: a mixed-label withdrawal emits one change note per label,
 *    so 2..5 outputs. services/withdraw-note-selection.ts permits those on
 *    purpose and there are pinned two- and five-label fixtures.
 *  - false WITHDRAWAL: the protocol allows a 1x1 transfer with a single output
 *    and no withdrawal at all (v2-monorepo Transact.t.sol:650-689; every
 *    1x1..5x5 configuration is precompiled).
 *
 * Fixing it properly needs a real signal - an operation tag on the event, or
 * decoding the bound calldata. Output arity cannot supply one. The one signal
 * available today is the caller, which names the route for logs the relayer
 * or a router submitted; feedLooksLikeTransfer applies it before this.
 */
export function looksLikeTransferFromArity(outputCount: number): boolean {
  return outputCount >= 2;
}

/**
 * Feed call for one log: Transfer or not. The caller decides when it names a
 * route: the relayer's transfer route (config/relayer.ts isTransferRouteCaller)
 * is a transfer, a withdrawal route (config/route-callers.ts) paid value out
 * and is a withdrawal, which also clears the false-TRANSFER case above for
 * every relayed mixed-label withdrawal. Arity decides only for the rest.
 */
export function feedLooksLikeTransfer(outputCount: number, route: { transfer: boolean; withdrawal: boolean }): boolean {
  if (route.transfer) return true;
  if (route.withdrawal) return false;
  return looksLikeTransferFromArity(outputCount);
}

/**
 * Audit heuristic: does this log LOOK like a plain withdrawal from its arity?
 *
 * Same status as above, and it carries one concrete misattribution worth
 * knowing about: in v2-monorepo Transact.t.sol:531-548 Alice spends one note,
 * creates the sole output for Bob, and withdraws publicly in the same 1x1
 * transact. Bob owns the only output and did not initiate that withdrawal, so
 * an "exactly one output + value left + I own an output" test attributes
 * Alice's withdrawal to Bob. Callers must treat a true result as "consistent
 * with", never as proof.
 */
export function looksLikeRealWithdrawalFromArity(outputCount: number, withdrew: boolean): boolean {
  return outputCount === 1 && withdrew;
}

/** Does this shape mean the outflow was a FEE rather than a payout to the user? */
export function outflowIsFee(shape: TransactShape): boolean {
  return shape === 'transfer' || shape === 'anchor-shaped';
}

/**
 * May the UI state, unaided, that the user withdrew this value?
 *
 * Only 'withdrawal' earns that. 'ambiguous-outflow' and 'anchor-shaped' are
 * shapes, not intents, and must be rendered as a neutral public outflow unless
 * a positively confirmed local stamp supplies the intent.
 */
export function mayClaimWithdrawal(shape: TransactShape): boolean {
  return shape === 'withdrawal';
}

/**
 * The row type for one ASP feed event. The ASP once typed every Transacted
 * event 'withdrawal' and now types some 'transfer' by its own arity guess;
 * the snapshot's verdicts correct both: a log the client reads as a transfer
 * (feedLooksLikeTransfer, or a send stamped on this device) is a transfer,
 * and a log a withdrawal route submitted paid value out and is a withdrawal.
 */
export function feedEventType<T extends string>(
  aspType: T,
  txHash: string,
  transferTxHashes: ReadonlySet<string>,
  withdrawalRouteTxHashes: ReadonlySet<string>,
): T | 'transfer' | 'withdrawal' {
  if (aspType === 'withdrawal' && transferTxHashes.has(txHash)) return 'transfer';
  if (aspType === 'transfer' && withdrawalRouteTxHashes.has(txHash)) return 'withdrawal';
  return aspType;
}
