/**
 * Staging deployments — PURE module (no react-native imports).
 *
 * `EXPO_PUBLIC_STAGING=true` ADDS the whitelisted Ethereum mainnet and Citrea
 * deployments to the app's chain selector, alongside the build default
 * (Sepolia) and Sui — four chains, one url. Citrea is plain EVM, so it is not
 * behind its own flag; both entries are first-class `supportedChainIds`.
 * Unset ⇒ the normal Sepolia(+Sui) app, byte-for-byte.
 *
 * These deployments are INTERNAL: the ASP whitelists wallets server-side.
 *
 * Since the Prod/Staging switch (config/app-environment.ts) this file
 * describes the STAGING world only; the production pools live in
 * config/prod-deployments.ts and config/environments.ts picks one list.
 *
 * Addresses supplied by Artem (2026-07-30) and cross-checked live:
 *   - entrypoint + poolVault match the ASP /global/public/entrypoints feed
 *     (pool 6 on chain 1, pool 7 on chain 4114), which is how the runtime
 *     entrypoint resolution finds them;
 *   - relay.POOL() == poolVault verified on-chain for BOTH relays, so
 *     withdrawal proofs bound to the relay cannot hit
 *     PoolVault_ProofContextMismatch on that account.
 * From-blocks were binary-searched on-chain (eth_getCode) — the ASP feed says
 * fromBlock 0 for both pools, and scanning mainnet from genesis is unusable.
 */

// The relayer instance carrying the STAGING CHAINS' configs. Verified live
// (2026-07-31): /v1/details/evm/1 and /v1/details/evm/4114 both answer with
// the full asset lists (canonical mainnet USDC/USDT, Citrea cBTC), and a
// mainnet transfer quote returns a fee — chain 4114 quotes currently 500
// (server-side, reported to ops). Artem: this instance also serves the 0xbow
// V8 Sepolia deployment, so it must be used ONLY for the staging chains —
// Sepolia keeps its own era-mapped instances (config/relayer-eras.ts).
// Known caveat: this Cloud Run ingress has answered 403 from some networks
// regardless of headers (see relayer-eras.ts) — check reachability first if
// staging-chain quotes fail. Env-overridable per chain below, pending the
// final same-or-new-instance decision (daffy).
const STAGING_CHAINS_RELAYER_URL = 'https://relayer-testing.example';

/**
 * One staging pool deployment. The shape is shared with the prod list
 * (config/prod-deployments.ts); field docs live in config/chain-deployment.ts.
 * The alias keeps every existing import working.
 */
export type StagingDeployment = ChainDeployment;

// The testing relayer's signer EOA — shared by all three staging chains today.
//
// It is the on-chain `msg.sender` for the relayer's TRANSFER route: transfers are
// posted DIRECTLY from this EOA (relayer `simulateAndWriteRelayTransfer`), which
// overwrites whatever processor the client bound — unlike withdrawals, which go
// through PrivacyPoolRelay. So a relayed-transfer proof's context MUST bind THIS
// address; binding the relay contract instead reverts the transact with
// PoolVault_ProofContextMismatch after full proving, which is exactly what every
// relayed transfer on chain 10 did while this fell back to `staging.relay`.
//
// Verified 2026-08-20 by RECOVERING the address from the relayer's own EIP-712 fee
// commitments (domain "Privacy Pools Relayer" v1, chainId, verifyingContract = that
// chain's `relay`): chains 1, 4114 and 10 all recover to this EOA, and on each it
// equals the `feeRecipient` the relayer encodes into `feeCommitment.data` (its
// `fee_receiver_address` == its signer). Re-verify the same way if relayed transfers
// start reverting with ProofContextMismatch again — the relayer can rotate this key
// with no on-chain change to notice. It is pinned here only because the EVM
// `/v1/details` does not report it (the Sui relayer does, see use-sui-relay.ts);
// drop the pin once it does.
//
// Relayer-scoped value, per-chain FIELD — deliberately. The relayer resolves its
// key per chain id (`SIGNER_PRIVATE_KEY_<chainId>`, and `signer_private_key` sits
// inside each `chains.evm[]` entry), so ops can rotate one chain alone; and
// `relayerBaseUrl` is per-chain too, so two staging chains can point at different
// relayer deployments. So: EXPO_PUBLIC_STAGING_RELAYER_SIGNER moves all three at
// once, and the per-chain vars override it for the divergent case.
const STAGING_RELAYER_SIGNER =
  readAddress(process.env.EXPO_PUBLIC_STAGING_RELAYER_SIGNER)
  ?? '0x9e2f1B234953F46c6091636290E9035618EA3C07';

