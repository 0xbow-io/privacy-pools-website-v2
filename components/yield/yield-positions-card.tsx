import { Text, View } from 'react-native';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useSdkContext } from '@/components/sdk-provider';
import { Card } from '@/components/ui/card';
import { useNotes } from '@/hooks/use-notes';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useRedeemableYield } from '@/hooks/use-accrued-yield';
import { useResolvedYieldApy } from '@/hooks/use-yield-feeds';
import type { YieldApySource } from '@/services/yield-feeds';
import { getYieldDeploymentsForChain } from '@/config/yield';
import type { YieldDeployment } from '@/services/sdk-types';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { EthTokenIcon, TOKEN_ICONS, tokenIconKey } from '@/components/pools/pool-page-shared';
import { formatApyPercent } from '@/services/share-yield';
import { YieldPositionHint } from '@/components/yield/yield-position-hint';
import { displayTokenSymbol } from '@/services/share-display';

/**
 * Yield card (A5) — the home of the account's Aave yield position. Shows the
 * HONEST total: the redeemable underlying value of the shielded ppUSDC notes
 * via the router's ERC-4626 `previewRedeem` (principal PLUS accrued, valued
 * live). No fabricated principal/yield split — without a persisted per-note
 * cost basis we can't attribute how much of this is earned yield (see the
 * enablement checklist in config/yield.ts).
 *
 * Renders nothing unless the fail-closed resolver enables yield for the active
 * chain, and ONE CARD PER VAULT when it does: mainnet carries ppUSDC and
 * ppUSDT, and a single-deployment read made the ppUSDT position invisible
 * (codex, 2026-09-04).
 */
export function YieldPositionsCard() {
  // App-selected EVM chain — matches portfolio-provider/action-hub/pool-page,
  // which all price yield on the app's chain; the wagmi store diverges on staging.
  const chainId = useActiveEvmChain().id;
  // Yield is EVM-only; on an active Sui session the wagmi chainId is stale
  // EVM state, so don't present an EVM position there.
  const chainRouter = useChainRouter();
  // Non-EVM chain (Sui or Stellar): the EVM-only surfaces below stay off.
  const isSui = chainRouter.isSui || chainRouter.isStellar;
  const deployments = isSui ? [] : getYieldDeploymentsForChain(chainId);
  if (deployments.length === 0) return null;
  return (
    <>
      {deployments.map((deployment) => (
        <YieldPositionCard
          key={`${chainId}:${deployment.ppUSDC.toLowerCase()}`}
          chainId={chainId}
          deployment={deployment}
        />
      ))}
    </>
  );
}

/** One vault's position card. Hooks can't run in a loop, hence the split. */
function YieldPositionCard({ chainId, deployment }: { chainId: number; deployment: YieldDeployment }) {
  const { notes, isLoading: notesLoading } = useNotes();
  // useNotes stays "loading" (!isInitialized) FOREVER when no session exists —
  // disconnected viewers, and connected wallets that haven't signed in, never
  // initialize the SDK. Only a genuinely in-flight init (or a post-init note
  // hydration) is "loading"; everything else shows the opt-in empty state.
  const { isInitializing, isInitialized } = useSdkContext();
  const notesHydrating = isInitializing || (isInitialized && notesLoading);
  const { redeemableValue, hasYieldNotes, isValueLoading, isValueError } = useRedeemableYield({
    chainId,
    notes,
    // Scoped to THIS vault's share, so each card values its own position.
    asset: deployment.ppUSDC,
  });
  // Headline APY: the public ppUSDC vault-metrics feed's NET REALIZED APY when
  // it is live (asp-v2 PR #90 — dormant/404 until a yield pool is configured),
  // else the static EXPO_PUBLIC_YIELD_APY placeholder, else omitted entirely
  // (config/yield.ts policy). `source` travels with it so a real figure is
  // labelled "net APY" and never passed off as Aave's gross supply APY.
  const apy = useResolvedYieldApy({ chainId });
  const symbol = displayTokenSymbol(deployment.underlyingSymbol.toUpperCase());
  // Off the public-feed grid, never a query: a card that fetches on mount puts
  // a price request on the wire whenever the portfolio is opened.
  const price = useAllChainsPriceMap(chainId)[symbol] ?? 0;

  return (
    <YieldPositionsCardView
      symbol={symbol}
      apyLabel={deployment.apyLabel ?? 'Aave v3'}
      apyPercent={apy.percent}
      apySource={apy.source}
      // Ownership = shares alone: a dust position whose CURRENT redeemable
      // value rounds toward zero is still a position, and a pending/error
      // previewRedeem must not read as "no position".
      hasPosition={hasYieldNotes}
      notesLoading={notesHydrating}
      valueLoading={isValueLoading}
      valueUnavailable={isValueError}
      redeemableValue={redeemableValue}
      usdValue={price > 0 && !isValueLoading && !isValueError ? redeemableValue * price : null}
    />
  );
}

