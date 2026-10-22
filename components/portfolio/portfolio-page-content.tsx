import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { LooseShareUnwrap } from '@/components/yield/loose-share-unwrap';
import { poolDisplayLabel } from '@/config/pool-paths';
import { useMemo } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAccount } from 'wagmi';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';
import { PortfolioStats } from '@/components/portfolio/portfolio-stats';
import { AllPositions } from '@/components/portfolio/all-positions';
import { PointsCard } from '@/components/points/points-card';
import { PortfolioProvider, usePortfolio } from '@/components/portfolio-provider';
import { usePools } from '@/components/pools-provider';
import { useSdkContext } from '@/components/sdk-provider';
import { useDepositModal } from '@/components/deposit-modal-provider';
import { getChainConfig } from '@/config/chains';
import { useResolvedYieldApy } from '@/hooks/use-yield-feeds';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useWalletUnlockGate } from '@/hooks/use-wallet-unlock-gate';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';

// Token BRAND colors for the allocation bar (asset identity, not theme
// styling — same category as the chain-logo fills).
const TOKEN_BRAND_COLORS: Record<string, string> = {
  ETH: '#627EEA',
  USDC: '#2775CA',
  USDT: '#26A17B',
  DAI: '#F5AC37',
  WETH: '#EC1C79',
};

/**
 * Portfolio page shares the app header and plain theme background.
 *
 * Slots:
 *  - REAL: net/pending value + allocation (PortfolioProvider over the note
 *    set), the yield position card (previewRedeem totals + the
 *    YIELD_APY_PERCENT / apyLabel headline), and the positions table.
 *  - REAL yield earned: per row and in the tile, from the SDK's earned
 *    compute (services/yield-earned.ts, run app-wide by PoolsProvider).
 *
 * Always on for EVM chains, whether or not yield is configured: without a
 * yield deployment the page simply has no yield row.
 */
export function PortfolioPageContent() {
  const chainRouter = useChainRouter();
  // Non-EVM chain (Sui or Stellar): the EVM-only surfaces below stay off.
  const isSui = chainRouter.isSui || chainRouter.isStellar;
  // Chain scope decision: Sui still redirects (its note tokenIds would render
  // as mislabeled 18-decimal EVM assets), but any EVM chain loads the page —
  // the provider reads the ACTIVE chain's own pools, so the rows are labeled
  // correctly with or without a yield deployment; without one the yield card
  // simply doesn't render (QA 2026-08-18: Portfolio bounced back to / on
  // Optimism because it has no yield deployment).
  if (isSui) {
    return <Redirect href="/" />;
  }
  return (
    <PortfolioProvider>
      <PortfolioBody />
    </PortfolioProvider>
  );
}