// Static member reads — Metro only inlines static process.env.EXPO_PUBLIC_*
// access in the production web export.
// Our own Alchemy key, read here rather than imported: this module is
// deliberately a leaf (adding a config import edge once froze an env-derived
// constant in another module and broke two unrelated golden tests), and Metro
// only inlines a STATIC process.env.EXPO_PUBLIC_* member read.
//
// Without this the staging chains fell back to public endpoints, and the OP one
// rate-limited the app: mainnet.optimism.io answered 429 to the note-discovery
// and event traffic a session makes (QA 2026-08-20). The named per-chain
// overrides still win, and the public endpoints remain the last resort for a
// build with no key.
import { alchemyHostFor, buildRpcOrder } from './rpc-order';
import { readAddress, type ChainDeployment } from './chain-deployment';
import { STAGING_MAINNET_EXPLICIT } from './staging-mainnet';

const ALCHEMY_KEY = process.env.EXPO_PUBLIC_ALCHEMY_KEY?.trim();
/**
 * Staging endpoints in PREFERENCE ORDER, primary first - same contract as
 * config/rpc-order.ts, and the Alchemy host comes from the shared map so a new
 * chain picks it up automatically. Consumers wrap the list in viem's
 * `fallback()`, so these chains now fail over instead of failing the call; they
 * previously carried a single endpoint with no standby at all.
 */
const MAINNET_STAGING_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(1),
  process.env.EXPO_PUBLIC_STAGING_MAINNET_RPC_URL,
  process.env.EXPO_PUBLIC_MAINNET_RPC_URL,
  'https://ethereum-rpc.publicnode.com',
);
const MAINNET_STAGING_RPC = MAINNET_STAGING_RPCS[0];
// Citrea is not an Alchemy network, so its public RPC is the only option.
// Citrea is absent from the Alchemy map on purpose - Alchemy does not serve it -
// so its own endpoint leads and there is no standby to add.
const CITREA_STAGING_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(4114),
  process.env.EXPO_PUBLIC_STAGING_CITREA_RPC_URL,
  undefined,
  'https://rpc.mainnet.citrea.xyz',
);
const CITREA_STAGING_RPC = CITREA_STAGING_RPCS[0];
const OPTIMISM_STAGING_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(10),
  process.env.EXPO_PUBLIC_STAGING_OPTIMISM_RPC_URL,
  undefined,
  'https://mainnet.optimism.io',
);
const OPTIMISM_STAGING_RPC = OPTIMISM_STAGING_RPCS[0];
// Base. The public endpoint caps eth_getLogs at 2000 blocks (probed
// 2026-09-24: "eth_getLogs is limited to a 2,000 range"), Alchemy base-mainnet
// returned 10k / 50k / 100k, so the window is derived from who serves it like OP.
const BASE_STAGING_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(8453),
  process.env.EXPO_PUBLIC_STAGING_BASE_RPC_URL,
  undefined,
  'https://mainnet.base.org',
);
const BASE_STAGING_RPC = BASE_STAGING_RPCS[0];
const BASE_ON_ALCHEMY = /\.g\.alchemy\.com\//.test(BASE_STAGING_RPC);
// Same kill switch shape as OP and BSC: EXPO_PUBLIC_STAGING_BASE=false drops
// Base from a staging build without touching the other chains.
const BASE_STAGING_HIDDEN =
  process.env.EXPO_PUBLIC_STAGING_BASE?.trim().toLowerCase() === 'false';

