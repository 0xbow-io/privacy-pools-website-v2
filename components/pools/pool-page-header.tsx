import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { useCallback, useState } from 'react';
import { displayTokenSymbol } from '@/services/share-display';
import { getPoolPath, poolDisplayLabel } from '@/config/pool-paths';
import { View, Text, Pressable, ScrollView, useWindowDimensions } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { openedFromHomePanel } from '@/components/ui-url-events';
import { useAppNavigation } from '@/hooks/use-app-navigation';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { CHAIN_OPTIONS } from '@/components/pools/chain-selector';
import {
  ChevronLeftIcon,
  WEB_FIXED_POSITION,
  useEscapeToClose,
  type PoolOption,
} from './pool-page-shared';
import { CaretDownIcon } from '@/components/ui/modal-icons';
import { formatApyPercent } from '@/services/share-yield';
import { YieldPositionHint, YIELD_POSITION_NET_HINT } from '@/components/yield/yield-position-hint';
import { Pill, PILL_ICON_SIZE } from '@/components/ui/pill';

type Props = {
  poolName: string;
  activePool: PoolOption;
  poolOptions: PoolOption[];
  selectedChain: string;
  /** Aave yield APY (flag-gated) — renders a quiet chip next to the title. */
  yieldApy?: number;
};

