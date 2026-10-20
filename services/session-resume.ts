// Whether the wallet session is about to be rebuilt with no prompt.
//
// After a chain switch the SDK provider tears the session down and, for a
// wallet that proved its derivation signature in this tab, its auto-init
// effect rebuilds it silently on the new chain. That effect runs in the
// provider, after its children's effects, so for a render there is no session
// and none building, which consumers read as "signed out": the unlock gate
// offered Sign in and a row action opened the sign-in dialog, each flashing
// until the rebuild landed. These are that effect's own conditions, and
// `startedTarget` is its own once-per-target guard (state, not a copy).
//
// Account-key sessions are not covered: nothing reads their gap as locked
// (the withdraw flow skips the sign-in dialog for them, and the unlock gate is
// wallet-only).
//
// PURE (no react-native imports): bun-testable.

export function sessionResuming(s: {
  isInitialized: boolean;
  isInitializing: boolean;
  error: string | null;
  evmChain: boolean;
  identityMode: 'wallet' | 'key' | null;
  keysReady: boolean;
  /** The wallet address, lowercase, or null. */
  address: string | null;
  chainId: number;
  /** The address whose derivation signature this tab proved, lowercase. */
  provenAddress: string | null;
  /** The `address:chainId` the effect last started a build for. */
  startedTarget: string | null;
}): boolean {
  if (s.identityMode !== 'wallet' || s.isInitialized || s.isInitializing || s.error || s.keysReady) return false;
  if (!s.evmChain || !s.address || s.provenAddress !== s.address) return false;
  return s.startedTarget !== `${s.address}:${s.chainId}`;
}
