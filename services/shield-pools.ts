// Shield-tab pool directory + the pool-defaulting rule (pure, bun-testable).
//
// The shield widget is deposit-centric (2026-08-18 redesign): the user picks
// the token they PAY with, and the destination pool is a secondary property
// with a smart default:
//   1. a pool for the SAME token on the SAME chain (an ordinary deposit);
//   2. else the NATIVE-asset pool of the pay token's chain;
//   3. else the ETH pool on Ethereum mainnet (chain 1) when this build
//      carries it, falling back to the default chain's native pool.
//
// A yield UNDERLYING (prod USDC, USDT) is a PAY token, never a pool. The
// PPRouter wraps it in the same transaction and the note is the SHARE, so its
// destination is the share's pool: USDC lands in ppUSDC. Listing the
// underlying as a pool of its own put two "USDC" rows in the destination
// picker, one "held as ppUSDC" and one "wraps into ppUSDC", for what is a
// single place the money can go (Pat, 2026-09-05).
import { defaultChainId, getChainConfig, supportedChainIds } from '@/config/chains';
import { NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { getActionableTokens, getDepositableTokens, getKnownTokenMetadata, getTokenMetadataBySymbol, type TokenMetadata } from '@/config/tokens';
import { getConfiguredNativeYieldDeployment, getConfiguredYieldDepositDeploymentForUnderlying } from '@/config/yield';
import { isSupersededLegacyPool } from '@/config/pool-paths';
import { displayTokenSymbol } from '@/services/share-display';

export interface ShieldPool {
  chainId: number;
  chainName: string;
  symbol: string;
  address: string;
  decimals: number;
}

/**
 * The asset whose pool a token DEPOSITS INTO, pure for the tests: the share
 * for a yield underlying (whatever `depositDeploymentFor` answers), itself for
 * everything else, null for a withdraw-only asset with no router route (the
 * Entrypoint reverts those; defaultPoolFor('USDC', 1) on prod must never hand
 * the hub the closed pool - codex, 2026-09-04). An underlying whose share the
 * registry does not know is null too: no destination beats a wrong one.
 *
 * A pool that has not OPENED yet (`depositComingSoon`, mainnet ETH) is null on
 * the same grounds: it cannot receive a deposit, so it is not a destination.
 * The asset is still shown where the user picks it - the picker says
 * "Available soon" - but nothing may default into it.
 */
export function resolveDepositDestination(
  meta: TokenMetadata,
  chainId: number,
  depositDeploymentFor: (chainId: number, tokenAddress: string) => { ppUSDC: string } | undefined,
  knownMeta: (tokenAddress: string, chainId: number) => TokenMetadata | undefined,
  /// The chain's NATIVE-MODE route, if the build configures one: the native coin
  /// has no ERC-20 underlying to look a deployment up by (ppETH wraps msg.value
  /// to WETH itself), so without this ETH resolved to the plain, superseded
  /// pool and the hub pointed its destination at legacy ETH (Pat, 2026-09-18).
  nativeDeploymentFor?: (chainId: number) => { ppUSDC: string } | undefined,
): TokenMetadata | null {
  if (meta.isNative && nativeDeploymentFor) {
    const native = nativeDeploymentFor(chainId);
    if (native) return knownMeta(native.ppUSDC, chainId) ?? null;
  }
  const wrapped = depositDeploymentFor(chainId, meta.address);
  if (wrapped) return knownMeta(wrapped.ppUSDC, chainId) ?? null;
  return meta.withdrawOnly || meta.depositComingSoon ? null : meta;
}

/**
 * The reverse of resolveDepositDestination: the asset a wallet PAYS to land in
 * a pool. A yield SHARE named as the thing to deposit ("deposit into the
 * ppUSDC pool", from the pool page or a deep link) is paid as its UNDERLYING:
 * the PPRouter wraps USDC into ppUSDC inside the deposit, and no wallet holds
 * the share itself. Resolving the share literally made the deposit modal read
 * the wallet's ppUSDC balance and refuse every mainnet USDC deposit with
 * "Insufficient balance (0.0000 ppUSDC available)" (Matthew, prod,
 * 2026-09-05).
 *
 * A share is NEVER paid as itself. When its vault is not verified yet (the
 * probe is still running, or failed) or the registry does not know the
 * underlying, the answer is null and the caller refuses the open honestly,
 * because storing the share as the payment token reproduces the exact bug
 * for the life of that open: the modal re-checks validity on probe changes
 * but never re-resolves the token (codex P2 on 7421944). Anything that is
 * not a share is paid as itself.
 */
export function resolveDepositPayAsset(
  meta: TokenMetadata,
  chainId: number,
  deploymentForAsset: (chainId: number, tokenAddress: string) => { ppUSDC: string; underlying: string; nativeMode?: boolean } | undefined,
  knownMeta: (tokenAddress: string, chainId: number) => TokenMetadata | undefined,
): TokenMetadata | null {
  const deployment = deploymentForAsset(chainId, meta.address);
  const verifiedShare = !!deployment && deployment.ppUSDC.toLowerCase() === meta.address.toLowerCase();
  // A NATIVE-MODE share (ppETH) is paid with the chain's COIN, not with its
  // `underlying`: the router wraps msg.value to WETH itself, and WETH is not a
  // registry asset, so resolving it answered null and every hub / pool-page
  // ETH shield was refused as "unavailable until the vault is verified" from
  // the moment the hub started naming ppETH (codex on dd034a1, launch day).
  // The coin then takes the native yield route inside the modal.
  if (verifiedShare && deployment.nativeMode === true) return knownMeta(NATIVE_ASSET_ADDRESS, chainId) ?? null;
  if (verifiedShare) return knownMeta(deployment.underlying, chainId) ?? null;
  if (meta.yieldShare) return null;
  return meta;
}

function poolFor(chainId: number, symbol: string): ShieldPool | null {
  const chain = getChainConfig(chainId);
  if (!chain || chain.chainType !== 'evm') return null;
  const meta = getTokenMetadataBySymbol(symbol, chainId);
  if (!meta) return null;
  // Pool identity survives a disabled yield route. Never default to the
  // superseded pool (or another asset) just because execution is unavailable.
  // Deposit and conversion paths still enforce their flag/probe gates.
  const target = isSupersededLegacyPool(meta.symbol, chainId)
    ? getActionableTokens(chainId).find((token) => token.yieldShare
      && displayTokenSymbol(token.symbol).toUpperCase() === meta.symbol.toUpperCase())
    : resolveDepositDestination(meta, chainId, getConfiguredYieldDepositDeploymentForUnderlying, getKnownTokenMetadata, getConfiguredNativeYieldDeployment);
  if (!target) return null;
  return {
    chainId,
    chainName: chain.displayName ?? `Chain ${chainId}`,
    symbol: target.symbol,
    address: target.address,
    decimals: target.decimals,
  };
}

/**
 * Every EVM pool this build carries, grouped in chain order, ONE row per pool:
 * a share and its underlying both resolve to the share's pool, so the second
 * is dropped here rather than shown twice.
 */
export function listShieldPools(): ShieldPool[] {
  const out: ShieldPool[] = [];
  for (const chainId of supportedChainIds) {
    const chain = getChainConfig(chainId);
    if (!chain || chain.chainType !== 'evm') continue;
    for (const token of getDepositableTokens(chainId)) {
      const pool = poolFor(chainId, token.symbol);
      if (!pool) continue;
      const seen = out.some((p) => p.chainId === pool.chainId && p.address.toLowerCase() === pool.address.toLowerCase());
      if (!seen) out.push(pool);
    }
  }
  return out;
}

/**
 * The default destination pool for a pay token (see the rule at the top).
 * `payChainId` is the chain the pay token lives on.
 */
export function defaultPoolFor(paySymbol: string, payChainId: number): ShieldPool {
  const samePool = poolFor(payChainId, paySymbol);
  if (samePool) return samePool;
  const payChain = getChainConfig(payChainId);
  if (payChain?.chainType === 'evm') {
    const nativePool = poolFor(payChainId, payChain.nativeCurrency.symbol);
    if (nativePool) return nativePool;
  }
  // Chain not available (or carries no pools): Ethereum mainnet's ETH pool
  // when the build has it, else the default chain's native pool.
  const mainnetEth = supportedChainIds.includes(1) ? poolFor(1, 'ETH') : null;
  if (mainnetEth) return mainnetEth;
  const fallbackChain = getChainConfig(defaultChainId);
  const fallback = fallbackChain?.chainType === 'evm'
    ? poolFor(defaultChainId, fallbackChain.nativeCurrency.symbol)
    : null;
  if (fallback) return fallback;
  // Last resort: ANY pool this build carries. The rule above assumed the
  // default chain always has a native pool, which stopped being true the day
  // a native pool could be closed to deposits (mainnet ETH, `depositComingSoon`
  // - the default chain on the staging build is Ethereum). Throwing there
  // turned an ordinary "no pool for this token" into a caught exception and a
  // destination-less Shield card, so name a real pool instead.
  const anyPool = listShieldPools()[0];
  if (anyPool) return anyPool;
  // Config invariant: a build always carries at least one pool.
  throw new Error('No shield pool configured for this build.');
}

/**
 * A native-coin deposit on a chain whose build CONFIGURES a native-mode yield
 * route (mainnet ETH → ppETH) has exactly one place to go: through that router.
 * Falling back to a plain Entrypoint deposit would land the coin in the
 * superseded legacy pool, which is what this refuses. It is true while the
 * verified route is unavailable (probe pending or failed) or the yield path is
 * off, and the caller throws instead of shielding plainly.
 */
export function plainNativeDepositRefused(args: {
  isNative: boolean;
  nativeRouteConfigured: boolean;
  viaYieldRoute: boolean;
}): boolean {
  return args.isNative && args.nativeRouteConfigured && !args.viaYieldRoute;
}
