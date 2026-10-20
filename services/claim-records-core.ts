// Pure half of services/claim-records-store.ts: the received notes this device
// confirmed as claimed, by commitment, and whether a registration rode along.
//
// Why commitments and not the claim's tx hash (DEV-574). The anchor stamp
// (services/anchor-stamps-core.ts) names the claim's hash, and it is written
// only once the claim is positively confirmed. When that confirmation does not
// come back in time, the spend was classified by its shape alone, and a claim
// sent before the viewing key is published has an output this account cannot
// read yet, so the shape rule saw "a recipient that is not me" and the user's
// own payment read as Transfer Out. The inputs of a claim are notes someone
// sent to this account: only once our nullifiers are confirmed spent by the
// claim do we record them. An attempted claim must leave no record if it fails,
// since a later ordinary send or withdrawal of those notes is not a claim.
//
// Only local data: the commitments are the notes this device already holds, and
// nothing here is sent anywhere.

export type ClaimRecord = {
  /** Lowercase, 0x-prefixed. */
  commitment: string;
  chainId: number;
  /** The claim's transaction also registered the account (registerAndRelay). */
  withRegistration: boolean;
  /** unix ms */
  timestamp: number;
};

/** Bounded so a long-lived device cannot grow the record without limit. */
export const MAX_CLAIM_RECORDS = 500;

export function normalizeClaimCommitment(c: string): string {
  const s = c.trim();
  if (!s) return '';
  // Same spelling the spend classifier keys on (normalizeHashValue): the
  // number, as 32 bytes of lowercase hex, whether it came as hex or decimal.
  try {
    return `0x${BigInt(s).toString(16).padStart(64, '0')}`;
  } catch {
    return s.toLowerCase();
  }
}

export function parseClaimRecords(raw: unknown): ClaimRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is ClaimRecord => !!r
    && typeof r === 'object'
    && typeof (r as ClaimRecord).commitment === 'string'
    && (r as ClaimRecord).commitment.length > 0
    && typeof (r as ClaimRecord).chainId === 'number'
    && typeof (r as ClaimRecord).withRegistration === 'boolean'
    && typeof (r as ClaimRecord).timestamp === 'number');
}

/** One record per (chain, commitment); the latest wins, oldest drop first. */
export function upsertClaimRecords(
  list: readonly ClaimRecord[],
  input: { chainId: number; commitments: readonly string[]; withRegistration: boolean; now: number },
): ClaimRecord[] {
  const fresh = input.commitments.map(normalizeClaimCommitment).filter(Boolean);
  const replaced = new Set(fresh.map((c) => `${input.chainId}:${c}`));
  const kept = list.filter((r) => !replaced.has(`${r.chainId}:${r.commitment}`));
  for (const commitment of fresh) {
    kept.push({ commitment, chainId: input.chainId, withRegistration: input.withRegistration, timestamp: input.now });
  }
  return kept.length > MAX_CLAIM_RECORDS ? kept.slice(kept.length - MAX_CLAIM_RECORDS) : kept;
}

/**
 * commitment -> { withRegistration } over every chain, the shape
 * reconstructUserSpends takes. A commitment is unique to its note, so the
 * chain is not part of the key.
 */
export function toClaimedInputMap(list: readonly ClaimRecord[]): Map<string, { withRegistration: boolean }> {
  const out = new Map<string, { withRegistration: boolean }>();
  for (const r of list) out.set(normalizeClaimCommitment(r.commitment), { withRegistration: r.withRegistration });
  return out;
}
