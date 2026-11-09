/**
 * The two worlds the app can serve, fully described - PURE module (no
 * react-native imports) so bun tests can assert on both records.
 *
 * Everything that differs between prod and staging is a field on
 * `EnvironmentConfig`: ASP base URL, the EVM pool deployments (with their
 * relayer, processors, RPCs), whether the build's base chain (Sepolia) and
 * Sui are served, the token registry, the swap output tokens and the LiFi
 * coverage. The rest of the config layer reads `ACTIVE_ENVIRONMENT` and the
 * two `ACTIVE_DEPLOYMENTS*` views; nothing else should reach for a
 * per-environment constant directly.
 *
 * Entries are DUPLICATED per environment even when identical (mainnet USDC is
 * mainnet USDC in both): an environment is one closed set, and no object here
 * is shared by reference between the two records, so a screen can never hold
 * a prod token next to a staging one.
 *
 *   staging = exactly what the app was before the switch existed: the dev ASP
 *             (api-dev), Sepolia, the whitelisted staging pools (mainnet,
 *             Citrea, Optimism, BSC via EXPO_PUBLIC_STAGING) and Sui.
 *   prod    = the prod ASP (api-v2), the prod relayer, and the production
 *             pools on Ethereum, Citrea and BNB Chain. No Sepolia, no Sui.
 */

import { ACTIVE_APP_ENVIRONMENT, appEnvironmentLabel, type AppEnvironment } from './app-environment';
import type { ChainDeployment } from './chain-deployment';
import { PROD_ASP_URL_DEFAULT, PROD_CHAINS, PROD_YIELD_DEPLOYMENTS } from './prod-deployments';
import { STAGING_CHAINS, STAGING_ENABLED, STAGING_MAINNET_ONLY_CHAIN_IDS } from './staging-deployments';
import { STAGING_MAINNET_OPT_IN } from './staging-mainnet';
import { parseDepositCapUsd } from '@/services/deposit-cap';
import { YIELD_DEPOSITS_PAUSED, yieldDepositsPausedOnChain } from './yield-deposits-paused';
import type { YieldDeployment } from '@/services/sdk-types';

// Lowercased so notes deposited via this app share casing with notes
// discovered/imported from RPC (which arrive lowercase). Keeps the SDK's
// character-strict tokenId equality check happy when a wallet holds notes
// from multiple provenances.
export const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export type TokenMetadata = {
  symbol: string;
  address: string;
  decimals: number;
  isNative: boolean;
  /**
   * Set when the pool asset is itself a yield-bearing share: an ERC-4626-style
   * wrapper over an Aave v3 aToken (`asset()` is the aToken, `feeBps()` is the
   * protocol's cut of the yield, `exchangeRate()` grows). The live APY for
   * such a token is read on chain (services/share-yield.ts): the wrapper's
   * fee and Aave's current supply rate for the underlying. Asset-level reads
   * only, nothing derived from a user's notes.
   */
  yieldShare?: 'aave-v3';
  /**
   * Legacy pool asset: the Entrypoint has `enabled:false` for it, so a new
   * deposit reverts, but notes already in the pool are real and stay
   * spendable. Balances, withdraw and send must know the token (symbol,
   * decimals, price); deposit-shaped pickers must not offer it. Dropping such
   * a token from the registry instead orphaned live notes: on 2026-09-04
   * mainnet USDC rendered as "0XA0B8", 0.00001 (18 dp), $0, and could not be
   * selected for withdrawal (Matthew, 10 USDC deposited the day before).
   */
  withdrawOnly?: true;
  /**
   * Deposits for this asset are not open YET — the opposite end of
   * `withdrawOnly`, which is a pool that closed for good. Deposit-shaped
   * surfaces still SHOW it (a picker row, a pool page) but refuse to act on
   * it, and say it is coming rather than pretending it does not exist.
   * Balances, withdraw and send are untouched: notes already in the pool are
   * real and stay spendable.
   */
  depositComingSoon?: true;
  /**
   * Set together with `depositComingSoon` when the vault deposit kill switch
   * is on (config/yield-deposits-paused.ts): the asset enters a yield vault,
   * and vault deposits are paused. Every surface that already refuses a
   * coming-soon pool refuses this one; only the words differ ("Deposits
   * paused"). Withdraw, send and balances never read it.
   */
  depositPaused?: true;
};

