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
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { useState } from 'react';
import { getPoolPath } from '@/config/pool-paths';
import { View, Text, Pressable, useWindowDimensions, Platform } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { useRouter } from 'expo-router';
import { useShareYield } from '@/hooks/use-share-yield';
import { formatApyPercent } from '@/services/share-yield';

import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Path, Circle, Line, Polyline } from 'react-native-svg';
import { Card } from '@/components/ui/card';
import { DashedEllipse } from '@/components/ui/dashed-ellipse';
import { PrivacyScore } from '@/components/ui/privacy-score';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';
import { useYieldFeeds } from '@/hooks/use-yield-feeds';
import { HoverHint } from '@/components/ui/hover-hint';

const WEB_OVERLAY_POSITION = Platform.select({ web: { position: 'fixed' }, default: { position: 'absolute' } }) as Record<string, string>;

const ROW_CHART_W = 640;
const ROW_CHART_H = 72;

/**
 * The expanded row's APY history. A REAL yield row plots the NET realized
 * APY series from the ASP feeds (hooks/use-yield-feeds.ts, ppUSDC rate
 * history) once the feed describes THIS row's share and at least two samples
 * exist; a vault the feed does not cover (ppUSDT today) says so instead of
 * drawing anything.
 */
/**
 * The APY cell: the LIVE net rate of THIS row's share, read on chain through
 * the same hook the My Pools chip uses, so the two pages agree. The page-level
 * `aprText` (the ASP feed's 30-day realized ppUSDC figure, or the configured
 * placeholder) is only the fallback while the read is in flight or fails.
 * Before this the feed figure was stamped on
 * every yield row of the chain, so an ETH position wore USDC's rate (Mike,
 * 2026-09-21: "1.16% APY on My Pools, 3.12% APR on Portfolio").
 */
function PositionApy({ position }: { position: Position }) {
  const { yield: live } = useShareYield({
    chainId: position.chainId,
    tokenAddress: position.shareAddress,
    enabled: !!position.yield,
  });
  const text = live ? `${formatApyPercent(live.netApyPercent)}%` : position.aprText ?? null;
  return (
    <Text
      className={`font-pp-semi-bold text-[13px] leading-[13px] ${text ? 'text-success' : 'text-text-muted'}`}
      testID="position-apy"
    >
      {text ?? '\u2014'}
    </Text>
  );
}

function RowYieldHistory({ position, colors }: { position: Position; colors: (typeof Colors)['light'] }) {
  const feeds = useYieldFeeds({ chainId: position.chainId ?? 0, period: '30D' });
  const feedIsThisVault = !!position.shareAddress && !!feeds.feedShareAddress
    && feeds.feedShareAddress === position.shareAddress.toLowerCase();
  const realReady = feeds.yieldFeedsAvailable && feedIsThisVault && feeds.netApySeriesPercents.length >= 2;
  const venue = position.venueLabel ?? 'Aave v3';
  if (!realReady) {
    return (
      <Text className="font-pp-regular text-[11px] text-text-muted">
        {feeds.isLoading ? 'Loading APY history…' : 'APY history is not available yet for this vault.'}
      </Text>
    );
  }
  return (
    <>
      <Text className="font-pp-regular text-[10px] uppercase tracking-[0.4px] text-text-muted">Net APY · 30D · {venue}</Text>
      <RowYieldChart series={feeds.netApySeriesPercents} colors={colors} />
    </>
  );
}

/**
 * Sparkline over a series of APY percents, oldest to newest.
 *
 * The plotted band is the DATA range plus a tenth of itself as headroom above
 * and below, never zero to max. A rate series moves in tenths of a point, so a
 * zero-based axis would draw every pool as a flat line; but the old version
 * said nothing about that and inset the line by a fixed 6px, which put the
 * lowest sample on the floor of the box and read as a climb from nothing
 * (Nathaniel, QA 2026-09-21: "this graph looks like it's going from 0 - high").
 *
 * Two things now say so. The padding is in DATA space, so the gap above and
 * below is proportional to the swing and the line cannot ride an edge. And the
 * two figures are drawn as dashed rules AT their own heights, which frames the
 * band as a window onto a range rather than as the full height of the chart.
 * The hint spells it out for anyone who still reads the floor as zero.
 */
const ROW_CHART_PAD_RATIO = 0.1;

