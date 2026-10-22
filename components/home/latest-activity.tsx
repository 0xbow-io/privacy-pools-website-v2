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
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { useEffect, useState } from 'react';
import { rowTypeLabel } from '@/services/row-type-label';
import { withPublicSwapRows } from '@/services/swap-route-evidence';
import { swapHeadline, type SwapLeg } from '@/services/swap-rows';
import { consolidationHeadline } from '@/services/self-transfer-row';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, TokenHues } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useMyTransactionOwnership } from '@/hooks/use-my-transaction-ownership';
import { mergeMyTransactions } from '@/services/transfer-direction';
import type { Transaction } from '@/components/pools-provider';


import { Pill } from '@/components/ui/pill';

function timeAgo(timestamp: number, now: number): string {
  // Provider timestamps are normalized to milliseconds; tolerate seconds in
  // case an unnormalized event slips through.
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const s = Math.max(1, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Re-render tick so the relative time stays live after page load.
function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A Swap leg in the same figures as a single amount. */


const TYPE_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  Deposit: 'arrow-down-circle',
  Withdrawal: 'arrow-up-circle',
  Transfer: 'swap-horizontal',
  Swap: 'swap-vertical',
  Exit: 'exit-outline',
};

export function ActivityRow({ tx, colors }: { tx: Transaction; colors: typeof Colors['light'] }) {
  const balanceDisplay = useBalanceDisplay(tx.chainId);
  const amountView = balanceDisplay(tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress);
  const swapAmount = (leg: SwapLeg) => balanceDisplay(leg.tokenAmount, leg.asset, leg.chainId, leg.tokenAddress).text;
  const scheme = colors === Colors.dark ? 'dark' : 'light';
  const hue = TokenHues[scheme][tx.asset.toUpperCase()] ?? TokenHues[scheme].ETH;
  const pending = tx.status === 'pending';
  const failed = tx.status === 'failed';
  const now = useNow();
  return (
    <View className="flex-1 flex-row items-center gap-[10px]">
      {/* nw-keep(data-color): icon-well background is the runtime per-asset hue */}
      <View className="h-[32px] w-[32px] items-center justify-center rounded-full" style={{ backgroundColor: hue.bg }}>
        {/* nw-keep(data-color): glyph color is the runtime per-asset hue into the vector-icon sink */}
        <Ionicons name={TYPE_ICON[tx.type] ?? 'ellipse-outline'} size={16} color={hue.fg} />
      </View>
      <View className="flex-1 gap-[1px]">
        <Text className="font-pp-sans-medium text-[13px] text-text" numberOfLines={1}>
          {rowTypeLabel(tx)} · <Text className="font-pp-mono">{consolidationHeadline(tx) ?? swapHeadline(tx, swapAmount) ?? amountView.text}</Text>
        </Text>
        <Text className="font-pp-sans text-[11.5px] text-text-muted" numberOfLines={1}>
          {timeAgo(tx.timestamp, now)} · {tx.chain}
        </Text>
      </View>
      <ShareCountHint hint={amountView.hint} />
      <Pill tone={pending ? 'warning' : failed ? 'danger' : 'success'} label={pending ? 'Pending' : failed ? 'Failed' : 'Settled'} />
    </View>
  );
}

/**
 * One quiet line of life under the action card: the latest event in the pool,
 * with a door into the full activity drawer. Keeps the home action-first
 * while proving the pool is breathing.
 */
export function LatestActivity({ onViewAll }: { onViewAll: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const { data } = usePools();
  const { isConnected } = useMultiChainWallet();
  const { filterMineEvents, ownAddress } = useMyTransactionOwnership();

  // Signed in, this is YOUR activity — showing a stranger's deposits to someone
  // who has their own is noise. Signed out it stays the pool's pulse, which is
  // the point of the line then. "Mine" is the SAME ownership and lineage merge
  // as My Transactions (hooks/use-my-transaction-ownership.ts): a row that
  // table shows never drops out of this line at the ASP handoff (codex,
  // 2026-09-04).
  // A walletless account-key session is signed in too (ownAddress).
  const mine = isConnected || !!ownAddress;
  const source = mine
    ? mergeMyTransactions(
      filterMineEvents(data.transactions, { internalTxHashes: data.internalTxHashes, spendClassificationPending: data.spendClassificationPending }),
      data.lineageRows,
      data.anchorTxHashes,
    )
    : withPublicSwapRows(data.transactions, data.swapRouteKinds);
  // Mobile keeps the single compact line; anything wider shows the last 3.
  const txs = source.slice(0, width >= 640 ? 3 : 1);
  const linkLabel = mine ? 'My activity' : 'All activity';

  if (txs.length === 0) return null;

  // Single (mobile): compact inline row with the All-activity link beside it.
  if (txs.length === 1) {
    return (
      <View className="w-full flex-row items-center gap-[12px] rounded-inner border border-border-light bg-surface-raised px-[14px] py-[10px]">
        <ActivityRow tx={txs[0]} colors={colors} />
        <Pressable onPress={onViewAll} className="flex-row items-center gap-[2px]" accessibilityRole="button">
          <Text className="font-pp-sans-semi-bold text-[12.5px] text-primary">{linkLabel}</Text>
          {/* nw-keep(data-color): chevron color is the primary theme token into the vector-icon sink */}
          <Ionicons name="chevron-forward" size={13} color={colors.primary} />
        </Pressable>
      </View>
    );
  }

  // Non-mobile: stack the last few, with the All-activity link underneath.
  return (
    <View className="w-full rounded-inner border border-border-light bg-surface-raised px-[14px]">
      {txs.map((tx, i) => (
        <View key={i} className={`py-[9px] ${i > 0 ? 'border-t border-border-light' : ''}`}>
          <ActivityRow tx={tx} colors={colors} />
        </View>
      ))}
      <Pressable
        onPress={onViewAll}
        className="flex-row items-center justify-end gap-[2px] border-t border-border-light py-[10px]"
        accessibilityRole="button"
      >
        <Text className="font-pp-sans-semi-bold text-[12.5px] text-primary">{linkLabel}</Text>
        {/* nw-keep(data-color): chevron color is the primary theme token into the vector-icon sink */}
        <Ionicons name="chevron-forward" size={13} color={colors.primary} />
      </Pressable>
    </View>
  );
}
