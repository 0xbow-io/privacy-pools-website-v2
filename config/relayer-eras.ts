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
};

export const RELAY_PROCESSOR_BY_VAULT: Record<string, RelayEra> = {
  // Pre-cutover V8 pool (poolId 1 in /entrypoints): V8 relay; transfers
  // posted directly from the signer EOA on that era. Served by the
  // "relayer-v2-testing" instance (announced with relay_contract 0x87a5BF…,
  // pool_vault 0x4DECEef2… — on-chain verified: relay.POOL() == the vault
  // below). The 403-from-some-networks problem noted here on 2026-07-22 was an
  // ingress issue and is fixed; as of 2026-08-23 the instance answers 201 to
  // quotes from both localhost:8081 and the Vercel preview origins.
  //
  // This entry is now redundant with the default below, since the current era
  // uses the same instance. Kept because it is the only record of WHICH relay
  // contract that era's proofs must bind to, which is not the current one.
  '0x4deceef285a24ca05999870887c895042731d7cb': {
    relay: '0x87a5BFbAd7cA6B1FF3d9E631877B5930f17C24B0',
    transfersViaSignerEoa: true,
    relayerBaseUrl: 'https://relayer-testing.example',
  },
};

// 2026-08-25: the staging relayer moved to the BATCH-CAPABLE PrivacyPoolRelay
// (v2.0 @ b2a37959 - relayBatch + MAX_BATCH()=10), deployed by the relayer
// team against the SAME pool/entrypoint (verified on-chain: POOL() ==
// 0x09b94d31..., ENTRYPOINT() == 0xeb3e39..., MAX_BATCH() == 10) and now
// advertised by /v1/details. The previous V9 relay 0x762665Dc... had no
// relayBatch in its bytecode, which made every /v1/relay/batch call a 500.
// Proofs bind the processor, so this constant must track whatever contract
// the relayer actually calls through - for singles AND batches alike.
export const CURRENT_RELAY = '0x7430cc030d7eb8C83E76cD983996982C8C054204';
/**
 * The hosted relayer for the current pool era.
 *
 * MUST stay the "staging" instance, and the reason is not preference — it is the
 * only instance whose on-chain caller matches the current pool's relay.
 *
 * Tried moving to "relayer-v2-testing" on 2026-08-23 to fix a real CORS problem
 * (staging allows only http://localhost:8081, so relayer quotes from a deployed
 * preview are discarded by the browser and the flow looks stalled). The switch
 * was reverted the same day: a relayed withdrawal on Sepolia, proof bound to the
 * V9 relay 0x762665Dc… that this pool requires, was rejected by the testing
 * instance with
 *
 *   Relay failed: The contract function "relay" reverted.
 *   (PoolVault_ProofContextMismatch)
 *
 * i.e. the testing instance posts Sepolia from a DIFFERENT relay — it serves the
 * pre-cutover V8 pool (see RELAY_PROCESSOR_BY_VAULT above, relay 0x87a5BFbA…,
 * vault 0x4DECEef2…), and a relay bound to another pool cannot relay for this
 * one. Serving all four chains and answering quotes identically does not make it
 * interchangeable; only the on-chain caller decides.
 *
 * So the CORS fix has to come from the relayer side, not from swapping
 * instances here. It since has: as of 2026-10-08 staging accepts any origin,
 * local ports and deployed previews alike. Anyone re-attempting the switch for
 * another reason: a quote succeeding proves nothing, the revert only shows up
 * on a real relayed spend.
 */
export const CURRENT_RELAYER_BASE_URL = 'https://relayer-staging.example';

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
