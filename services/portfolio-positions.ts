// Portfolio position aggregation (pure, node-testable).
//
// The portfolio page must present the SAME balance model as the rest of the
// app (codex P1: it previously re-aggregated raw notes, resurrected spent
// deposits from history, mixed pending into row values while excluding it
// from totals, and let ppUSDC yield shares masquerade as an 18-decimal
// phantom pool). The inputs here are therefore:
//
//  - `pools`: the CANONICAL per-token balances from pools-provider's
//    myPools (notes + association-set leaf gating + deduplicated deposit
//    events; active = leaf-confirmed spendable, pending = everything else,
//    declined events skipped, spent notes excluded) — never a second
//    reconstruction;
//  - `yieldSources`: the yield-share classification (config/yield deployments +
//    shared per-vault rates), applied BEFORE the generic
//    rows so shares are valued in underlying units at the live exchange
//    rate and presented under the underlying, not as an ordinary pool. The
//    actual share symbol is carried separately for spend actions. PLURAL
//    since mainnet carries two vaults (ppUSDC and ppUSDT): a singular source
//    filtered only the first share address, so ppUSDT notes fell through to
//    generic aggregation as an 18-decimal phantom pool — the exact bug the
//    classification exists to prevent (codex, 2026-09-04).
//
// Outputs follow the review's model: Net Value / allocation / hasPositions
// derive from ACTIVE SPENDABLE value only; pending is carried separately
// and labeled. Yield rows pass their
// canonical share identity to the existing withdrawal/redemption flow.

import { displayTokenSymbol } from '@/services/share-display';

export interface PortfolioSourcePool {
  symbol: string;
  tokenAddress: string;
  /** Chain the holding lives on — balances span chains, so rows must state it. */
  chainId?: number;
  /** Active (leaf-gated spendable) balance, whole-token units. */
  activeBalance: number;
  /** Pending (unconfirmed / leaf-pending) balance, whole-token units. */
  pendingBalance: number;
}

export interface PortfolioYieldSource {
  chainId?: number;
  /** Live conversion for one whole share; absent when the public rate is unavailable. */
  underlyingPerShare?: number;
  underlyingSymbol: string;
  /** Actual note/payout asset (for example ppUSDC). */
  shareSymbol: string;
  ppUSDCAddress: string;
  /** previewRedeem over ACTIVE shares: principal + accrued, underlying units. */
  redeemableUnderlying: number;
  /** The account holds active ppUSDC shares. */
  hasShares: boolean;
  /** Shares not yet active, in ppUSDC base units (distinct pending state). */
  pendingShares: bigint;
  ppUSDCDecimals: number;
  /** previewRedeem in flight — redeemableUnderlying means "unknown", not 0. */
  valueLoading: boolean;
  /** previewRedeem failed — value unavailable, not 0. */
  valueError: boolean;
}

export interface PortfolioPositionModel {
  tokenSymbol: string;
  tokenAddress: string;
  /** Chain of the source holding (undefined for the aggregate yield row). */
  chainId?: number;
  /** ACTIVE balance (yield rows: redeemable underlying), whole-token units. */
  activeBalance: number;
  pendingBalance: number;
  /** ACTIVE USD value — the only figure that feeds Net Value/allocation. */
  activeValueUsd: number;
  pendingValueUsd: number;
  pendingValueUnavailable?: boolean;
  isYield: boolean;
  /** Actual share-note symbol used by Withdraw/Send for a yield row. */
  shareSymbol?: string;
  /** Yield value loading/errored — USD omitted, not rendered as $0. */
  valueUnavailable: boolean;
  /** Withdrawal allowed only when canonical active funds exist. */
  withdrawEnabled: boolean;
  /** Pending yield shares in ppUSDC base units (yield rows only). */
  pendingShares?: bigint;
}

export interface PortfolioAggregation {
  positions: PortfolioPositionModel[];
  /** Sum of ACTIVE USD only (spendable + known yield value). */
  totalValueUsd: number;
  /** Sum of pending USD across every token (incl. pending-only tokens). */
  pendingValueUsd: number;
  pendingValueUnavailable: boolean;
  /** Active-spendable-only: pending-only rows do not count as spendable positions. */
  hasPositions: boolean;
}