/**
 * BSC. The public endpoint is a fallback for ordinary calls ONLY: probed
 * 2026-08-27, bsc-dataseed.binance.org rejects eth_getLogs at EVERY range
 * tried, down to 50 blocks ("Request exceeds defined limit"), while Alchemy's
 * bnb-mainnet returned 3k / 10k / 50k / 100k / 500k. So a BSC build without an
 * Alchemy key can hold a session but cannot scan; the key is effectively
 * required for this chain.
 */
const BSC_STAGING_RPCS = buildRpcOrder(
  ALCHEMY_KEY,
  alchemyHostFor(56),
  process.env.EXPO_PUBLIC_STAGING_BSC_RPC_URL,
  undefined,
  'https://bsc-dataseed.binance.org',
);
const BSC_STAGING_RPC = BSC_STAGING_RPCS[0];
const BSC_ON_ALCHEMY = /\.g\.alchemy\.com\//.test(BSC_STAGING_RPC);
// Same kill switch shape as OP: EXPO_PUBLIC_STAGING_BSC=false drops BSC from a
// staging build without touching the other chains.
const BSC_STAGING_HIDDEN =
  process.env.EXPO_PUBLIC_STAGING_BSC?.trim().toLowerCase() === 'false';
// Whoever ends up serving OP decides how big an eth_getLogs window is allowed,
// including when the named override points somewhere else entirely, so the test
// is on the resolved URL and not on whether a key exists.
const OPTIMISM_ON_ALCHEMY = /\.g\.alchemy\.com\//.test(OPTIMISM_STAGING_RPC);

// OP mainnet is a TESTING deployment (Artem, 2026-08-13) and may never ship
// to prod, so it gets its own kill switch on top of the staging gate:
// EXPO_PUBLIC_STAGING_OPTIMISM=false removes it from a staging build without
// touching mainnet/Citrea. (EXPO_PUBLIC_DISABLED_CHAIN_IDS=10 works too —
// chains.ts honours it for any chain — but this flag keeps the OP decision
// legible in the env rather than buried in an ID list.)
const OPTIMISM_STAGING_HIDDEN =
  process.env.EXPO_PUBLIC_STAGING_OPTIMISM?.trim().toLowerCase() === 'false';

