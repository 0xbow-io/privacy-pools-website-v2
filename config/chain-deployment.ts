/**
 * One EVM pool deployment as the app needs to know it - PURE module (no
 * react-native imports) shared by config/staging-deployments.ts and
 * config/prod-deployments.ts, and read by config/environments.ts.
 *
 * Every field that decides where a proof binds or a request goes lives here,
 * so an environment is fully described by its list of these.
 */
export type ChainDeployment = {
  chainId: number;
  /** chains.ts route segment (lowercase). */
  name: string;
  displayName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl: string;
  explorerName: string;
  rpcUrl: string;
  /**
   * Endpoints in preference order, primary first (viem `fallback()`).
   * Optional: consumers fall back to `[rpcUrl]`, so existing fixtures and any
   * deployment that only ever had one endpoint stay valid.
   */
  rpcUrls?: string[];
  pool: string;
  keystore: string;
  aspRegistry: string;
  /**
   * AUTHORITATIVE for pinned chains: resolveEntrypointChainConfig
   * (services/entrypoint-resolution.ts) uses this address instead of the ASP
   * /entrypoints feed. The feed has served a wrong row before (the chain-10
   * row shipped with entrypoint/poolVault pointing at the wrong contracts),
   * which feed-first resolution would have turned into
   * deposits-revert-on-simulation.
   */
  entrypoint: string;
  accessRouter: string;
  /** PrivacyPoolRelay - the WITHDRAWAL proof processor. */
  relay: string;
  /**
   * RelaySwaps - the SWAP proof processor and LiFi `fromAddress`. Absent when
   * no RelaySwaps is deployed for the chain, which keeps intent swaps dark
   * there (config/intent-swaps.ts fails closed on a missing processor).
   */
  relaySwaps?: string;
  fromBlock: bigint;
  keystoreFromBlock: bigint;
  /**
   * `eth_getLogs` block-window cap for this RPC (inclusive block count).
   * Omit for the 10k that Alchemy/Infura allow. Citrea's public RPC caps at
   * 1000 and errors past it (-32602 "query exceeds max block range 1000"),
   * which broke the state-leaf scan every withdrawal runs.
   */
  logsMaxBlockRange?: bigint;
  /**
   * Hosted relayer for the deployment. The 0xbow relayer is ONE multi-chain
   * service (config `chains.evm[]`, all routes keyed by
   * /:chainType/:chainId - monorepo PR #194).
   */
  relayerBaseUrl: string;
  /**
   * The relayer's signer EOA - the on-chain caller (and therefore the proof
   * processor) for the TRANSFER route on the current relayer build. Only
   * `undefined` if a build blanks the default, in which case transfers fall
   * back to binding the relay contract - correct ONLY for a relayer build that
   * routes transfers through relay() (pre-#181).
   */
  relayerSigner?: string;
};

/** A checksummed-or-not 0x address, or undefined for anything else (zero address included). */
export function readAddress(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  // The zero address would bind an impossible proof processor - treat it as
  // unset rather than letting proofs fail after expensive proving work.
  if (/^0x0{40}$/.test(v)) return undefined;
  return v;
}
