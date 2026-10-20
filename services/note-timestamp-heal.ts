/**
 * Which block timestamp created each commitment, from an event snapshot.
 *
 * An imported note arrives with `createdAtBlock: '0x0'` when the sender could
 * not stamp it. That stub is not cosmetic: the state-tree leaf is
 * Poseidon(commitment, createdAtBlock), so a note that keeps the stub cannot
 * be anchored and therefore cannot be spent. Healing it means finding the
 * commitment in the chain's own events and reading the real timestamp back.
 *
 * BOTH EVENT FAMILIES, and that is the whole reason this module exists. The
 * healer used to index `transacts[].outputCommitments` only, which covers a
 * note that arrived by transfer. A note can also arrive by DEPOSIT - someone
 * deposits for a recipient who has never registered, so nothing is announced
 * on chain and a claim link is the only route to the money - and that
 * commitment is a `deposits[].outputCommitment`. Those notes imported fine
 * and then failed at the anchor with "leaf not found in tree", which reads as
 * a broken claim rather than a missing index (codex, 2026-09-16).
 *
 * Pure and dependency-free: the timestamp parser is passed in, so this can be
 * tested without the snapshot source or a React runtime.
 */

/** The shape this needs, not the full snapshot type. */
export type TimestampSnapshot = {
  transacts?: readonly {
    txHash?: string | null;
    blockTimestamp?: string | number | null;
    outputCommitments?: readonly unknown[] | null;
  }[] | null;
  deposits?: readonly {
    txHash?: string | null;
    blockTimestamp?: string | number | null;
    outputCommitment?: unknown;
  }[] | null;
};

export type CommitmentOrigin = { txHash: string; ts: bigint };

export type CommitmentIndex = {
  byCommitment: Map<string, CommitmentOrigin>;
  /**
   * Rows whose timestamp could not be read. Non-zero means an absence is NOT
   * proven: the caller must not turn "commitment missing from this index"
   * into "the payment never landed".
   */
  skippedRows: number;
  transactsIndexed: number;
  depositsIndexed: number;
};

/** Commitments are compared as 0x-prefixed, zero-padded, lowercase hex. */
export function normalizeCommitment(value: string): string {
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * Index every commitment the snapshot can date.
 *
 * The caller passes its own timestamp parser, because a snapshot row carries
 * unix seconds, unix milliseconds or ISO depending on which it is. It returns
 * 0 or less when it cannot read one, and such a row is counted as skipped
 * rather than guessed at.
 */
export function indexCommitmentTimestamps(
  snapshot: TimestampSnapshot | null | undefined,
  toMs: (value: string | number | null | undefined) => number,
): CommitmentIndex {
  const byCommitment = new Map<string, CommitmentOrigin>();
  let skippedRows = 0;
  let transactsIndexed = 0;
  let depositsIndexed = 0;

  for (const t of snapshot?.transacts ?? []) {
    const ms = toMs(t.blockTimestamp);
    if (!(ms > 0)) { skippedRows += 1; continue; }
    transactsIndexed += 1;
    for (const c of t.outputCommitments ?? []) {
      if (c === null || c === undefined) continue;
      byCommitment.set(normalizeCommitment(String(c)), {
        txHash: String(t.txHash ?? ''),
        ts: BigInt(Math.floor(ms / 1000)),
      });
    }
  }

  for (const d of snapshot?.deposits ?? []) {
    const ms = toMs(d.blockTimestamp);
    if (!(ms > 0)) { skippedRows += 1; continue; }
    depositsIndexed += 1;
    if (d.outputCommitment === null || d.outputCommitment === undefined) continue;
    byCommitment.set(normalizeCommitment(String(d.outputCommitment)), {
      txHash: String(d.txHash ?? ''),
      ts: BigInt(Math.floor(ms / 1000)),
    });
  }

  return { byCommitment, skippedRows, transactsIndexed, depositsIndexed };
}