const ALL_STAGING_CHAINS: StagingDeployment[] = [
  {
    chainId: 1,
    name: 'ethereum',
    displayName: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://etherscan.io',
    explorerName: 'Etherscan',
    rpcUrl: MAINNET_STAGING_RPC,
    rpcUrls: MAINNET_STAGING_RPCS,
    pool: '0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52',
    keystore: '0x08806e1aD685FbF518dfa6795b90ca4c1F04Cd64',
    aspRegistry: '0x4BeCb4c0175Df3dA440A694E73Fd3c459B8dd422',
    entrypoint: '0x02a1E00294291d0E938eC92A8c2883044524ec4B',
    accessRouter: '0x641E395651bAB1195e14DfFaAe7534623B4B6973',
    relay: '0xeD30CB5e05684b0C3C6345c990576607F070A7b4',
    // RelaySwaps deployed by Daffy 2026-08-18, verified on-chain (POOL() ==
    // this vault, ENTRYPOINT() == this entrypoint). The legacy env override
    // applies to THIS (staging) deployment only; prod pins its own.
    // Redeployed by Daffy 2026-09-24 with the current RelaySwaps (ROUTING_TYPEHASH
    // matches prod 0xd0395c08; POOL()/ENTRYPOINT() match above) and published by
    // the staging relayer at /v1/details. The earlier 0x3f63…9C6E and 0x5f39…57f7
    // predate the routing layout the SDK checks, so every staging swap died at confirm.
    relaySwaps: readAddress(process.env.EXPO_PUBLIC_MAINNET_SWAP_PROCESSOR_ADDRESS) ?? '0x1aB4008b96B1791EC693304aB8855b86Fe093724',
    fromBlock: 25648399n,
    keystoreFromBlock: 25648400n,
    relayerBaseUrl: process.env.EXPO_PUBLIC_STAGING_MAINNET_RELAYER_URL?.trim() || STAGING_CHAINS_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_STAGING_MAINNET_RELAYER_SIGNER) ?? STAGING_RELAYER_SIGNER,
  },
  {
    chainId: 4114,
    name: 'citrea',
    displayName: 'Citrea',
    nativeCurrency: { name: 'Citrea Bitcoin', symbol: 'cBTC', decimals: 18 },
    explorerUrl: 'https://explorer.mainnet.citrea.xyz',
    explorerName: 'Citrea Explorer',
    rpcUrl: CITREA_STAGING_RPC,
    rpcUrls: CITREA_STAGING_RPCS,
    pool: '0x4A20b3ae656339b9707C61992dCdA642366D3004',
    keystore: '0x8240695D24746D6ED38E9a4EEF57EF78b33158f4',
    aspRegistry: '0x70b54A09e7d5fD73e56eAfe65455834F83f595A7',
    entrypoint: '0xdc3b42cBE2a967Cc5212a2E9b0986254798317f1',
    accessRouter: '0x4BeCb4c0175Df3dA440A694E73Fd3c459B8dd422',
    relay: '0x224fD8EB6b7bE6D23189CC22dd04DD7E7aCD59Fd',
    fromBlock: 10621712n,
    keystoreFromBlock: 10621667n,
    logsMaxBlockRange: 1000n,
    relayerBaseUrl: process.env.EXPO_PUBLIC_STAGING_CITREA_RELAYER_URL?.trim() || STAGING_CHAINS_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_STAGING_CITREA_RELAYER_SIGNER) ?? STAGING_RELAYER_SIGNER,
  },
  {
    // OP mainnet — the INTENTS testing deployment (addresses from Artem,
    // 2026-08-13; all cross-checked on-chain the same day: every contract has
    // code, relay.POOL() == pool, relay.ENTRYPOINT() == entrypoint, and the
    // entrypoint has ETH + native-OP USDC/USDT configured via assets()).
    //
    // Off-chain state at wiring time (server-side):
    //  - The ASP's chain-10 registration (pool 8) is WRONG: its "entrypoint"
    //    is this pool vault and its "poolVault" is an unrelated one-selector
    //    contract (0x8884dc0c…, mainnet's pool address — looks copied). Until
    //    ops re-registers it, the ASP indexes nothing for chain 10 (its
    //    /10/public/assets-stats is empty) and the runtime entrypoint feed is
    //    poisoned — which is why resolveEntrypointChainConfig PINS staging
    //    chains to these addresses instead of trusting the feed.
    //  - RESOLVED 2026-08-17: the testing relayer now carries a chainId-10
    //    config (transfer/withdraw/swap quote routes answer with schema
    //    validation, not "config not found"), and RelaySwaps is deployed
    //    (pinned in config/relayer.ts). Caveat at wiring time: the relayer's
    //    OP wallet was unfunded (quotes work; execution needs Daffy's funding).
    //  - RESOLVED 2026-08-20: the relayer's OP signer EOA is now known and
    //    pinned as STAGING_RELAYER_SIGNER (recovered from its own EIP-712 fee
    //    commitment), and that wallet now holds OP ETH. Relayed TRANSFERS used
    //    to bind the `relay` fallback here, which reverted every one of them
    //    with PoolVault_ProofContextMismatch — the relayer posts transfers
    //    straight from the signer EOA, so the relay contract is never
    //    msg.sender on that route.
    chainId: 10,
    name: 'optimism',
    displayName: 'Optimism',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerName: 'Etherscan',
    rpcUrl: OPTIMISM_STAGING_RPC,
    rpcUrls: OPTIMISM_STAGING_RPCS,
    pool: '0x02a1E00294291d0E938eC92A8c2883044524ec4B',
    keystore: '0x4BeCb4c0175Df3dA440A694E73Fd3c459B8dd422',
    aspRegistry: '0x8240695D24746D6ED38E9a4EEF57EF78b33158f4',
    entrypoint: '0x4A20b3ae656339b9707C61992dCdA642366D3004',
    accessRouter: '0x08806e1aD685FbF518dfa6795b90ca4c1F04Cd64',
    relay: '0x55DC6ADe57F3243c659cFe045F591C011924fECc',
    // RelaySwaps deployed by Daffy 2026-08-17, verified on-chain (execute
    // selector present, POOL()/ENTRYPOINT() match). The env override applies
    // to this staging deployment only.
    // Redeployed by Daffy 2026-09-24 alongside mainnet above, same checks. The
    // earlier 0x2d3B…2611 and 0x3b20…63f5 predate the routing layout.
    relaySwaps: readAddress(process.env.EXPO_PUBLIC_OPTIMISM_SWAP_PROCESSOR_ADDRESS) ?? '0x581Bc5D58597c0602f05C4f58E88418D27920980',
    // Binary-searched via eth_getCode 2026-08-13: keystore deployed at
    // 155397570, pool at 155397571 — one starting block covers both.
    fromBlock: 155397570n,
    keystoreFromBlock: 155397570n,
    // The window depends on WHO serves the endpoint, so it is derived rather
    // than pinned.
    //
    // mainnet.optimism.io rejects the default 10k window ("Block range is too
    // large", -32062; probed 2026-08-14: 3000 passes, 4000 fails). Alchemy does
    // not: probed 2026-08-20 against opt-mainnet, 3000 / 10k / 100k / 500k all
    // return. That matters beyond tidiness — this pool starts at block
    // 155397570 and OP produces a block every two seconds, so a scan spans
    // ~420k blocks, and at 3000 per request that is ~140 requests for every
    // state-leaf scan. On the public endpoint the answer was 429 (QA
    // 2026-08-20); 50k keeps us an order of magnitude inside what was measured
    // to work while cutting the request count ~17x.
    logsMaxBlockRange: OPTIMISM_ON_ALCHEMY ? 50_000n : 3000n,
    relayerBaseUrl: process.env.EXPO_PUBLIC_STAGING_OPTIMISM_RELAYER_URL?.trim() || STAGING_CHAINS_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_STAGING_OPTIMISM_RELAYER_SIGNER) ?? STAGING_RELAYER_SIGNER,
  },
  {
    // Base mainnet (staging, deployed 2026-09-24 by the same deployer as BSC,
    // 0xCfEECf99…). Artem sent only the yield contracts, so every pool address
    // was READ OFF CHAIN rather than copied:
    //  - entrypoint: ENTRYPOINT() of Artem's Base ppETH router 0xcf1af77E…
    //    (the OP router answers the known OP entrypoint the same way);
    //  - pool: entrypoint.poolVault();
    //  - keystore, aspRegistry: pool.keystore() / pool.aspRegistry() (the same
    //    reads return the pinned OP values on OP);
    //  - accessRouter: pool.ACCESS_ROUTER() == entrypoint.ACCESS_ROUTER();
    //  - relay: the deployer's only contract whose POOL() is this pool and
    //    ENTRYPOINT() this entrypoint, same bytecode size as the OP/mainnet relays.
    // Entrypoint assets(): ETH, USDC, USDT, ppETH and ppUSDC enabled.
    // RelaySwaps published by the staging relayer at /v1/details on 2026-09-24,
    // verified on-chain the same day: POOL() and ENTRYPOINT() are this pool and
    // entrypoint, ROUTING_TYPEHASH equals OP's 0x581B…0980, same bytecode size.
    chainId: 8453,
    name: 'base',
    displayName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://basescan.org',
    explorerName: 'BaseScan',
    rpcUrl: BASE_STAGING_RPC,
    rpcUrls: BASE_STAGING_RPCS,
    pool: '0x2B7bC8aF6E60f6A33b82E3098fec2EC81C2b6256',
    keystore: '0x641E395651bAB1195e14DfFaAe7534623B4B6973',
    aspRegistry: '0x08806e1aD685FbF518dfa6795b90ca4c1F04Cd64',
    entrypoint: '0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52',
    accessRouter: '0x7a6966EdcE2908DD0848e9b96964ef0D04B2A2F6',
    relay: '0xb96f13df76a13F712A372Eda0DBc8A98a886268F',
    relaySwaps: readAddress(process.env.EXPO_PUBLIC_BASE_SWAP_PROCESSOR_ADDRESS) ?? '0x1069f1B3A5BAd78A38af64A9018a4724bD8a738c',
    // Binary-searched via eth_getCode 2026-09-24: keystore at 51737314, pool
    // at 51737345. The keystore block covers both.
    fromBlock: 51737314n,
    keystoreFromBlock: 51737314n,
    logsMaxBlockRange: BASE_ON_ALCHEMY ? 50_000n : 2000n,
    relayerBaseUrl: process.env.EXPO_PUBLIC_STAGING_BASE_RELAYER_URL?.trim() || STAGING_CHAINS_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_STAGING_BASE_RELAYER_SIGNER) ?? STAGING_RELAYER_SIGNER,
  },
  {
    // BSC mainnet. Addresses supplied by Artem on
    // https://github.com/patcito/0xbow-remote/issues/13 (2026-08-27) so he can
    // run Q&A on his side. Like OP this is a TESTING deployment behind both the
    // staging gate and its own switch (EXPO_PUBLIC_STAGING_BSC=false).
    //
    // Governance differs from the other chains and is worth stating: there is no
    // Canon Guard on BSC, governance is an EOA (deployer / DEFAULT_ADMIN
    // 0xCfEECf990E0369773E24f5b70F61b388dE997827, ASP publisher
    // 0x696FE46495688fC9e99BAd2dAF2133B33de364eA).
    chainId: 56,
    name: 'bsc',
    displayName: 'BNB Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    explorerUrl: 'https://bscscan.com',
    explorerName: 'BscScan',
    rpcUrl: BSC_STAGING_RPC,
    rpcUrls: BSC_STAGING_RPCS,
    pool: '0x968950B99a92d6b96914474a318ac83ed37B3bE6',
    keystore: '0xCb037548418FAC4F4EC9273CeF16D79f9c1cb94a',
    aspRegistry: '0x15bD39eF2184d92f71545a174eCb19904820346B',
    entrypoint: '0x88b0e52636Cb19b9b00DD5c6eF9eE81bb5a2fD1F',
    accessRouter: '0x6b40E8174164037555bcCdAc0efbf29d20939F9B',
    relay: '0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52',
    // Published by the testing relayer and verified on-chain 2026-10-12:
    // POOL()/ENTRYPOINT() match this staging deployment, ROUTING_TYPEHASH
    // matches the SDK, and the LiFi router is approved. Prod pins its own.
    relaySwaps: '0xbe16948700c538D71599dB99Df604a2EA9a7e61a',
    // Artem's list carries no deployment block, so it was derived rather than
    // guessed: binary-searched via eth_getCode 2026-08-27 against Alchemy
    // bnb-mainnet, and the pool, keystore and entrypoint all appear at
    // 118420793 - one starting block covers them.
    fromBlock: 118420793n,
    keystoreFromBlock: 118420793n,
    // Derived from WHO serves the endpoint, like OP. Probed 2026-08-27:
    // Alchemy bnb-mainnet returned 3k / 10k / 50k / 100k / 500k, while the
    // public bsc-dataseed rejected eth_getLogs at EVERY range down to 50 blocks
    // ("Request exceeds defined limit"). 50_000 matches the OP precedent and
    // keeps an order of magnitude of headroom; the non-Alchemy number is a
    // formality, since that endpoint cannot serve a scan at all.
    logsMaxBlockRange: BSC_ON_ALCHEMY ? 50_000n : 1000n,
    relayerBaseUrl: process.env.EXPO_PUBLIC_STAGING_BSC_RELAYER_URL?.trim() || STAGING_CHAINS_RELAYER_URL,
    relayerSigner:
      readAddress(process.env.EXPO_PUBLIC_STAGING_BSC_RELAYER_SIGNER) ?? STAGING_RELAYER_SIGNER,
  },
];

