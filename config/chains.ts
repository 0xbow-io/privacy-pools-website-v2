import {
  MAINNET_RPC_URL,
  MAINNET_RPC_URLS,
  SEPOLIA_ASP_REGISTRY_ADDRESS,
  SEPOLIA_FROM_BLOCK,
  SEPOLIA_KEYSTORE_ADDRESS,
  SEPOLIA_KEYSTORE_FROM_BLOCK,
  SEPOLIA_POOL_ADDRESS,
  SEPOLIA_RPC_URL,
  SEPOLIA_RPC_URLS,
  SUI_MAINNET_RPC_URL,
  SUI_TESTNET_RPC_URL,
  TEST_MODE,
} from '@/config/env';
// config/sui imports only config/env, so this edge introduces no cycle.
import { ACTIVE_SUI_NETWORK } from '@/config/sui';
import {
  SUI_TESTNET_CONTRACTS,
  SUI_TESTNET_GVK,
  type GlobalViewKey,
  type SuiContracts,
} from '@/config/sui-deployment';
// Pure module (reads only process.env) — no cycle.
import {
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_ID,
  STELLAR_TESTNET_NETWORK,
  STELLAR_TESTNET_RPC_URL,
  type StellarContracts,
  type StellarNetwork,
} from '@/config/stellar-deployment';
// Per-pool-era relayer routing: each hosted relayer instance serves exactly one
// pool, so the base URL must follow the selected vault (same era mapping as the
// proof-processor binding). config/relayer.ts imports only pool-profile — no cycle.
import { SEPOLIA_RELAYER_BASE_URL } from '@/config/relayer';
// The active environment (Prod or Staging, config/app-environment.ts) decides
// which EVM pool deployments register here and whether the build's base chain
// (Sepolia) and Sui are served at all. Pure module — no cycle.
import { ACTIVE_DEPLOYMENTS_BY_CHAIN, ACTIVE_ENVIRONMENT } from '@/config/environments';
// A user-configured endpoint for one chain, resolved once at module load. Pure
// module — no cycle.
import { ACTIVE_CUSTOM_RPC_OVERRIDES, activeCustomRpcUrl, hasCustomRpcOverride, queryableChainIds } from '@/config/custom-rpc';
import { resolveRuntimeStellarOptIn, runtimeStellarRequestedInUrl } from '@/services/stellar-opt-in';
import { explorerLabel } from '@/services/explorer-label';
import { windowForCustomEndpoint } from '@/services/rpc-log-chunking';

export type ChainType = 'evm' | 'sui' | 'stellar';

export interface EvmContracts {
  fromBlock: bigint;
  /**
   * Block to start scanning Keystore events from. The keystore is
   * shared across pool versions, so its first leaf can predate the
   * current pool's deploy block — falling back to `fromBlock` would
   * miss leaves registered before the V5→V6 pool migration. First
   * Sepolia keystore leaf is at block 10761919.
   */
  keystoreFromBlock: bigint;
  poolAddress: string;
  keystoreAddress: string;
  /**
   * On-chain ASPRegistry contract. The v2.0 SDK's ASPClient reads
   * `latestASPRoot` from it as the trust anchor for cross-checking
   * association-set leaves served by the ASP HTTP API.
   */
  aspRegistryAddress?: string;
}