function RowYieldChart({ series, colors }: { series: number[]; colors: (typeof Colors)['light'] }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(0.0001, max - min);
  const lo = min - range * ROW_CHART_PAD_RATIO;
  const span = range * (1 + ROW_CHART_PAD_RATIO * 2);
  const yOf = (v: number) => ROW_CHART_H - ((v - lo) / span) * ROW_CHART_H;
  const yTop = yOf(max);
  const yBottom = yOf(min);
  const coords = series
    .map((v, i) => {
      const x = (i / Math.max(1, series.length - 1)) * ROW_CHART_W;
      return `${x.toFixed(1)},${yOf(v).toFixed(1)}`;
    })
    .join(' ');
  const axisHint = `Axis covers ${min.toFixed(2)}% to ${max.toFixed(2)}%. It does not start at zero.`;

  return (
    <View className="flex-row gap-[8px]">
      <HoverHint hint={axisHint} testID="row-yield-axis-hint">
        {/* The two figures sit at the heights they describe, so the band
            between them is visibly narrower than the box. */}
        {/* nw-keep(measured-or-inset): label offsets are the computed pixel
            heights of the two data bounds inside the plot box. */}
        <View className="w-[40px]" style={{ height: ROW_CHART_H }}>
          <Text
            className="font-pp-regular text-[10px] leading-[12px] text-right text-text-muted"
            // nw-keep(measured-or-inset): centred on the max gridline
            style={{ position: 'absolute', right: 0, top: yTop - 6 }}
          >
            {max.toFixed(2)}%
          </Text>
          <Text
            className="font-pp-regular text-[10px] leading-[12px] text-right text-text-muted"
            // nw-keep(measured-or-inset): centred on the min gridline
            style={{ position: 'absolute', right: 0, top: yBottom - 6 }}
          >
            {min.toFixed(2)}%
          </Text>
        </View>
      </HoverHint>
      <View className="flex-1">
        {/* nw-keep(svg-or-canvas): grid/series stroke colors are theme tokens fed to
            react-native-svg stroke props (no className path on SVG primitives). */}
        <Svg width="100%" height={ROW_CHART_H} viewBox={`0 0 ${ROW_CHART_W} ${ROW_CHART_H}`} preserveAspectRatio="none">
          {/* The two bounds of the plotted range. The old single rule sat at
              half height, where no value lives, and read as a baseline. */}
          <Line x1="0" y1={yTop} x2={ROW_CHART_W} y2={yTop} stroke={colors.border} strokeWidth={1} strokeDasharray="4 4" />
          <Line x1="0" y1={yBottom} x2={ROW_CHART_W} y2={yBottom} stroke={colors.border} strokeWidth={1} strokeDasharray="4 4" />
          <Polyline points={coords} fill="none" stroke={colors.success} strokeWidth={2} />
        </Svg>
      </View>
    </View>
  );
}

type Position = {
  id: string;
  poolName: string;
  canonicalPoolSymbol?: string;
  poolIcon?: string;
  chainName: string;
  /**
   * Chain the position lives on. Required for the pool link: omitting it made
   * getPoolDetailPath fall back to the DEFAULT chain, so a Sepolia holding
   * linked to /chains/ethereum/... — and the pool page pins the app to the
   * chain named in the URL, silently moving the user to mainnet.
   */
  chainId?: number;
  chainIcon?: string;
  myValueToken: string;
  shareHint?: string | null;
  myValueUsd: string;
  /** Pending funds for this token — shown as a labeled secondary line. */
  pendingLabel?: string | null;
  /**
   * Yield earned on this position, pre-formatted with its unit (e.g.
   * "+12 USDC"). Rendered in green beside the venue below the value — kept
   * separate from pendingLabel, which means "not yet spendable", the opposite
   * of earned.
   */
  earnedText?: string | null;
  /** Venue the yield comes from, e.g. "Aave v3". Small, muted, next to earned. */
  venueLabel?: string | null;
  /**
   * Fallback rate for this position, pre-formatted (e.g. "3.24%"): the page's
   * chain-level feed figure or the configured placeholder. The cell prefers the
   * row's own live on-chain rate (PositionApy) whenever it has one.
   */
  aprText?: string | null;
  /** A REAL yield-share position (ppUSDC). Only yield rows expand to
   *  the APY history; an ordinary ETH/USDC row has no yield history to show. */
  yield?: boolean;
  /** Share address of a yield row (matches the ASP feed to this vault). */
  shareAddress?: string;
  /** Exact note asset for actions when the headline is an underlying value. */
  actionSymbol?: string;
  /**
   * Ordinary relayer withdraw allowed for this row. A yield-share row uses
   * the same path and pays out actionSymbol, without router redemption.
   */
  withdrawEnabled?: boolean;
  privacyScore: number;
};

