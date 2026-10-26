// The keystore identity check, answered from the bulk ASP registries
// (read through readRegistryView in services/nullifying-key-hash-cache.ts)
// instead of per-account chain reads, which named the user's own account to
// the RPC provider on every sign-in and pre-deposit check.

export type KeystoreIdentityStatus = 'unknown' | 'unregistered' | 'compatible' | 'partial' | 'incompatible';

export interface RegistryView {
  /** Registered nullifying-key hash, or null when absent from the local copy. */
  nullifyingKeyHash: string | null;
  /** Whether a miss in the nullifying-key registry can be trusted as "not registered". */
  nullifyingFresh: boolean;
  /** Published viewing key, or null when absent from the local copy. */
  viewingKey: string | null;
  /** Whether the viewing-key registry is current (a hit could otherwise be rotated away). */
  viewingFresh: boolean;
}

function asBig(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Same semantics as the old chain read: 'unknown' whenever the data cannot
 * answer, and never 'compatible' unless both registries are current and match.
 */
export function identityStatusFromRegistry(
  view: RegistryView,
  activeNullifyingKeyHash: string,
  activeViewingKey: string,
): KeystoreIdentityStatus {
  const n = view.nullifyingKeyHash ? asBig(view.nullifyingKeyHash) : null;
  if (n === null || n === 0n) {
    // The hash is write-once, so only a current registry can say "not there".
    return view.nullifyingFresh ? 'unregistered' : 'unknown';
  }
  const active = asBig(activeNullifyingKeyHash);
  if (active === null) return 'unknown';
  if (n !== active) return 'incompatible';
  if (!view.viewingFresh) return 'unknown';
  if (!view.viewingKey) return 'partial';
  const v = asBig(view.viewingKey);
  // A malformed entry cannot answer either way.
  if (v === null) return 'unknown';
  if (v === 0n) return 'partial';
  return view.viewingKey!.toLowerCase() === activeViewingKey.toLowerCase() ? 'compatible' : 'partial';
}