export interface ChainConfig {
  id: number;
  chainType: ChainType;
  name: string;
  displayName: string;
  rpcUrl: string;
  /**
   * Endpoints in preference order, primary first, for callers that fail over
   * (viem `fallback()`). Always non-empty and always starts with `rpcUrl`.
   */
  rpcUrls: string[];
  explorerUrl: string;
  relayerBaseUrl: string;
  /** EVM contract addresses (only present on EVM chains). */
  contracts?: EvmContracts;
  /**
   * Largest block window this chain's RPC accepts in one `eth_getLogs`
   * call, as an inclusive block count (N ⇒ [from, from + N - 1]). Omitted ⇒
   * `DEFAULT_MAX_BLOCK_RANGE` in services/rpc-log-chunking.ts, the 10k that
   * Alchemy/Infura allow. Set it where the RPC caps tighter: past the cap
   * Citrea answers -32602 "query exceeds max block range 1000" instead of
   * truncating, which failed withdrawals outright. The sweep also shrinks
   * on a cap error it recognises, but only if the provider's wording is
   * recognisable — prefer configuring the real number here.
   */
  logsMaxBlockRange?: bigint;
  /**
   * True for test networks. Declared per-chain rather than inferred from the
   * id or the name, because "citrea" and "sepolia" both read like testnets and
   * only one is: chain 4114 is Citrea MAINNET. Protocol-wide figures use this
   * to keep testnet volume out of the headline totals — see
   * `mainnetChainIds` and hooks/use-global-statistics.ts.
   */
  isTestnet?: boolean;
  /** Sui deployed object IDs (only present on Sui chains). */
  suiContracts?: SuiContracts;
  /** Global View Key for note encryption (only present on Sui chains). */
  globalViewKey?: GlobalViewKey;
  /** Soroban contract IDs (only present on Stellar chains). */
  stellarContracts?: StellarContracts;
  /** Network passphrase + relayer endpoint (only present on Stellar chains). */
  stellarNetwork?: StellarNetwork;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

// Sui uses string-based chain IDs internally but we use numeric for uniformity
// sui:mainnet = 101, sui:testnet = 102, sui:devnet = 103
export const SUI_MAINNET_ID = 101;
export const SUI_TESTNET_ID = 102;
export const SUI_DEVNET_ID = 103;
// Stellar has no numeric chain id either; same convention, own range (defined in stellar-deployment).
export { STELLAR_TESTNET_ID };
/**
 * Stellar testnet is one more network in the selector. It shows with the debug
 * gate (?debug=1) or with its own opt-in, ?stellar=true (remembered in this
 * browser, ?stellar=false forgets it). See services/stellar-opt-in.ts.
 *
 * Only where the environment includes Stellar (staging, or a build with
 * EXPO_PUBLIC_STELLAR_ENABLED). On prod the query param is not even read, so
 * no URL can put a testnet next to the mainnet pools.
 */
export const STELLAR_OPT_IN: boolean = ACTIVE_ENVIRONMENT.includesStellar && resolveRuntimeStellarOptIn();
/** This page load came with ?stellar=true: the network selector starts on Stellar. */
export const STELLAR_SELECTED_BY_URL: boolean = STELLAR_OPT_IN && runtimeStellarRequestedInUrl();

const allChains: Record<number, ChainConfig> = {
  /*1: {
    id: 1,
    name: 'ethereum',
    displayName: 'Ethereum',
    rpcUrl: MAINNET_RPC_URL,
    rpcUrls: MAINNET_RPC_URLS,
    explorerUrl: 'https://etherscan.io',
    relayerBaseUrl: 'https://testnet-relayer.privacypools.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },*/
  11155111: {
    id: 11155111,
    chainType: 'evm',
    name: 'sepolia',
    displayName: 'Sepolia',
    isTestnet: true,
    rpcUrl: SEPOLIA_RPC_URL,
    rpcUrls: SEPOLIA_RPC_URLS,
    explorerUrl: 'https://sepolia.etherscan.io',
    relayerBaseUrl: SEPOLIA_RELAYER_BASE_URL,
    contracts: {
      // All values are env-driven (see config/env.ts → EXPO_PUBLIC_SEPOLIA_*),
      // so the client can be re-pointed at a new deployment without code edits.
      // Defaults track the internal-testing "0xbow-v1" deploy. The entrypoint
      // is resolved at runtime from the ASP /entrypoints API, not set here.
      fromBlock: SEPOLIA_FROM_BLOCK,
      keystoreFromBlock: SEPOLIA_KEYSTORE_FROM_BLOCK,
      poolAddress: SEPOLIA_POOL_ADDRESS,
      keystoreAddress: SEPOLIA_KEYSTORE_ADDRESS,
      aspRegistryAddress: SEPOLIA_ASP_REGISTRY_ADDRESS,
    },
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  },
  [SUI_TESTNET_ID]: {
    id: SUI_TESTNET_ID,
    chainType: 'sui',
    name: 'sui-testnet',
    displayName: 'Sui Testnet',
    isTestnet: true,
    rpcUrl: SUI_TESTNET_RPC_URL,
    rpcUrls: [SUI_TESTNET_RPC_URL],
    explorerUrl: 'https://testnet.suivision.xyz',
    relayerBaseUrl: '', // Direct transaction submission (no relayer needed)
    suiContracts: SUI_TESTNET_CONTRACTS,
    globalViewKey: SUI_TESTNET_GVK,
    nativeCurrency: { name: 'SUI', symbol: 'SUI', decimals: 9 },
  },
  [SUI_MAINNET_ID]: {
    id: SUI_MAINNET_ID,
    chainType: 'sui',
    name: 'sui-mainnet',
    displayName: 'Sui',
    rpcUrl: SUI_MAINNET_RPC_URL,
    rpcUrls: [SUI_MAINNET_RPC_URL],
    explorerUrl: 'https://suivision.xyz',
    relayerBaseUrl: '',
    nativeCurrency: { name: 'SUI', symbol: 'SUI', decimals: 9 },
  },
  [STELLAR_TESTNET_ID]: {
    id: STELLAR_TESTNET_ID,
    chainType: 'stellar',
    name: 'stellar-testnet',
    displayName: 'Stellar Testnet',
    isTestnet: true,
    rpcUrl: STELLAR_TESTNET_RPC_URL,
    rpcUrls: [STELLAR_TESTNET_RPC_URL],
    explorerUrl: 'https://stellar.expert/explorer/testnet',
    relayerBaseUrl: '', // Self-submitted spends for now (no Stellar relayer service yet)
    stellarContracts: STELLAR_TESTNET_CONTRACTS,
    stellarNetwork: STELLAR_TESTNET_NETWORK,
    nativeCurrency: { name: 'Stellar Lumens', symbol: 'XLM', decimals: 7 },
  },
  // 42161: { ... },
  // 8453: { ... },
  // 10: { ... },
  // 56: { ... },
};

// Environment deployments (prod pools in Prod, the whitelisted staging pools in
// Staging): whole chain entries (id, RPC, explorer, contracts, relayer) come
// from the active environment's presets, so nothing Sepolia-flavoured can leak
// into them. Each registers as a first-class EVM chain behind the selector.
{
  for (const d of ACTIVE_ENVIRONMENT.deployments) {
    allChains[d.chainId] = {
      id: d.chainId,
      chainType: 'evm',
      name: d.name,
      displayName: d.displayName,
      rpcUrl: d.rpcUrl,
      rpcUrls: d.rpcUrls ?? [d.rpcUrl],
      explorerUrl: d.explorerUrl,
      relayerBaseUrl: d.relayerBaseUrl,
      logsMaxBlockRange: d.logsMaxBlockRange,
      contracts: {
        fromBlock: d.fromBlock,
        keystoreFromBlock: d.keystoreFromBlock,
        poolAddress: d.pool,
        keystoreAddress: d.keystore,
        aspRegistryAddress: d.aspRegistry,
      },
      nativeCurrency: d.nativeCurrency,
    };
  }
}

// A user's own endpoint, if they set one (config/custom-rpc.ts). Applied LAST,
// after every preset, so it is the final word on where this chain's calls go —
// and applied here, at the one place chain records are assembled, so every
// consumer (the wagmi transports, the pool session, the on-chain note index,
// share rates, the wallet's add-chain parameters) follows without its own copy
// of the rule.
//
// EVM only, deliberately. Sui's client is built by dapp-kit from config/sui.ts
// rather than from these records, so overriding a Sui entry here would leave
// the app describing one endpoint while the Sui session used another.
const presetRpcUrls: Record<number, string[]> = {};
{
  for (const chain of Object.values(allChains)) {
    presetRpcUrls[chain.id] = [...chain.rpcUrls];
    if (chain.chainType !== 'evm') continue;
    const custom = activeCustomRpcUrl(chain.id);
    if (!custom) continue;
    // The override REPLACES our endpoints rather than leading them: see the
    // header of config/custom-rpc.ts.
    // Our Alchemy-sized window does not carry over to their endpoint.
    allChains[chain.id] = { ...chain, rpcUrl: custom, rpcUrls: [custom], logsMaxBlockRange: windowForCustomEndpoint(chain.logsMaxBlockRange) };
  }
}

/**
 * This build's OWN endpoints for a chain, ignoring any custom endpoint the user
 * set. Use it only where the endpoint leaves the app: the sole case today is
 * the `wallet_addEthereumChain` parameter set, which would otherwise hand the
 * user's private node (and often its API key) to an external wallet, and
 * through WalletConnect to its relay, to be stored there (codex, 2026-09-11).
 * Everything that makes calls FROM this app should use `rpcUrls`, so that the
 * user's choice is honoured.
 */
export function getPresetRpcUrls(chainId: number): string[] | undefined {
  const preset = presetRpcUrls[chainId];
  return preset ? [...preset] : undefined;
}

// The build's ordinary EVM chain (Sepolia on test builds). In Staging it stays
// SUPPORTED (selectable) but the first environment deployment (mainnet) is the
// DEFAULT — the deployment exists to exercise the whitelisted pools, so it
// boots there (Artem, 2026-07-31). In Prod the base chain is not served at all
// (Sepolia lives on the dev ASP) and the default is the first prod deployment.
// The environment names its base chain (staging: Sepolia); the TEST_MODE
// derivation only stands in for an environment that names none.
const baseEvmChainId = ACTIVE_ENVIRONMENT.baseEvmChainId ?? (TEST_MODE ? 11155111 : 1);
export const defaultChainId = ACTIVE_ENVIRONMENT.defaultChainId ?? ACTIVE_ENVIRONMENT.deployments[0]?.chainId ?? baseEvmChainId;
// The Sui chain this build advertises, driven by the same EXPO_PUBLIC_SUI_NETWORK
// flag as the RPC URL and the dapp-kit client, so the three can never disagree.
// Note: mainnet stays inert until SUI_MAINNET_ID carries `suiContracts` — see the
// header of config/sui.ts for the full checklist.
export const ACTIVE_SUI_CHAIN_ID =
  ACTIVE_SUI_NETWORK === 'mainnet' ? SUI_MAINNET_ID : SUI_TESTNET_ID;
// Chains this build serves. Staging: mainnet (default) + Citrea + OP + BSC +
// the ordinary chain (Sepolia) + Sui (usual debug gating), one selector. Prod:
// the prod deployments only. `EXPO_PUBLIC_DISABLED_CHAIN_IDS="11155111,102"`
// excludes chains from a deployment without code edits (the ASP serves every
// pool it knows; this list is the frontend's authority on what to surface).
// The default chain cannot be excluded.
const disabledChainIds = new Set(
  (process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isFinite(id)),
);
const enabledChainIds = [
  ...ACTIVE_ENVIRONMENT.deployments.map((d) => d.chainId),
  ...(ACTIVE_ENVIRONMENT.includesBaseChain ? [baseEvmChainId] : []),
  ...(ACTIVE_ENVIRONMENT.includesSui ? [ACTIVE_SUI_CHAIN_ID] : []),
  // STELLAR_OPT_IN implies includesStellar: it only gates selection (isChainSelectable).
  ...(ACTIVE_ENVIRONMENT.includesStellar ? [STELLAR_TESTNET_ID] : []),
];
export const supportedChainIds = [...new Set(enabledChainIds)].filter(
  (id) => id === defaultChainId || !disabledChainIds.has(id),
);

const chains = supportedChainIds.reduce<Record<number, ChainConfig>>((acc, chainId) => {
  const chain = allChains[chainId];
  if (!chain) {
    throw new Error(`Missing chain config for enabled chain ${chainId}`);
  }
  acc[chainId] = chain;
  return acc;
}, {});

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return chains[chainId];
}