function PortfolioBody() {
  const tabClearance = useTabBarClearance();
  const { isConnected } = useAccount();
  const { sessionAddress } = useSdkContext();
  const { positions, totalValue, totalValueFormatted, pendingValueFormatted, hasPositions, chainDisplayName, chainId, isLoading: portfolioLoading, yieldEarnedUsdFormatted } = usePortfolio();
  // Live APY for real yield rows (feed first, env placeholder second).
  const liveApy = useResolvedYieldApy({ chainId });
  const { data: poolsData } = usePools();
  const { openDepositModal } = useDepositModal();
  // Connected but not signed in: the notes are not decrypted, so every figure
  // below would be a FALSE zero (Nathaniel, QA 2026-10-12: $0 and "No
  // positions yet" over real deposits). Same gate and action as My balances.
  const { requiresWalletUnlock, keyInitFailed, retryKeyInit } = useWalletUnlockGate();
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const signedOut = requiresWalletUnlock || keyInitFailed;

  // Allocation over ACTIVE spendable USD only — rows and totals share the
  // same numerator/denominator, so the bar can never exceed 100% (codex P1).
  const portfolioAssets = useMemo(() => {
    if (!hasPositions || totalValue === 0) return [];
    return positions.map((p) => {
      // The drawn weight and the quoted share are the SAME number: a segment
      // that names a percentage the bar was not drawn at is worse than one
      // that names nothing (Nathaniel, QA 2026-09-21: the bar identified none
      // of its segments at all).
      const percentage = Math.max(1, Math.round((p.valueUsd / totalValue) * 100));
      return {
        color: TOKEN_BRAND_COLORS[p.tokenSymbol] || '#999999',
        percentage,
        label: `${p.tokenSymbol} ${percentage}% of net value`,
      };
    });
  }, [positions, totalValue, hasPositions]);

  const mappedPositions = useMemo(
    () => {
      const rows: Array<{
        id: string;
        poolName: string;
        canonicalPoolSymbol?: string;
        chainName: string;
        chainId: number;
        myValueToken: string;
        myValueUsd: string;
        pendingLabel: string | null;
        earnedText?: string | null;
        venueLabel?: string | null;
        aprText?: string | null;
        withdrawEnabled: boolean;
        /** Exact pool/note symbol actions must spend, e.g. ppUSDC. */
        actionSymbol?: string;
        shareAddress?: string;
        privacyScore: number;
      }> = positions.map((p, i) => {
        // Match the pool row on the position's OWN chain: allPools spans chains
        // and a symbol can exist on several.
        const rowChainId = p.chainId ?? chainId;
        const poolEntry = poolsData.allPools.find(
          (pool) => pool.tokenAddress.toLowerCase() === p.tokenAddress.toLowerCase() && pool.chainId === rowChainId,
        );
        return {
          id: `${rowChainId}:${i + 1}`,
          poolName: poolDisplayLabel(p.shareSymbol ?? p.tokenSymbol, rowChainId),
          canonicalPoolSymbol: p.shareSymbol ?? p.tokenSymbol,
          // The position's own chain — every row used to be labeled with the
          // ACTIVE chain, so a Citrea holding read as Ethereum (qwen3.8 review).
          chainName: getChainConfig(rowChainId)?.displayName ?? chainDisplayName,
          chainId: rowChainId,
          myValueToken: p.valueUnavailable
            ? 'Value temporarily unavailable'
            : `${p.balanceFormatted} ${p.tokenSymbol}`,
          myValueUsd: p.valueUnavailable ? '—' : p.valueUsdFormatted,
          shareHint: p.shareHint,
          pendingLabel: p.pendingLabel,
          // A real ppUSDC position keeps its identity: venue + live APY (the
          // ASP net realized APY when the feed answers, else the configured
          // placeholder), and it is the only row that expands to APY history.
          // Earned to date from the SDK's flow accounting (null renders "—").
          // Never substitute the redeemable total.
          ...(p.isYield
            ? {
                yield: true,
                earnedText: p.earnedText ?? null,
                venueLabel: 'Aave v3',
                aprText: liveApy.percent != null ? `${liveApy.percent.toFixed(2)}%` : null,
                actionSymbol: p.shareSymbol,
                shareAddress: p.tokenAddress,
              }
            : {}),
          withdrawEnabled: p.withdrawEnabled,
          // '—', not a false '$0' TVL: on a chain whose assets-stats feed is
          // empty (Optimism while the ASP chain-10 registration is pending)
          // there is no figure, and $0 asserts one.
          privacyScore: poolEntry?.privacyScore ?? 50,
        };
      });

      return rows;
    },
    [chainDisplayName, chainId, positions, poolsData.allPools, liveApy.percent],
  );

  // Only a real yield position fills the tile.
  const hasRealYield = positions.some((p) => p.isYield);
  const yieldEarnedTile = hasRealYield ? yieldEarnedUsdFormatted : null;

  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow px-[20px] pt-[20px]"
        // nw-keep(measured-or-inset): clearance for the floating bottom bar
        contentContainerStyle={{ paddingBottom: 20 + tabClearance }}
      >
        {/* 1100px is this app's page width: /explore, /transactions and
            /ecosystem all use it, and the header nav moves between them and
            this page. Portfolio was the one page at 820, so stepping between
            Explore and Portfolio visibly resized the SAME activity table
            (owner, QA 2026-09-21). Kept as a literal rather than a shared
            constant because NativeWind only compiles class strings it can read
            statically. */}
        <View className="mx-auto w-full max-w-[1100px] grow gap-[20px]">
          <LooseShareUnwrap />
          {signedOut ? (
            <View
              testID="portfolio-sign-in"
              className="items-center gap-[12px] rounded-card border border-border-light px-[16px] py-[32px]"
            >
              <Text className="font-pp-regular text-[14px] text-text-secondary">
                Sign in to see your positions
              </Text>
              <Pressable
                className="rounded-control bg-button-primary px-[16px] py-[8px]"
                accessibilityRole="button"
                accessibilityLabel="Sign in"
                onPress={() => (keyInitFailed ? retryKeyInit() : openSeedDerivationModal())}
              >
                <Text className="font-pp-medium text-[13px] text-button-primary-text">
                  {keyInitFailed ? 'Retry' : 'Sign in'}
                </Text>
              </Pressable>
            </View>
          ) : (
          <>
          <PortfolioStats
            netValue={portfolioLoading ? '—' : totalValueFormatted}
            pending={portfolioLoading ? '—' : pendingValueFormatted}
            assetsCount={positions.length}
            yieldEarnedUsd={portfolioLoading ? null : yieldEarnedTile}
            assetsLabel={hasPositions ? positions.map((p) => p.tokenSymbol).join(', ') : 'No assets yet'}
            hasData={hasPositions}
            assets={portfolioAssets}
          />
          {(isConnected || !!sessionAddress) && <PointsCard />}
          {/* The yield POSITION is a row in All positions, so the page is one
              list of what you hold. */}
          <AllPositions
            positionsCount={mappedPositions.length}
            netValue={totalValueFormatted}
            isConnected={isConnected}
            hasPositions={hasPositions || mappedPositions.length > 0}
            onDeposit={() => openDepositModal()}
            positions={mappedPositions}
          />
          </>
          )}
          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View className="px-[20px] pb-[20px]">
          <Footer />
        </View>
      )}
    </View>
  );
}