export interface SwapTokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  isNative: boolean;
  name?: string;
}

export type TokenRegistry = Record<number, Record<string, TokenMetadata>>;

export type EnvironmentConfig = {
  id: AppEnvironment;
  /** Short user-facing name: "Prod" / "Staging". */
  label: string;
  /** ASP base URL, no trailing slash. */
  aspUrl: string;
  /**
   * Operator override for THIS ASP's X25519 note-encryption key (the SDK
   * otherwise reads /public-key live). Per environment on purpose: the dev and
   * prod ASPs serve different keys, so one shared override would encrypt note
   * data for the wrong ASP.
   */
  aspPublicKey?: string;
  /** EVM pool deployments this environment serves, default chain first. */
  deployments: ChainDeployment[];
  deploymentsByChain: Record<number, ChainDeployment>;
  /** Whether the build's base EVM chain (Sepolia) is served. */
  includesBaseChain: boolean;
  /**
   * The base EVM chain itself, when served. Named here rather than derived
   * from the build-wide TEST_MODE flag: Sepolia is a fact about the staging
   * world, not about the build (codex, 2026-09-02).
   */
  baseEvmChainId?: number;
  /**
   * The chain the app boots on. Unset: the first deployment, else the base
   * EVM chain (config/chains.ts defaultChainId).
   */
  defaultChainId?: number;
  /** Whether the Sui chain is served (debug-gated in the UI as before). */
  includesSui: boolean;
  /**
   * Whether Stellar testnet is served (debug-gated in the UI, like Sui). On in
   * staging; `EXPO_PUBLIC_STELLAR_ENABLED=true` also turns it on in the prod
   * environment, so it can be tried next to exactly what prod serves.
   */
  includesStellar: boolean;
  /** Known tokens per chain, keyed by lowercase address. */
  tokensByChain: TokenRegistry;
  /** Chain whose catalog stands in for an unknown chain id in the token helpers. */
  fallbackTokenChainId: number;
  /** Candidate swap OUTPUT tokens per destination chain. */
  swapOutputTokens: Record<number, SwapTokenInfo[]>;
  /** Chains LiFi serves among this environment's chains (cross-chain routes need both ends). */
  lifiServedChainIds: readonly number[];
  /**
   * Per-deposit USD cap the UI enforces (the ASP enforces the same on its
   * side). Prod launches at $100 (Ameen, 2026-09-03); staging has none unless
   * EXPO_PUBLIC_MAX_DEPOSIT_USD says so. Undefined = no cap.
   */
  maxDepositUsd?: number;
  /**
   * Aave-yield deployments per chain, the code default that
   * EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON overrides. Prod ships its verified routers
   * here (config/prod-deployments.ts); staging has none unless the env says so.
   */
  yieldDeployments?: Record<number, YieldDeployment[]>;
};

function normalizeBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

function native(symbol: string, decimals = 18): TokenMetadata {
  return { symbol, address: NATIVE_ASSET_ADDRESS, decimals, isNative: true };
}

