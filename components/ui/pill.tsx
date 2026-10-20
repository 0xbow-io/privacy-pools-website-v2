import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

/**
 * The one status pill: transaction status, ASP verdict, funds state, payment
 * request state, pending balance and yield rates all render through it, so
 * they share one size, shape and type. The tone carries the meaning; 'neutral'
 * sits on a card, 'neutral-inset' on a surface already tinted secondary (the
 * View Details hero).
 */
export type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'neutral-inset';

const TONE: Record<PillTone, { bg: string; fg: string }> = {
  success: { bg: 'bg-success-bg', fg: 'text-success' },
  warning: { bg: 'bg-warning-bg', fg: 'text-warning' },
  danger: { bg: 'bg-danger-bg', fg: 'text-danger' },
  neutral: { bg: 'bg-background-secondary', fg: 'text-text-secondary' },
  'neutral-inset': { bg: 'bg-background', fg: 'text-text-muted' },
};

/** Size for an icon placed in a pill's `trailing` slot. */
export const PILL_ICON_SIZE = 12;

export function Pill({ tone, label, trailing, testID }: { tone: PillTone; label: string; trailing?: ReactNode; testID?: string }) {
  const { bg, fg } = TONE[tone];
  return (
    <View className={`flex-row items-center gap-[4px] rounded-pill px-[10px] py-[4px] ${bg}`} testID={testID}>
      <Text numberOfLines={1} className={`font-pp-sans-medium text-[12px] leading-[16px] ${fg}`}>
        {label}
      </Text>
      {trailing}
    </View>
  );
}