/**
 * Staging pools on Ethereum, OP and Base mainnet: shown only in staging-mainnet
 * (?env=staging-mainnet). config/environments.ts drops them from plain staging.
 */
export const STAGING_MAINNET_ONLY_CHAIN_IDS: ReadonlySet<number> = new Set([1, 10, 8453]);

// Ethereum must stay first — STAGING_CHAINS[0] is the staging build's default
// chain (chains.ts), and that contract predates the OP entry.
export const STAGING_CHAINS: StagingDeployment[] = ALL_STAGING_CHAINS.filter(
  (d) => (d.chainId !== 10 || !OPTIMISM_STAGING_HIDDEN)
    && (d.chainId !== 56 || !BSC_STAGING_HIDDEN)
    && (d.chainId !== 8453 || !BASE_STAGING_HIDDEN),
);

// "true"/"1" enable staging. The earlier per-chain spellings ("mainnet",
// "citrea") also count as enabled so a stale env can't half-configure a
// build — there is only one staging mode now, and it carries both chains.
// `?.trim() ||` (not ??) so a set-but-empty primary var still falls through
// to the legacy one.
const rawStaging = (process.env.EXPO_PUBLIC_STAGING?.trim() || process.env.EXPO_PUBLIC_STAGING_CHAIN?.trim())
  ?.toLowerCase();
