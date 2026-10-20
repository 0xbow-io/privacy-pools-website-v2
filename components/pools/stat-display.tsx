import { View, Text } from 'react-native';
import { Skeleton } from '@/components/ui/skeleton';

export type StatItem = {
  label: string;
  value: string;
  /** Secondary line under the value (e.g. the token amount behind a USD figure). */
  sub?: string;
  /** The value isn't known yet (prices/notes/sync still loading) — render a
   *  pulsing skeleton in its place instead of a false 0 or a dash. */
  loading?: boolean;
};

/**
 * Statistics as a compact list, in the activity feed's idiom: muted label on
 * the left, value right-aligned and emphasised, an optional quieter line under
 * it, hairline between rows.
 *
 * Replaces a 2-column grid of 24px bold figures. That grid had two problems
 * this shape does not: at 24px a value like "$326.58k" could not fit its half
 * of the card and broke onto a second line mid-number, and three 107px rows
 * plus a 360px floor made the card tall enough to be clipped on a phone.
 * Here the label absorbs the slack and the value never wraps, so one layout
 * serves every width.
 */
export function StatRows({ items }: { items: StatItem[] }) {
  return (
    <View>
      {items.map((item, index) => (
        <View key={item.label}>
          <View className="flex-row items-center justify-between gap-[14px] px-[16px] py-[10px]">
            <Text numberOfLines={1} className="min-w-0 shrink font-pp-regular text-[12px] leading-[16px] text-text-muted">
              {item.label}
            </Text>
            <View className="shrink-0 items-end">
              {item.loading ? (
                // Same height as the value's line so the row doesn't shift.
                <View className="h-[19px] justify-center">
                  <Skeleton width={64} height={13} />
                </View>
              ) : (
                <Text numberOfLines={1} className="font-pp-semi-bold text-[14.5px] leading-[19px] text-text">
                  {item.value}
                </Text>
              )}
              {!!item.sub && (
                <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[15px] text-text-muted">
                  {item.sub}
                </Text>
              )}
            </View>
          </View>
          {index < items.length - 1 && <View className="h-[1px] self-stretch bg-border-light" />}
        </View>
      ))}
    </View>
  );
}

/**
 * The same figures as a single compact strip — value over label, wrapping.
 *
 * Used where the numbers are a summary above other content (My Privacy Pools)
 * rather than the content itself: five short figures read faster side by side
 * than as five stacked rows, and this costs roughly half the height of the
 * 24px-figure block it replaces.
 */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <View className="flex-row flex-wrap items-stretch gap-y-[10px] px-[16px] py-[13px]">
      {items.map((item, index) => (
        <View
          key={item.label}
          className={`min-w-[84px] grow basis-0 gap-[2px] ${index > 0 ? 'border-l border-border-light pl-[12px]' : ''}`}
        >
          {item.loading ? (
            // Same height as the value's line so the strip doesn't shift.
            <View className="h-[20px] justify-center">
              <Skeleton width={52} height={13} />
            </View>
          ) : (
            <Text numberOfLines={1} className="font-pp-semi-bold text-[15px] leading-[20px] text-text">
              {item.value}
            </Text>
          )}
          <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[14px] text-text-muted">
            {item.label}
          </Text>
          {!!item.sub && (
            <Text numberOfLines={1} className="font-pp-regular text-[10.5px] leading-[14px] text-text-muted">
              {item.sub}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}
