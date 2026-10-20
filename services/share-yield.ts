// Live APY for the yield-bearing pool shares (ppUSDC / ppUSDT), read on chain.
//
// WHY THIS EXISTS: the prod pools' stablecoins are ERC-4626-style wrappers over
// Aave v3 aTokens. The ASP's yield feeds (/:chainId/public/ppusdc-vault-metrics,
// ppusdc-rate-history, yield-deposits) answer 404 "not enabled on this chain"
// for every prod chain (checked 2026-09-04), and the app must never show a
// fabricated figure on prod. The chain itself has everything needed for the
// CURRENT rate:
//
//   share.asset()                        -> the Aave aToken the wrapper holds
//   share.feeBps()                       -> the protocol's cut of the yield
//   aToken.UNDERLYING_ASSET_ADDRESS()    -> USDC / USDT
//   aToken.POOL()                        -> the Aave v3 Pool
//   pool.getReserveData(underlying)      -> currentLiquidityRate (ray, per year)
//
//   gross APY = (1 + rate / SECONDS_PER_YEAR) ^ SECONDS_PER_YEAR - 1   (Aave's own formula)
//   net APY   = gross * (1 - feeBps / 10_000)                          (what the share earns)
//
// Every read is ASSET-level (a token address that is public config), never
// keyed by anything from a user's notes, so the privacy request discipline
// (docs/privacy-request-discipline.md) is untouched. History (a chart, earned
// to date) needs archive reads or the ASP feed and is deliberately NOT here.
//
// FEE MODEL (Pat, 2026-09-04): feeBps() (2000 on every prod share) IS the
// protocol's revenue on prod. That is why the prod Entrypoint charges a 0
// vetting fee: the yield cut pays for it. A chain without share tokens would
// have to fund vetting some other way (staging charges 100 bps on ETH).

import type { Address, PublicClient } from 'viem';
import { ACTIVE_ENVIRONMENT, type EnvironmentConfig, type TokenMetadata } from '@/config/environments';

const RAY = 1e27;
export const SECONDS_PER_YEAR = 31_536_000;

export const SHARE_VAULT_ABI = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export const AAVE_ATOKEN_ABI = [
  { type: 'function', name: 'UNDERLYING_ASSET_ADDRESS', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

// Aave v3 IPool.getReserveData (DataTypes.ReserveData, v3.0 layout). Newer
// pools return one more trailing field; a static tuple decodes from the head,
// so the extra word is ignored.
export const AAVE_POOL_ABI = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

export interface ShareApy {
  /** Aave supply APY for the underlying, before the wrapper's fee. Percent. */
  grossApyPercent: number;
  /** What the share actually earns after the fee. Percent. */
  netApyPercent: number;
  feeBps: number;
}

/**
 * Pure: Aave's per-second compounded supply APY, then the wrapper's net share.
 * Returns null for anything that cannot be a rate (NaN, negative, a fee of
 * 100% or more) so a caller omits the figure instead of printing nonsense.
 */
export function shareApyFromAave(input: { liquidityRateRay: bigint; feeBps: bigint }): ShareApy | null {
  if (input.liquidityRateRay < 0n || input.feeBps < 0n || input.feeBps >= 10_000n) return null;
  const apr = Number(input.liquidityRateRay) / RAY;
  if (!Number.isFinite(apr)) return null;
  const gross = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
  if (!Number.isFinite(gross) || gross < 0) return null;
  const feeBps = Number(input.feeBps);
  const net = gross * (10_000 - feeBps) / 10_000;
  return { grossApyPercent: gross * 100, netApyPercent: net * 100, feeBps };
}

export interface ShareYield extends ShareApy {
  share: Address;
  aToken: Address;
  underlying: Address;
  aavePool: Address;
}

export type ShareYieldReader = Pick<PublicClient, 'readContract'>;

/** The five asset-level reads behind a share's live APY. Throws on RPC failure. */
export async function fetchShareYield(client: ShareYieldReader, share: Address): Promise<ShareYield | null> {
  const [aToken, feeBps] = await Promise.all([
    client.readContract({ address: share, abi: SHARE_VAULT_ABI, functionName: 'asset' }),
    client.readContract({ address: share, abi: SHARE_VAULT_ABI, functionName: 'feeBps' }),
  ]);
  const [underlying, aavePool] = await Promise.all([
    client.readContract({ address: aToken, abi: AAVE_ATOKEN_ABI, functionName: 'UNDERLYING_ASSET_ADDRESS' }),
    client.readContract({ address: aToken, abi: AAVE_ATOKEN_ABI, functionName: 'POOL' }),
  ]);
  const reserve = await client.readContract({
    address: aavePool,
    abi: AAVE_POOL_ABI,
    functionName: 'getReserveData',
    args: [underlying],
  });
  const apy = shareApyFromAave({ liquidityRateRay: reserve.currentLiquidityRate, feeBps });
  if (!apy) return null;
  return { ...apy, share, aToken, underlying, aavePool };
}

/**
 * The configured share token at (chainId, address) in the ACTIVE environment,
 * or undefined. Fails closed: a token nobody flagged is a plain ERC-20 and gets
 * no APY line, whatever its symbol says.
 */
export function getYieldShareToken(
  chainId: number | undefined,
  tokenAddress: string | undefined,
  env: Pick<EnvironmentConfig, 'tokensByChain'> = ACTIVE_ENVIRONMENT,
): TokenMetadata | undefined {
  if (!chainId || !tokenAddress) return undefined;
  const token = env.tokensByChain[chainId]?.[tokenAddress.toLowerCase()];
  return token?.yieldShare ? token : undefined;
}

/** "2.88" for 2.8834; the one place the figure is rounded for display. */
export function formatApyPercent(percent: number): string {
  return percent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
