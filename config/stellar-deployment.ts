/**
 * Stellar testnet deployment - single source of truth for deployed contract IDs.
 *
 * Mirrors v2-monorepo packages/contracts-stellar/scripts/deployments/testnet.json
 * (origin/v2.0, deployed 2026-09-30 by GDMVB24I…3CDN; the pool was then upgraded
 * in place to a4c3dbb5, wasm 4c8a42a3). Checked on-chain 2026-09-30: all four
 * contracts are live, the relay contract's pool() resolves to the pool, native
 * XLM is enabled (0.01 XLM minimum, 100 bps fee, 0.1 XLM max relay fee).
 *
 * Every value can be overridden per deployment via EXPO_PUBLIC_STELLAR_* (see
 * .env.example). Each access is STATIC so Expo inlines it into the web bundle;
 * `process.env[name]` would not be inlined and would silently use the default.
 */

/** Soroban contract IDs (C… StrKeys) for a Stellar Privacy Pools deployment. */
export interface StellarContracts {
  /** Pool contract. On Stellar the pool is also the deposit entrypoint. */
  poolContractId: string;
  keystoreContractId: string;
  aspRegistryContractId: string;
  /** Immutable relay contract (relayed withdrawals). Deployed, not used by the UI yet. */
  relayContractId: string;
  /** Stellar Asset Contract for native XLM on this network. */
  nativeAssetContractId: string;
}

export interface StellarNetwork {
  networkPassphrase: string;
  /** Freighter's network name for this passphrase, for the mismatch message. */
  freighterNetworkName: string;
  /** Relayer base (/api/v1/relayer/*). The ASP is the environment's (ASP_URL, config/env.ts), as for every chain. */
  relayerUrl: string;
}

const env = (value: string | undefined, fallback: string) => value || fallback;

/** Numeric id for Stellar testnet (no native one), shared with asp-v2's STELLAR_CHAIN_ID. */
export const STELLAR_TESTNET_ID = 202;

export const STELLAR_TESTNET_CONTRACTS: StellarContracts = {
  poolContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_POOL_ID,
    'CD7MO327ZMNRWQFKPCTOOZ45LDH3EOVCEM2BYRJSGXYVG4Q2BXJ4LNXY',
  ),
  keystoreContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_KEYSTORE_ID,
    'CBCRN7ZYS5J3NCFL6CSCDZAFH7WZK3WPNXPNE3HFMRQ277AH6E5QDR3P',
  ),
  aspRegistryContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_ASP_REGISTRY_ID,
    'CAU4IZTQYTXBUTCJIGVQOPSPEUTC6G4LXFCPYQRF4VLOCQDNY3ICAOZD',
  ),
  relayContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_RELAY_ID,
    'CAL2LFF6F2GDXIEYA6VTH7BF2E2JZPSOUASBL6IGVLHVIK2RSESD42W6',
  ),
  nativeAssetContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
};

export const STELLAR_TESTNET_RPC_URL = env(
  process.env.EXPO_PUBLIC_STELLAR_RPC_URL,
  'https://soroban-testnet.stellar.org',
);

export const STELLAR_TESTNET_HORIZON_URL = env(
  process.env.EXPO_PUBLIC_STELLAR_HORIZON_URL,
  'https://horizon-testnet.stellar.org',
);

export const STELLAR_TESTNET_NETWORK: StellarNetwork = {
  networkPassphrase: 'Test SDF Network ; September 2015',
  freighterNetworkName: 'Testnet',
  // Like EXPO_PUBLIC_SUI_RELAYER_URL: the v2 relayer (packages/relayer/relayer). Without it relayed flows refuse.
  relayerUrl: process.env.EXPO_PUBLIC_STELLAR_RELAYER_URL ?? '',
};

/** The v2 relayer's id for Stellar testnet (its `chains.stellar[].id`; Stellar has no native one). */
export const STELLAR_RELAYER_CHAIN_ID = 1;

/** The relayer base URL, or a clear error when the build has none. */
export function requireStellarRelayerUrl(url: string = STELLAR_TESTNET_NETWORK.relayerUrl): string {
  if (!url) {
    throw new Error('The Stellar testnet relayer is not configured for this build (EXPO_PUBLIC_STELLAR_RELAYER_URL).');
  }
  return url;
}

/**
 * Native XLM: 7 decimals (stroops). The pool accepts 0.01 XLM; the app keeps a
 * 1 XLM floor.
 */
export const STELLAR_XLM = {
  symbol: 'XLM',
  name: 'Stellar Lumens',
  decimals: 7,
  minDeposit: 10_000_000n,
} as const;

/**
 * Circuits are the EVM set, unchanged (the Stellar verifier registers the same 27
 * verifying keys), so the artifacts already served under /artifacts are reused.
 */
export const STELLAR_ARTIFACT_BASE_URL = env(
  process.env.EXPO_PUBLIC_STELLAR_ARTIFACT_BASE_URL,
  '/artifacts',
);

/**
 * App-wide key-derivation domain for Stellar. Changing it gives every user a
 * different account, so it must never change once anyone holds notes under it.
 */
export const STELLAR_KEY_APP_IDENTIFIER = 'privacy-pools/stellar/account-seed:v1';

/**
 * Testnet relayer fee, as our relayer is configured (XLM `fee_bps: 50`):
 * 50 bps of the amount withdrawn, added on top, capped at the asset's
 * on-chain max_relay_fee (0.1 XLM on the 2026-09-30 deployment). The relayer's signed
 * quote is authoritative; this only sizes note selection and the review line.
 */
export const STELLAR_RELAYER_FEE_BPS = 50n;
export const STELLAR_MAX_RELAY_FEE = 1_000_000n;

export function estimateStellarRelayFee(amount: bigint): bigint {
  const fee = (amount * STELLAR_RELAYER_FEE_BPS) / 10_000n;
  return fee > STELLAR_MAX_RELAY_FEE ? STELLAR_MAX_RELAY_FEE : fee;
}

/**
 * The largest withdrawal amount whose amount + estimated relay fee fits in
 * `inputs` (the fee is added on top and paid from the same notes). What Max /
 * 100% offer, so they never fill an amount Review then has to refuse.
 */
export function maxStellarWithdrawForInputs(inputs: bigint): bigint {
  if (inputs <= 0n) return 0n;
  // Uncapped fee: amount * (1 + bps/10000) <= inputs.
  let best = (inputs * 10_000n) / (10_000n + STELLAR_RELAYER_FEE_BPS);
  // Capped fee: amount + MAX_FEE <= inputs, valid only where the cap binds.
  const capped = inputs - STELLAR_MAX_RELAY_FEE;
  if (capped > best && estimateStellarRelayFee(capped) === STELLAR_MAX_RELAY_FEE) best = capped;
  // Floor rounding can leave the estimate one stroop high; step down to fit.
  while (best > 0n && best + estimateStellarRelayFee(best) > inputs) best--;
  return best;
}