/** A chain's name even when THIS environment does not serve it (receipt copy). */
export function chainDisplayNameAnyEnvironment(chainId: number): string | undefined {
  return allChains[chainId]?.displayName;
}

/**
 * Whether a chain is a test network.
 *
 * Fails CLOSED for an unknown id — an id this build has no config for is
 * treated as a testnet, so an unrecognised chain can never quietly inflate a
 * protocol-wide total. (The alternative, defaulting to "mainnet", is the
 * failure this exists to prevent.)
 */
export function isTestnetChain(chainId: number): boolean {
  const chain = allChains[chainId];
  return chain ? chain.isTestnet === true : true;
}

/**
 * The build's non-testnet chains. This is the default scope for protocol-wide
 * figures: Sepolia carries the overwhelming majority of indexed volume on a
 * test deployment, so including it made "Total value locked" read as testnet
 * play money labelled as protocol TVL.
 */
export const mainnetChainIds: number[] = supportedChainIds.filter((id) => !isTestnetChain(id));

/** Map a configured Sui chain id to its Wallet-Standard CAIP-2 id. */
function suiCaipId(chainId: number): string {
  return chainId === SUI_MAINNET_ID ? 'sui:mainnet' : 'sui:testnet';
}

/**
 * Whether a connected Sui wallet account can sign for one of the app's enabled
 * Sui networks.
 *
 * `WalletAccount.chains` is the Wallet-Standard list of chains the account
 * *supports* (a capability list) — NOT a "currently selected network". dapp-kit
 * requests the app's own configured network when signing, so the only thing we
 * can (and need to) check is whether the account is able to sign for an enabled
 * Sui chain. This therefore FAILS CLOSED: an account that doesn't advertise an
 * enabled Sui chain (mainnet-only / devnet / localnet / unknown / empty) is a
 * mismatch. Only Sui testnet is enabled today (see `supportedChainIds`).
 *
 * Single source of truth for `useMultiChainWallet`'s `networkMismatch` flag and
 * the Sui session's submit guard.
 */
