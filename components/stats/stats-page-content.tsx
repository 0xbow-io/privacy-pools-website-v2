import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
import { Platform, ScrollView, View } from 'react-native';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';
import { Transactions } from '@/components/pools/transactions';
import { StatsSummary } from '@/components/stats/stats-summary';
import { StatsAssetCards } from '@/components/stats/stats-asset-cards';
import { useGlobalStatistics } from '@/hooks/use-global-statistics';

/**
 * Protocol Stats shares the app header and plain theme background with
 * the portfolio and pools pages.
 *
 * Everything on this page is REAL ASP data, from two endpoints:
 *   - `/global/public/statistics` (GlobalStatistics) → the summary tiles
 *   - `/:chainId/public/assets-stats` (AssetsStatsResponse) → the pool cards
 * There is no demo data on this page: the summary row was cut to the five
 * ASP-sourced figures, which retired the fabricated "Median deposit" tile.
 *
 * The read model is resolved ONCE here and passed down, so the two sections
 * share one derivation (and, via the provider's query key, one network call).
 *
 * The activity feed is the shared <Transactions mode="full" /> table, pinned
 * to the protocol-wide scope: /explore is a protocol page, so it opens on "All"
 * even for a connected wallet (everywhere else a connected wallet lands on
 * "My Transactions"). The scope switch still works — this only sets the
 * starting tab. It opens on 3 rows with a "Show more" rather than the full
 * 25-row pager: on this page the feed is the last of three sections, and a
 * full table pushed the pools out of reach.
 */
export function StatsPageContent() {
  const tabClearance = useTabBarClearance();
  const stats = useGlobalStatistics();

  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow px-[20px] pt-[20px]"
        // nw-keep(measured-or-inset): clearance for the floating bottom bar
        contentContainerStyle={{ paddingBottom: 20 + tabClearance }}
      >
        <View className="mx-auto w-full max-w-[1100px] grow gap-[20px]">
          <StatsSummary stats={stats} />
          <StatsAssetCards stats={stats} />
          <Transactions mode="full" defaultScope="all" initialRows={3} />
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
