/**
 * PRODUCTION deployments - PURE module (no react-native imports).
 *
 * The production pools Artem deployed (2026-09-02), served by the prod ASP
 * (https://api-v2.0xbow.io) and the prod relayer. Sepolia and the staging
 * pools are NOT here: they stay on the dev endpoints (Artem: "Sepolia and
 * staging pools are still on dev endpoint") and live in
 * config/staging-deployments.ts. Which of the two lists the app serves is
 * decided by config/app-environment.ts, see config/environments.ts.
 *
 * Addresses cross-checked live on 2026-09-02:
 *  - entrypoint + poolVault + fromBlock match the prod ASP
 *    /global/public/entrypoints feed (pool 1 on chain 1, pool 2 on 4114,
 *    pool 3 on 56). The deployment is deterministic: the same addresses on
 *    every chain.
 *  - relay.POOL() == poolVault and relay.ENTRYPOINT() == entrypoint on all
 *    three chains (cast), MAX_BATCH() == 10, and the relay bytecode carries
 *    the same selector set as the verified staging mainnet relay (so
 *    registerAndRelay is present; identical bytecode on all three chains).
 *  - keystore / aspRegistry read off pool.keystore() / pool.aspRegistry();
 *    accessRouter off pool.ACCESS_ROUTER() (== entrypoint.ACCESS_ROUTER()).
 *  - RelaySwaps has code on chains 1 and 56 with POOL() == poolVault; it is
 *    NOT deployed on Citrea (matches the relayer's swapsSupported:false).
 *  - Entrypoint assets(): mainnet ETH/USDC/USDT, Citrea cBTC only (the
 *    USDT.e/USDC.e/ctUSD rows the relayer lists are `enabled:false` on
 *    chain), BSC BNB/USDT/FDUSD (both stables 18 decimals on BSC).
 *  - fromBlock: the feed's mainnet value (25884228) is exactly the keystore's
 *    deploy block (binary-searched via eth_getCode; the pool follows two
 *    blocks later), so the feed value is trusted as the scan floor for the
 *    other two chains too - their public RPCs are pruned and cannot answer a
 *    historical eth_getCode.
 */

import { readAddress, type ChainDeployment } from './chain-deployment';
import { alchemyHostFor, buildRpcOrder } from './rpc-order';
import type { YieldDeployment } from '@/services/sdk-types';

/** Prod ASP. Must be https: the app is served over https and a plain-http API is mixed content. */
export const PROD_ASP_URL_DEFAULT = 'https://api-v2.0xbow.io';

// The prod relayer (Artem, 2026-09-02). ONE multi-chain service: /v1/details
// lists chains 1, 4114 and 56 with the contracts pinned below; transfer quotes
// answer 201 on all three; CORS allows the Vercel preview origins.
export const PROD_RELAYER_URL =
  process.env.EXPO_PUBLIC_PROD_RELAYER_URL?.trim() || 'https://relayer-v2-prod-149184580131.us-east1.run.app';

// Same address set on every chain (deterministic deploy).
const PROD_ENTRYPOINT = '0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3';
const PROD_POOL = '0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed';
const PROD_KEYSTORE = '0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71';
const PROD_ASP_REGISTRY = '0x259C0BEa1d783c202509BD3b2688d23b8AEf58B0';
const PROD_ACCESS_ROUTER = '0x40a6bC296D87f71Ab31Ca3Bfb50513441fBD5160';
const PROD_RELAY = '0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461';
// Own override name on purpose: EXPO_PUBLIC_MAINNET_SWAP_PROCESSOR_ADDRESS
// belongs to the staging world and must never re-point a prod proof.
// 0xd0395c08… since the relayer's ppETH redeploy (daffy, 2026-09-18, chains 1
// and 56; the previous 0x5936aEfB… was verified 2026-09-02). The relayer
// publishes its RelaySwaps on /v1/details/evm/{chain}; services/relayer-details.ts
// refuses a swap before quoting when this pin and that answer disagree, which is
// what a proof bound to a stale processor otherwise becomes on chain
// (PoolVault_ProofContextMismatch).
const PROD_RELAY_SWAPS =
  readAddress(process.env.EXPO_PUBLIC_PROD_RELAY_SWAPS_ADDRESS) ?? '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8';