export function buildPortfolioPositions(params: {
  pools: PortfolioSourcePool[];
  /** USD price lookup — address first, symbol fallback; chain-scoped upstream. */
  priceFor: (tokenAddress: string, symbol: string, chainId?: number) => number;
  /** Configured vault identity, qualified by the holding chain. */
  yieldSources?: PortfolioYieldSource[];
}): PortfolioAggregation {
  const { pools, priceFor, yieldSources = [] } = params;
  const matches = (pool: PortfolioSourcePool, source: PortfolioYieldSource) =>
    pool.tokenAddress.toLowerCase() === source.ppUSDCAddress.toLowerCase()
    && (source.chainId === undefined || pool.chainId === source.chainId);

  const positions: PortfolioPositionModel[] = [];
  let totalValueUsd = 0;
  let pendingValueUsd = 0;
  let pendingValueUnavailable = false;

  for (const pool of pools) {
    // Classify ppUSDC BEFORE generic aggregation (codex P1): shares are
    // valued via previewRedeem below, never via an address-prefix symbol
    // with fallback decimals and no price.
    if (yieldSources.some((source) => matches(pool, source))) continue;

    const price = priceFor(pool.tokenAddress, pool.symbol, pool.chainId);
    const activeUsd = pool.activeBalance * price;
    const pendingUsd = pool.pendingBalance * price;
    pendingValueUsd += pendingUsd;
    if (pool.activeBalance <= 0) continue; // pending-only funds are not a position
    totalValueUsd += activeUsd;
    positions.push({
      tokenSymbol: pool.symbol,
      tokenAddress: pool.tokenAddress,
      ...(pool.chainId !== undefined ? { chainId: pool.chainId } : {}),
      activeBalance: pool.activeBalance,
      pendingBalance: pool.pendingBalance,
      activeValueUsd: activeUsd,
      pendingValueUsd: pendingUsd,
      isYield: false,
      valueUnavailable: false,
      withdrawEnabled: true,
    });
  }

  // Canonical leaf-gated balances own spendability. Configured deployment
  // identity survives missing rates and foreign-chain cached holdings.
  for (const source of yieldSources) {
    const pool = pools.find((p) => matches(p, source));
    const hasActive = pool ? pool.activeBalance > 0 : source.hasShares;
    const pendingShares = pool?.pendingBalance ?? Number(source.pendingShares) / 10 ** source.ppUSDCDecimals;
    if (!hasActive && pendingShares <= 0) continue;
    const chainId = source.chainId ?? pool?.chainId;
    const rate = source.underlyingPerShare;
    const rateKnown = rate != null && Number.isFinite(rate) && rate > 0;
    const price = priceFor('', source.underlyingSymbol, chainId)
      || priceFor('', displayTokenSymbol(source.underlyingSymbol), chainId);
    const unavailable = hasActive && (source.valueLoading || source.valueError || price <= 0);
    const activeBalance = !hasActive || unavailable ? 0
      : pool && rateKnown ? pool.activeBalance * rate : source.redeemableUnderlying;
    const pendingUnknown = pendingShares > 0 && (!rateKnown || price <= 0);
    const pendingBalance = rateKnown ? pendingShares * rate : pendingShares;
    const activeUsd = activeBalance * price;
    const pendingUsd = pendingUnknown ? 0 : pendingBalance * price;
    totalValueUsd += activeUsd;
    pendingValueUsd += pendingUsd;
    pendingValueUnavailable ||= pendingUnknown;
    positions.push({
      tokenSymbol: displayTokenSymbol(source.underlyingSymbol),
      tokenAddress: source.ppUSDCAddress,
      chainId,
      activeBalance,
      pendingBalance,
      activeValueUsd: activeUsd,
      pendingValueUsd: pendingUsd,
      pendingValueUnavailable: pendingUnknown,
      isYield: true,
      shareSymbol: source.shareSymbol,
      valueUnavailable: unavailable,
      withdrawEnabled: hasActive,
      pendingShares: source.pendingShares,
    });
  }

  return {
    positions,
    totalValueUsd,
    pendingValueUsd,
    pendingValueUnavailable,
    hasPositions: positions.some((p) => p.withdrawEnabled),
  };
}
