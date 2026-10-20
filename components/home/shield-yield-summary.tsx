import { Platform, Text, View } from 'react-native';
import { HoverHint } from '@/components/ui/hover-hint';
import { formatApyPercent } from '@/services/share-yield';
import { YieldPositionHint } from '@/components/yield/yield-position-hint';

/* ANIMATION STORYBOARD
 * Pending: a quiet placeholder breathes in the reserved value area.
 * Response: placeholder and rate crossfade; the row never changes size.
 * Unavailable: a muted dash replaces the rate, without implying zero yield.
 */
const TIMING = { breathe: 1800, crossfade: 240 };

export function ShieldYieldSummary({
  netApyPercent, loading, showDisclosure, compact = false,
}: {
  netApyPercent: number | undefined;
  loading: boolean;
  showDisclosure: boolean;
  /** Phone web: one short row; the rate's hint already says it is variable. */
  compact?: boolean;
}) {
  const unavailable = !loading && netApyPercent === undefined;
  return (
    <View className={`gap-[10px] px-[4px] ${compact ? 'py-[2px]' : 'py-[12px]'}`} testID="shield-live-apy">
      {Platform.OS === 'web' && <style>{`
        @keyframes apy-breathe { 50% { opacity: .35; } }
        .apy-fade { transition: opacity ${TIMING.crossfade}ms ease-out; }
        .apy-placeholder { animation: apy-breathe ${TIMING.breathe}ms ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .apy-placeholder { animation: none; }
          .apy-fade { transition: none !important; }
        }
      `}</style>}
      <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
        <Text className="font-pp-sans-medium text-[14px] text-text">Yield while shielded</Text>
        <View className="flex-row items-center gap-[6px]">
        <HoverHint hint={unavailable ? 'The live yield rate is temporarily unavailable.' : 'The net yield rate is variable.'}>
          <View className="min-w-[128px] h-[28px] flex-row items-center justify-end gap-[5px]">
            <View className="relative min-w-[64px] h-[28px] items-end justify-center">
              <Text
                testID="shield-apy-value"
                aria-hidden={loading}
                accessibilityElementsHidden={loading}
                accessibilityLabel={unavailable ? 'Yield rate unavailable' : undefined}
                className={`apy-fade font-pp-sans-medium text-[18px] leading-[28px] ${unavailable ? 'text-text-muted' : 'text-text'}`}
                // nw-keep(animated): only the value crossfades; the suffix stays anchored.
                style={{ opacity: loading ? 0 : 1 }}
              >
                {netApyPercent === undefined ? '—' : `${formatApyPercent(netApyPercent)}%`}
              </Text>
              <View
                pointerEvents="none"
                accessibilityRole="progressbar"
                accessibilityLabel="Loading live yield rate"
                aria-hidden={!loading}
                accessibilityElementsHidden={!loading}
                className="apy-fade absolute inset-0 items-end justify-center"
                // nw-keep(animated): placeholder retires in the same fixed value slot.
                style={{ opacity: loading ? 1 : 0 }}
              >
                <View className={`${loading ? 'apy-placeholder ' : ''}w-[48px] h-[10px] rounded-pill bg-border-light`} />
              </View>
            </View>
            <Text className="font-pp-sans text-[12px] leading-[20px] text-text-secondary">net APY</Text>
          </View>
        </HoverHint>
        <YieldPositionHint testID="shield-yield-position-hint" />
        </View>
      </View>
      {showDisclosure && <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">
        Variable net rate.
      </Text>}
    </View>
  );
}
