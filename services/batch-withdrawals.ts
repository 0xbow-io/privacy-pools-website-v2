// Full-balance batch withdrawal glue (business logic only, no SDK import).
//
// The v2.0 SDK can withdraw an entire single-asset balance in ONE atomic
// on-chain transaction even when it spans more input notes than one proof
// supports (5): it partitions the active notes into ≤5-note single-label
// groups, proves each group, and submits them together via `relayBatch`
// (`session.prepareBatchWithdraw` / `session.relayBatchWithdraw`). Note state
// is persisted only after the confirmed receipt, so a failure at ANY point
// leaves every local note ACTIVE — there is no per-item partial spend.
//
// This module holds the pure decision/progress/safety logic the withdraw
// modal wires around those SDK calls. The SDK boundary (note partitioning,
// quoting, proving, relaying) is injected or handled by the caller so this
// stays unit-testable and free of the SDK's page-load weight (snarkjs etc.).
//
// The whole route is gated by EXPO_PUBLIC_BATCH_WITHDRAWALS (config/env.ts):
// as of 2026-07-14 the Sepolia stack does not serve batch (the staging relayer
// 404s on /v1/quote|relay/evm/11155111/batch and the deployed PrivacyPoolRelay
// 0x762665Dc… has neither the relayBatch nor the MAX_BATCH() selector), so the
// flag defaults OFF and single-proof withdrawals are completely unaffected.

import { NoteStatus } from '@/services/sdk-types';
import type { Note } from '@/services/sdk-types';

/**
 * Circuit input cap per transact proof. Mirrors the SDK's MAX_INPUTS (which is
 * not value-exported) and the modal's WITHDRAW_MAX_INPUTS.
 */
export const BATCH_MAX_INPUTS = 5;

/** Structural mirror of the SDK's BatchWithdrawGroup. */
export type BatchGroup = {
  label: string;
  inputCommitments: string[];
  amountOut: bigint;
};

/**
 * The SDK's `selectNotesForFullWithdraw`, injected so this module never
 * imports the SDK. Throws (EmptyBatchSelection) when there is nothing active.
 */
export type SelectGroupsFn = (args: {
  notes: Note[];
  tokenId: string;
  maxInputs: number;
}) => BatchGroup[];

// --- Route decision -------------------------------------------------------

/**
 * Whether this is a full-balance withdrawal — the only shape the SDK's batch
 * flow supports.
 *
 * Intent is NEVER inferred from numeric closeness (that would silently promote
 * a typed 9.99995 into a 10-ETH sweep): the batch route triggers only when the
 * user EXPLICITLY selected Max/100% (`maxSelected`, which stores the exact
 * atomic balance) or typed an amount that equals the active balance to the
 * wei. There is no rounding tolerance.
 */
export function isFullBalanceRequest(args: {
  requestedWei: bigint;
  totalActiveWei: bigint;
  maxSelected: boolean;
}): boolean {
  const { requestedWei, totalActiveWei, maxSelected } = args;
  if (totalActiveWei <= 0n) return false;
  if (maxSelected) return true;
  return requestedWei > 0n && requestedWei === totalActiveWei;
}

/**
 * How many transact proofs a FULL-balance withdrawal of this asset needs,
 * derived from exact note topology — a pure mirror of the SDK's
 * `selectNotesForFullWithdraw` grouping (group active notes by label, then
 * chunk each lineage into ≤`maxInputs`). Batching is required exactly when
 * this is > 1; a single lineage of ≤`maxInputs` notes stays on the
 * single-proof path. Never uses float amounts. `notes` may be unfiltered — it
 * filters to ACTIVE, positive-value, matching-token notes itself.
 */
