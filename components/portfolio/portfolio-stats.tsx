import { View, Text, useWindowDimensions } from 'react-native';
import { Card } from '@/components/ui/card';
import { HoverHint } from '@/components/ui/hover-hint';
import { Skeleton } from '@/components/ui/skeleton';

function getResponsiveFontSize(width: number): number {
  if (width >= 785) return 24;
  if (width >= 700) return 21;
  if (width >= 620) return 18;
  if (width >= 540) return 16;
  return 14;
}

type Asset = {
  color: string;
  percentage: number;
  /**
   * What this segment is, e.g. "USDC 42% of net value". The bar was a row of
   * unlabelled colours with no legend and no hover, so it showed a shape and
   * named nothing (Nathaniel, QA 2026-09-21). Shown on hover, and carried as
   * the accessibility hint where there is no hover.
   */
  label?: string;
};

type PortfolioStatsProps = {
  netValue?: string;
  pending?: string;
  assetsCount?: number;
  assetsLabel?: string;
  /**
   * Total yield earned, already USD-formatted. Null when there is no figure to
   * show: no yield position, or no row has a figure (services/yield-earned.ts).
   */
  yieldEarnedUsd?: string | null;
  /** The rows' figures are still being computed: a shimmer, not a dash. */
  yieldEarnedLoading?: boolean;
  hasData?: boolean;
  assets?: Asset[];
};

/**
 * One band of the allocation bar, which says what it is on hover (web) and
 * through the accessibility hint everywhere else. HoverHint is the app's
 * tooltip: it portals the bubble to <body>, which is what gets it out from
 * under the card's stacking context.
 *
 * The flex weight stays on the OUTER node so the row still divides itself by
 * allocation; HoverHint's own wrapper only has to fill it.
 */
function AssetSegment({ asset, seam = false }: { asset: Asset; seam?: boolean }) {
  return (
    <View
      // nw-keep(measured-or-inset): flex weight is the asset's live allocation percentage
      style={{ flex: asset.percentage }}
      className={seam ? 'h-[10px] border-r-[1px] border-r-card-background' : 'h-[10px] border-r-[1px]'}
    >
      <HoverHint hint={asset.label}>
        {/* nw-keep(data-color): asset brand color (runtime allocation datum, not a theme token) */}
        <View className="h-[10px] w-full" style={{ backgroundColor: asset.color }} />
      </HoverHint>
    </View>
  );
}