export function suiAccountSupportsApp(chains: readonly string[] | undefined): boolean {
  if (!chains?.length) return false;
  const enabled = supportedChainIds
    .filter((id) => getChainConfig(id)?.chainType === 'sui')
    .map(suiCaipId);
  return enabled.some((caip) => chains.includes(caip));
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const chain = chains[chainId];
  if (!chain) return '';
  // Sui explorers (SuiVision) address transactions at /txblock/<digest>;
  // /tx/<digest> 404s there. EVM explorers and stellar.expert use /tx/<hash>
  // (stellar.expert wants the hash without the SDK's 0x prefix).
  const path = chain.chainType === 'sui' ? 'txblock' : 'tx';
  const hash = chain.chainType === 'stellar' ? txHash.replace(/^0x/, '') : txHash;
  return `${chain.explorerUrl}/${path}/${hash}`;
}

export function getExplorerAddressUrl(chainId: number, address: string): string {
  const chain = chains[chainId];
  if (!chain) return '';
  // SuiVision and stellar.expert use /account/<addr>; EVM explorers use
  // /address/<addr>. A Stellar contract id (C…) lives under /contract/.
  const path = chain.chainType === 'evm'
    ? 'address'
    : chain.chainType === 'stellar' && /^C[A-Z2-7]{55}$/.test(address) ? 'contract' : 'account';
  return `${chain.explorerUrl}/${path}/${address}`;
}