// The prod relayer's signer EOA per chain - the on-chain msg.sender (so the
// proof processor) for the TRANSFER route. RECOVERED on 2026-09-02 from the
// relayer's own EIP-712 fee commitments (domain "Privacy Pools Relayer" v1,
// verifyingContract = PROD_RELAY, primaryType RelayTransferCommitment):
//   chain 1    -> 0x9e2f1B23... (also the feeRecipient in commitment.data)
//   chain 4114 -> 0x9e2f1B23... (same)
//   chain 56   -> was 0x7E5F4552... (the account of private key 0x...01, a
//                 placeholder) on 2026-09-02. Ops has since configured the real
//                 key: on 2026-09-25 /v1/details reports relayerAddress
//                 0x9e2f1B23... for chain 56 too, funded and sending on BSC,
//                 while 0x7E5F... holds nothing. Keeping the placeholder pin
//                 reverted every relayed BSC transfer with
//                 PoolVault_ProofContextMismatch (QA 2026-09-25).
const PROD_RELAYER_SIGNER =
  readAddress(process.env.EXPO_PUBLIC_PROD_RELAYER_SIGNER)
  ?? '0x9e2f1B234953F46c6091636290E9035618EA3C07';

// Static member reads - Metro only inlines static process.env.EXPO_PUBLIC_*
// access in the production web export. Same endpoint policy as the staging
// module: own Alchemy key first, named override, public node last.
const ALCHEMY_KEY = process.env.EXPO_PUBLIC_ALCHEMY_KEY?.trim();

const MAINNET_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(1),
  process.env.EXPO_PUBLIC_PROD_MAINNET_RPC_URL,
  process.env.EXPO_PUBLIC_MAINNET_RPC_URL,
  'https://ethereum-rpc.publicnode.com',
);
// Citrea is not an Alchemy network; its public RPC is the only option.
const CITREA_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(4114),
  process.env.EXPO_PUBLIC_PROD_CITREA_RPC_URL,
  undefined,
  'https://rpc.mainnet.citrea.xyz',
);
// The public BSC endpoint cannot serve eth_getLogs at any range (probed
// 2026-08-27); the Alchemy key is effectively required for this chain.
const BSC_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(56),
  process.env.EXPO_PUBLIC_PROD_BSC_RPC_URL,
  undefined,
  'https://bsc-dataseed.binance.org',
);
const BSC_PROD_ON_ALCHEMY = /\.g\.alchemy\.com\//.test(BSC_PROD_RPCS[0]);

// The 2026-10-14 chains. Public fallbacks are the chains' own endpoints. Their
// eth_getLogs windows were probed the same day: mainnet.optimism.io rejects
// 50k ("Block range is too large", staging measured 3000 passing), the public
// Base endpoint rate-limits (staging uses 2000), while Alchemy on all four and
// the public Arbitrum and Robinhood endpoints answer a 50k window.
const OPTIMISM_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(10),
  process.env.EXPO_PUBLIC_PROD_OPTIMISM_RPC_URL,
  undefined,
  'https://mainnet.optimism.io',
);
const BASE_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(8453),
  process.env.EXPO_PUBLIC_PROD_BASE_RPC_URL,
  undefined,
  'https://mainnet.base.org',
);
const ARBITRUM_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(42161),
  process.env.EXPO_PUBLIC_PROD_ARBITRUM_RPC_URL,
  undefined,
  'https://arb1.arbitrum.io/rpc',
);
const ROBINHOOD_PROD_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(4663),
  process.env.EXPO_PUBLIC_PROD_ROBINHOOD_RPC_URL,
  undefined,
  'https://rpc.mainnet.chain.robinhood.com',
);
const onAlchemy = (rpcs: string[]): boolean => /\.g\.alchemy\.com\//.test(rpcs[0]);

// Alchemy serves an ADDRESS-FILTERED eth_getLogs over millions of blocks (it caps
// the response size, which rpc-log-chunking narrows around as "volume").
// Probed 2026-10-15 on the pool+keystore: Ethereum deploy..head (314k) in one
// 1.0s call, BSC 2M in 0.6s, Robinhood 870k in 0.6s. The old 10k (Ethereum)
// and 50k (BSC) windows made a fresh scan 32 calls / 51s and 169 calls / 70s.
export const ALCHEMY_LOGS_MAX_BLOCK_RANGE = 2_000_000n;


