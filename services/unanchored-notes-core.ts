// Pure half of services/unanchored-notes-store.ts, split for the same reason
// outgoing-deposits-core is split from its store: the storage half is guarded by
// `Platform.OS === 'web'` and so no-ops under test, which would leave the actual
// logic unexercised.
//
// What this tracks: notes that reached this device through a receipt link and
// have NOT been anchored. Those notes are genuinely on-chain (the sender's
// transact created them); what they are not is self-discoverable, which is what
// anchoring fixes. So "unanchored" cannot be derived from the chain, and a stored
// note is indistinguishable from a not-yet-run discovery pass. It has to be
// recorded when the device-only path is taken.

export type UnanchoredEntry = { owner: string; chainId: number; commitment: string };

const norm = (s: string) => s.trim().toLowerCase();
const keyOf = (owner: string, chainId: number, commitment: string) =>
  `${norm(owner)}:${chainId}:${norm(commitment)}`;

/** Drop anything that is not a well-formed entry, so one bad row cannot poison the list. */
export function parseUnanchoredEntries(raw: unknown): UnanchoredEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is UnanchoredEntry =>
    !!e && typeof e === 'object'
    && typeof (e as UnanchoredEntry).owner === 'string'
    && typeof (e as UnanchoredEntry).chainId === 'number'
    && typeof (e as UnanchoredEntry).commitment === 'string');
}

/** Add these commitments for (owner, chainId). Idempotent. Returns a NEW array. */
export function withUnanchoredNotes(
  entries: readonly UnanchoredEntry[],
  owner: string | null | undefined,
  chainId: number,
  commitments: readonly string[],
): UnanchoredEntry[] {
  if (!owner) return [...entries];
  const seen = new Set(entries.map((e) => keyOf(e.owner, e.chainId, e.commitment)));
  const next = [...entries];
  for (const c of commitments) {
    if (!c) continue;
    const k = keyOf(owner, chainId, c);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push({ owner: norm(owner), chainId, commitment: norm(c) });
  }
  return next;
}

/**
 * Remove these commitments for (owner, chainId).
 *
 * Callers must do this ONLY on a positively confirmed anchor. Clearing on an
 * unknown outcome would tell someone their funds are safely on-chain when
 * nothing verified that, which is the exact failure this area already produced.
 */
export function withoutUnanchoredNotes(
  entries: readonly UnanchoredEntry[],
  owner: string | null | undefined,
  chainId: number,
  commitments: readonly string[],
): UnanchoredEntry[] {
  if (!owner) return [...entries];
  const drop = new Set(commitments.filter(Boolean).map((c) => keyOf(owner, chainId, c)));
  return entries.filter((e) => !drop.has(keyOf(e.owner, e.chainId, e.commitment)));
}

/** Commitments this owner holds on this chain that are link-only, lowercase. */
export function selectUnanchoredCommitments(
  entries: readonly UnanchoredEntry[],
  owner: string | null | undefined,
  chainId: number,
): Set<string> {
  const out = new Set<string>();
  if (!owner) return out;
  const o = norm(owner);
  for (const e of entries) {
    if (norm(e.owner) === o && e.chainId === chainId) out.add(norm(e.commitment));
  }
  return out;
}