function envBool(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Ethereum-mainnet ETH deposits are held shut until the ETH pool opens
 * (2026-09-05). Not `legacy()`: that asset is closed for good, this one is
 * merely not open yet, so the UI says "Available soon" instead of dropping
 * the row. Applies to chain 1 in BOTH worlds — prod and staging deploy on the
 * same real Ethereum — and only to NEW deposits: existing mainnet ETH notes
 * stay withdrawable and sendable. Set EXPO_PUBLIC_MAINNET_ETH_DEPOSITS=true
 * to open it without a code change.
 */
const MAINNET_ETH_DEPOSITS_OPEN = envBool(process.env.EXPO_PUBLIC_MAINNET_ETH_DEPOSITS);

/**
 * The ppETH route is what opens that pool: native ETH shields by going through
 * a NATIVE_MODE PPRouter, which wraps it to WETH and mints ppETH shares, so the
 * row stops being "Available soon" the moment such a route is configured for
 * chain 1 — no second switch to remember on launch day.
 *
 * Read off the environment's OWN deployment table rather than config/yield's
 * merged view on purpose: config/yield imports this module, and on prod the
 * chain-1 routers are a fixed allowlist there anyway
 * (config/prod-deployments.ts), so the table below IS the flip. A staging or
 * preview build supplying ppETH through EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON sets
 * EXPO_PUBLIC_MAINNET_ETH_DEPOSITS alongside it, which is the other half of
 * this `||`.
 *
 * This only opens the ROW. Whether a deposit actually routes into ppETH is
 * still decided per render by the master yield flags and the fail-closed
 * bytecode + NATIVE_MODE probe (services/yield-vault-probe.ts); with the route
 * configured but unverified the row is open and the deposit shields plainly,
 * which is the same conservative outcome ppUSDC has always had.
 */
export function nativeYieldRouteInTable(
  deployments: Record<number, YieldDeployment[]> | undefined,
  chainId: number,
): boolean {
  return (deployments?.[chainId] ?? []).some((d) => d.nativeMode === true);
}

/** A pool asset that will take deposits, but does not yet. */
function comingSoon(token: TokenMetadata): TokenMetadata {
  return { ...token, depositComingSoon: true };
}

/**
 * The registry with every vault ENTRY marked paused: each yield share, each
 * underlying a deployment wraps, and the native coin where a native-mode route
 * takes it. Pure, for the tests. Reads the environment's own deployment table,
 * the inventory, not the flag-gated view: a paused build must not reopen a
 * plain pool just because yield flags are off. Nothing is removed, so notes in
 * these assets stay known, priced and spendable.
 */
export function pauseVaultDeposits(
  tokens: TokenRegistry,
  deployments: Record<number, YieldDeployment[]> | undefined,
  chainPaused: (chainId: number) => boolean = () => true,
): TokenRegistry {
  const out: TokenRegistry = {};
  for (const [key, chainTokens] of Object.entries(tokens)) {
    // A chain the switch does not name keeps its registry as is.
    if (!chainPaused(Number(key))) {
      out[Number(key)] = chainTokens;
      continue;
    }
    const list = deployments?.[Number(key)] ?? [];
    const underlyings = new Set(list.map((d) => d.underlying.toLowerCase()));
    const nativeRoute = list.some((d) => d.nativeMode === true);
    out[Number(key)] = Object.fromEntries(Object.entries(chainTokens).map(([address, token]) => {
      const entersVault = !!token.yieldShare
        || underlyings.has(token.address.toLowerCase())
        || (token.isNative && nativeRoute);
      return [address, entersVault ? { ...token, depositComingSoon: true as const, depositPaused: true as const } : token];
    }));
  }
  return out;
}

/** The registry a build serves: vault entries paused on every chain the kill switch names. */
function servedTokens(tokens: TokenRegistry, deployments?: Record<number, YieldDeployment[]>): TokenRegistry {
  return YIELD_DEPOSITS_PAUSED ? pauseVaultDeposits(tokens, deployments, yieldDepositsPausedOnChain) : tokens;
}

/** Mainnet (chain 1) native ETH, deposit-gated by the flag and the ppETH route. */
export function mainnetEth(deployments?: Record<number, YieldDeployment[]>): TokenMetadata {
  const open = MAINNET_ETH_DEPOSITS_OPEN || nativeYieldRouteInTable(deployments, 1);
  return open ? native('ETH') : comingSoon(native('ETH'));
}

function erc20(symbol: string, address: string, decimals: number): [string, TokenMetadata] {
  return [address.toLowerCase(), { symbol, address, decimals, isNative: false }];
}

/** An Aave-v3-backed share token (ppUSDC / ppUSDT): an ERC-20 pool asset that also earns. */
function aaveShare(symbol: string, address: string, decimals: number): [string, TokenMetadata] {
  return [address.toLowerCase(), { symbol, address, decimals, isNative: false, yieldShare: 'aave-v3' }];
}

/** A pool asset deposits are closed for, kept so existing notes stay usable. */
function legacy(symbol: string, address: string, decimals: number): [string, TokenMetadata] {
  return [address.toLowerCase(), { symbol, address, decimals, isNative: false, withdrawOnly: true }];
}

function registry(...entries: Array<[string, TokenMetadata]>): Record<string, TokenMetadata> {
  return Object.fromEntries(entries);
}

const NATIVE_KEY = NATIVE_ASSET_ADDRESS.toLowerCase();

// ---------------------------------------------------------------------------
// Staging: today's app, unchanged.

function buildStagingTokens(): TokenRegistry {
  return {
    // BSC mainnet (staging deployment, Artem 2026-08-27). Verified on-chain the
    // same day against entrypoint 0x88b0e526...: both assets enabled, minAmount 1.
    // USDT here is EIGHTEEN decimals, not the six it has on Ethereum - Binance-Peg
    // tokens are 18. Read off the contract rather than copied from Ethereum.
    56: registry(
      [NATIVE_KEY, native('BNB')],
      erc20('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
    ),
    11155111: registry(
      [NATIVE_KEY, native('ETH')],
      erc20('USDC', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6),
      erc20('USDT', '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', 6),
    ),
    // Canonical mainnet stables: the staging deployment's ASP lists both
    // (api-dev /1/public/assets-stats).
    1: registry(
      [NATIVE_KEY, mainnetEth()],
      erc20('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
      erc20('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    ),
    // Citrea (staging deployment): native cBTC only.
    4114: registry([NATIVE_KEY, native('cBTC')]),
    // OP mainnet (intents testing deployment): the three assets configured on
    // the entrypoint (verified on-chain via assets() 2026-08-13 - native OP
    // USDC/USDT, not the bridged .e variants).
    10: registry(
      [NATIVE_KEY, native('ETH')],
      erc20('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
      erc20('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    ),
    // Base mainnet (staging, 2026-09-24): the plain assets enabled on the
    // entrypoint (assets() read on-chain), native Base USDC and Base USDT,
    // symbol and decimals read off the contracts.
    8453: registry(
      [NATIVE_KEY, native('ETH')],
      erc20('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
      erc20('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
    ),
  };
}

const NATIVE_SWAP_ADDRESS = NATIVE_ASSET_ADDRESS as `0x${string}`;

function buildStagingSwapOutputs(): Record<number, SwapTokenInfo[]> {
  return {
    // Staging BSC accepts plain BNB and USDT (18 decimals). The shared target
    // rule excludes native BNB from bridged deposits; USDT can receive them.
    56: [
      { symbol: 'BNB', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'BNB' },
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, isNative: false, name: 'Tether USD' },
    ],
    // Ethereum Sepolia (pool chain). LiFi does not serve it - quotes fail
    // closed - but the list keeps the UI honest for local/fork testing.
    11155111: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, isNative: false, name: 'USD Coin' },
      { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6, isNative: false, name: 'Tether USD' },
    ],
    // OP mainnet (staging intents deployment, 2026-08-13): the first chain in
    // the app that LiFi actually serves. The three entries mirror the assets
    // configured on the OP entrypoint (native OP USDC/USDT, verified on-chain).
    10: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, isNative: false, name: 'USD Coin' },
      { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, isNative: false, name: 'Tether USD' },
    ],
    // Base mainnet (staging, 2026-09-24): mirrors the Base entrypoint's assets.
    8453: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, isNative: false, name: 'USD Coin' },
      { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, isNative: false, name: 'Tether USD' },
    ],
    // Ethereum mainnet (staging deployment). Verified on-chain 2026-08-18
    // against the mainnet entrypoint 0x02a1E002...: all three are configured
    // assets, and the relayer prices chain-1 swap quotes.
    1: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, isNative: false, name: 'USD Coin' },
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, isNative: false, name: 'Tether USD' },
    ],
  };
}