/**
 * Every prod deployment. PROD_CHAINS (below) is this list, Ethereum first;
 * EXPO_PUBLIC_DISABLED_CHAIN_IDS hides a chain per build (config/chains.ts).
 *
 * The four 2026-10-14 chains were verified on chain the same day, each value
 * read back rather than copied from the deployment screenshots:
 *  - code at every core address; relay.POOL() == pool, relay.ENTRYPOINT() ==
 *    entrypoint, MAX_BATCH() == 10, and the relay's runtime bytecode hashes
 *    the same as mainnet's and BSC's (so registerAndRelay is there);
 *  - pool.keystore() / aspRegistry() / ACCESS_ROUTER() and
 *    entrypoint.poolVault() / ACCESS_ROUTER() equal the pins;
 *  - fromBlock = the keystore's first block with code (eth_getCode binary
 *    search on an archive endpoint); the pool and entrypoint follow it;
 *  - Entrypoint AssetConfigured logs since deploy, cross-checked with
 *    assets(): see buildProdTokens in config/environments.ts.
 *  - RelaySwaps: since 2026-10-15 the prod relayer reports swapsSupported with
 *    mainnet's 0xd0395c08 on Optimism, Base and Arbitrum, so swaps run there.
 *    Robinhood Chain has none (and no LI.FI receiver), so swaps stay dark there
 *    (config/intent-swaps.ts).
 */
