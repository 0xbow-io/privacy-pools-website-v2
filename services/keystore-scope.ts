import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { alreadySetRegistrationRefusal, awaitKeystoreRegistries, readRegistryView } from '@/services/nullifying-key-hash-cache';

/** The keystore a chain's sessions and registry reads are scoped to. */
export function keystoreScopeAddress(chainId: number): string | undefined {
  return LEGACY_CONFIG?.keystore ?? getChainConfig(chainId)?.contracts?.keystoreAddress;
}

/**
 * The check every caller of `prepareRegisterKeystore()` runs before it treats
 * an "already registered" (or viewing-key-only) result as this session's own
 * registration. Local only: it compares the hash the SDK's own check just read.
 */
export function ownRegistrationResultRefusal(
  chainId: number,
  account: string | null | undefined,
  registration: { alreadyRegistered: boolean; keystoreCalldata: unknown; nullifyingKeyHash: unknown },
): string | null {
  // No account: nothing was read for it, so the result is unconfirmed.
  return alreadySetRegistrationRefusal(chainId, account ?? '', keystoreScopeAddress(chainId), registration);
}

export type OwnViewingKey =
  | { state: 'registered'; viewingKey: string }
  | { state: 'unregistered' }
  /** No current registry data: neither registered nor unregistered. */
  | { state: 'unknown' };

/**
 * This session account's published viewing key, from the bulk viewing-key
 * registry (and our own confirmed registration record), asked FIRST: while the
 * registry answers, the account never reaches the RPC. A missing registry is
 * 'unknown', never 'unregistered': the caller must not offer "register" on a
 * guess. Missing or stale data stays unknown; no account-specific RPC fallback
 * is allowed, including on payment-request and registration paths.
 */
export async function lookupOwnViewingKey(
  chainId: number,
  account: string,
  opts: { waitMs?: number } = {},
): Promise<OwnViewingKey> {
  const keystore = keystoreScopeAddress(chainId);
  if (opts.waitMs && opts.waitMs > 0) await awaitKeystoreRegistries(chainId, keystore, opts.waitMs);
  const view = readRegistryView(chainId, account, keystore);
  if (view.viewingFresh) {
    if (!view.viewingKey || /^0x0*$/i.test(view.viewingKey)) return { state: 'unregistered' };
    return { state: 'registered', viewingKey: view.viewingKey };
  }
  return { state: 'unknown' };
}