export function countFullWithdrawGroups(args: {
  notes: Note[];
  tokenId: string;
  maxInputs: number;
}): number {
  const { notes, tokenId, maxInputs } = args;
  const target = tokenId.toLowerCase();
  const perLabel = new Map<string, number>();
  for (const note of notes) {
    if (note.status !== NoteStatus.ACTIVE) continue;
    if (String(note.tokenId).toLowerCase() !== target) continue;
    let value: bigint;
    try {
      value = BigInt(note.value);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    const key = String(note.label);
    perLabel.set(key, (perLabel.get(key) ?? 0) + 1);
  }
  let groups = 0;
  for (const count of perLabel.values()) {
    groups += Math.ceil(count / maxInputs);
  }
  return groups;
}

export type BatchPlanResult =
  | { eligible: true; groups: BatchGroup[]; groupCount: number; totalWei: bigint }
  | { eligible: false; message: string };

/**
 * Partitions the asset's active notes into per-proof groups (via the injected
 * SDK selector) and checks the batch fits on-chain limits. Pure read.
 */
export function planBatchWithdraw(args: {
  notes: Note[];
  tokenId: string;
  maxInputs: number;
  maxBatch: number;
  selectGroups: SelectGroupsFn;
}): BatchPlanResult {
  const { notes, tokenId, maxInputs, maxBatch, selectGroups } = args;
  let groups: BatchGroup[];
  try {
    groups = selectGroups({ notes, tokenId, maxInputs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { eligible: false, message: `No withdrawable balance to batch: ${message}` };
  }
  if (groups.length === 0) {
    return { eligible: false, message: 'No withdrawable balance to batch.' };
  }
  if (groups.length > maxBatch) {
    return {
      eligible: false,
      message: `This balance needs ${groups.length} proofs but one batch supports at most ${maxBatch}. Withdraw part of it first.`,
    };
  }
  const totalWei = groups.reduce((sum, group) => sum + group.amountOut, 0n);
  return { eligible: true, groups, groupCount: groups.length, totalWei };
}

/**
 * A batch proves EVERY active note of the asset, so every one must be
 * ASP-spendable — one unapproved note fails the whole prepare. Returns the
 * notes that are not (yet) in the spendable set; `null` set = none known yet,
 * so everything is reported unspendable and the caller should keep syncing.
 */
export function findUnspendableActiveNotes(
  activeNotes: Note[],
  spendableCommitments: Set<string> | null,
): Note[] {
  if (!spendableCommitments) return [...activeNotes];
  return activeNotes.filter((note) => !spendableCommitments.has(note.commitment));
}

// --- Review ↔ confirm safety ----------------------------------------------

/**
 * Fund-safety check mirroring the single-withdrawal flow: the session fetches
 * its OWN quote inside `prepareBatchWithdraw`, so the prepared batch must not
 * release a different total or charge more fee than the user reviewed.
 */
export function verifyBatchPrepareAgainstReview(args: {
  preparedTotalOutWei: bigint;
  preparedTotalFeeWei: bigint;
  reviewedTotalOutWei: bigint;
  reviewedTotalFeeWei: bigint;
}): { ok: true } | { ok: false; reason: string } {
  const { preparedTotalOutWei, preparedTotalFeeWei, reviewedTotalOutWei, reviewedTotalFeeWei } =
    args;
  if (preparedTotalOutWei !== reviewedTotalOutWei) {
    return {
      ok: false,
      reason:
        'Your withdrawable balance changed since you reviewed this withdrawal. Press Withdraw again to see the updated total.',
    };
  }
  if (preparedTotalFeeWei > reviewedTotalFeeWei) {
    return {
      ok: false,
      reason:
        'The relayer fee went up since you reviewed this withdrawal. Press Withdraw again to get a fresh quote before confirming.',
    };
  }
  return { ok: true };
}

// --- Progress mapping -------------------------------------------------------

export type BatchPhase = 'proving' | 'submitting';

export type BatchProgress = {
  phase: BatchPhase;
  /** 1-based index of the proof being generated (== total while submitting). */
  current: number;
  total: number;
};

export function batchProgressMessage(progress: BatchProgress): string {
  if (progress.phase === 'proving') {
    return `Generating proof ${progress.current} of ${progress.total}...`;
  }
  return `Submitting batch (${progress.total} proofs) via relayer...`;
}

/**
 * 0..1 fraction for the progress bar. The submit+confirm wait is one final
 * segment after the N proof segments.
 */
export function batchProgressFraction(progress: BatchProgress): number {
  const units = progress.total + 1;
  if (progress.phase === 'proving') {
    return Math.min(1, Math.max(0, (progress.current - 1) / units));
  }
  return progress.total / units;
}

export type BatchProgressTracker = {
  /** One transact proof finished. */
  tick: () => void;
  /** All proofs done; the batch is being submitted / awaiting confirmation. */
  submitting: () => void;
};

/**
 * Maps proof-completion ticks onto BatchProgress updates. Emits the initial
 * "proving 1 of N" state immediately so the UI never shows a stale message.
 */
export function createBatchProgressTracker(
  total: number,
  onUpdate: (progress: BatchProgress) => void,
): BatchProgressTracker {
  let completed = 0;
  onUpdate({ phase: 'proving', current: 1, total });
  return {
    tick() {
      completed = Math.min(completed + 1, total);
      if (completed < total) {
        onUpdate({ phase: 'proving', current: completed + 1, total });
      }
    },
    submitting() {
      onUpdate({ phase: 'submitting', current: total, total });
    },
  };
}

// --- Failure semantics -------------------------------------------------------

/**
 * Where a batch withdrawal failed, classified at the point where on-chain
 * transaction certainty changes — because the honest fund-state message differs
 * sharply between them:
 * - `pre-submit`: selection / quote / proving, or the SDK rejecting an expired
 *   commitment BEFORE broadcasting. No transaction was sent; notes untouched.
 * - `submission-unknown`: the relay request errored ambiguously. The relayer
 *   may or may not have broadcast the tx — resync before retrying.
 * - `receipt-unknown`: a tx hash exists but its receipt couldn't be confirmed.
 *   It may have landed — check the explorer / sync before retrying.
 * - `reverted`: the receipt returned status:false. relayBatch is atomic, so a
 *   revert spent no notes; safe to retry.
 * - `confirmed-sync-failed`: the batch confirmed on-chain but the local
 *   note-state refresh failed. Funds are safe; the user just needs to sync.
 */
export type BatchFailureStage =
  | 'pre-submit'
  | 'submission-unknown'
  | 'receipt-unknown'
  | 'reverted'
  | 'confirmed-sync-failed';

/**
 * Classify an error thrown by the relay call into a stage. The SDK re-asserts
 * the fee-commitment expiry BEFORE it broadcasts, so an expiry error is
 * pre-submit (no tx). A receipt/timeout error means a tx likely exists but its
 * outcome is unknown. Everything else is treated as submission-unknown (the
 * safe assumption: a tx may have been sent).
 */
export function classifyBatchRelayError(message: string): BatchFailureStage {
  const lower = message.toLowerCase();
  // The relayer refused in its own simulation because the ASP root moved:
  // nothing was broadcast.
  if (lower.includes('invalidasproot')) return 'pre-submit';
  // POST-CONFIRM persistence errors must never read as pre-submit (codex
  // round 3): the SDK's NoteConflictError ("Conflicting note for commitment
  // …") is thrown AFTER a successful receipt while persisting local state —
  // the broad 'commitment' match labelled a CONFIRMED batch "no funds moved".
  if (lower.includes('conflicting note')) return 'confirmed-sync-failed';
  // Pre-submit: the SDK's pre-broadcast assertions (fee-commitment expiry
  // re-check, signed-commitment validation). The conflicting-note carve-out
  // above runs FIRST because its message also contains 'commitment'.
  if (lower.includes('expir') || lower.includes('commitment')) return 'pre-submit';
  if (lower.includes('receipt') || lower.includes('timeout') || lower.includes('timed out')) {
    return 'receipt-unknown';
  }
  return 'submission-unknown';
}

/**
 * User-facing failure text with honest fund-state semantics per stage. `txHash`
 * is included so the caller knows whether to offer an explorer link.
 */
export function describeBatchFailure(
  stage: BatchFailureStage,
  message: string,
  opts?: { hasTxHash?: boolean },
): string {
  switch (stage) {
    case 'pre-submit':
      return `Batch withdrawal failed while preparing proofs: ${message} No funds moved and your notes are untouched.`;
    case 'submission-unknown':
      return `Batch withdrawal failed during submission: ${message} The transaction may still have been sent. Sync your account before retrying.`;
    case 'receipt-unknown':
      return `Batch withdrawal was submitted but its confirmation couldn't be verified: ${message} ${
        opts?.hasTxHash ? 'Check the transaction in the explorer, then sync' : 'Sync'
      } your account before retrying.`;
    case 'reverted':
      return `The batch withdrawal reverted on-chain: ${message} No notes were spent. You can retry.`;
    case 'confirmed-sync-failed':
      return `Your batch withdrawal confirmed on-chain, but the app couldn't refresh your local balance: ${message} Your funds are safe. Sync your account.`;
  }
}

// --- Proving inside the quote window -----------------------------------------

/**
 * The relayer's batch fee commitment lives about 60 s from the quote, and the
 * proofs are built after the quote because each binds its fee split. Six proofs
 * took 62 s on a 2-vCPU runner, so on a slow device a whole-balance batch can
 * never fit. The relayer prices a batch per item (650000 gas each, measured
 * 2026-10-08 for 1, 2, 3, 4 and 6 items), so sending the same groups as several
 * smaller batches costs the same total fee, and each smaller batch gets its own
 * quote and its own window.
 */
export const BATCH_QUOTE_WINDOW_MS = 60_000;
/** Share of the window a sub-batch is sized to prove in, leaving room for the POST. */
export const BATCH_WINDOW_BUDGET = 0.6;
/** Fresh proofs per sub-batch after a refusal that sent nothing. */
export const BATCH_MAX_REPROVES = 3;

/** The sub-batch size that proves inside the window at the speed just measured. */
export function subBatchSize(args: { groups: number; provingMs: number; windowMs?: number }): number {
  const { groups, provingMs, windowMs = BATCH_QUOTE_WINDOW_MS } = args;
  if (groups <= 1 || provingMs <= 0) return 1;
  const perGroup = provingMs / groups;
  const fits = Math.floor((windowMs * BATCH_WINDOW_BUDGET) / perGroup);
  return Math.max(1, Math.min(groups - 1, fits));
}

/** A prepared batch no longer matches what the user reviewed; nothing was sent for it. */
export class BatchChangedSinceReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchChangedSinceReviewError';
  }
}

/** Some sub-batches confirmed before a later one failed: those funds moved. */
export class BatchPartiallyWithdrawnError extends Error {
  constructor(
    readonly confirmed: { txHash: `0x${string}` | null; amountOutWei: bigint; feeWei: bigint }[],
    readonly cause: unknown,
    /** The failing batch may have been sent: its notes may be spent too. */
    readonly lastOutcomeUnknown = false,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    const done = `Part of your balance was withdrawn in ${confirmed.length} transaction${confirmed.length === 1 ? '' : 's'} before this stopped: ${why}`;
    super(lastOutcomeUnknown
      ? `${done} The last batch may still have been sent. Sync your account before withdrawing again.`
      : `${done} The rest is still shielded. Sync your account, then withdraw it again.`);
    this.name = 'BatchPartiallyWithdrawnError';
  }
}

type PreparedBatch = { totalAmountOut: bigint | string | number; totalFee: bigint | string | number };

/**
 * Withdraw every group, as one batch when it proves inside the quote window
 * and otherwise as sub-batches sized from the measured proving speed. A refusal
 * that sent nothing (the quote ran out, or the ASP root moved) is re-proved
 * with a fresh quote. Every prepared batch must release exactly its groups'
 * amounts, and the fees of all of them together must stay within the reviewed
 * fee (`feeOk`, the same allowance as a single withdrawal). Nothing is sent for
 * a batch that fails either check.
 */
export async function withdrawGroupsWithinWindow<P extends PreparedBatch, R>({
  groups, reviewedTotalFeeWei, feeOk, prepare, relay, isReprovable, outcomeKnown, isQuoteExpiry, shouldContinue,
  onReprove, onConfirmed, now = Date.now,
}: {
  groups: BatchGroup[];
  reviewedTotalFeeWei: bigint;
  feeOk: (feeWei: bigint, reviewedWei: bigint) => boolean;
  /** Prepare (quote + prove) exactly these groups; `all` is true for the whole balance. */
  prepare: (groups: BatchGroup[], all: boolean) => Promise<P>;
  /** Relay one prepared batch; resolves only on a confirmed receipt. */
  relay: (prepared: P) => Promise<R>;
  isReprovable: (error: unknown) => boolean;
  /** Whether a failed relay provably sent nothing or reverted (its notes are untouched). */
  outcomeKnown: (error: unknown) => boolean;
  isQuoteExpiry: (error: unknown) => boolean;
  shouldContinue: () => boolean;
  onReprove: (info: { attempt: number; size: number; reason: 'expired' | 'refused' }) => void;
  onConfirmed: (result: R, prepared: P, info: { index: number; groups: number; remaining: number }) => void;
  now?: () => number;
}): Promise<{ results: R[]; feeWei: bigint; amountOutWei: bigint } | null> {
  const results: R[] = [];
  const confirmed: { txHash: `0x${string}` | null; amountOutWei: bigint; feeWei: bigint }[] = [];
  let remaining = groups;
  let size = groups.length;
  let feeWei = 0n;
  let amountOutWei = 0n;
  let attempt = 0;
  const fail = (error: unknown, known = true): never => {
    throw confirmed.length > 0 ? new BatchPartiallyWithdrawnError(confirmed, error, !known) : error;
  };
  while (remaining.length > 0) {
    if (!shouldContinue()) return confirmed.length > 0 ? fail(new Error('The withdrawal was left before it finished.')) : null;
    const chunk = remaining.slice(0, size);
    const expectedOut = chunk.reduce((sum, g) => sum + g.amountOut, 0n);
    const started = now();
    let prepared: P;
    try {
      prepared = await prepare(chunk, chunk.length === groups.length);
    } catch (error) {
      return fail(error);
    }
    const provingMs = now() - started;
    if (!shouldContinue()) return confirmed.length > 0 ? fail(new Error('The withdrawal was left before it finished.')) : null;
    if (BigInt(prepared.totalAmountOut) !== expectedOut) {
      return fail(new BatchChangedSinceReviewError('Your withdrawable balance changed since you reviewed this withdrawal. Press Withdraw again to see the updated total.'));
    }
    const chunkFee = BigInt(prepared.totalFee);
    if (!feeOk(feeWei + chunkFee, reviewedTotalFeeWei)) {
      return fail(new BatchChangedSinceReviewError('The relayer fee went up since you reviewed this withdrawal. Press Withdraw again to get a fresh quote before confirming.'));
    }
    let result: R;
    try {
      result = await relay(prepared);
    } catch (error) {
      attempt += 1;
      if (attempt > BATCH_MAX_REPROVES || !isReprovable(error) || !shouldContinue()) return fail(error, outcomeKnown(error));
      const expired = isQuoteExpiry(error);
      // A batch that ran out of time while proving is split to the size that
      // fits; one refused for a moved root is simply proved again.
      if (expired) size = subBatchSize({ groups: chunk.length, provingMs });
      onReprove({ attempt, size, reason: expired ? 'expired' : 'refused' });
      continue;
    }
    attempt = 0;
    feeWei += chunkFee;
    amountOutWei += expectedOut;
    results.push(result);
    const txHash = (result as { txHash?: `0x${string}` } | null)?.txHash ?? null;
    confirmed.push({ txHash, amountOutWei: expectedOut, feeWei: chunkFee });
    remaining = remaining.slice(chunk.length);
    onConfirmed(result, prepared, { index: results.length, groups: chunk.length, remaining: remaining.length });
  }
  return { results, feeWei, amountOutWei };
}

/**
 * The note manager a sub-batch session proves from: the same store, with its
 * ACTIVE notes limited to `inputCommitments`. The SDK's batch withdraw always
 * takes every active note of the asset, so this is how one session proves only
 * some groups. Reads of other statuses and every write go to the real store,
 * so a confirmed sub-batch persists where the UI reads.
 */
export function noteManagerLimitedTo<M extends object>(manager: M, inputCommitments: ReadonlySet<string>): M {
  return new Proxy(manager, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property !== 'getNotes') return value.bind(target);
      return (...args: unknown[]) => {
        const notes = value.apply(target, args) as Note[];
        return notes.filter((note) => note.status !== NoteStatus.ACTIVE || inputCommitments.has(note.commitment));
      };
    },
  });
}
