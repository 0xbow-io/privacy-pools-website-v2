// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { Text, View } from 'react-native';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import type { ShareBalanceDisplay } from '@/services/share-balance-display';

export function BalanceAmount({ view, className }: { view: ShareBalanceDisplay; className?: string }) {
  return (
    <View className="flex-row items-center gap-[4px] shrink">
      <Text className={className}>{view.text}</Text>
      <ShareCountHint hint={view.hint} />
    </View>
  );
}
