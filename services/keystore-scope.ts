import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { alreadySetRegistrationRefusal } from '@/services/nullifying-key-hash-cache';

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
