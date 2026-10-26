import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Card } from '@/components/ui/card';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { BlockchainFilter } from '@/components/pools/blockchain-filter';
import { getChainConfig } from '@/config/chains';
import { getPoolPath, isSupersededLegacyPool } from '@/config/pool-paths';
import { formatUsd } from '@/services/format-fiat';
import { displayTokenSymbol } from '@/services/share-display';
import { ShareApyChip } from '@/components/yield/share-apy-chip';
import { applyChainFilter, poolsWindow, showMoreLabel } from '@/services/explore-pools';
import type { GlobalStatisticsView, StatsAssetRow } from '@/hooks/use-global-statistics';

/**
 * Every per-asset figure the ASP can publish, in display order. Declared once
 * so the card can work out which of them the deployed API actually sends and
 * lay every row out on the SAME columns — a per-row "omit if null" made the
 * figures shift sideways from row to row whenever one pool was missing a field.
 */
const STAT_COLUMNS: { key: string; label: string; get: (row: StatsAssetRow) => string | null }[] = [
  { key: 'accepted', label: 'Accepted', get: (r) => (r.fundsAcceptedUsd === null ? null : formatUsd(r.fundsAcceptedUsd)) },
  { key: 'pending', label: 'Pending', get: (r) => (r.pendingUsd === null ? null : formatUsd(r.pendingUsd)) },
  { key: 'deposits', label: 'Deposits', get: (r) => (r.depositsCount === null ? null : r.depositsCount.toLocaleString('en-US')) },
  { key: 'withdrawals', label: 'Withdrawals', get: (r) => (r.withdrawalsCount === null ? null : r.withdrawalsCount.toLocaleString('en-US')) },
  { key: 'transfers', label: 'Transfers', get: (r) => (r.transfersCount === null ? null : r.transfersCount.toLocaleString('en-US')) },
  { key: 'avgDeposit', label: 'Avg deposit', get: (r) => (r.avgDepositUsd === null ? null : formatUsd(r.avgDepositUsd)) },
  { key: 'medianDeposit', label: 'Median deposit', get: (r) => (r.medianDepositUsd === null ? null : formatUsd(r.medianDepositUsd)) },
];

type StatColumn = (typeof STAT_COLUMNS)[number];

// The Chain menu is absolutely positioned inside the card header and has to
// escape the card's own overflow:hidden. Card applies the caller's `style`
// last, which is the documented way to override it (DROPDOWN_ZINDEX_PATTERN.md).
// nw-keep(forwarded-style-contract): caller-last overflow must beat Card's base class
const CARD_OVERFLOW = { overflow: 'visible' } as const;

/**
 * One label/value pair in a row's stat strip. A column only exists at all when
 * some pool has the figure (see activeColumns); within it, a pool the ASP has
 * no value for shows "n/a": not published, never a fabricated $0 (and no em
 * dash, per the copy rule).
 */
function MiniStat({ label, value, stacked }: { label: string; value: string | null; stacked: boolean }) {
  return (
    <View className={stacked ? 'w-1/3 gap-[2px] pr-[8px]' : 'flex-1 gap-[2px]'}>
      <Text
        numberOfLines={1}
        className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted"
      >
        {label}
      </Text>
      {/* Colour is fully conditional (no unconditional text-* token in the
          string) so co-active classes can't fight over CSS emission order. */}
      <Text
        numberOfLines={1}
        className={`font-pp-semi-bold text-[13px] leading-[16px] ${value === null ? 'text-text-muted' : 'text-text'}`}
      >
        {value ?? 'n/a'}
      </Text>
    </View>
  );
}

