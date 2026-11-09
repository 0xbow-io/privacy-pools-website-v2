/**
 * The shareable URL of a Stellar one-time claim (services/stellar/stellar-claim.ts):
 * the brand domain when configured, else this origin, plus the Stellar opt-in
 * and this world (services/stellar/stellar-link.ts) so a fresh browser lands
 * where the note is.
 */
import { ACTIVE_APP_ENVIRONMENT } from '@/config/app-environment';
import { PAY_URL_BASE } from '@/config/env';
import { STAGING_MAINNET_EXPLICIT } from '@/config/staging-mainnet';
import { encodeStellarClaim, type StellarClaimNote } from '@/services/stellar/stellar-claim';
import { withStellarLinkParams } from '@/services/stellar/stellar-link';

export function buildStellarClaimUrl(notes: readonly StellarClaimNote[]): string | null {
  const base = PAY_URL_BASE || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  if (!base) return null;
  return withStellarLinkParams(`${base}/import-note#${encodeStellarClaim(notes)}`, ACTIVE_APP_ENVIRONMENT, { stagingMainnet: STAGING_MAINNET_EXPLICIT });
}
