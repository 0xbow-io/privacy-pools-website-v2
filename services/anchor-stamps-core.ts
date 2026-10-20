// Pure half of services/anchor-stamps-store.ts. Split for the same reason as
// outgoing-deposits-core and unanchored-notes-core: the store is guarded by
// `Platform.OS === 'web'` and no-ops under test, so logic living there would go
// unexercised (and CI runs only `services` and `scripts`, so a component is
// never executed at all).
//
// What this records: "transaction T was MY anchor, and it spent commitment C."
//
// Why a record is needed when services/transact-shape.ts already exists. The
// shape rule can prove, from chain data, that a transact was a SELF-transfer -
// more outputs than distinct input labels is something the SDK's withdrawal
// builder cannot produce. That is enough to stop calling the outflow a
// withdrawal, which is the actual bug. It is NOT enough to say WHY the user
// self-transferred: anchoring a link-received note and consolidating dust make
// the identical shape. Only the client that performed the action knows which,
// so intent comes from here and facts come from the chain.
//
// Consequences of that split, and they are the whole point:
//   - A missing stamp means "I do not know the reason", never "it was a
//     withdrawal". Absence must never upgrade into a claim.
//   - A stamp is only ever written on a POSITIVELY confirmed anchor.
//
// Durable (localStorage), unlike unanchored-notes which is sessionStorage on
// purpose. The difference matters: an unanchored flag must die with the note
// cache it describes, whereas the row this decorates is re-derived from chain
// on every new session, so a tab-scoped stamp would vanish while the row it
// explains came back. A confirmed anchor is also permanent - it cannot be
// undone by a later session - so there is nothing to go stale.

export type AnchorStamp = {
  owner: string;
  chainId: number;
  txHash: string;
  /** The ONE input commitment this transaction spent. See recordAnchorStamps. */
  commitment: string;
};

const norm = (s: string) => s.trim().toLowerCase();
const keyOf = (owner: string, chainId: number, txHash: string, commitment: string) =>
  `${norm(owner)}:${chainId}:${norm(txHash)}:${norm(commitment)}`;

/**
 * How many stamps to keep. Anchors are rare (one per claimed payment), so this
 * is generous; it exists only so a long-lived browser profile cannot grow the
 * entry without bound. Oldest entries are dropped first.
 */
export const MAX_ANCHOR_STAMPS = 200;

/** Drop anything malformed, so one bad row cannot poison the transactions table. */
export function parseAnchorStamps(raw: unknown): AnchorStamp[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is AnchorStamp =>
    !!e && typeof e === 'object'
    && typeof (e as AnchorStamp).owner === 'string'
    && typeof (e as AnchorStamp).chainId === 'number'
    && typeof (e as AnchorStamp).txHash === 'string'
    && typeof (e as AnchorStamp).commitment === 'string');
}

/**
 * Add one (txHash, commitment) pair per confirmed anchor leg. Idempotent.
 *
 * Granularity is deliberate and was got wrong once already. The self-funded
 * claim path submits ONE transact per note (hooks/use-note-import.ts, the loop
 * passing `inputCommitments: [note.commitment]`), so N claimed notes produce N
 * transactions, each spending exactly one commitment. Recording every claimed
 * commitment against every hash would assert that a transaction spent notes it
 * never touched. The relayed/gasless branch is the opposite shape - one
 * transaction for all inputs - and legitimately passes several commitments.
 */
export function withAnchorStamps(
  stamps: readonly AnchorStamp[],
  owner: string | null | undefined,
  chainId: number,
  txHash: string | null | undefined,
  commitments: readonly string[],
): AnchorStamp[] {
  if (!owner || !txHash) return [...stamps];
  const seen = new Set(stamps.map((s) => keyOf(s.owner, s.chainId, s.txHash, s.commitment)));
  const next = [...stamps];
  for (const c of commitments) {
    if (!c) continue;
    const k = keyOf(owner, chainId, txHash, c);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push({ owner: norm(owner), chainId, txHash: norm(txHash), commitment: norm(c) });
  }
  return next.length > MAX_ANCHOR_STAMPS ? next.slice(next.length - MAX_ANCHOR_STAMPS) : next;
}

/** Was this transaction one of MY confirmed anchors, on this chain? */
export function isAnchorTx(
  stamps: readonly AnchorStamp[],
  owner: string | null | undefined,
  chainId: number,
  txHash: string | null | undefined,
): boolean {
  if (!owner || !txHash) return false;
  const o = norm(owner);
  const t = norm(txHash);
  return stamps.some((s) => norm(s.owner) === o && s.chainId === chainId && norm(s.txHash) === t);
}

/** Anchor tx hashes for this owner/chain, lowercase. */
export function selectAnchorTxHashes(
  stamps: readonly AnchorStamp[],
  owner: string | null | undefined,
  chainId: number,
): Set<string> {
  const out = new Set<string>();
  if (!owner) return out;
  const o = norm(owner);
  for (const s of stamps) {
    if (norm(s.owner) === o && s.chainId === chainId) out.add(norm(s.txHash));
  }
  return out;
}