/**
 * Staging chains are ON by default (Pat, 2026-08-27), so a build carries the
 * whitelisted mainnet/Citrea/OP/BSC deployments without anyone remembering an
 * env var. `EXPO_PUBLIC_STAGING=false` (or `0`/`off`) still turns them off, and
 * the production-hostname backstop below is unchanged - it refuses to activate
 * on privacypools.com regardless of this default, which is what makes an
 * always-on default safe for the public app.
 *
 * Two consequences worth knowing, neither introduced here:
 *  - a staging build BOOTS on Ethereum mainnet (chains.ts derives defaultChainId
 *    from STAGING_CHAINS[0]), so non-production hosts now start on mainnet
 *    rather than Sepolia;
 *  - the relayer serves ONLY Sepolia (probed 2026-08-27, /v1/details lists
 *    11155111 alone), so on every staging chain a shield works while a relayed
 *    withdrawal or private transfer has nothing to post it.
 */
const stagingDisabled =
  rawStaging === 'false' || rawStaging === '0' || rawStaging === 'off' || rawStaging === 'no';
const stagingRequested = !stagingDisabled;

// Deployment-safety backstop: these are INTERNAL deployments pointing at real
// value. If the flag ever leaks into the public production project, refuse to
// activate on the production hostnames rather than silently replacing the
// Sepolia app with live mainnet/Citrea pools. (Client-side check by necessity —
// EXPO_PUBLIC_* inlining leaves no build-role signal in the bundle.)
const PUBLIC_PRODUCTION_HOSTNAMES = new Set(['v2.privacypools.com', 'privacypools.com', 'www.privacypools.com']);
const onPublicProductionHost =
  typeof window !== 'undefined' && !!window.location?.hostname
  && PUBLIC_PRODUCTION_HOSTNAMES.has(window.location.hostname);

// `?env=staging-mainnet` (config/staging-mainnet.ts) lifts the backstop for a
// tester who asks for it by URL, now or remembered. The EXPO_PUBLIC_STAGING_MAINNET
// build default never does. It only shapes the STAGING world: the prod
// environment never reads STAGING_CHAINS.
export const STAGING_ENABLED: boolean = stagingRequested && (!onPublicProductionHost || STAGING_MAINNET_EXPLICIT);

/**
 * The STAGING world's pins, whether or not staging is the active environment.
 * Runtime consumers (processor binding, entrypoint pins, "does this build
 * serve chain X") must read ACTIVE_DEPLOYMENTS_BY_CHAIN from
 * config/environments.ts instead: prod deploys different pools on the same
 * chain ids, and reading this map in a prod session would bind a proof to
 * the staging relay.
 */
export const STAGING_BY_CHAIN: Record<number, StagingDeployment> = STAGING_ENABLED
  ? Object.fromEntries(STAGING_CHAINS.map((d) => [d.chainId, d]))
  : {};