function buildStagingEnvironment(): EnvironmentConfig {
  // EXPO_PUBLIC_STAGING=false still strips the whitelisted pools from the
  // staging world (Sepolia + Sui only), exactly as before the switch.
  // Ethereum, OP and Base mainnet pools are staging-mainnet only
  // (?env=staging-mainnet, config/staging-mainnet.ts, Pat 2026-09-27): plain
  // staging never lists them anywhere. STAGING_CHAINS itself stays whole for the
  // Node e2e scripts that read it directly.
  const deployments = STAGING_ENABLED
    ? STAGING_CHAINS.filter((d) => STAGING_MAINNET_OPT_IN || !STAGING_MAINNET_ONLY_CHAIN_IDS.has(d.chainId))
    : [];
  return {
    id: 'staging',
    // staging-mainnet boots on Ethereum (its first deployment), plain staging on Sepolia.
    defaultChainId: STAGING_MAINNET_OPT_IN ? undefined : 11155111,
    label: appEnvironmentLabel('staging'),
    maxDepositUsd: parseDepositCapUsd(process.env.EXPO_PUBLIC_MAX_DEPOSIT_USD, undefined),
    // The dev ASP. EXPO_PUBLIC_ASP_URL keeps its historical meaning: it points
    // the STAGING world somewhere else (a local ASP, a fork).
    aspUrl: normalizeBaseUrl(process.env.EXPO_PUBLIC_ASP_URL) ?? 'https://api-dev.0xbow.io',
    // Legacy names keep their historical meaning: they describe the dev ASP.
    aspPublicKey: process.env.EXPO_PUBLIC_ASP_PUBLIC_KEY?.trim() || process.env.ASP_PUBLIC_KEY?.trim() || undefined,
    deployments,
    deploymentsByChain: Object.fromEntries(deployments.map((d) => [d.chainId, d])),
    includesBaseChain: true,
    baseEvmChainId: 11155111,
    includesSui: true,
    includesStellar: true,
    tokensByChain: servedTokens(buildStagingTokens()),
    fallbackTokenChainId: 11155111,
    swapOutputTokens: buildStagingSwapOutputs(),
    // Verified against li.quest/v1/chains: of the staging chains Ethereum, OP
    // Mainnet, Base and BSC are LiFi networks (Citrea and Sepolia are not).
    // BSC supports wallet delivery and private swaps through its staging
    // RelaySwaps and plain USDT pool. Production has a separate asset catalog.
    lifiServedChainIds: [1, 10, 8453, 56],
  };
}

