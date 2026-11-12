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

/** A deposit refused because the registry and the chain disagree about this account. */
export const REGISTRATION_UNCONFIRMED_MESSAGE =
  'Could not confirm this unlock matches the account\'s registration yet. Nothing was sent. Try again in a few minutes.';
export const REGISTRATION_INCOMPATIBLE_MESSAGE =
  'This account is registered with a different unlock. Switch unlock, or import its notes to exit.';
export const REGISTRATION_SYNCING_REFUSAL =
  'Still syncing account registrations. Nothing was sent. Try again in a moment.';

/**
 * The last check before a write mints a note under this session's keys, once
 * the live "is anything registered?" read is in. That read is a nonzero check:
 * it says SOMEONE registered this address, not which keys. So a registry miss
 * ('unregistered') next to a registered chain is a contradiction, either the
 * registry lags or the address is registered under another unlock, and the
 * second strands the funds for good. Refuse rather than guess. Returns the
 * refusal text, or null to go ahead (an unregistered chain goes to the
 * caller's own registration step).
 */
export function ownRegistrationRefusal(status: KeystoreIdentityStatus, registeredOnChain: boolean): string | null {
  if (status === 'incompatible') return REGISTRATION_INCOMPATIBLE_MESSAGE;
  if (!registeredOnChain) return null;
  if (status === 'unregistered') return REGISTRATION_UNCONFIRMED_MESSAGE;
  if (status === 'unknown') return REGISTRATION_SYNCING_REFUSAL;
  return null;
}

/** The two per-account chain reads the identity check made before it used the registries. */
export interface ChainIdentityReads {
  readNullifyingKeyHash: () => Promise<string | null | undefined>;
  readViewingKey: () => Promise<string | null | undefined>;
}

/**
 * The registries answer FIRST, from the local copy, so nothing names the
 * account while they can. Only when they cannot ('unknown': no current data and
 * no write-once hit) and the caller allows it does this ask the chain, the same
 * two reads the check made before the registries existed. A failed chain read
 * throws: it is never turned into 'compatible' or 'unregistered'.
 */
export async function identityStatusWithChainFallback(
  view: RegistryView,
  activeNullifyingKeyHash: string,
  activeViewingKey: string,
  chain: ChainIdentityReads | null,
): Promise<KeystoreIdentityStatus> {
  const fromRegistry = identityStatusFromRegistry(view, activeNullifyingKeyHash, activeViewingKey);
  if (fromRegistry !== 'unknown' || !chain) return fromRegistry;
  const n = await chain.readNullifyingKeyHash();
  const nullifying = !n || asBig(n) === 0n ? null : n;
  const hash = nullifying ?? `0x${'0'.repeat(64)}`;
  const first = identityStatusFromRegistry(
    { nullifyingKeyHash: hash, nullifyingFresh: true, viewingKey: null, viewingFresh: true },
    activeNullifyingKeyHash,
    activeViewingKey,
  );
  // 'partial' here only means "hash matches, viewing key still to read".
  if (first !== 'partial') return first;
  const v = await chain.readViewingKey();
  return identityStatusFromRegistry(
    { nullifyingKeyHash: hash, nullifyingFresh: true, viewingKey: v ?? null, viewingFresh: true },
    activeNullifyingKeyHash,
    activeViewingKey,
  );
}