type AllPositionsProps = {
  positionsCount?: number;
  netValue?: string;
  isConnected?: boolean;
  hasPositions?: boolean;
  onDeposit?: () => void;
  positions?: Position[];
};

// Arrow right icon
function ArrowRightIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 12 12" fill="none">
      {/* nw-keep(svg-or-canvas): caller color prop into the arrow stroke (SVG glyph, no className path) */}
      <Path
        d="M6.75 2.25L10.5 6M10.5 6L6.75 9.75M10.5 6H1.5"
        stroke={color}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// Menu icon (three dots vertical)
function MenuDotsIcon({ color = '#4D4D4D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      {/* nw-keep(svg-or-canvas): caller color prop into the dot fills (SVG glyph, no className path) */}
      <Circle cx={8} cy={3} r={1.5} fill={color} />
      <Circle cx={8} cy={8} r={1.5} fill={color} />
      <Circle cx={8} cy={13} r={1.5} fill={color} />
    </Svg>
  );
}

export function AllPositions({
  positionsCount = 0,
  netValue = '$0.00',
  isConnected = false,
  hasPositions = false,
  onDeposit,
  positions = [],
}: AllPositionsProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const isMobile = width <= 450;
  const showPrivacyScore = false; // Privacy Score removed per feedback
  const showViewPoolText = width >= 626;
  // DEV-568: desktop rows carry Withdraw and View Pool themselves and have no
  // three-dot menu. Only the mobile layout, which has no actions column, keeps
  // the menu as its way to both.
  // Below 543px the fixed VALUE and APY columns leave no room for inline
  // actions, so that narrow layout keeps the menu too.
  const menuOnly = isMobile || width < 543;
  const showRowWithdraw = !menuOnly;
  const showYieldEarned = width >= 543;
  const [showAll, setShowAll] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Rows expanded to reveal their yield chart. Independent of the row menu. */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (positionId: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(positionId)) next.delete(positionId);
      else next.add(positionId);
      return next;
    });
  const { connectWallet } = useSupportedWalletConnection();
  const { openWithdrawModal } = useWithdrawModal();
  const router = useRouter();

  const handleConnectWallet = () => {
    connectWallet();
  };

  const handleDeposit = () => {
    onDeposit?.();
  };

  const handleMenuPress = (positionId: string) => {
    setOpenMenuId(openMenuId === positionId ? null : positionId);
  };

  const closeMenu = () => {
    setOpenMenuId(null);
  };

  // A phone hides the header that carries Show All, so it lists every position.
  // Uncapped from the first render: a tap that mounted the rest would fetch
  // their live APY (useShareYield) at a time the tap chose.
  const displayPositions = showAll || isMobile ? positions : positions.slice(0, 5);

  return (
    <Card
      noPadding
      className="z-[99999]"
      // nw-keep(forwarded-style-contract): caller-last overflow:visible must beat Card's base
      // overflow-hidden so the row dropdown escapes the card (DROPDOWN_ZINDEX_PATTERN.md).
      style={{ overflow: 'visible' }}
    >
      <View className="flex-row flex-wrap items-center justify-between gap-[12px] border-b border-b-border-light p-[16px]">
        <View className="flex-row items-center gap-[10px]">
          <Text className="font-pp-bold text-[16px] leading-[16px] text-text">
            All Positions
          </Text>
          <Text className="font-pp-bold text-[12px] leading-[12px] text-text">
            ({positionsCount})
          </Text>
        </View>
        {!isMobile && (
          <View className="flex-row items-center gap-[8px]">
            <Text className="font-pp-regular text-[12px] leading-[12px] text-text-light">
              Net value:
            </Text>
            <Text className="font-pp-semi-bold text-[12px] leading-[12px] text-text">
              {netValue}
            </Text>
            {/* Only when there are rows past the cap to show. */}
            {positions.length > 5 && (
              <Pressable
                className="flex-row items-center gap-[4px]"
                onPress={() => setShowAll(!showAll)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showAll }}
                accessibilityLabel={showAll ? 'Show fewer positions' : 'Show all positions'}
              >
                <Text className="font-pp-regular text-[12px] text-text">
                  {showAll ? 'Show Less' : 'Show All'}
                </Text>
                <Ionicons
                  name={showAll ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  // nw-keep(data-color): chevron glyph color is a theme token into the vector-icon sink
                  color={colors.text}
                />
              </Pressable>
            )}
          </View>
        )}
      </View>

      {/* Positions List */}
      <View className={hasPositions ? 'relative overflow-visible' : 'min-h-[195px]'}>
        {hasPositions ? (
          <View className="relative overflow-visible px-[16px] py-[8px]">
            {/* Table Header */}
            <View className="flex-row items-center gap-[8px]">
              <View className="relative z-[1] flex-[2] p-[8px]">
                <Text className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted">POOL</Text>
              </View>
              <View className="relative z-[1] w-[170px] items-end p-[8px]">
                <Text className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted">VALUE</Text>
              </View>
              <View className="relative z-[1] w-[64px] items-end p-[8px]">
                <Text className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted">APY</Text>
              </View>
              {showYieldEarned && (
                <View className="relative z-[1] flex-1 p-[8px]">
                  <Text className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted">YIELD EARNED</Text>
                </View>
              )}
              {showPrivacyScore && (
                <View className="relative z-[1] flex-1 p-[8px]">
                  <Text className="font-pp-semi-bold text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted">PRIVACY SCORE</Text>
                </View>
              )}
              {!isMobile && <View className={showViewPoolText || showRowWithdraw ? 'relative z-[1] flex-1 p-[8px]' : 'relative z-[1] w-[28px] p-[8px]'} />}
              <View className="relative z-[99999] w-[24px] items-center justify-center overflow-visible" />
              <View className="relative z-[1] w-[20px]" />
            </View>

            {/* Table Rows */}
            {displayPositions.map((position, index) => (
              <View key={position.id} className={openMenuId === position.id ? 'relative z-[99999] overflow-visible' : 'relative z-[1] overflow-visible'}>
                {/* z-1 on the row strip, and it has to be HERE rather than a
                    bigger number on the menu.
                    react-native-web gives every View `z-index: 0` in its base
                    style, so this strip is `position: relative; z-index: 0` and
                    is therefore a stacking context of its own. The menu's
                    99999 is sealed inside it and never competes with anything
                    outside; what competes is this strip, at 0, against the
                    expanded chart below it, also at 0 and later in the
                    document. The chart won, and since it has no background
                    only its green stroke showed, over the word "Withdraw"
                    (Nathaniel, QA 2026-09-21). Raising the strip itself is
                    what puts the whole row, menu included, over its chart. */}
                <View className="relative z-[1] flex-row items-center gap-[8px] overflow-visible">
                  {/* Pool — icon, name, and the holding line beneath it. Also
                      the expand/collapse target for this row's yield chart. */}
                  <Pressable
                    className="relative z-[1] flex-[2] flex-row items-center gap-[10px] p-[8px]"
                    // Only a yield row has an APY history to
                    // expand; every ordinary row used to open the fabricated
                    // Aave chart (codex audit 2026-08-25).
                    onPress={position.yield ? () => toggleExpanded(position.id) : undefined}
                    disabled={!position.yield}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: expandedIds.has(position.id) }}
                    accessibilityLabel={position.yield
                      ? `${expandedIds.has(position.id) ? 'Hide' : 'Show'} ${position.poolName} yield chart`
                      : `${position.poolName} position`}
                    testID={`position-row-toggle-${position.poolName}`}
                  >
                    <TokenNetworkIcon symbol={position.canonicalPoolSymbol ?? position.poolName} size={32} chainId={position.chainId} />
                    <View className="flex-1 gap-[4px]">
                      <View className="flex-row items-center gap-[6px]">
                        <Text className="font-pp-bold text-[13px] leading-[13px] text-text">
                          {position.poolName}
                        </Text>
                        {/* No venue tag beside the name (Mike, 2026-09-21: "held on
                            Aave v3" dropped). The venue still names itself in the
                            APR column and the yield hint. */}
                        {position.venueLabel ? null : position.actionSymbol ? (
                          <Text className="font-pp-regular text-[10.5px] text-text-muted">
                            held as {position.actionSymbol}
                          </Text>
                        ) : null}
                      </View>
                      {/* The holding itself — "earning" only where the position
                          actually sits in a yield venue, so a plain pool balance
                          is not mislabeled as accruing. */}
                      {/* The (i) rides on the amount's line: as a column
                          sibling it took a line of its own (Ameen, QA
                          2026-10-25). The amount shrinks, the (i) never does. */}
                      <View className="flex-row items-center gap-[4px]">
                        <Text
                          numberOfLines={1}
                          className="shrink font-pp-regular text-[11px] leading-[12px] text-text-secondary"
                        >
                          {position.myValueToken}
                          {position.venueLabel ? ' earning' : ''}
                        </Text>
                        <ShareCountHint hint={position.shareHint ?? null} />
                      </View>
                      {position.pendingLabel ? (
                        <Text className="font-pp-regular text-[11px] leading-[12px] text-text-muted">
                          {position.pendingLabel}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  {/* Value — the position's USD value. Yield earned has its own
                      column now (Mike, 2026-09-21), so it no longer stacks here. */}
                  <View className="relative z-[1] w-[170px] items-end p-[8px]">
                    <Text className="font-pp-semi-bold text-[13px] leading-[13px] text-text">
                      {position.myValueUsd}
                    </Text>
                  </View>
                  {/* APY — the position's current live rate. Em dash where a
                      position has no yield venue (a plain pool holding earns
                      nothing, and 0% would read as a broken feed). */}
                  <View className="relative z-[1] w-[64px] items-end p-[8px]">
                    <PositionApy position={position} />
                  </View>
                  {/* Yield Earned — replaces the Pool Value column, which said
                      nothing about the holder's own position. Green for a
                      positive figure (services/yield-earned.ts); muted for a
                      zero; an em dash where the SDK gives no figure or its
                      error bound shows at display precision. */}
                  {showYieldEarned && (
                    <View className="relative z-[1] flex-1 p-[8px]">
                      <Text
                        className={`font-pp-semi-bold text-[12px] leading-[12px] ${position.earnedText && (position.earnedText.startsWith('+') || position.earnedText.startsWith('<')) ? 'text-success' : 'text-text-muted'}`}
                        testID="position-yield-earned"
                      >
                        {position.earnedText ?? '\u2014'}
                      </Text>
                    </View>
                  )}
                  {/* Privacy Score */}
                  {showPrivacyScore && (
                    <View className="relative z-[1] flex-1 p-[8px]">
                      <PrivacyScore score={position.privacyScore} />
                    </View>
                  )}
                  {/* Row actions. Withdraw used to live ONLY behind the
                      kebab, so the portfolio read as a page with nothing to do
                      on it (Nathaniel, QA 2026-09-21: "Portfolio page has no
                      CTA's"). It is the same call the kebab makes, just visible
                      where there is room for it; the kebab keeps both actions
                      for narrower widths. */}
                  {!isMobile && (
                    <View className={showViewPoolText || showRowWithdraw ? 'relative z-[1] flex-1 flex-row items-center gap-[14px] p-[8px]' : 'relative z-[1] w-[28px] p-[8px]'}>
                      {showRowWithdraw && position.withdrawEnabled !== false && (
                        <Pressable
                          onPress={() => openWithdrawModal(undefined, { tokenSymbol: position.actionSymbol ?? position.canonicalPoolSymbol ?? position.poolName })}
                          accessibilityRole="button"
                          accessibilityLabel={`Withdraw ${position.poolName}`}
                          testID={`position-withdraw-${position.poolName}`}
                        >
                          <Text className="font-pp-regular text-[12px] leading-[12px] text-text underline">
                            Withdraw
                          </Text>
                        </Pressable>
                      )}
                      <Pressable
                        className="flex-row items-center gap-[6px]"
                        onPress={() => router.push(getPoolPath(position.actionSymbol ?? position.canonicalPoolSymbol ?? position.poolName, position.chainId) as Parameters<typeof router.push>[0])}
                      >
                        {showViewPoolText && (
                          <Text className="font-pp-regular text-[12px] leading-[12px] text-text">
                            View Pool
                          </Text>
                        )}
                        {/* nw-keep(data-color): theme-token color into the ArrowRight SVG icon component */}
                        <ArrowRightIcon color={colors.text} />
                      </Pressable>
                    </View>
                  )}
                  {/* Menu: mobile only (DEV-568). On desktop it only repeated
                      the row's View Pool and Withdraw. */}
                  {!menuOnly ? (
                    <View className="w-[24px]" />
                  ) : (
                  <View className="relative z-[99999] w-[24px] items-center justify-center overflow-visible">
                    <Pressable
                      className="rounded-card bg-background-secondary p-[4px]"
                      onPress={() => handleMenuPress(position.id)}
                    >
                      {/* nw-keep(data-color): theme-token color into the MenuDots SVG icon component */}
                      <MenuDotsIcon color={colors.textSecondary} />
                    </Pressable>
                    {/* Dropdown Menu */}
                    {openMenuId === position.id && (
                      <>
                        <Pressable
                          className="inset-0 z-[9998]"
                          // nw-keep(platform-css): web-only fixed overlay (native falls back to absolute) — the tap-catcher
                          style={WEB_OVERLAY_POSITION}
                          onPress={closeMenu}
                        />
                        <View
                          className="absolute right-0 top-[28px] z-[99999] min-w-[160px] rounded-card border border-border-light bg-menu-background p-[6px]"
                          // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                          style={DROPDOWN_SHADOW}
                        >
                          {/* Real actions only — the old View Details /
                              Add to Position / Share rows were no-ops. */}
                          <Pressable
                            className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                            onPress={() => { closeMenu(); router.push(getPoolPath(position.actionSymbol ?? position.canonicalPoolSymbol ?? position.poolName, position.chainId) as Parameters<typeof router.push>[0]); }}
                          >
                            {/* nw-keep(data-color): theme-token color into the vector-icon sink */}
                            <Ionicons name="eye-outline" size={16} color={colors.text} />
                            <Text className="font-pp-regular text-[14px] text-text">
                              View Pool
                            </Text>
                          </Pressable>
                          {/* Yield shares use the ordinary relayer path too.
                              actionSymbol keeps the payout named ppUSDC rather
                              than launching the legacy USDC pool. */}
                          {position.withdrawEnabled !== false && (
                            <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { closeMenu(); openWithdrawModal(undefined, { tokenSymbol: position.actionSymbol ?? position.canonicalPoolSymbol ?? position.poolName }); }}>
                              {/* nw-keep(data-color): theme-token color into the vector-icon sink */}
                              <Ionicons name="remove-outline" size={16} color={colors.text} />
                              <Text className="font-pp-regular text-[14px] text-text">
                                Withdraw
                              </Text>
                            </Pressable>
                          )}
                        </View>
                      </>
                    )}
                  </View>
                  )}
                  {/* Expand caret — mirrors the row's Pool press target at the
                      far edge. A separate Pressable rather than wrapping the
                      whole row: the row already holds the menu and View Pool
                      buttons, and nesting them would emit button-in-button. */}
                  {position.yield ? (
                    <Pressable
                      className="relative z-[1] w-[20px] items-center justify-center"
                      onPress={() => toggleExpanded(position.id)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: expandedIds.has(position.id) }}
                      accessibilityLabel={`${expandedIds.has(position.id) ? 'Hide' : 'Show'} ${position.poolName} yield chart`}
                    >
                      <Text className="text-[11px] leading-[13px] text-text-secondary">
                        {expandedIds.has(position.id) ? '\u25b4' : '\u25be'}
                      </Text>
                    </Pressable>
                  ) : (
                    <View className="relative z-[1] w-[20px]" />
                  )}
                </View>
                {/* Expanded: this position's yield history (RowYieldHistory: the
                    ASP net APY series, plain text when the feed does not cover
                    this vault). */}
                {expandedIds.has(position.id) && position.yield && (
                  <View className="gap-[8px] px-[8px] pb-[14px] pt-[2px]">
                    <RowYieldHistory position={position} colors={colors} />
                  </View>
                )}
                {/* Divider between rows */}
                {index < displayPositions.length - 1 && (
                  <View className="relative z-[-1] h-[1px] self-stretch bg-border-light" />
                )}
              </View>
            ))}
          </View>
        ) : (
          <View className="relative min-h-[195px] items-center justify-center overflow-hidden">
            {/* Dashed Ellipse */}
            <View className="absolute h-[430px] w-[430px]">
              {/* nw-keep(data-color): scheme-resolved stroke/fill tokens into the DashedEllipse SVG props */}
              <DashedEllipse
                strokeColor={colors.borderLight}
                fillColor={colors.cardBackground}
              />
            </View>

            {/* Text and Button */}
            <View className="items-center gap-[16px]">
              <Text className="font-pp-medium text-[16px] leading-[19.2px] text-center text-text">
                No positions yet.{'\n'}Make your first one now
              </Text>
              {isConnected ? (
                <Pressable
                  className="rounded-[4px] bg-button-primary px-[20px] py-[10px]"
                  onPress={handleDeposit}
                >
                  <Text className="font-pp-medium text-[14px] text-center text-button-primary-text">
                    Deposit
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  className="rounded-[4px] bg-button-primary px-[20px] py-[10px]"
                  onPress={handleConnectWallet}
                >
                  <Text className="font-pp-medium text-[14px] text-center text-button-primary-text">
                    Connect Wallet
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      </View>
    </Card>
  );
}