// ---------------------------------------------------------------------------
// Prod: the production pools on the prod ASP + relayer.

function buildProdTokens(yieldDeployments: Record<number, YieldDeployment[]>): TokenRegistry {
  // Every entry is an asset the PROD entrypoint has `enabled:true` for and
  // the prod ASP lists in /{chain}/public/assets-stats. Decimals read off the
  // contracts. Re-read on-chain 2026-09-04 (Pat: the pool stables are the
  // yield wrappers): plain USDC/USDT are `enabled:false` on the prod
  // entrypoint (a shield of them reverts), while ppUSDC / ppUSDT, the
  // ERC-4626 shares over Aave aUSDC / aUSDT (18 decimals, exchangeRate about
  // 1.0), are enabled with minAmount 10 shares and a 0 vetting fee. The ASP
  // lists exactly ETH, ppUSDC, ppUSDT on chain 1.
  // The 0 vetting fee is deliberate and TIED TO YIELD (Pat, 2026-09-04): the
  // protocol earns its 20% cut of the Aave yield through the shares' feeBps()
  // instead of taxing deposits. Staging still charges a vetting fee on ETH
  // because it has no yield. Do not "fix" either side from here.
  return {
    1: registry(
      [NATIVE_KEY, mainnetEth(yieldDeployments)],
      aaveShare('ppUSDC', '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', 18),
      aaveShare('ppUSDT', '0xA4cF419558Ef36CC6FfB666195684dC963910426', 18),
      // ppETH, deployed 2026-09-15. The launch note in prod-deployments.ts said
      // the switch was ONE entry there and nothing else; it is two, and the
      // prod-runtime test is what said so — a yield deployment whose share the
      // token registry does not know reads back yieldShare: undefined, so the
      // share would have been unpriced and unlabelled while the route itself
      // worked. Symbol and decimals read off mainnet, not copied from chat.
      aaveShare('ppETH', '0x66051920D25af4E3596A8a46309F4D045F9D83B7', 18),
      // Plain USDC / USDT took deposits until 2026-09-04 (Artem: "nuked the old
      // pools, replacing them with yield ones"); the notes are still in the
      // pool. Withdraw-only: known, priced, spendable, never offered to deposit.
      legacy('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
      legacy('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    ),
    // Citrea: native cBTC only. The relayer also lists USDT.e / USDC.e / ctUSD,
    // but the entrypoint has them disabled, so they are not depositable.
    4114: registry([NATIVE_KEY, native('cBTC')]),
    // BSC: plain USDT is `enabled:false`; ppUSDT (over Aave BSC aUSDT),
    // Binance-Peg FDUSD and United Stables U are the enabled stables, all 18
    // decimals. U (entrypoint asset since block 128602948, 2026-10-19) is a
    // plain pool like FDUSD.
    56: registry(
      [NATIVE_KEY, native('BNB')],
      aaveShare('ppUSDT', '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2', 18),
      erc20('FDUSD', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 18),
      erc20('U', '0xcE24439F2D9C6a2289F741120FE202248B666666', 18),
      // Same story as mainnet: plain USDT (18 dp on BSC) is disabled for
      // deposits but any note already in the pool must stay spendable.
      legacy('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
    ),
    // ---- 2026-10-14 chains (on by default; EXPO_PUBLIC_DISABLED_CHAIN_IDS
    // hides one per build, see config/chains.ts). Each list
    // is the entrypoint's AssetConfigured history since deploy, cross-checked
    // with assets(): the plain stables were enabled first and switched off
    // in the same deploy once their shares were configured, so they are
    // legacy (withdraw-only) here exactly like mainnet's. Native ETH is enabled
    // and routes through the ppETH NATIVE_MODE router, as on mainnet. Shares
    // are 18 decimals; underlyings' symbol and decimals read off the contracts.
    10: registry(
      [NATIVE_KEY, native('ETH')],
      aaveShare('ppUSDC', '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', 18),
      aaveShare('ppUSDT', '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C', 18),
      aaveShare('ppETH', '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', 18),
      legacy('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
      legacy('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    ),
    // Base has no ppUSDT, so plain Base USDT stays an open pool (share-less).
    8453: registry(
      [NATIVE_KEY, native('ETH')],
      aaveShare('ppUSDC', '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', 18),
      aaveShare('ppETH', '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', 18),
      erc20('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
      legacy('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    ),
    // Arbitrum: USDT is USDT0 (on-chain symbol "USD₮0"), shown as USDT.
    42161: registry(
      [NATIVE_KEY, native('ETH')],
      aaveShare('ppUSDC', '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', 18),
      aaveShare('ppUSDT', '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C', 18),
      aaveShare('ppETH', '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', 18),
      legacy('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
      legacy('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    ),
    // Robinhood Chain: no yield, so plain pools. The entrypoint enables
    // exactly ETH and USDG (Global Dollar, 6 decimals).
    4663: registry(
      [NATIVE_KEY, native('ETH')],
      erc20('USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6),
    ),
  };
}

function buildProdSwapOutputs(): Record<number, SwapTokenInfo[]> {
  // Only chains with a deployed RelaySwaps (1 and 56); the lists mirror the
  // entrypoint's enabled assets. No Citrea entry: no RelaySwaps there.
  //
  // CANDIDATES, not answers. Two different questions read this table and each
  // applies its own rule (config/intent-swaps.ts):
  //   - getSwapOutputTokens: what a CONVERSION can land in, filtered through
  //     intentTargetRefusal (the pool rule);
  //   - getSwapDeliveryTokens: what LiFi can hand to a WALLET, which is every
  //     plain asset here and never a share;
  //   - getSwapInputTokens: what a note can be spent FROM, plain assets only.
  //
  // The shares below were kept out entirely until 2026-09-21 on the reading
  // that they have no LiFi liquidity (Octavio, relayer team, 2026-09-04). That
  // holds for a swap that must DELIVER the share, and the delivery and input
  // lists still drop them for exactly that reason. It never applied to a
  // conversion landing in the share's pool: there LiFi is asked for the plain
  // underlying (or the coin, in native mode) and the PPRouter mints the share
  // as the deposit's last step, so no DEX is ever asked to fill a share. The
  // SDK encodes that substitution itself — estimateReshieldAmount,
  // prepareReshieldQuote and relayReshield all swap the output token for
  // yieldDepositFundingToken(target) before quoting — and ppv2 shipped the
  // router redeposit leg in b942f58 (2026-09-18). Without the shares listed
  // here that leg had no token to select, so mainnet offered nothing to
  // receive at all: plain ETH is refused now that ppETH is the open pool.
  //
  // Addresses are the share (`ppUSDC`) field of PROD_YIELD_DEPLOYMENTS
  // (config/prod-deployments.ts), the same values intent-targets.ts checks
  // shareRouteConfigured against, at that table's 18 decimals.
  // Still refused, by the same rules and unchanged here: a CROSS-chain
  // conversion into a share (the arriving flow carries no destination router),
  // a share as a wallet delivery, and a share as a swap input.
  return {
    1: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'ppUSDC', address: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', decimals: 18, isNative: false, name: 'USD Coin' },
      { symbol: 'ppUSDT', address: '0xA4cF419558Ef36CC6FfB666195684dC963910426', decimals: 18, isNative: false, name: 'Tether USD' },
      { symbol: 'ppETH', address: '0x66051920D25af4E3596A8a46309F4D045F9D83B7', decimals: 18, isNative: false, name: 'Ether' },
    ],
    56: [
      { symbol: 'BNB', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'BNB' },
      { symbol: 'FDUSD', address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', decimals: 18, isNative: false, name: 'First Digital USD' },
      { symbol: 'U', address: '0xcE24439F2D9C6a2289F741120FE202248B666666', decimals: 18, isNative: false, name: 'United Stables' },
      // BSC has one share deployment, over Aave BSC aUSDT, same shape as
      // mainnet's pair; plain BSC USDT is withdraw-only.
      { symbol: 'ppUSDT', address: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2', decimals: 18, isNative: false, name: 'Tether USD' },
    ],
    // 2026-10-15: the relayer serves swaps on Optimism, Base and Arbitrum (same
    // RelaySwaps as mainnet). Same shape as mainnet: the coin and the shares
    // (config above), plus Base's open plain USDT pool. Robinhood stays out:
    // no RelaySwaps and no LI.FI receiver there.
    10: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'ppUSDC', address: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', decimals: 18, isNative: false, name: 'USD Coin' },
      { symbol: 'ppUSDT', address: '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C', decimals: 18, isNative: false, name: 'Tether USD' },
      { symbol: 'ppETH', address: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', decimals: 18, isNative: false, name: 'Ether' },
    ],
    8453: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'ppUSDC', address: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', decimals: 18, isNative: false, name: 'USD Coin' },
      { symbol: 'ppETH', address: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', decimals: 18, isNative: false, name: 'Ether' },
      { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, isNative: false, name: 'Tether USD' },
    ],
    42161: [
      { symbol: 'ETH', address: NATIVE_SWAP_ADDRESS, decimals: 18, isNative: true, name: 'Ether' },
      { symbol: 'ppUSDC', address: '0x4a5B11c3898367664D94B43bE1DcEA163BB1D094', decimals: 18, isNative: false, name: 'USD Coin' },
      { symbol: 'ppUSDT', address: '0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C', decimals: 18, isNative: false, name: 'Tether USD' },
      { symbol: 'ppETH', address: '0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49', decimals: 18, isNative: false, name: 'Ether' },
    ],
  };
}

function buildProdEnvironment(): EnvironmentConfig {
  return {
    id: 'prod',
    label: appEnvironmentLabel('prod'),
    maxDepositUsd: parseDepositCapUsd(process.env.EXPO_PUBLIC_MAX_DEPOSIT_USD, 100),
    aspUrl: normalizeBaseUrl(process.env.EXPO_PUBLIC_PROD_ASP_URL) ?? PROD_ASP_URL_DEFAULT,
    aspPublicKey: process.env.EXPO_PUBLIC_PROD_ASP_PUBLIC_KEY?.trim() || undefined,
    deployments: PROD_CHAINS,
    deploymentsByChain: Object.fromEntries(PROD_CHAINS.map((d) => [d.chainId, d])),
    // Sepolia and Sui are dev-ASP worlds (Artem, 2026-09-02).
    includesBaseChain: false,
    includesSui: false,
    includesStellar: process.env.EXPO_PUBLIC_STELLAR_ENABLED === 'true',
    tokensByChain: servedTokens(buildProdTokens(PROD_YIELD_DEPLOYMENTS), PROD_YIELD_DEPLOYMENTS),
    fallbackTokenChainId: 1,
    swapOutputTokens: buildProdSwapOutputs(),
    // li.quest/v1/chains (checked 2026-10-14) lists Ethereum (1), BSC (56), OP
    // (10), Base (8453), Arbitrum (42161) and Robinhood Chain (4663); Citrea is
    // not a LiFi network. Wallet delivery needs no RelaySwaps on the destination.
    lifiServedChainIds: [1, 56, 10, 8453, 42161, 4663],
    yieldDeployments: PROD_YIELD_DEPLOYMENTS,
  };
}

export const ENVIRONMENTS: Readonly<Record<AppEnvironment, EnvironmentConfig>> = Object.freeze({
  prod: buildProdEnvironment(),
  staging: buildStagingEnvironment(),
});

/** The world this page load serves. Resolved once; see config/app-environment.ts. */
export const ACTIVE_ENVIRONMENT: EnvironmentConfig = ENVIRONMENTS[ACTIVE_APP_ENVIRONMENT];

export function getActiveEnvironment(): EnvironmentConfig {
  return ACTIVE_ENVIRONMENT;
}

/** The active environment's EVM pool deployments, default chain first. */
export const ACTIVE_DEPLOYMENTS: ChainDeployment[] = ACTIVE_ENVIRONMENT.deployments;

/**
 * Per-chain pins for the active environment. THE map every processor binding,
 * entrypoint pin and "does this build serve chain X" check must read - not
 * STAGING_BY_CHAIN, which describes the staging world regardless of which one
 * is active.
 */
export const ACTIVE_DEPLOYMENTS_BY_CHAIN: Record<number, ChainDeployment> = ACTIVE_ENVIRONMENT.deploymentsByChain;
