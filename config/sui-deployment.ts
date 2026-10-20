/**
 * Sui testnet deployment - single source of truth for deployed object IDs.
 *
 * Mirrors ppv2-sui-v2-sync/deployments/testnet.json (v2-synced contracts:
 * G1 tagged leaves, G2 depths 22/18/18, G3-G6 bounds, INTL-19 keystore liveness).
 * Publish digest: 5z91JC5ihDAik6CqFp2CmxoNNsasnKmekuek6csrcuUV
 *
 * Keep these in sync with the deployment JSON whenever contracts are re-published.
 */

/** Move object IDs + package for a Sui Privacy Pools deployment. */
export interface SuiContracts {
  /** Published package ID (provides the pool/entrypoint/keystore modules). */
  packageId: string;
  /** Unified Pool shared object. */
  poolObjectId: string;
  /** Entrypoint shared object (deposit gateway). */
  entrypointObjectId: string;
  /** Keystore shared object. */
  keystoreObjectId: string;
  /** ASP Registry shared object. */
  aspRegistryObjectId: string;
  /** RelayConfig shared object. */
  relayConfigObjectId: string;
}

/** Global View Key (BabyJubJub public key) used to encrypt note ciphertexts. */
export interface GlobalViewKey {
  x: bigint;
  y: bigint;
}

// Object IDs default to the v2-synced testnet deployment (ppv2-sui `v2-sync`
// branch, deployments/testnet.json — package 0xaaef2b67, publish digest
// 5z91JC5ihDAik6CqFp2CmxoNNsasnKmekuek6csrcuUV) and can be overridden per
// deployment via EXPO_PUBLIC_SUI_* env vars (see .env.example). Each access is
// STATIC (not a dynamic key) so Expo inlines the value into the web bundle at
// build time — `process.env[someVar]` would NOT be inlined and would silently
// fall back to the defaults below.
export const SUI_TESTNET_CONTRACTS: SuiContracts = {
  packageId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_PACKAGE_ID) ||
    '0xaaef2b67d15b8d73a83db671a9da840f8e0548daebf96d2d2ee2af91202b0fc6',
  poolObjectId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_POOL_ID) ||
    '0x3bd5794fab542c89d37aca18694f16963261b05fec261fd09cc2c4464daeaef7',
  keystoreObjectId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_KEYSTORE_ID) ||
    '0x36312c4f14dad7e5edea957045bd87d8a850f660f41ba3b8d6917079c346480a',
  aspRegistryObjectId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_ASP_REGISTRY_ID) ||
    '0x41ede5df5083a3bb36502e17e078692dc53e8fba513c5df428e1278b89ea04d8',
  entrypointObjectId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_ENTRYPOINT_ID) ||
    '0x8ccb80ef2f2af7ef2e11416687addb66b3d4afc19e06f70fd0d3ef51eb9c11ff',
  relayConfigObjectId:
    (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_RELAY_CONFIG_ID) ||
    '0xc84b1737a0fabeb168d3c989f561b0f6438d5f0f80993c557a3d1db0808a647e',
};

/**
 * Global View Key (testnet). Stored on the Pool and bound on-chain; rotatable via
 * pool::rotate_gvk (AdminCap). This static value is the deployment default, but the
 * UI should prefer reading pool.gvk()/pool.gvk_enabled from chain (SDK getPoolGvk/
 * getGvkEnabled) so it stays correct across rotation / toggle. The private key is NOT
 * included here - it lives only in the gitignored deployment secrets.
 */
/**
 * Resolve a decimal-bigint env override: trim whitespace, fall back to the
 * default when empty, and reject a non-decimal value with a load-time throw.
 * Fail-fast matters because a silently-wrong GVK coordinate would corrupt spend
 * witnesses — `BigInt(' ')`/`BigInt('\t')` parse to `0n`, which `||` does not
 * catch, and use-sui-session falls back to SUI_TESTNET_GVK when the live read
 * fails. The env value is read with a STATIC `process.env.EXPO_PUBLIC_*` access
 * at the callsite so Expo still inlines it.
 */
function readDecimalEnv(value: string | undefined, fallback: string, name: string): bigint {
  const resolved = (value ?? '').trim() || fallback;
  if (!/^\d+$/.test(resolved)) {
    throw new Error(`Invalid ${name}: expected a decimal bigint string`);
  }
  return BigInt(resolved);
}

export const SUI_TESTNET_GVK: GlobalViewKey = {
  x: readDecimalEnv(
    typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_SUI_GVK_X : undefined,
    '8000183593861526005546494415586001530851855863213787059736487848909126781386',
    'EXPO_PUBLIC_SUI_GVK_X',
  ),
  y: readDecimalEnv(
    typeof process !== 'undefined' ? process.env?.EXPO_PUBLIC_SUI_GVK_Y : undefined,
    '4719770751669487579175485260758459751413694420339086962996537886462047699885',
    'EXPO_PUBLIC_SUI_GVK_Y',
  ),
};

/**
 * Sui relayer base URL (testnet). When set, the withdraw modal's RELAYED choice
 * routes through `useSuiSession().relayedWithdraw` (gas-abstracted, context-bound
 * to the relayer). Empty string => no relayer configured; the modal falls back to
 * the DIRECT `transferOrWithdraw` path (the user submits + pays gas themselves).
 * Override at runtime via `EXPO_PUBLIC_SUI_RELAYER_URL`.
 */
export const SUI_TESTNET_RELAYER_URL: string =
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_RELAYER_URL) || '';

/**
 * ASP approved-set source. The spend flow proves input notes against this
 * published set, the balance gate splits available vs pending with it, and
 * the label-registration sweep consults it before registering. Defaults to
 * the 0xBow Sui ASP's association-set endpoint for the configured
 * entrypoint — an unset env var must NOT disable it (an empty URL silently
 * turns off the sweep and the spendability gate in production builds).
 * See services/sui-witness/asp-labels.ts. Override via EXPO_PUBLIC_SUI_ASP_LABELS_URL.
 */
export const SUI_ASP_LABELS_URL: string =
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_SUI_ASP_LABELS_URL) ||
  `https://api-dev.0xbow.io/association-set/leaves?entrypoint=${SUI_TESTNET_CONTRACTS.entrypointObjectId}&chainId=102`;

/** SUI asset config registered on-chain (entrypoint AssetConfig for 0x2::sui::SUI). */
export const SUI_TESTNET_ASSET_CONFIG = {
  '0x2::sui::SUI': {
    enabled: true,
    minAmount: 1n,
    vettingFeeBps: 0,
    maxRelayFee: 50000000n,
  },
} as const;

/** On-chain tree depths (must match the SDK circuit constants). */
export const SUI_TESTNET_TREE_DEPTHS = {
  state: 22,
  keystore: 18,
  asp: 18,
} as const;