function AssetRow({
  row,
  columns,
  stacked,
  last,
}: {
  row: StatsAssetRow;
  columns: StatColumn[];
  stacked: boolean;
  last: boolean;
}) {
  const router = useRouter();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // The row headlines the underlying ("USDC"); the route and testID keep the pool symbol.
  const symbol = displayTokenSymbol(row.symbol);
  const chainLabel = getChainConfig(row.chainId)?.displayName ?? null;

  return (
    // The WHOLE row navigates to that pool's detail page. Path comes from the
    // shared getPoolPath() helper (config/chains.ts) — the same one All
    // Pools / My Privacy Pools / the portfolio table use — so the Sui special
    // case and the chain-name segment stay in one place.
    <Pressable
      className={`px-[16px] py-[14px] active:bg-background-secondary ${last ? '' : 'border-b border-b-border-light'}`}
      onPress={() => router.push(getPoolPath(row.symbol, row.chainId) as Parameters<typeof router.push>[0])}
      accessibilityRole="button"
      // Chain-qualified, both of them: the table spans chains now, so "ETH"
      // alone names a Sepolia row and a mainnet row at once.
      accessibilityLabel={`${symbol} pool statistics on ${chainLabel ?? `chain ${row.chainId}`}`}
      testID={`stats-pool-row-${row.chainId}-${row.symbol}`}
    >
      <View className={stacked ? 'gap-[12px]' : 'flex-row items-center gap-[16px]'}>
        {/* Identity + TVL: the row's anchor, on one line. Given ~1.6 columns'
            worth of the row so the ticker, chain and TVL never crowd, while
            the figures beside it still spread over the remaining width. */}
        <View className={stacked ? 'gap-[6px]' : 'min-w-[220px] flex-[1.6] gap-[6px]'}>
          {/* Line 1: the chain-badged token mark (the badge says which chain, so
              no chain name) and the symbol. The 24h TVL change used to sit here
              and was dropped (Ameen, 2026-09-08: "just get rid of the tvl growth
              here") — it read as yield to Nat, and on a pool this small a day's
              inflow swings it into the thousands of percent. */}
          <View className="flex-row items-center gap-[8px]">
            <TokenNetworkIcon symbol={row.symbol} size={24} chainId={row.chainId} />
            <Text className="font-pp-bold text-[14px] leading-[16px] text-text">{symbol}</Text>
          </View>
          {/* Line 2: the money, then the live net APY of a yield-bearing share
              (the same chip as My balances); nothing for a plain asset. */}
          <View className="flex-row flex-wrap items-center gap-x-[8px] gap-y-[4px]">
            {row.tvlUsd === null ? null : (
              <Text className="font-pp-bold text-[19px] leading-[23px] text-text">{formatUsd(row.tvlUsd)}</Text>
            )}
            {row.tvlTokenText === null ? null : (
              <Text numberOfLines={1} className="font-pp-regular text-[11.5px] leading-[14px] text-text-secondary">
                {row.tvlTokenText}
              </Text>
            )}
            <ShareApyChip chainId={row.chainId} tokenAddress={row.tokenAddress} testID={`stats-pool-apy-${row.chainId}-${row.symbol}`} />
          </View>
        </View>

        {/* The figures, spread across the rest of the row rather than packed
            against the identity block. On a wide screen the old fixed-width
            strip left most of the card empty. */}
        <View className={stacked ? 'flex-row flex-wrap gap-y-[10px]' : 'flex-[3] flex-row items-center gap-[12px]'}>
          {columns.map((column) => (
            <MiniStat key={column.key} label={column.label} value={column.get(row)} stacked={stacked} />
          ))}
        </View>

        {/* The row navigates; on a wide screen the chevron says so and closes
            off the right edge instead of leaving it ragged. */}
        {stacked ? null : (
          // nw-keep(data-color): theme-token color into the vector-icon sink
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        )}
      </View>
    </Pressable>
  );
}

/**
 * Per-pool (per-asset) rows — REAL data, all of it from
 * `apiClient.getAssetsStats('all')` (`AssetsStatsResponse.assets`):
 *   Pool TVL $      ← totalInAssetValueUsd (stablecoin-repaired, see the hook)
 *   Pool TVL token  ← totalInAssetValue ÷ decimals
 *   Funds accepted  ← acceptedDepositsValueUsd (falls back to totalDeposits*)
 *   Pending         ← pendingDepositsValueUsd
 *   Deposits        ← totalDepositsCount
 * Nothing here is fabricated, and any field the ASP omits is omitted from the
 * card rather than rendered as a zero.
 *
 * EVERY CHAIN THE BUILD SERVES, not the selected one: Explore is the protocol
 * page, so a viewer standing on Citrea should still see the mainnet and
 * Optimism pools. The table's own Chain control (top right) narrows it, and it
 * is the SAME BlockchainFilter the transactions feed below uses, so the two
 * controls behave identically instead of being two dropdowns that look alike.
 *
 * All of the arithmetic (scope, order, window) lives in services/explore-pools.ts:
 * CI runs `bun test services scripts` and never renders a component.
 */
