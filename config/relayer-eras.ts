/**
 * Per-pool-era relayer routing data — PURE module (no react-native/DOM
 * imports) so bun tests and node tooling can import it directly.
 *
 * Each hosted relayer instance serves exactly one pool deployment, so both the
 * proof-processor binding AND the relayer base URL must follow the selected
 * vault. config/relayer.ts consumes this map and applies the active pool
 * selection; keep era data here, selection logic there.
 */

export type RelayEra = {
  /** PrivacyPoolRelay contract for the era — the WITHDRAWAL proof processor. */
  relay: string;
  /** Whether the era's relayer posts TRANSFERS from the signer EOA (issue #217). */
  transfersViaSignerEoa: boolean;
  /** The hosted relayer instance serving this era's pool, if not the current one. */
  relayerBaseUrl?: string;
  supportsBatchWithdrawals: boolean;
};

// V8 is the default: its rotated verifiers match the frontend ceremony keys.
// The testing service advertises this exact pool/entrypoint/relay tuple.
export const CURRENT_RELAY = '0x87a5BFbAd7cA6B1FF3d9E631877B5930f17C24B0';
export const CURRENT_RELAYER_BASE_URL = 'https://relayer-v2-testing-149184580131.us-east1.run.app';

export const RELAY_PROCESSOR_BY_VAULT: Record<string, RelayEra> = {
  '0x4deceef285a24ca05999870887c895042731d7cb': {
    relay: CURRENT_RELAY,
    supportsBatchWithdrawals: false,
    transfersViaSignerEoa: true,
    relayerBaseUrl: CURRENT_RELAYER_BASE_URL,
  },
  // Preserve explicit V9 routing; changing the default does not move its notes.
  '0x09b94d3127019298757a6ceeb7911922085f7c01': {
    supportsBatchWithdrawals: true,
    relay: '0x7430cc030d7eb8C83E76cD983996982C8C054204',
    transfersViaSignerEoa: true,
    relayerBaseUrl: 'https://relayer-v2-staging-149184580131.us-east1.run.app',
  },
};

/**
 * Pure resolver for the Sepolia relayer base URL. Env override wins (ops
 * re-pointing); then the selected era's own instance; then the current one.
 */
export function resolveSepoliaRelayerBaseUrl(
  selectedVault: string | undefined,
  envOverride: string | undefined,
): string {
  const trimmed = envOverride?.trim();
  if (trimmed) return trimmed;
  const era = selectedVault ? RELAY_PROCESSOR_BY_VAULT[selectedVault.toLowerCase()] : undefined;
  return era?.relayerBaseUrl ?? CURRENT_RELAYER_BASE_URL;
}

/** Sepolia relays are per vault. Unknown vaults route to the V8 service. */
export function relaySupportsBatchWithdrawals(chainId: number, vault?: string): boolean {
  return chainId !== 11155111 || RELAY_PROCESSOR_BY_VAULT[vault?.toLowerCase() ?? '']?.supportsBatchWithdrawals === true;
}
