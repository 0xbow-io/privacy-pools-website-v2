/**
 * The account's own Activity rows older than the public feed's window, built
 * from the event snapshot the client already downloads whole.
 *
 * The public events feed is the latest 50 rows per chain, so an account's
 * older deposits and exits scroll out of it. They used to come back through a
 * second request to the same route filtered by `address=<session address>`,
 * which told the ASP, every two minutes, which rows were this user's: their
 * address joined to their IP and online times at the operator that also runs
 * the relayer. The snapshot carries every deposit and ragequit of every pool,
 * so the same rows can be picked out locally from what this account owns.
 *
 * WHAT IS MINE
 *
 * A deposit whose output commitment is one of my notes, or whose depositor is
 * my activity address. A ragequit whose exited commitment is one of my notes,
 * or whose ragequitter is my activity address. That is the address filter's
 * answer plus the commitments it could never see (a cross-chain shield is
 * deposited by the bridge executor, not by me). Deposits I made FOR someone
 * else stay in, exactly as the filter returned them: the table shows them as
 * authored, not owned (hooks/use-my-transaction-ownership.ts).
 *
 * WHAT THE ROWS CARRY
 *
 * The same fields the ASP row did, read off the snapshot (amount, depositor or
 * ragequitter, tx hash, block time, asset, and a ragequit's label), with two
 * differences. `eventId` is local, since the ASP's id is not in the snapshot.
 * A deposit carries no review verdict and carries its output commitment
 * instead: the provider matches the row to its note by that commitment and
 * derives the verdict from local evidence (`ownDepositReviewStatus`).
 *
 * Pure and framework-free so bun tests can drive it.
 */

import type { AssetMetadata, GlobalEvent, SnapshotDeposit, SnapshotRagequit } from '@/services/api-types';
import { normalizeCommitment } from '@/services/deposit-ownership';
import type { DepositReviewStatus } from '@/services/funds-state';
import { snapshotTimestampToMs } from '@/services/outgoing-transfers';

/** A feed-shaped row built locally from the snapshot. */
export type OwnHistoryEvent = Omit<GlobalEvent, 'eventId'> & {
  /** Local id: `snapshot:<chain>:<tx>:<logIndex>`. Never an ASP id. */
  eventId: string;
  /** A deposit's output commitment, for the exact note match. */
  commitment?: string;
};

/**
 * Either kind of row the activity list maps. A public row carries the
 * commitment of the own row it covers, when there is one.
 */
export type ActivityEvent = (GlobalEvent & { commitment?: string }) | OwnHistoryEvent;

type Tagged<T> = T & { chainId: number };

export type OwnHistoryInput = {
  deposits: readonly Tagged<SnapshotDeposit>[];
  ragequits: readonly Tagged<SnapshotRagequit>[];
  /** The account's activity address, any case. Null in a session without one. */
  activityAddress: string | null;
  /** Commitments of every note this account holds, any chain, any encoding. */
  ownedCommitments: Iterable<string>;
  /** Display name for a chain, as the feed's `asset.chainName` would carry it. */
  chainName: (chainId: number) => string;
};

function assetFor(chainId: number, tokenAddress: string, chainName: string): AssetMetadata {
  return {
    asset: tokenAddress,
    chainId,
    chainName,
    // The ASP sends the address here too; mapEventToTransaction resolves the
    // symbol and decimals from the token registry either way.
    tokenSymbol: tokenAddress,
    tokenAddress,
    assetAddress: tokenAddress,
    denomination: 18,
  };
}

/** The account's own deposits and ragequits from the snapshot, as feed rows. */
export function buildOwnHistoryEvents(input: OwnHistoryInput): OwnHistoryEvent[] {
  const me = input.activityAddress?.toLowerCase() || null;
  const owned = new Set<string>();
  for (const c of input.ownedCommitments) {
    const canonical = normalizeCommitment(c);
    if (canonical) owned.add(canonical);
  }
  const isOwned = (commitment: string) => owned.has(normalizeCommitment(commitment) ?? '');

  const rows: OwnHistoryEvent[] = [];
  for (const d of input.deposits) {
    const mine = (me !== null && d.depositAddress?.toLowerCase() === me) || isOwned(d.outputCommitment);
    if (!mine) continue;
    const timestamp = snapshotTimestampToMs(d.blockTimestamp);
    rows.push({
      type: 'deposit',
      eventId: `snapshot:${d.chainId}:${d.txHash.toLowerCase()}:${d.logIndex}`,
      createdAt: String(d.blockTimestamp),
      amount: d.depositedValue,
      address: d.depositAddress,
      txHash: d.txHash,
      timestamp,
      asset: assetFor(d.chainId, d.asset, input.chainName(d.chainId)),
      commitment: d.outputCommitment,
    });
  }
  for (const r of input.ragequits) {
    const mine = (me !== null && r.ragequitter?.toLowerCase() === me) || isOwned(r.commitment);
    if (!mine) continue;
    const timestamp = snapshotTimestampToMs(r.blockTimestamp);
    rows.push({
      type: 'ragequit',
      eventId: `snapshot:${r.chainId}:${r.txHash.toLowerCase()}:${r.logIndex}`,
      createdAt: String(r.blockTimestamp),
      amount: r.withdrawnValue,
      address: r.ragequitter,
      txHash: r.txHash,
      timestamp,
      asset: assetFor(r.chainId, r.asset, input.chainName(r.chainId)),
      label: r.label,
    });
  }
  return rows;
}

function normalizeLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  try {
    return `0x${BigInt(label.trim()).toString(16).padStart(64, '0')}`;
  } catch {
    return null;
  }
}

/**
 * The review verdict for one of my deposits that the public window no longer
 * holds, from evidence already on this device. Strongest first:
 *
 * 1. The pool's published decisions: a rejected label is declined, a
 *    poi-required one needs proof. These override membership, as they do for
 *    spending (services/sdk-setup.ts getLabelStatus).
 * 2. The session chain's association-set gate, when it has judged this note.
 *    The balance counts the note by the same answer, so the row and the
 *    balance agree (#214).
 * 3. The note's own status from that chain's last sync: REJECTED is declined,
 *    a SPENT note was spent in a private transaction, which only an approved
 *    note can be, and an ACTIVE deposit note is approved where no gate is
 *    there to say otherwise. The SDK stores a deposit's note PENDING and
 *    promotes it to ACTIVE only once its label is in the association set.
 * 4. An exited note (EXIT_PENDING, EXITED) has no verdict: a ragequit needs no
 *    review, and the pending one it may have had is moot. Null.
 *
 * Anything else is pending.
 */
export function ownDepositReviewStatus(input: {
  label: string | null | undefined;
  noteStatus: string | null | undefined;
  /** Labels normalized as 0x-padded hex, or null when the decisions are not loaded. */
  decisions: { rejected: ReadonlySet<string>; poiRequired: ReadonlySet<string> } | null;
  /** The session gate's answer for this note, or null when it has none. */
  leafConfirmed: boolean | null;
}): DepositReviewStatus | null {
  const label = normalizeLabel(input.label);
  if (input.decisions && label) {
    if (input.decisions.rejected.has(label)) return 'declined';
    if (input.decisions.poiRequired.has(label)) return 'poi_required';
  }
  if (input.leafConfirmed === true) return 'approved';
  const status = String(input.noteStatus ?? '').toUpperCase();
  if (status === 'REJECTED') return 'declined';
  if (status === 'SPENT') return 'approved';
  if (status === 'ACTIVE' && input.leafConfirmed === null) return 'approved';
  if (status === 'EXITED' || status === 'EXIT_PENDING') return null;
  return 'pending';
}