export function StatsAssetCards({ stats }: { stats: GlobalStatisticsView }) {
  const { assets, chainOptions, isAssetsLoading, error } = stats;
  const { width } = useWindowDimensions();
  const stacked = width < 620;
  // A column earns its place only if SOME pool has that figure — a field the
  // deployed API never sends stays off the card entirely, rather than becoming
  // a strip of em dashes.
  const activeColumns = STAT_COLUMNS.filter((column) => assets.some((row) => column.get(row) !== null));

  const [chainFilter, setChainFilter] = useState<Set<number>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  // A plain pool a share replaced (legacy ETH once ppETH opened) is not a pool
  // to explore: two rows named ETH with the closed one on top by TVL was the
  // reading this avoids (Pat, 2026-09-18). Its notes stay reachable from My
  // balances and its -legacy URL.
  const listed = assets.filter((row) => !isSupersededLegacyPool(row.symbol, row.chainId));
  const rows = applyChainFilter(listed, chainFilter);

  // The expansion and the page are stored WITH the chain selection they belong
  // to, so narrowing the filter falls back to the short table by derivation:
  // no reset effect, no state write during render. (`poolsWindow` still clamps
  // the page, for the case the list shrinks under the SAME selection because a
  // refetch dropped a pool.)
  const viewKey = [...chainFilter].sort((a, b) => a - b).join(',');
  const [pager, setPager] = useState({ viewKey, expanded: false, page: 0 });
  const onCurrentView = pager.viewKey === viewKey;
  // The top-3 collapse is for the unfiltered list. With chains picked, the
  // three richest pools were often all on one chain (Ethereum's three, on
  // prod), so choosing Ethereum + Citrea looked like Citrea had been ignored:
  // its pool sat behind "Show more" (Pat, 2026-09-04). A chosen filter shows
  // everything it matches, paged.
  const win = poolsWindow({
    total: rows.length,
    expanded: chainFilter.size > 0 || (onCurrentView && pager.expanded),
    page: onCurrentView ? pager.page : 0,
  });
  const visible = rows.slice(win.start, win.end);

  const header = (
    <View className="z-[99999] flex-row items-center justify-between gap-[10px] overflow-visible border-b border-b-border p-[16px]">
      <View className="flex-row items-baseline gap-[6px]">
        <Text className="font-pp-bold text-[16px] leading-[16px] text-text">Pools</Text>
        <Text className="font-pp-bold text-[12px] leading-[12px] text-text-secondary">({rows.length})</Text>
      </View>
      <View className="flex-row items-center gap-[14px] overflow-visible">
        {/* Only worth a control when there is something to choose between. */}
        {chainOptions.length >= 2 ? (
          <BlockchainFilter
            open={filterOpen}
            onToggle={() => setFilterOpen(!filterOpen)}
            onClose={() => setFilterOpen(false)}
            options={chainOptions}
            selected={chainFilter}
            onChange={setChainFilter}
            align="end"
          />
        ) : null}
      </View>
    </View>
  );

  if (assets.length === 0) {
    return (
      // Same overflow contract as the populated card below, so the message and
      // the table are the same shape.
      <Card noPadding style={CARD_OVERFLOW}>
        {header}
        <View className="p-[20px]">
          <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">
            {isAssetsLoading
              ? 'Loading pool statistics…'
              : error
                ? `Pool statistics are unavailable right now (${error})`
                : 'No pool statistics published yet.'}
          </Text>
        </View>
      </Card>
    );
  }

  return (
    // ONE container, pools as rows inside it — they were separate cards with
    // a gutter between each, which spent a lot of height on chrome and made
    // three pools look like three unrelated things.
    //
    // z-[90] beats the transactions card's z-[80] below: the Chain menu opens
    // downward, over that card (DROPDOWN_ZINDEX_PATTERN.md).
    <Card noPadding className="z-[90]" style={CARD_OVERFLOW}>
      {header}
      {/* Below the header's stacking context, so the row borders cannot paint
          over an open Chain menu (DROPDOWN_ZINDEX_PATTERN.md §6). */}
      <View className="z-[1]">
        {rows.length === 0 ? (
          <View className="p-[20px]">
            <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">
              No pools on the selected chains.
            </Text>
          </View>
        ) : null}
        {visible.map((row, index) => (
          <AssetRow
            key={row.key}
            row={row}
            columns={activeColumns}
            stacked={stacked}
            last={index === visible.length - 1 && !win.showMore && !win.showPager}
          />
        ))}
        {win.showMore ? (
          <Pressable
            className="items-center px-[16px] py-[12px] active:bg-background-secondary"
            onPress={() => setPager({ viewKey, expanded: true, page: 0 })}
            accessibilityRole="button"
            accessibilityLabel={`Show ${win.showMoreCount} more pools`}
            testID="stats-pools-load-more"
          >
            {/* Same label and style as the transactions feed's own control, so
                the two on this page read alike. */}
            <Text className="font-pp-medium text-[13px] text-text-secondary">
              {showMoreLabel(win.showMoreCount, win.hiddenCount)}
            </Text>
          </Pressable>
        ) : null}
        {win.showPager ? (
          <View className="flex-row items-center justify-between border-t border-t-border-light px-[16px] py-[12px]">
            <Pressable
              className={`py-[2px] ${win.page <= 0 ? 'opacity-40' : 'opacity-100'}`}
              onPress={() => setPager({ viewKey, expanded: true, page: win.page - 1 })}
              disabled={win.page <= 0}
              accessibilityRole="button"
              testID="stats-pools-prev-page"
            >
              <Text className="font-pp-medium text-[12px] leading-[14px] text-text">Prev</Text>
            </Pressable>
            <Text className="font-pp-regular text-[12px] text-text-secondary">
              Page {win.page + 1} / {win.pageCount}
            </Text>
            <Pressable
              className={`py-[2px] ${win.page >= win.pageCount - 1 ? 'opacity-40' : 'opacity-100'}`}
              onPress={() => setPager({ viewKey, expanded: true, page: win.page + 1 })}
              disabled={win.page >= win.pageCount - 1}
              accessibilityRole="button"
              testID="stats-pools-next-page"
            >
              <Text className="font-pp-medium text-[12px] leading-[14px] text-text">Next</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Card>
  );
}