/**
 * Presentational half — pure props so the dev preview route can render it
 * without a live yield position. Collapsible like the other home cards.
 */
export function YieldPositionsCardView({
  symbol,
  apyLabel,
  apyPercent,
  apySource = null,
  hasPosition,
  redeemableValue,
  usdValue,
  notesLoading = false,
  valueLoading = false,
  valueUnavailable = false,
}: {
  symbol: string;
  apyLabel: string;
  /** null = APY unconfigured → the number is omitted (config/yield policy). */
  apyPercent: number | null;
  /**
   * Provenance of `apyPercent`. 'ppusdc-net-realized' = the feed's NET realized
   * APY (after the protocol yield fee) → labelled "net APY", never as the gross
   * Aave supply APY. null/'env-placeholder' = the static configured value.
   */
  apySource?: YieldApySource | null;
  hasPosition: boolean;
  redeemableValue: number;
  usdValue: number | null;
  /** Notes still hydrating — ownership unknown, don't show the opt-in copy. */
  notesLoading?: boolean;
  /** previewRedeem in flight for an owned position. */
  valueLoading?: boolean;
  /** previewRedeem failed for an owned position. */
  valueUnavailable?: boolean;
}) {
  // A lookup, not a call: the share resolves to its underlying's art via the
  // key, and the compiler lint does not read a map index as creating a
  // component during render.
  const IconComponent = TOKEN_ICONS[tokenIconKey(symbol)] ?? EthTokenIcon;

  return (
    <Card noPadding className="overflow-hidden" testID="yield-positions-card">
      <View className="flex-row items-center gap-[10px] border-b border-b-border-light p-[16px]">
        <Text className="font-pp-bold text-[16px] leading-[16px] text-text">Yield</Text>
        <View className="rounded-[4px] border border-success px-[7px] py-[2px]">
          <Text className="font-pp-semi-bold text-[10px] uppercase tracking-[0.4px] text-success">
            {apyPercent !== null
              ? `${apyLabel} · ${formatApyPercent(apyPercent)}% ${apySource === 'ppusdc-net-realized' ? 'net APY' : 'APY'}`
              : apyLabel}
          </Text>
        </View>
        <YieldPositionHint testID="portfolio-yield-position-hint" />
      </View>

      {hasPosition ? (
        <>
          <View className="flex-row items-center gap-[10px] px-[16px] py-[14px]">
            <IconComponent size={20} />
            <Text className="font-pp-semi-bold text-[12px] text-text">
              {symbol}
            </Text>
            <View className="ml-auto items-end gap-[2px]">
              {valueLoading ? (
                <Text className="font-pp-regular text-[14px] text-text-muted" testID="yield-value-loading">
                  Loading…
                </Text>
              ) : valueUnavailable ? (
                <Text className="font-pp-regular text-[14px] text-warning" testID="yield-value-unavailable">
                  Value temporarily unavailable
                </Text>
              ) : (
                <>
                  <Text className="font-pp-bold text-[14px] text-success" testID="yield-redeemable-value">
                    {redeemableValue.toLocaleString('en-US', { maximumFractionDigits: 4 })} {symbol} redeemable
                  </Text>
                  {usdValue !== null && (
                    <Text className="font-pp-regular text-[10px] text-text-muted">
                      ${usdValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </Text>
                  )}
                </>
              )}
            </View>
          </View>
          <View className="border-t border-t-border-light px-[16px] py-[10px]">
            <Text className="font-pp-regular text-[11px] text-text-muted">
              Principal + accrued yield. Accrues into your balance, nothing to claim
            </Text>
          </View>
        </>
      ) : notesLoading ? (
        // Ownership unknown while notes hydrate — never solicit an opt-in
        // a holder doesn't need.
        <Text className="font-pp-regular text-[12px] text-text-muted p-[16px]" testID="yield-notes-loading">
          Loading…
        </Text>
      ) : (
        <Text className="font-pp-regular text-[12px] text-text-muted p-[16px]">
          Opt in at deposit to earn Aave yield on {symbol}.
        </Text>
      )}
    </Card>
  );
}
