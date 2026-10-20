import { useCallback, useEffect, useState } from 'react';
import { displayTokenSymbol } from '@/services/share-display';
import { getPoolPath, poolDisplayLabel } from '@/config/pool-paths';
import { View, Text, Pressable } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { ChainSelector, CHAIN_OPTIONS } from '@/components/pools/chain-selector';
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
  multiChain: boolean;
  supportedChainOptions: typeof CHAIN_OPTIONS;
  selectedChain: string;
  onSelectChain: (id: string) => void;
  /** Aave yield APY (flag-gated) — renders a quiet chip next to the title. */
  yieldApy?: number;
};

export function PoolPageHeader({
  poolName,
  activePool,
  poolOptions,
  multiChain,
  supportedChainOptions,
  selectedChain,
  onSelectChain,
  yieldApy,
}: Props) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const [chainDropdownOpen, setChainDropdownOpen] = useState(false);
  const [assetDropdownOpen, setAssetDropdownOpen] = useState(false);
  const [selectedAssetDropdownChain, setSelectedAssetDropdownChain] = useState(selectedChain);
  // Follow the page's chain (it changes with the route), rather than keeping
  // the chain the component happened to mount with.
  useEffect(() => { setSelectedAssetDropdownChain(selectedChain); }, [selectedChain]);
  // Only the pools of the chain picked in the dropdown; a pool row always
  // routes to its own chain so the badge and the destination agree. A chain
  // with no rows loaded shows an empty line rather than other chains' pools.
  const visiblePools = poolOptions.filter((p) => p.chainKey === selectedAssetDropdownChain);

  useEscapeToClose(useCallback(() => {
    setChainDropdownOpen(false);
    setAssetDropdownOpen(false);
  }, []), chainDropdownOpen || assetDropdownOpen);

  return (
    <View className="relative flex-row items-center justify-between gap-[10px] overflow-visible p-[12px] z-[99999]">
      <View className="absolute bottom-0 left-0 right-0 h-[1px] z-[-1] bg-border" />
      {/* flex-1 + min-w-0 + flex-wrap: on a mid-width card the title, the APY
          pill and the chain badge do not fit one line, so the pill wraps under
          the title and the badge keeps its place inside the card (Artem, QA
          2026-10-15). Wide and narrow cards that fit are unchanged. */}
      <View testID="pool-header-title-group" className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-[10px] gap-y-[8px] overflow-visible z-[99999]">
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          {/* nw-keep(data-color): title-color token into the SVG icon color prop (non-class sink) */}
          <ChevronLeftIcon color={colors.text} />
        </Pressable>
        <View className="relative overflow-visible z-[99999]">
          <Pressable
            className="flex-row items-center gap-[10px]"
            onPress={() => { setAssetDropdownOpen(!assetDropdownOpen); setChainDropdownOpen(false); }}
          >
            <activePool.icon size={20} />
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
              <View
                className="absolute top-[32px] left-0 z-[99999] w-[300px] gap-[16px] rounded-card border border-border-light bg-menu-background p-[16px]"
                // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                style={DROPDOWN_SHADOW}
              >
                {multiChain && (
                  <View className="gap-[8px]">
                    <View className="pb-[4px]">
                      <Text className="text-[16px] text-text font-pp-regular">
                        Select Chain
                      </Text>
                    </View>
                    <View className="flex-row gap-[8px]">
                      {CHAIN_OPTIONS.map((chain) => (
                        <Pressable
                          key={chain.id}
                          className={`h-[32px] w-[32px] items-center justify-center rounded-control border bg-[#FFFFFF] dark:bg-card-background ${
                            selectedAssetDropdownChain === chain.id
                              ? 'border-[#000000] dark:border-text'
                              : 'border-[#DCDEDF]'
                          }`}
                          onPress={() => setSelectedAssetDropdownChain(chain.id)}
                        >
                          <chain.icon size={16} />
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
                <View className="gap-[8px]">
                  {/* The right column is pool TVL, and unlabelled it read as
                      the user's own balance (Artem, QA 2026-08-28 — "maybe
                      just mark it as tvl"). Ambiguous money figures are worth
                      one word. */}
                  <View className="flex-row items-center justify-between pb-[4px]">
                    <Text className="text-[16px] text-text font-pp-regular">
                      Pools
                    </Text>
                    <Text className="text-[12px] font-pp-regular text-[#737373] dark:text-text-secondary">
                      TVL
                    </Text>
                  </View>
                  {visiblePools.length === 0 && (
                    <Text className="py-[12px] text-[14px] font-pp-regular text-[#737373] dark:text-text-secondary">
                      No pools loaded for this chain.
                    </Text>
                  )}
                  {visiblePools.map((pool) => {
                    const activeChainForBadge = CHAIN_OPTIONS.find((c) => c.id === pool.chainKey) || CHAIN_OPTIONS[0];
                    return (
                      <View key={pool.id}>
                        <Pressable
                          className="-mx-[8px] flex-row items-center gap-[8px] rounded-pill px-[8px] py-[10px] hover:bg-background-secondary"
                          onPress={() => {
                            setAssetDropdownOpen(false);
                            router.push(getPoolPath(pool.name, pool.chainId) as Parameters<typeof router.push>[0]);
                          }}
                        >
                          <View className="h-[20px] w-[26px] flex-row items-end">
                            <pool.icon size={20} />
                            <View className="h-[12px] w-[12px] ml-[-6px] overflow-hidden rounded-[6px] border border-[#FFFFFF] dark:border-card-background">
                              <activeChainForBadge.icon size={12} />
                            </View>
                          </View>
                          <Text className="flex-1 text-[14px] text-text font-pp-regular">
                            {poolDisplayLabel(pool.name, pool.chainId)}
                          </Text>
                          <Text className="flex-1 text-right text-[14px] font-pp-regular text-[#737373] dark:text-text-secondary">
                            {pool.tvl}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              </View>
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
      {multiChain && (
        <ChainSelector
          open={chainDropdownOpen}
          onToggle={() => { setChainDropdownOpen(!chainDropdownOpen); setAssetDropdownOpen(false); }}
          onClose={() => setChainDropdownOpen(false)}
          selectedChain={selectedChain}
          onSelectChain={onSelectChain}
          chains={supportedChainOptions}
        />
      )}
    </View>
  );
}
