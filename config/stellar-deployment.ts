import { ARTIFACTS_BASE } from '@/config/artifacts';

/**
 * Stellar testnet deployment - single source of truth for deployed contract IDs.
 *
 * Redeployed from scratch 2026-10-29 by GAKJWKXT…XB3D (from ledger 5453276) with
 * the ceremony verifying keys, the same set as the EVM pools and /artifacts.
 * Checked on-chain 2026-10-29: native XLM is enabled (0.01 XLM minimum, 100 bps
 * fee, 0.5 XLM max relay fee); USDC and wETH are enabled too but not offered here.
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
  /** Varial's network name for this passphrase, for the mismatch message. */
  varialNetworkName: string;
  /** Relayer base (/api/v1/relayer/*). The ASP is the environment's (ASP_URL, config/env.ts), as for every chain. */
  relayerUrl: string;
}

const env = (value: string | undefined, fallback: string) => value || fallback;

/** Numeric id for Stellar testnet (no native one), shared with asp-v2's STELLAR_CHAIN_ID. */
export const STELLAR_TESTNET_ID = 202;

export const STELLAR_TESTNET_CONTRACTS: StellarContracts = {
  poolContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_POOL_ID,
    'CAEC22LQOCPYI54KVKDABDD2BEJ5FJ5RBCEGUMPBBYFK2P5TIDHMXLEO',
  ),
  keystoreContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_KEYSTORE_ID,
    'CCADEFKNONBCNZCJMEZY762CGHWEEPHC5WKXQRXJNS4EFQGPJPQQ5ZAO',
  ),
  aspRegistryContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_ASP_REGISTRY_ID,
    'CDZMJFM35EGJJOSYM5RBTRU4VYQ2CRHTTNLIWNN2BEBS2WEH2ZPNRDU4',
  ),
  relayContractId: env(
    process.env.EXPO_PUBLIC_STELLAR_RELAY_ID,
    'CD3JIC3HAIG7NANY7MSGPQZDU5I4PJ4OWZGLTZC2QWEBOPE6RVGENH7Q',
  ),
  nativeAssetContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
};

/** The deployment's first ledger (the ASP registry's creation); the SDK's event scans start there. */
export const STELLAR_TESTNET_DEPLOYMENT_LEDGER = env(process.env.EXPO_PUBLIC_STELLAR_DEPLOYMENT_LEDGER, '5453276');

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
  varialNetworkName: 'Testnet',
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
  ARTIFACTS_BASE,
);

/**
 * App-wide key-derivation domain for Stellar. Changing it gives every user a
 * different account, so it must never change once anyone holds notes under it.
 */
export const STELLAR_KEY_APP_IDENTIFIER = 'privacy-pools/stellar/account-seed:v1';

/** Native-XLM relayer policy; resource costs are read from the shared fee feed. */
export const STELLAR_RELAYER_FEE_BPS = 50n;
/** The deployed asset's on-chain maximum relay fee. */
export const STELLAR_MAX_RELAY_FEE = 5_000_000n;