/** Human name of a chain's block explorer, for "View on X" labels. */
export function getExplorerName(chainId: number): string {
  const deployment = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
  if (deployment) return deployment.explorerName;
  const chain = chains[chainId];
  if (chain?.chainType === 'sui') return 'SuiVision';
  if (chain?.chainType === 'stellar') return 'StellarExpert';
  return explorerLabel(chainId, chain?.explorerUrl);
}

/**
 * Route path for a pool detail page. Sui gets a single, chain-clean segment
 * (`/chains/sui`) rather than the misleading `/chains/sepolia/sui`; EVM pools
 * keep `/chains/<chain>/<asset>`. The asset-driven `[chainName]/[poolAssetName]`
 * route still resolves the old two-segment URLs, so existing deep links work.
 */
export function getPoolDetailPath(symbol: string, chainId?: number): string {
  const isSui = symbol.toUpperCase() === 'SUI'
    || (chainId != null && chains[chainId]?.chainType === 'sui');
  if (isSui) return '/chains/sui';
  const isStellar = symbol.toUpperCase() === 'XLM'
    || (chainId != null && chains[chainId]?.chainType === 'stellar');
  if (isStellar) return '/chains/stellar';
  const chainName = (chainId != null ? chains[chainId]?.name : undefined)
    ?? getDefaultChainConfig().name;
  return `/chains/${chainName.toLowerCase()}/${symbol.toLowerCase()}`;
}

