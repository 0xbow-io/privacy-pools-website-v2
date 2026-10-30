import { View, Text } from 'react-native';
import type { AssetStatistics, GlobalStatistics } from '@/services/api-types';
import { Card } from '@/components/ui/card';
import { formatUsd } from '@/components/pools-provider';
import { resolveTransfersCount } from '@/services/global-stats';
import { StatRows, type StatItem } from '@/components/pools/stat-display';

type Props = {
  isMobile: boolean;
  statistics: GlobalStatistics | null;
  /**
   * Pool-SCOPED statistics (per-asset endpoint, asp-v2 PR #92). The ONLY
   * legitimate source for the transfers row here: `statistics` is
   * the protocol-wide aggregate, and using it on a pool page silently shows
   * every pool the same number (review P1). Null until the endpoint deploys.
   */
  assetStats?: AssetStatistics | null;
  tvlUsd: string;
  tvlToken: string;
  fundsAccepted: string;
  depositCount: number;
  avgDepositUsd: number;
  withdrawalCount: number;
  transferCount: number;
};

/**
 * Pool statistics as a compact list.
 *
 * Was a 2x3 grid of 24px bold figures with a 360px floor. Two things were wrong
 * with it: values like "$326.58k" did not fit half the card at that size and
 * broke mid-number onto a second line, and the height floor plus three 107px
 * rows made the card taller than a phone could show, so it was clipped. One
 * list now serves both widths — no floor, no wrapping, about a third less
 * height — and matches the activity feed's label/value idiom.
 */
export function PoolPageStatsCard({
  isMobile,
  statistics,
  tvlUsd,
  tvlToken,
  fundsAccepted,
  depositCount,
  avgDepositUsd,
  withdrawalCount,
  transferCount,
  assetStats = null,
}: Props) {
  // Transfers is a pool-scoped row and reads ONLY from the per-asset stats
  // (null until asp-v2 PR #92 deploys). The GLOBAL payload is never consulted
  // for it: on a pool page it would show the protocol-wide figure under a
  // pool-local label — the review P1. The other rows keep their pre-#92
  // sources, upgraded to the per-asset figure when it is available.
  const scoped = assetStats?.allTime ?? null;

  const items: StatItem[] = [
    { label: 'Pool TVL', value: tvlUsd, sub: tvlToken },
    { label: 'Total funds accepted', value: fundsAccepted },
    {
      label: 'Deposits',
      value: (scoped?.totalDepositsCount ?? (statistics ? statistics.allTime.totalDepositsCount : depositCount)).toLocaleString('en-US'),
    },
    {
      label: 'Average deposit',
      value: scoped
        ? formatUsd(parseFloat(scoped.avgDepositSizeUsd) || 0)
        : statistics
          ? formatUsd(parseFloat(statistics.allTime.avgDepositSizeUsd) || 0)
          : formatUsd(avgDepositUsd),
    },
    {
      label: 'Withdrawals',
      value: (scoped?.totalWithdrawalsCount ?? statistics?.allTime.totalWithdrawalsCount ?? withdrawalCount).toLocaleString('en-US'),
    },
    {
      label: 'Transfers',
      value: resolveTransfersCount(scoped, transferCount).toLocaleString('en-US'),
    },
  ];

  return (
    <Card noPadding className={isMobile ? 'w-full' : 'flex-1'}>
      <View className="px-[16px] pb-[6px] pt-[14px]">
        <Text className="font-pp-bold text-[16px] leading-[20px] text-text">Statistics</Text>
      </View>
      <StatRows items={items} />
      <Text className="px-[16px] pb-[8px] font-pp-regular text-[11px] leading-[16px] text-text-muted">
        Activity counts are not an anonymity score. Amounts and timing also matter.
      </Text>
      <View className="h-[6px]" />
    </Card>
  );
}
