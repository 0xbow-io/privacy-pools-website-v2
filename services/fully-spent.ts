/**
 * Which deposit transactions are fully spent, from the account's notes.
 *
 * A deposit is fully spent once the lineage it STARTED holds no live value.
 * The old rule looked at each root note (no parent) and flagged its tx when
 * that one lineage was dead. Session notes carry no parent linkage, so every
 * note reads as a root, and a reshield's tx holds two lineages: the source
 * side's change and the newly deposited note. A dead 0-value change flagged
 * the tx, and the fresh, untouched deposit showed "Fully spent" (Mike,
 * 2026-09-24). The reverse also has to hold: a partial reshield leaves a LIVE
 * source change in that tx, which must not keep a fully withdrawn deposit
 * from reading as spent (review, #132).
 *
 * So each lineage (label) is attributed to the tx that started it: the tx of
 * its earliest note by block time. A tx is fully spent when every lineage it
 * started is dead. A lineage whose notes carry no usable time yet falls back
 * to every tx it has a note in, which is the previous behaviour.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */
export type SpendableNoteLike = {
  label: string;
  value: string;
  status: string;
  parentCommitmentHash: string | null;
  txHash: string;
  /** Unix seconds (hex) once healed; a block number or 0 before that. */
  createdAtBlock?: string | null;
};

function noteTime(n: SpendableNoteLike): bigint | null {
  try {
    const t = BigInt(n.createdAtBlock ?? '0x0');
    // Below one billion is a block number or a placeholder, not a time.
    return t >= 1_000_000_000n ? t : null;
  } catch {
    return null;
  }
}

export function fullySpentDepositTxHashes(
  notes: readonly SpendableNoteLike[],
  isLive: (status: string) => boolean,
): Set<string> {
  const spent = new Set<string>();
  if (notes.length === 0) return spent;

  const liveLabels = new Set<string>();
  const byLabel = new Map<string, SpendableNoteLike[]>();
  for (const n of notes) {
    const label = String(n.label).toLowerCase();
    const list = byLabel.get(label) ?? [];
    list.push(n);
    byLabel.set(label, list);
    if (!isLive(String(n.status).toUpperCase())) continue;
    try {
      if (BigInt(n.value) > 0n) liveLabels.add(label);
    } catch { /* unparseable value holds nothing */ }
  }

  // tx -> the lineages it started.
  const startedByTx = new Map<string, Set<string>>();
  const credit = (tx: string, label: string) => {
    const set = startedByTx.get(tx) ?? new Set<string>();
    set.add(label);
    startedByTx.set(tx, set);
  };
  for (const [label, list] of byLabel) {
    const roots = list.filter((n) => !n.parentCommitmentHash && n.txHash);
    if (roots.length === 0) continue;
    let earliest: SpendableNoteLike | null = null;
    let earliestT: bigint | null = null;
    for (const n of roots) {
      const t = noteTime(n);
      if (t !== null && (earliestT === null || t < earliestT)) { earliest = n; earliestT = t; }
    }
    if (earliest) credit(String(earliest.txHash).toLowerCase(), label);
    else for (const n of roots) credit(String(n.txHash).toLowerCase(), label);
  }

  for (const [tx, labels] of startedByTx) {
    if ([...labels].every((l) => !liveLabels.has(l))) spent.add(tx);
  }
  return spent;
}

/**
 * The same, per chain: each chain's deposits judged against that chain's
 * notes only. A row on another chain than the selected one is judged against
 * its own chain's notes, and a cross-chain swap's two chains never share a
 * lineage set even though both hold a note under the source tx hash.
 */
export function fullySpentDepositTxHashesByChain(
  notesByChain: ReadonlyMap<number, readonly SpendableNoteLike[]>,
  isLive: (status: string) => boolean,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const [chainId, notes] of notesByChain) out.set(chainId, fullySpentDepositTxHashes(notes, isLive));
  return out;
}
