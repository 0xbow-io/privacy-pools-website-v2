/**
 * Who made the ORIGINAL deposit behind a note (Stellar request, 2026-11-19).
 *
 * A note's label is the label of the deposit it descends from. The public feed
 * names that deposit's depositor, so for a received transfer the app can say
 * "this money started as a deposit by 0x...". It is local data: both sides are
 * rows already loaded from the public feed grid, so this adds no request and
 * its timing cannot be caused by anything the user does.
 *
 * It is NOT the sender. Alice deposits, sends to Bob, Bob sends to Carol: Carol's
 * note still carries Alice's deposit label. The UI says so in the same breath
 * (ORIGIN_DEPOSITOR_NOTE), because calling it "sender" would be wrong.
 *
 * PURE (no react-native imports) so bun can pin it.
 */
import { hexKey } from '@/services/swap-rows';

/** The fields of a feed row this needs. */
export type OriginRow = {
  type?: string;
  chainId?: number;
  label?: string | null;
  fullAddress?: string;
  /** asp-v2: 'bridged_pool' | 'pool' | 'wallet' | 'bridged_wallet'. */
  fundingSource?: string;
};

export const ORIGIN_DEPOSITOR_LABEL = 'Original deposit by';
export const ORIGIN_DEPOSITOR_NOTE = 'The first deposit behind these funds, not necessarily who sent them to you.';

/** A deposit funded by a swap or bridge names the executor, not a party: never shown as an origin. */
function namesAParty(row: OriginRow): boolean {
  return row.fundingSource !== 'bridged_pool' && row.fundingSource !== 'pool' && row.fundingSource !== 'bridged_wallet';
}

const key = (chainId: number, label: string) => `${chainId}:${hexKey(label)}`;

/** Deposit feed rows by chain and label, depositor lower-cased. First row wins. */
export function buildDepositorByLabel(rows: readonly OriginRow[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.type !== 'Deposit' || !r.label || !r.fullAddress || typeof r.chainId !== 'number') continue;
    if (!namesAParty(r)) continue;
    const k = key(r.chainId, r.label);
    if (!map.has(k)) map.set(k, r.fullAddress.toLowerCase());
  }
  return map;
}

/**
 * The original depositor for a received-transfer row, or null: not a transfer
 * in, no label, no deposit row indexed for it yet, or it is the viewer's own
 * deposit (nothing to tell them).
 */
export function originDepositorFor(
  tx: OriginRow & { direction?: string },
  byLabel: ReadonlyMap<string, string>,
  ownAddress?: string | null,
): string | null {
  if (tx.type !== 'Transfer' || tx.direction !== 'in' || !tx.label || typeof tx.chainId !== 'number') return null;
  const depositor = byLabel.get(key(tx.chainId, tx.label));
  if (!depositor) return null;
  if (ownAddress && depositor === ownAddress.toLowerCase()) return null;
  return depositor;
}