export const ALL_PROD_CHAINS: ChainDeployment[] = [
  {
    chainId: 1,
    name: 'ethereum',
    displayName: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://etherscan.io',
    explorerName: 'Etherscan',
    rpcUrl: MAINNET_PROD_RPCS[0],
    rpcUrls: MAINNET_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    relaySwaps: PROD_RELAY_SWAPS,
    fromBlock: 25884228n,
    keystoreFromBlock: 25884228n,
    ...(onAlchemy(MAINNET_PROD_RPCS) ? { logsMaxBlockRange: ALCHEMY_LOGS_MAX_BLOCK_RANGE } : {}),
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_MAINNET_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  {
    chainId: 4114,
    name: 'citrea',
    displayName: 'Citrea',
    nativeCurrency: { name: 'Citrea Bitcoin', symbol: 'cBTC', decimals: 18 },
    explorerUrl: 'https://explorer.mainnet.citrea.xyz',
    explorerName: 'Citrea Explorer',
    rpcUrl: CITREA_PROD_RPCS[0],
    rpcUrls: CITREA_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    // No RelaySwaps on Citrea (no code at the address; relayer says swapsSupported:false).
    fromBlock: 12093842n,
    keystoreFromBlock: 12093842n,
    logsMaxBlockRange: 1000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_CITREA_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  {
    chainId: 56,
    name: 'bsc',
    displayName: 'BNB Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    explorerUrl: 'https://bscscan.com',
    explorerName: 'BscScan',
    rpcUrl: BSC_PROD_RPCS[0],
    rpcUrls: BSC_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    relaySwaps: PROD_RELAY_SWAPS,
    fromBlock: 119401440n,
    keystoreFromBlock: 119401440n,
    logsMaxBlockRange: BSC_PROD_ON_ALCHEMY ? ALCHEMY_LOGS_MAX_BLOCK_RANGE : 1000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_BSC_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  // ---- 2026-10-14 chains, ON by default (Pat). Not yet served by the prod relayer
  // (400 on /v1/details/evm/{id}) or listed by the prod ASP on that day; a build
  // can hide one with EXPO_PUBLIC_DISABLED_CHAIN_IDS (config/chains.ts).
  // relayerSigner defaults to the signer the relayer uses on 1, 4114 and 56; it
  // could not be confirmed for these chains because the relayer does not serve
  // them yet. Check /v1/details/evm/{chain} relayerAddress before opting in and
  // set the per-chain override if it differs.
  {
    chainId: 10,
    name: 'optimism',
    displayName: 'Optimism',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerName: 'Optimism Explorer',
    rpcUrl: OPTIMISM_PROD_RPCS[0],
    rpcUrls: OPTIMISM_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    // Relayer reports swapsSupported:true here with this relaySwaps (2026-10-15).
    relaySwaps: PROD_RELAY_SWAPS,
    // keystore 158189808, pool 158189839, entrypoint 158189841.
    fromBlock: 158189808n,
    keystoreFromBlock: 158189808n,
    logsMaxBlockRange: onAlchemy(OPTIMISM_PROD_RPCS) ? ALCHEMY_LOGS_MAX_BLOCK_RANGE : 3000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_OPTIMISM_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  {
    chainId: 8453,
    name: 'base',
    displayName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://basescan.org',
    explorerName: 'BaseScan',
    rpcUrl: BASE_PROD_RPCS[0],
    rpcUrls: BASE_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    // Relayer reports swapsSupported:true here with this relaySwaps (2026-10-15).
    relaySwaps: PROD_RELAY_SWAPS,
    // keystore 52595825, pool 52595864, entrypoint 52595866.
    fromBlock: 52595825n,
    keystoreFromBlock: 52595825n,
    logsMaxBlockRange: onAlchemy(BASE_PROD_RPCS) ? ALCHEMY_LOGS_MAX_BLOCK_RANGE : 2000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_BASE_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  {
    chainId: 42161,
    name: 'arbitrum',
    displayName: 'Arbitrum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://arbiscan.io',
    explorerName: 'Arbiscan',
    rpcUrl: ARBITRUM_PROD_RPCS[0],
    rpcUrls: ARBITRUM_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    // Relayer reports swapsSupported:true here with this relaySwaps (2026-10-15).
    relaySwaps: PROD_RELAY_SWAPS,
    // keystore 514746410, pool 514746502, entrypoint 514746509.
    fromBlock: 514746410n,
    keystoreFromBlock: 514746410n,
    // 50k answered on Alchemy and on arb1.arbitrum.io (probed 2026-10-14).
    logsMaxBlockRange: onAlchemy(ARBITRUM_PROD_RPCS) ? ALCHEMY_LOGS_MAX_BLOCK_RANGE : 50_000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_ARBITRUM_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
  {
    // Robinhood Chain mainnet, chain id 4663: chainid.network (ethereum-lists)
    // lists it, and eth_chainId on rpc.mainnet.chain.robinhood.com and on
    // Alchemy's robinhood-mainnet both answer 4663 (46630 is the testnet).
    chainId: 4663,
    name: 'robinhood',
    displayName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    explorerName: 'Blockscout',
    rpcUrl: ROBINHOOD_PROD_RPCS[0],
    rpcUrls: ROBINHOOD_PROD_RPCS,
    pool: PROD_POOL,
    keystore: PROD_KEYSTORE,
    aspRegistry: PROD_ASP_REGISTRY,
    entrypoint: PROD_ENTRYPOINT,
    accessRouter: PROD_ACCESS_ROUTER,
    relay: PROD_RELAY,
    // keystore 88433690, pool 88433848, entrypoint 88433859.
    fromBlock: 88433690n,
    keystoreFromBlock: 88433690n,
    // 50k answered on Alchemy and on the chain's public RPC (probed 2026-10-14).
    logsMaxBlockRange: onAlchemy(ROBINHOOD_PROD_RPCS) ? ALCHEMY_LOGS_MAX_BLOCK_RANGE : 50_000n,
    relayerBaseUrl: PROD_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_PROD_ROBINHOOD_RELAYER_SIGNER) ?? PROD_RELAYER_SIGNER,
  },
];

// Ethereum must stay first: PROD_CHAINS[0] is the prod default chain.
export const PROD_CHAINS: ChainDeployment[] = ALL_PROD_CHAINS;

export const PROD_BY_CHAIN: Record<number, ChainDeployment> = Object.fromEntries(
  PROD_CHAINS.map((d) => [d.chainId, d]),
);

/**
 * Prod Aave-yield deployments, one per share (Artem, 2026-09-04), verified on
 * chain the same day: each router's VAULT() is its share, ENTRYPOINT() and
 * POOL_VAULT() are the prod contracts above, POOL() is Aave v3 on that chain,
 * and quote(1e18) answers. Read by config/yield.ts when
 * EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON is unset; the yield flags still gate.
 *
 * Mainnet ppUSDT joined on 2026-09-04 (Pat linked its deployment,
 * 0x08debbd6…3f00): the factory 0x8d238db4…09d8 emitted
 * (vault=ppUSDT, router=0x13a0b86b…f41C, underlying=USDT). Verified on chain
 * the same day: VAULT()=ppUSDT, ENTRYPOINT()/POOL_VAULT() are the prod
 * contracts above, POOL()=Aave v3, ZAP()=0xDC3D922d…f3A5, quote(1e18)=1000040,
 * share feeBps 2000 - the same shape and code size as the ppUSDC pair.
 */
export const ALL_PROD_YIELD_DEPLOYMENTS: Record<number, YieldDeployment[]> = {
  1: [
    {
      ppRouter: '0xe76E793d776c1e207aD7a7fa7C57d27420d85110',
      zap: '0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B',
      ppUSDC: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6',
      ppUSDCDecimals: 18,
      underlying: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      underlyingDecimals: 6,
      underlyingSymbol: 'USDC',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0x13a0b86bac3e0C29bd64fED7BCD2EE84f371f41C',
      zap: '0xDC3D922df81FC7B7f58229431ED91acB0482f3A5',
      ppUSDC: '0xA4cF419558Ef36CC6FfB666195684dC963910426',
      ppUSDCDecimals: 18,
      underlying: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      underlyingDecimals: 6,
      underlyingSymbol: 'USDT',
      apyLabel: 'Aave v3',
    },
    // ppETH — THE LAUNCH SWITCH. Paste the four addresses below in and ship;
    // nothing else in the app has to change. A native-mode entry makes the
    // mainnet ETH row stop saying "Available soon" (config/environments.ts),
    // makes the deposit modal route native ETH through the router instead of a
    // plain shield, and makes that deposit fund the router with msg.value and
    // skip the approval (services/yield-native-deposit.ts).
    //
    // {
    // FILLED IN 2026-09-15 from Artem's deployment, every field verified against
    // mainnet before it was written here (not copied from the message):
    //   NATIVE_MODE()  true          <- gate 1, the one that decides the route
    //   symbol()       "ppETH"
    //   decimals()     18            <- with WETH's 18, satisfies the 18/18 rule
    //   asset()        aEthWETH      <- same shape as ppUSDC, whose asset() is
    //                                   aEthUSDC while its `underlying` is plain
    //                                   USDC; so `underlying` here is plain WETH
    //   feeBps()       2000          <- the 20% yield cut, as ppUSDC/ppUSDT
    //   VAULT()        the share below, ZAP() the zap below (router wiring
    //                  cross-checked in both directions)
    {
      ppRouter: '0x77613D670BB9fD48A9898D0eac8ebf21B566F960',
      zap: '0x33c1eEf370bBb447414156CFc4fDABD434776EAf',
      ppUSDC: '0x66051920D25af4E3596A8a46309F4D045F9D83B7',
      ppUSDCDecimals: 18,
      underlying: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // mainnet WETH
      underlyingDecimals: 18,
      underlyingSymbol: 'WETH',
      nativeMode: true,
      apyLabel: 'Aave v3',
    },
    //
    // Three things gate it after that, all of them on their own:
    //   1. the router's NATIVE_MODE() probe (services/yield-vault-probe.ts) —
    //      an ERC-20-mode router here disables the route rather than misroutes;
    //   2. the relayer listing the ppETH share, or the note could only leave by
    //      ragequit (the deposit modal re-checks this at confirm time);
    //   3. the Entrypoint having the ppETH asset enabled.
    //
    // STATUS 2026-09-18, each checked rather than assumed:
    //   1. PASSES. NATIVE_MODE() answers true on the router above.
    //   3. PASSES. The prod ASP lists ppETH on chain 1 in
    //      /1/public/assets-stats at the share address above.
    //   2. PASSES since 2026-09-18 ~04:30Z. The relayer team redeployed prod
    //      (branch fat/deploy/added-ppETH) and /v1/details/evm/1 now lists
    //      ppETH at the share address above, next to WETH, USDC, USDT, ppUSDC
    //      and ppUSDT. The same redeploy moved relaySwaps to
    //      0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8 on chains 1 and 56 and
    //      dropped the native ETH ticker from chain 1; neither touches this
    //      route (deposits go through the router, exits through `relay`).
    //      All three gates open: this entry is the launch.
  ],
  56: [
    {
      ppRouter: '0x9929Ad2Edc2E0B5D59C3f5b2910812D0c8b84E16',
      zap: '0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766',
      ppUSDC: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2',
      ppUSDCDecimals: 18,
      underlying: '0x55d398326f99059fF775485246999027B3197955',
      underlyingDecimals: 18,
      underlyingSymbol: 'USDT',
      apyLabel: 'Aave v3',
    },
  ],
  // 2026-10-14 chains (Artem). The shares, zaps and routers come from the same
  // factories (PPYieldTokenFactory 0xe13E3A01…, PPYieldTokenZapFactory
  // 0x1B91de1f…, PPRouterFactory 0xb62A15eb…), so each has ONE address on
  // every chain that carries it. Verified on OP, Base and Arbitrum the same
  // day, per router: VAULT() is the share, ZAP() the zap, ENTRYPOINT() and
  // POOL_VAULT() the prod contracts, POOL() Aave v3 on that chain, NATIVE_MODE()
  // true only for ppETH; per share: symbol, decimals 18, feeBps 2000, asset()
  // the Aave aToken; per zap: VAULT() the share, UNDERLYING() the plain token
  // below. The routers carry mainnet's router code size (9814 bytes).
  // Robinhood Chain has no yield deployment (no factory code there).
  //
  // NOTE: the ppETH zap/router addresses here equal the BSC ppUSDT share/zap
  // above (same deployer nonces on a different chain). Every table is keyed by
  // chain, so they never meet, but never key anything by address alone.
  10: [
    {
      ppRouter: '0xaaE55aFcF94c1604C5713CD19510c5140e8Afa0e',
      zap: '0x34F9F5c4788a60eae7A8901d83E0bbe56Ab43251',
      ppUSDC: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094',
      ppUSDCDecimals: 18,
      underlying: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // native OP USDC
      underlyingDecimals: 6,
      underlyingSymbol: 'USDC',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0x19918499f1d06162A18B208cA4c97032A828dF0a',
      zap: '0x12a78A1EA6F12d2a2cF37070cF93c872BFC2Da7E',
      ppUSDC: '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C',
      ppUSDCDecimals: 18,
      underlying: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // bridged OP USDT
      underlyingDecimals: 6,
      underlyingSymbol: 'USDT',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766',
      zap: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2',
      ppUSDC: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49',
      ppUSDCDecimals: 18,
      underlying: '0x4200000000000000000000000000000000000006', // OP WETH
      underlyingDecimals: 18,
      underlyingSymbol: 'WETH',
      nativeMode: true,
      apyLabel: 'Aave v3',
    },
  ],
  8453: [
    {
      ppRouter: '0xaaE55aFcF94c1604C5713CD19510c5140e8Afa0e',
      zap: '0x34F9F5c4788a60eae7A8901d83E0bbe56Ab43251',
      ppUSDC: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094',
      ppUSDCDecimals: 18,
      underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
      underlyingDecimals: 6,
      underlyingSymbol: 'USDC',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766',
      zap: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2',
      ppUSDC: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49',
      ppUSDCDecimals: 18,
      underlying: '0x4200000000000000000000000000000000000006', // Base WETH
      underlyingDecimals: 18,
      underlyingSymbol: 'WETH',
      nativeMode: true,
      apyLabel: 'Aave v3',
    },
  ],
  42161: [
    {
      ppRouter: '0xaaE55aFcF94c1604C5713CD19510c5140e8Afa0e',
      zap: '0x34F9F5c4788a60eae7A8901d83E0bbe56Ab43251',
      ppUSDC: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094',
      ppUSDCDecimals: 18,
      underlying: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native Arbitrum USDC
      underlyingDecimals: 6,
      underlyingSymbol: 'USDC',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0x19918499f1d06162A18B208cA4c97032A828dF0a',
      zap: '0x12a78A1EA6F12d2a2cF37070cF93c872BFC2Da7E',
      ppUSDC: '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C',
      ppUSDCDecimals: 18,
      underlying: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT0
      underlyingDecimals: 6,
      underlyingSymbol: 'USDT',
      apyLabel: 'Aave v3',
    },
    {
      ppRouter: '0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766',
      zap: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2',
      ppUSDC: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49',
      ppUSDCDecimals: 18,
      underlying: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum WETH
      underlyingDecimals: 18,
      underlyingSymbol: 'WETH',
      nativeMode: true,
      apyLabel: 'Aave v3',
    },
  ],
};

/** The prod yield table (kept as its own name so tests can pin the full table). */
export const PROD_YIELD_DEPLOYMENTS: Record<number, YieldDeployment[]> = Object.fromEntries(
  Object.entries(ALL_PROD_YIELD_DEPLOYMENTS),
);