export function PoolPageHeader({
  poolName,
  activePool,
  poolOptions,
  selectedChain,
  yieldApy,
}: Props) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const [assetDropdownOpen, setAssetDropdownOpen] = useState(false);
  const [selectedAssetDropdownChain, setSelectedAssetDropdownChain] = useState(selectedChain);
  // Only the pools of the chain picked in the dropdown; a pool row always
  // routes to its own chain so the badge and the destination agree. A chain
  // with no configured rows shows an empty state.
  const visiblePools = poolOptions.filter((p) => p.chainKey === selectedAssetDropdownChain);

  // Opened from home with My balances or All activity open: router.back()
  // returns to the router's bare home entry and closes the panel, and the
  // browser's Back makes expo-router reset the navigator. Return the way the
  // My Pools link does, to the remembered home with its panel.
  const navigateTo = useAppNavigation();
  const goBack = () => {
    if (openedFromHomePanel()) navigateTo('/');
    else router.back();
  };

  useEscapeToClose(useCallback(() => {
    setAssetDropdownOpen(false);
  }, []), assetDropdownOpen);

  return (
    <View className="relative flex-row items-center justify-between gap-[10px] overflow-visible p-[12px] z-[99999]">
      <View className="absolute bottom-0 left-0 right-0 h-[1px] z-[-1] bg-border" />
      {/* Allow the APY pill to wrap on narrow cards. */}
      <View testID="pool-header-title-group" className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-[10px] gap-y-[8px] overflow-visible z-[99999]">
        <Pressable onPress={goBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          {/* nw-keep(data-color): title-color token into the SVG icon color prop (non-class sink) */}
          <ChevronLeftIcon color={colors.text} />
        </Pressable>
        <View className="relative overflow-visible z-[99999]">
          <Pressable
            className="flex-row items-center gap-[10px]"
            accessibilityRole="button"
            accessibilityLabel="Browse pools"
            accessibilityState={{ expanded: assetDropdownOpen }}
            onPress={() => {
              if (!assetDropdownOpen) setSelectedAssetDropdownChain(selectedChain);
              setAssetDropdownOpen(!assetDropdownOpen);
            }}
          >
            <TokenNetworkIcon symbol={activePool.name} chainId={activePool.chainId} size={28} badgeSize={15} />
            <Text className="text-[16px] leading-[16px] text-text font-pp-bold">
              {displayTokenSymbol(poolName)}
            </Text>
            {/* nw-keep(data-color): title-color token into the SVG icon color prop (non-class sink) */}
            <CaretDownIcon color={colors.text} />
          </Pressable>
          {assetDropdownOpen && (
            <>
              {/* nw-keep(platform-css): web-only position:fixed backdrop (WEB_FIXED_POSITION) — no className path */}
              <Pressable className="inset-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={() => setAssetDropdownOpen(false)} />
              <ScrollView
                className="absolute top-[32px] left-0 z-[99999] rounded-card border border-border bg-card-background"
                contentContainerClassName="gap-[12px] p-[16px]"
                // nw-keep(platform-css): shared dropdown shadow and viewport-bounded width
                style={[DROPDOWN_SHADOW, { width: Math.min(440, width - 88), maxHeight: Math.max(120, height - 200) }]}
              >
                {CHAIN_OPTIONS.length > 1 && (
                  <View className="gap-[8px]">
                    <View className="pb-[4px]">
                      <Text className="text-[16px] text-text font-pp-bold">
                        Browse chains
                      </Text>
                    </View>
                    <View className="flex-row flex-wrap items-center gap-[8px]">
                      {CHAIN_OPTIONS.map((chain) => (
                        <Pressable
                          key={chain.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Browse ${chain.name} pools`}
                          accessibilityState={{ selected: selectedAssetDropdownChain === chain.id }}
                          className={`flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px] ${
                            selectedAssetDropdownChain === chain.id
                              ? 'border-tint bg-background-secondary'
                              : 'border-border active:bg-background-secondary'
                          }`}
                          onPress={() => setSelectedAssetDropdownChain(chain.id)}
                        >
                          <chain.icon size={16} />
                          <Text className={`font-pp-medium text-[12px] ${selectedAssetDropdownChain === chain.id ? 'text-text' : 'text-text-secondary'}`}>{chain.name}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
                <View>
                  {/* The right column is pool TVL, and unlabelled it read as
                      the user's own balance (Artem, QA 2026-08-28 — "maybe
                      just mark it as tvl"). Ambiguous money figures are worth
                      one word. */}
                  <View className="flex-row items-center justify-between pb-[12px]">
                    <Text className="text-[16px] text-text font-pp-bold">
                      Pools
                    </Text>
                    <Text className="text-[12px] font-pp-regular text-text-secondary">
                      TVL
                    </Text>
                  </View>
                  {visiblePools.length === 0 && (
                    <Text className="py-[12px] text-[14px] font-pp-regular text-text-secondary">
                      No pools available on this chain.
                    </Text>
                  )}
                  {visiblePools.map((pool) => {
                    return (
                      <View key={pool.id}>
                        <Pressable
                          className={`-mx-[8px] flex-row items-center gap-[12px] rounded-inner px-[8px] py-[10px] hover:bg-background-secondary active:bg-background-secondary ${pool.id === activePool.id ? 'bg-background-secondary' : ''}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${poolDisplayLabel(pool.name, pool.chainId)} pool`}
                          accessibilityState={{ selected: pool.id === activePool.id }}
                          onPress={() => {
                            setAssetDropdownOpen(false);
                            router.push(getPoolPath(pool.name, pool.chainId) as Parameters<typeof router.push>[0]);
                          }}
                        >
                          <TokenNetworkIcon symbol={pool.name} chainId={pool.chainId} size={28} badgeSize={15} />
                          <Text className="flex-1 text-[15px] text-text font-pp-bold">
                            {poolDisplayLabel(pool.name, pool.chainId)}
                          </Text>
                          <Text className="text-right text-[13px] font-pp-medium text-text">
                            {pool.tvl}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            </>
          )}
        </View>
        {/* APY chip, informational only. The pill reads just "x% APY" (Mike, 2026-10-16). The Aave source and the net-of-fee note live in the (i) hint. */}
        {typeof yieldApy === 'number' && (
          <Pill
            tone="success"
            label={`${formatApyPercent(yieldApy)}% APY`}
            trailing={<YieldPositionHint size={PILL_ICON_SIZE} hint={YIELD_POSITION_NET_HINT} testID="pool-yield-position-hint" />}
            testID="pool-apy-chip"
          />
        )}
      </View>

    </View>
  );
}
