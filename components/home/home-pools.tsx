import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, type Href } from 'expo-router';
import { Colors, TokenHues } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { getPoolPath, isSupersededLegacyPool, poolDisplayLabel } from '@/config/pool-paths';
import { isYieldUnderlying, YIELD_APY_PERCENT } from '@/config/yield';
import { ShareApyChip } from '@/components/yield/share-apy-chip';
import { Pill } from '@/components/ui/pill';
import { displayTokenSymbol } from '@/services/share-display';
import { formatApyPercent } from '@/services/share-yield';

/**
 * Minimalist list of the available pools under the action card — same quiet
 * visual language as LatestActivity. Each row deep-links to that pool's page.
 *
 * `limit` caps the list to the top N by TVL (the front page shows 4 beside the
 * activity feed); unset lists every pool, largest first.
 */
export function HomePools({ limit }: { limit?: number } = {}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { data } = usePools();
  // Ranked by real TVL (poolValueUsd, the number the display string was
  // formatted from) so a `limit` shows the LARGEST pools rather than whichever
  // happened to come first out of the config.
  const pools = useMemo(() => {
    // The share pool stands in for the plain pool it replaced (legacy ETH once
    // ppETH opened), same rule as the Explore table.
    const ranked = data.allPools
      .filter((pool) => !isSupersededLegacyPool(pool.name, pool.chainId))
      .sort((a, b) => b.poolValueUsd - a.poolValueUsd);
    return limit ? ranked.slice(0, limit) : ranked;
  }, [data.allPools, limit]);

  if (pools.length === 0) return null;

  const scheme = colorScheme === 'dark' ? 'dark' : 'light';

  return (
    <View className="w-full rounded-inner border border-border-light bg-surface-raised px-[14px]">
      {pools.map((pool, i) => {
        const hue = TokenHues[scheme][pool.name.toUpperCase()] ?? TokenHues[scheme].ETH;
        // Quiet Aave APY chip (A5) — flag-gated, informational only. Active
        // when this pool's asset is the configured yield underlying for its
        // chain, matched by exact token ADDRESS (not symbol — a same-symbol
        // impostor token must not get the chip; integration review finding 3).
        // isYieldUnderlying fails closed, so this is a no-op unless yield is
        // fully enabled.
        const yieldActive = isYieldUnderlying(pool.chainId, pool.tokenAddress);
        return (
          <Pressable
            key={pool.id}
            onPress={() => router.push(getPoolPath(pool.name, pool.chainId) as Href)}
            className={`flex-row items-center gap-[12px] py-[9px] ${i > 0 ? 'border-t border-t-border-light' : ''}`}
            accessibilityRole="button"
          >
            {/* nw-keep(data-color): per-token identity hue bg (runtime TokenHues lookup by pool name, no class token) */}
            <View className="w-[32px] h-[32px] rounded-full items-center justify-center" style={{ backgroundColor: hue.bg }}>
              {/* nw-keep(data-color): per-token identity hue fg (runtime TokenHues lookup) */}
              <Text className="text-[13px] font-pp-sans-semi-bold" style={{ color: hue.fg }}>
                {displayTokenSymbol(pool.name).slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View className="flex-1 gap-[1px]">
              <Text className="text-[13px] text-text font-pp-sans-medium" numberOfLines={1}>
                {poolDisplayLabel(pool.name, pool.chainId)} Pool
              </Text>
              <Text className="text-[11.5px] text-text-muted font-pp-sans" numberOfLines={1}>
                TVL <Text className="font-pp-mono">{pool.poolValue}</Text>
              </Text>
            </View>
            {yieldActive ? (
              <Pill
                tone="success"
                label={YIELD_APY_PERCENT !== null ? `Aave · ${formatApyPercent(YIELD_APY_PERCENT)}% APY` : 'Aave yield'}
                testID="home-pool-apy-chip"
              />
            ) : (
              // A yield-bearing share (ppUSDC / ppUSDT) gets its LIVE net APY,
              // read on chain; the chip renders nothing for a plain asset.
              <ShareApyChip chainId={pool.chainId} tokenAddress={pool.tokenAddress} testID="home-pool-apy-chip" />
            )}
            {/* nw-keep(data-color): muted chevron glyph color (theme token) into the vector-icon sink */}
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}
