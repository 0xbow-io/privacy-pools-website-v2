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
import { useShareFreeBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { useEffect, useMemo, useState } from 'react';
import { rowTypeLabel } from '@/services/row-type-label';
import { withPublicSwapRows } from '@/services/swap-route-evidence';
import { swapHeadline, type SwapLeg } from '@/services/swap-rows';
import { consolidationHeadline } from '@/services/self-transfer-row';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import type { Transaction } from '@/components/pools-provider';
import { useMyTransactionOwnership } from '@/hooks/use-my-transaction-ownership';
import { mergeMyTransactions } from '@/services/transfer-direction';
import { Colors } from '@/constants/theme';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { notifyUiUrl, retireUiParamEntry, setUiParamEntry } from '@/components/ui-url-events';


import { transactionBaseType, transactionTypeColor, transactionTypeGlyph } from '@/services/transaction-visuals';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { Pill } from '@/components/ui/pill';

/** A Swap leg in the same figures as a single amount. */


type Tab = 'mine' | 'all';

// 'fixed' is a web-only CSS position (needed to cover the viewport from inside
// the header); native falls back to absolute fill.
const OVERLAY_POSITION: ViewStyle = Platform.OS === 'web'
  ? ({ position: 'fixed' } as unknown as ViewStyle)
  : { position: 'absolute' };

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


function NotificationRow({ tx, colors, colorScheme }: { tx: Transaction; colors: (typeof Colors)['light']; colorScheme: 'light' | 'dark' }) {
  const balanceDisplay = useShareFreeBalanceDisplay(tx.chainId);
  const amountView = balanceDisplay(tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress);
  const swapAmount = (leg: SwapLeg) => balanceDisplay(leg.tokenAmount, leg.asset, leg.chainId, leg.tokenAddress).text;
  const pending = tx.status === 'pending';
  // Same mark and direction glyph as the My transactions rows.
  const baseType = transactionBaseType(tx.type);
  const failed = tx.status === 'failed';
  const now = useNow();
  return (
    <View className="flex-row items-center gap-[10px]">
      <TokenNetworkIcon symbol={tx.asset} chainId={tx.chainId} size={28} badgeSize={15} />
      <View className="min-w-0 flex-1 gap-[2px]">
        <View className="flex-row items-center gap-[5px]">
          {/* nw-keep(data-color): direction glyph color is per-type (theme token, or the bespoke transfer hue) into the vector-icon sink */}
          <Ionicons name={transactionTypeGlyph(tx.type, baseType)} size={13} color={transactionTypeColor(baseType, colors, colorScheme)} />
          <Text className="min-w-0 flex-1 font-pp-medium text-[12.5px] text-text" numberOfLines={1}>
            {rowTypeLabel(tx)} · {consolidationHeadline(tx) ?? swapHeadline(tx, swapAmount) ?? amountView.text}
          </Text>
        </View>
        <Text className="font-pp-regular text-[11px] text-text-muted" numberOfLines={1}>
          {timeAgo(tx.timestamp, now)} · {tx.chain}
        </Text>
      </View>
      <ShareCountHint hint={amountView.hint} />
      <Pill tone={pending ? 'warning' : failed ? 'danger' : 'success'} label={pending ? 'Pending' : failed ? 'Failed' : 'Completed'} />
    </View>
  );
}

/**
 * The bell is a mini-app, not a toast bin: a dropdown ledger of what's
 * happening — your deposits and transfers first, the pool's pulse second.
 * Pending items wear the amber dot on the bell so "is my deposit in yet?"
 * never needs a page hunt.
 */
export function NotificationCenter() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width, height } = useWindowDimensions();
  const router = useRouter();
  const { data } = usePools();
  const { filterMineEvents } = useMyTransactionOwnership();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('mine');

  const isMobile = width < 560;
  // New designs on a phone present the bell as a bottom sheet rather than a
  // dropdown pinned under a 28px icon: at 390px the dropdown had to be dragged
  // 60px off-anchor to fit, and a sheet is the idiom the rest of this app's
  // mobile surfaces already use.
  const asSheet = width < 768;

  // "Mine" is the SAME ownership and lineage merge as My Transactions
  // (hooks/use-my-transaction-ownership.ts): notes on every chain claim rows,
  // a key session without a wallet address is not empty, and a fresh own
  // deposit the feed has not indexed yet stays listed (codex, 2026-09-04).
  const mine = useMemo(
    () => mergeMyTransactions(
      filterMineEvents(data.transactions, { internalTxHashes: data.internalTxHashes, spendClassificationPending: data.spendClassificationPending }),
      data.lineageRows,
      data.anchorTxHashes,
    ),
    [filterMineEvents, data.transactions, data.lineageRows, data.anchorTxHashes, data.internalTxHashes, data.spendClassificationPending],
  );

  const pendingMine = mine.filter((tx) => tx.status === 'pending').length;
  const rows = (tab === 'mine' ? mine : withPublicSwapRows(data.transactions, data.swapRouteKinds)).slice(0, 8);

  // Tabs + list + "Open full activity" — identical in the dropdown and the
  // sheet, so it is built once and placed by whichever shell is showing.
  const content = (
    <>
          <View className="mx-[12px] flex-row gap-[2px] rounded-pill bg-background-secondary p-[3px]">
            {([
              { key: 'mine', label: 'My activity' },
              { key: 'all', label: 'Pool' },
            ] as { key: Tab; label: string }[]).map((t) => {
              const selected = t.key === tab;
              return (
                <Pressable
                  key={t.key}
                  onPress={() => setTab(t.key)}
                  className={`flex-1 items-center rounded-pill py-[7px] ${selected ? 'bg-card-background' : ''}`}
                >
                  <Text className={`text-[12px] ${selected ? 'font-pp-semi-bold text-text' : 'font-pp-medium text-text-muted'}`}>
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView className="grow-0" contentContainerClassName="px-[14px] pt-[6px]">
            {rows.length === 0 ? (
              <View className="items-center gap-[8px] py-[28px]">
                {/* nw-keep(data-color): muted empty-state icon color (theme token) */}
                <Ionicons name="leaf-outline" size={20} color={colors.textMuted} />
                <Text className="px-[20px] text-center font-pp-regular text-[12.5px] text-text-muted">
                  {tab === 'mine' ? 'Nothing yet. Deposit something to get started.' : 'No pool activity yet.'}
                </Text>
              </View>
            ) : (
              rows.map((tx) => (
                <View key={`${tx.chainId}:${tx.type}:${tx.txHash}:${tx.id}`} className="border-b border-b-border-light py-[8px]">
                  <NotificationRow tx={tx} colors={colors} colorScheme={colorScheme} />
                </View>
              ))
            )}
          </ScrollView>

          <Pressable
            onPress={() => {
              setOpen(false);
              router.push('/transactions');
            }}
            className="items-center border-t border-t-border-light py-[12px]"
          >
            <Text className="font-pp-semi-bold text-[13px] text-tint">Open full activity</Text>
          </Pressable>
    </>
  );

  return (
    <View className="relative z-[99999]">
      <Pressable
        onPress={() => {
          if (asSheet) {
            // Root-mounted (GlobalSheets) so it escapes the header's stacking
            // context — the bottom bar used to paint over it. State travels via
            // the URL, the same channel every other managed overlay uses.
            if (open) { retireUiParamEntry('notifications'); } else { setUiParamEntry('notifications', '1'); }
            notifyUiUrl();
            setOpen((v) => !v);
            return;
          }
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel="Notifications"
        testID="notification-bell"
        className="h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary"
      >
        {/* nw-keep(data-color): bell glyph color (theme token) into the vector-icon sink */}
        <Ionicons name={open ? 'notifications' : 'notifications-outline'} size={16} color={colors.text} />
        {pendingMine > 0 && <View className="absolute right-[3px] top-[2px] h-[9px] w-[9px] rounded-[5px] border-[1.5px] border-background bg-warning" />}
      </Pressable>

      {open && !asSheet && (
        <>
          {/* nw-keep(platform-css): fixed on web / absolute on native to cover the viewport */}
          <Pressable className="inset-0 z-[99998]" style={OVERLAY_POSITION} onPress={() => setOpen(false)} />
          <View
            className={`absolute top-[32px] z-[99999] overflow-hidden rounded-card border border-border-light bg-menu-background ${
              isMobile ? 'right-[-60px] max-h-[440px] w-[320px]' : 'right-0 max-h-[460px] w-[360px]'
            }`}
            // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
            style={DROPDOWN_SHADOW}
          >
            <View className="flex-row items-center justify-between px-[16px] pb-[8px] pt-[14px]">
              <Text className="font-pp-semi-bold text-[15px] text-text">Notifications</Text>
            </View>
            {content}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * The notification list as a bottom sheet, for mobile in the new designs.
 *
 * Rendered by GlobalSheets at the app ROOT, never from the header: a sheet
 * nested in the header is confined to that stacking context, which is exactly
 * how the bottom bar ended up painting over it. Chrome comes from the shared
 * <BottomSheet>, so it drags, scrims and closes like every other sheet.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { data } = usePools();
  const { filterMineEvents } = useMyTransactionOwnership();
  const [tab, setTab] = useState<Tab>('mine');

  // "Mine" is the SAME ownership and lineage merge as My Transactions
  // (hooks/use-my-transaction-ownership.ts): notes on every chain claim rows,
  // a key session without a wallet address is not empty, and a fresh own
  // deposit the feed has not indexed yet stays listed (codex, 2026-09-04).
  const mine = useMemo(
    () => mergeMyTransactions(
      filterMineEvents(data.transactions, { internalTxHashes: data.internalTxHashes, spendClassificationPending: data.spendClassificationPending }),
      data.lineageRows,
      data.anchorTxHashes,
    ),
    [filterMineEvents, data.transactions, data.lineageRows, data.anchorTxHashes, data.internalTxHashes, data.spendClassificationPending],
  );

  const rows = (tab === 'mine' ? mine : withPublicSwapRows(data.transactions, data.swapRouteKinds)).slice(0, 8);

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title="Notifications"
      testID="notification-sheet"
      dragTestID="notification-drag-area"
      closeTestID="notification-sheet-close"
      bodyContentClassName="px-[14px] pb-[24px] pt-[4px]"
    >
      <View className="mb-[8px] flex-row gap-[2px] rounded-pill bg-background-secondary p-[3px]">
        {([
          { key: 'mine', label: 'My activity' },
          { key: 'all', label: 'Pool' },
        ] as { key: Tab; label: string }[]).map((t) => {
          const selected = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              className={`flex-1 items-center rounded-pill py-[7px] ${selected ? 'bg-card-background' : ''}`}
            >
              <Text className={`text-[12px] ${selected ? 'font-pp-semi-bold text-text' : 'font-pp-medium text-text-muted'}`}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {rows.length === 0 ? (
        <View className="items-center gap-[8px] py-[28px]">
          {/* nw-keep(data-color): muted empty-state icon color (theme token) */}
          <Ionicons name="leaf-outline" size={20} color={colors.textMuted} />
          <Text className="px-[20px] text-center font-pp-regular text-[12.5px] text-text-muted">
            {tab === 'mine' ? 'Nothing yet. Deposit something to get started.' : 'No pool activity yet.'}
          </Text>
        </View>
      ) : (
        rows.map((tx) => (
          <View key={`${tx.chainId}:${tx.type}:${tx.txHash}:${tx.id}`} className="border-b border-b-border-light py-[8px]">
            <NotificationRow tx={tx} colors={colors} colorScheme={colorScheme} />
          </View>
        ))
      )}
    </BottomSheet>
  );
}