export function PortfolioStats({
  netValue = '$0.00',
  pending = '0%',
  assetsCount = 0,
  assetsLabel = 'No Assets here',
  yieldEarnedUsd = null,
  yieldEarnedLoading = false,
  hasData = false,
  assets = [],
}: PortfolioStatsProps) {
  const { width } = useWindowDimensions();
  const isMobile = width <= 450;
  const responsiveFontSize = getResponsiveFontSize(width);

  // Mobile 2x2 grid layout
  if (isMobile) {
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

        {/* Stats Grid - 2x2 */}
        <View className="flex-col">
          {/* Row 1 */}
          <View className="flex-row">
            <View className="flex-1 gap-[6px] p-[16px]">
              <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
                Net Value
              </Text>
              <Text className="font-pp-bold text-[18px] leading-[18px] text-text">
                {netValue}
              </Text>
            </View>
            <View className="my-[10px] w-[1px] self-stretch bg-border" />
            <View className="flex-1 gap-[6px] p-[16px]">
              <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
                Pending Balance
              </Text>
              <Text className="font-pp-bold text-[18px] leading-[18px] text-text-muted">
                {pending}
              </Text>
            </View>
          </View>

          {/* Horizontal Divider */}
          <View className="mx-[16px] h-[1px] self-stretch bg-border" />

          {/* Row 2 */}
          <View className="flex-row">
            <View className="flex-1 gap-[6px] p-[16px]">
              <View className="flex-row items-center gap-[6px]">
                <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
                  Yield earned
                </Text>
              </View>
              {yieldEarnedLoading ? (
                <View testID="portfolio-stats-yield-earned-loading">
                  <Skeleton width={72} height={18} />
                </View>
              ) : (
                <Text
                  className={`font-pp-bold text-[18px] leading-[18px] ${yieldEarnedUsd ? 'text-success' : 'text-text-muted'}`}
                >
                  {yieldEarnedUsd ?? '—'}
                </Text>
              )}
            </View>
            <View className="my-[10px] w-[1px] self-stretch bg-border" />
            <View className="flex-1 gap-[6px] p-[16px]">
              <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
                Assets
              </Text>
              <View className="h-[31px] justify-center">
                {hasData ? (
                  <View className="h-[10px] w-full flex-row">
                    {assets.map((asset, index) => (
                      <AssetSegment key={index} asset={asset} seam />
                    ))}
                  </View>
                ) : (
                  <Text className="font-pp-regular text-[12px] leading-[12px] text-text-muted">
                    {assetsLabel}
                  </Text>
                )}
              </View>
            </View>
          </View>
        </View>
      </Card>
    );
  }

  // Desktop horizontal layout
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

      {/* Stats Row */}
      <View className="min-h-[106px] flex-row">
        {/* Net Value & Pending */}
        <View className="flex-1 justify-start gap-[6px] p-[20px]">
          <View className="flex-row justify-between gap-[6px]">
            <View className="gap-[6px]">
              <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
                Net Value
              </Text>
              <Text
                className="font-pp-bold text-text"
                // nw-keep(measured-or-inset): headline size follows the width-driven responsive scale
                style={{ fontSize: responsiveFontSize, lineHeight: responsiveFontSize }}
              >
                {netValue}
              </Text>
            </View>
            <View className="gap-[6px]">
              <Text className="font-pp-regular text-[12px] leading-[12px] text-right text-text-secondary">
                Pending
              </Text>
              <Text
                className="font-pp-bold text-right text-text-muted"
                // nw-keep(measured-or-inset): headline size follows the width-driven responsive scale
                style={{ fontSize: responsiveFontSize, lineHeight: responsiveFontSize }}
              >
                {pending}
              </Text>
            </View>
          </View>
        </View>

        {/* Divider */}
        <View className="items-center justify-center self-stretch py-[10px]">
          <View className="w-[1px] flex-1 bg-border" />
        </View>

        {/* Yield earned */}
        <View className="flex-1 justify-start gap-[6px] p-[20px]">
          <View className="flex-row items-center gap-[6px]">
            <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
              Yield earned
            </Text>
          </View>
          {yieldEarnedLoading ? (
            <View testID="portfolio-stats-yield-earned-loading">
              <Skeleton width={96} height={responsiveFontSize} />
            </View>
          ) : (
            <Text
              className={`font-pp-bold ${yieldEarnedUsd ? 'text-success' : 'text-text-muted'}`}
              testID="portfolio-stats-yield-earned"
              // nw-keep(measured-or-inset): headline size follows the width-driven responsive scale
              style={{ fontSize: responsiveFontSize, lineHeight: responsiveFontSize }}
            >
              {yieldEarnedUsd ?? '—'}
            </Text>
          )}
        </View>

        {/* Divider */}
        <View className="items-center justify-center self-stretch py-[10px]">
          <View className="w-[1px] flex-1 bg-border" />
        </View>

        {/* Assets */}
        <View className="flex-1 justify-start gap-[6px] p-[20px]">
          <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
            Assets
          </Text>
          <View className="h-[31px] justify-center">
            {hasData ? (
              <View className="h-[10px] w-full flex-row">
                {assets.map((asset, index) => (
                  <AssetSegment key={index} asset={asset} />
                ))}
              </View>
            ) : (
              <Text className="font-pp-regular text-[12px] leading-[12px] text-text-muted">
                {assetsLabel}
              </Text>
            )}
          </View>
        </View>
      </View>
    </Card>
  );
}