/** The chain the app opens on (and falls back to). */
export const homeChainId = defaultChainId;

/** Whether a chain may appear in the chain pickers: EVM always, Sui with the debug gate, Stellar with the debug gate or ?stellar=true. */
export function isChainSelectable(chainId: number, debugEnabled: boolean): boolean {
  const type = chains[chainId]?.chainType;
  if (type === 'evm') return true;
  if (type === 'stellar') return debugEnabled || STELLAR_OPT_IN;
  return debugEnabled;
}

export function getDefaultChainConfig(): ChainConfig {
  return chains[defaultChainId];
}

export function isSupportedChainId(chainId: number): boolean {
  return supportedChainIds.includes(chainId);
}

/**
 * EVM-only support set. `supportedChainIds` mixes chain TYPES (EVM + Sui) for
 * the app-level chain selector; wagmi guards and EVM SDK/payment paths must
 * not treat a numeric Sui id (e.g. 102) as a supported EVM network — an
 * EIP-155 chain with the same number would otherwise dodge the network guard
 * and hit missing-contract failures.
 */
export const supportedEvmChainIds = supportedChainIds.filter(
  (id) => chains[id]?.chainType === 'evm',
);

export function isSupportedEvmChainId(chainId: number): boolean {
  return supportedEvmChainIds.includes(chainId);
}

export function getSupportedChains(): ChainConfig[] {
  return supportedChainIds.map((id) => chains[id]).filter(Boolean);
}

export function getRelayerBaseUrl(chainId: number): string {
  const chain = chains[chainId];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }
  return chain.relayerBaseUrl;
}

export function getRelayerDetailsUrl(chainId: number, assetAddress: string): string {
  const baseUrl = getRelayerBaseUrl(chainId);
  const params = new URLSearchParams({
    chainId: String(chainId),
    assetAddress,
  });
  return `${baseUrl}/relayer/details?${params.toString()}`;
}

/**
 * The EVM chains an account-key sweep may touch.
 *
 * Thin wrapper over the pure rule in config/custom-rpc.ts, which is where the
 * reasoning and the tests live. It exists HERE so callers do not have to import
 * `@/config/custom-rpc` themselves: that module holds the endpoint URLs, which
 * carry provider API keys, and a guard test keeps its importer list to three
 * files on purpose. Chain ids are not secret; endpoints are.
 *
 * (It also keeps the pure rule testable. `bun test` cannot import this module
 * at all, because config/chains pulls react-native in, which is the same split
 * services/hub-token-catalog-rule.ts uses.)
 */
export function queryableEvmChainIds(): number[] {
  return queryableChainIds(supportedEvmChainIds, ACTIVE_CUSTOM_RPC_OVERRIDES);
}

/**
 * Whether the user pointed this chain at their own endpoint. A yes/no only, for
 * the same reason as above: the endpoint itself stays in the chain record,
 * which is what callers use to make the call.
 *
 * Thin wrapper over the pure `hasCustomRpcOverride` (config/custom-rpc.ts),
 * same split as `queryableEvmChainIds` above: the reasoning lives there so
 * `bun test` can exercise it without importing this react-native-pulling
 * module.
 */
export function usesCustomRpc(chainId: number): boolean {
  return getChainConfig(chainId)?.chainType === 'evm'
    && hasCustomRpcOverride(ACTIVE_CUSTOM_RPC_OVERRIDES, chainId);
}
