// What a spend of mine reads as when the only value that left my balance was
// the relayer's fee (UserSpend kind 'fee', services/transact-shape.ts).
//
// Every output of such a tx is my own note, so nothing reached anyone else: it
// is a private transfer to myself. The chain says so on any device, either
// through the relayer's TRANSFER route or through more outputs than input
// labels, which the withdrawal builder cannot produce. It is a consolidation
// only when it has the Consolidate action's shape, which is when the spend
// carries note counts (UserSpend.consolidation); anything else is a
// self-transfer, and note counts mean nothing on it. Neither label reads a
// local stamp.

export type NoteCounts = { spent: number; created: number };

/** The row's type as the user reads it. */
export function selfTransferLabel(consolidation: NoteCounts | undefined): string {
  return consolidation ? 'Consolidation' : 'Self-transfer';
}

const notesWord = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

/** "3 notes → 1 note", as the consolidation panel writes it. */
export function noteCountText(counts: NoteCounts): string {
  return `${notesWord(counts.spent)} → ${notesWord(counts.created)}`;
}

/** The headline a consolidation row shows in place of an amount, or null. */
export function consolidationHeadline(tx: { direction?: string; noteCounts?: NoteCounts }): string | null {
  return tx.direction === 'self' && tx.noteCounts ? noteCountText(tx.noteCounts) : null;
}

/** Does this row's amount state only the relayer fee? */
export function isFeeAmountRow(tx: { direction?: string }): boolean {
  return tx.direction === 'self';
}
