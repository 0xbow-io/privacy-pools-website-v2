import type { ReactNode } from 'react';
import { View, Text, useWindowDimensions } from 'react-native';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function getResponsiveFontSize(width: number): number {
  if (width >= 785) return 24;
  if (width >= 700) return 21;
  if (width >= 620) return 18;
  if (width >= 540) return 16;
  return 14;
}

type PortfolioStatsProps = {
  netValue?: string;
  pending?: string;
  /**
   * Total yield earned, already USD-formatted. Null when there is no figure to
   * show: no yield position, or no row has a figure (services/yield-earned.ts).
   */
  yieldEarnedUsd?: string | null;
  /** The rows' figures are still being computed: a shimmer, not a dash. */
  yieldEarnedLoading?: boolean;
};

/**
 * Net value, pending and yield earned, one box each. The asset colour bar is
 * gone and pending has its own box so the header is less crowded (Ameen, QA
 * 2026-10-25). All positions below lists what you hold.
 */
export function PortfolioStats({
  netValue = '$0.00',
  pending = '0%',
  yieldEarnedUsd = null,
  yieldEarnedLoading = false,
}: PortfolioStatsProps) {
  const { width } = useWindowDimensions();
  const isMobile = width <= 450;
  const responsiveFontSize = isMobile ? 18 : getResponsiveFontSize(width);
  const pad = isMobile ? 'p-[16px]' : 'p-[20px]';

  const stat = (label: string, value: ReactNode) => (
    <View className={`flex-1 justify-start gap-[6px] ${pad}`}>
      <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
        {label}
      </Text>
      {value}
    </View>
  );

  const divider = (
    <View className="items-center justify-center self-stretch py-[10px]">
      <View className="w-[1px] flex-1 bg-border" />
    </View>
  );

  const figure = (text: string, className: string, testID?: string) => (
    <Text
      className={`font-pp-bold ${className}`}
      testID={testID}
      // nw-keep(measured-or-inset): headline size follows the width-driven responsive scale
      style={{ fontSize: responsiveFontSize, lineHeight: responsiveFontSize }}
    >
      {text}
    </Text>
  );

  const netValueBox = stat('Net Value', figure(netValue, 'text-text'));
  const pendingBox = stat('Pending', figure(pending, 'text-text-muted'));
  const yieldBox = stat(
    'Yield earned',
    yieldEarnedLoading ? (
      <View testID="portfolio-stats-yield-earned-loading">
        <Skeleton width={isMobile ? 72 : 96} height={responsiveFontSize} />
      </View>
    ) : (
      figure(
        yieldEarnedUsd ?? '—',
        yieldEarnedUsd ? 'text-success' : 'text-text-muted',
        'portfolio-stats-yield-earned',
      )
    ),
  );

  return (
    <Card noPadding>
      {/* Header */}
      <View className="gap-[10px] border-b border-b-border p-[16px]">
        <Text className="font-pp-bold text-[16px] leading-[16px] text-text">
          Portfolio
        </Text>
        <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
          Track all your positions in one place
        </Text>
      </View>

      {isMobile ? (
        // Phones: net value and pending side by side, yield earned below.
        <View className="flex-col">
          <View className="flex-row">
            {netValueBox}
            {divider}
            {pendingBox}
          </View>
          <View className="mx-[16px] h-[1px] self-stretch bg-border" />
          <View className="flex-row">{yieldBox}</View>
        </View>
      ) : (
        <View className="min-h-[106px] flex-row">
          {netValueBox}
          {divider}
          {pendingBox}
          {divider}
          {yieldBox}
        </View>
      )}
    </Card>
  );
}
