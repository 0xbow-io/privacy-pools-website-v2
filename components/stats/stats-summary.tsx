import { Fragment } from 'react';
import { useWindowDimensions, Linking, Platform, Text, View } from 'react-native';
import { Card } from '@/components/ui/card';
import { formatUsd } from '@/services/format-fiat';
import { serverTransfersCount } from '@/services/global-stats';
import type { GlobalStatisticsView } from '@/hooks/use-global-statistics';

type Tile = {
  label: string;
  value: string;
  /** Secondary line — the same figure over the last 24h, where the ASP has one. */
  sub: string | null;
};

const ATTRIBUTION_URL = 'https://0xbow.io';

/**
 * Figure size for a five-across row. The card tops out at 1100px, so each
 * column gets ~210px on a wide screen and proportionally less as the window
 * narrows — the headline steps down with it rather than wrapping or clipping.
 */
function getFigureSize(width: number): number {
  if (width >= 1180) return 24;
  if (width >= 1024) return 21;
  if (width >= 900) return 19;
  if (width >= 760) return 17;
  return 20; // wrapped two-up layout below 760. Room for the larger figure again
}

/** Finite-or-null guard: the ASP serves numbers as strings and omits fields. */
function finiteOrNull(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function countText(raw: string | number | undefined | null): string | null {
  const n = finiteOrNull(raw);
  return n === null ? null : Math.round(n).toLocaleString('en-US');
}

function usdText(raw: string | number | undefined | null): string | null {
  const n = finiteOrNull(raw);
  return n === null ? null : formatUsd(n);
}

/** "as of 14:32" line from `GlobalStatistics.cacheTimestamp`; null if unparsable. */
function freshnessText(cacheTimestamp: string | undefined): string | null {
  if (!cacheTimestamp) return null;
  const ms = Date.parse(cacheTimestamp);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Protocol-wide summary tiles.
 *
 * REAL — every tile below reads the per-chain assets-stats feed, summed over
 * the chains in scope (hooks/use-global-statistics.ts → `totals`). It does NOT
 * read `getGlobalStatistics()` for the figures: that payload has no chain
 * breakdown, so it cannot exclude testnet volume. Field origins:
 * (`GlobalStatistics`, surfaced through usePools()/useGlobalStatistics):
 *   Total value locked   ← allTime.tvlUsd
 *   Total deposits       ← allTime.totalDepositsValueUsd  (24h: last24h.*)
 *   Deposits             ← allTime.totalDepositsCount     (24h: last24h.*)
 *   Withdrawals          ← allTime.totalWithdrawalsCount  (24h: last24h.*)
 *   Transfers            ← allTime.totalTransfersCount    (24h: last24h.*)   [PR #92]
 *
 * The Transfers tile rides an asp-v2 PR #92 field the deployed API does not
 * send yet — it is simply omitted until the field arrives (see
 * services/global-stats.ts), then appears on the normal fetch cadence.
 *
 * Average deposit and Median deposit were dropped: both are derived shapes of
 * the deposit figures already on the row, and the median had no real source at
 * all (it was a flag-gated fabrication). Nothing on this card is demo data now.
 *
 * A tile whose source does not resolve to a finite number is dropped rather
 * than rendered as $0 / NaN (config/yield.ts's omit-the-unknown policy).
 */
export function StatsSummary({ stats }: { stats: GlobalStatisticsView }) {
  const { totals, isLoading, error } = stats;
  const { width } = useWindowDimensions();
  // One divided row, the same treatment the portfolio summary uses: hairlines
  // separate the figures instead of five boxed surfaces, which reads quieter
  // and lets all five sit on a single line. Below 760px five columns would be
  // unreadable, so the row wraps two-up and the hairlines drop out.
  const isWrapped = width < 760;
  const figureSize = getFigureSize(width);

  // The all-time figures come from `totals` (chain-scoped), NOT from
  // statistics.allTime. /global/public/statistics aggregates every chain the
  // ASP indexes with no breakdown to filter by, and on a test deployment
  // Sepolia is ~99.98% of it — so the headline "protocol TVL" was testnet play
  // money. `totals` sums the per-chain feed over mainnets only, or over the
  // single test network when the user has selected one.
  //
  // NO 24h sublines. The only 24h window the ASP publishes is on
  // /global/public/statistics, which aggregates every indexed chain and cannot
  // be scoped. Attaching it to a scoped total labels other chains' activity as
  // this scope's — including on a testnet scope, where mainnet and other
  // testnets are still folded into the same number. Omitted until the API
  // offers a chain-scoped 24h source, per the omit-the-unknown policy.

  const tiles: Tile[] = [];
  const pushTile = (label: string, value: string | null, sub: string | null) => {
    if (value === null) return; // unknown ⇒ omit the tile, never render $0/NaN
    tiles.push({ label, value, sub });
  };

  // Deliberately NO 24h line on TVL: `last24h.tvlUsd` is a 24h-windowed TVL
  // whose relationship to the all-time figure (delta vs. snapshot) the ASP
  // docs don't pin down, so labelling it "+X in 24h" would be a guess.
  pushTile('Total value locked', usdText(totals.tvlUsd), null);

  pushTile(
    'Total deposits',
    usdText(totals.totalDepositsUsd),
    null,
  );

  pushTile(
    'Deposits',
    countText(totals.depositsCount),
    null,
  );

  // Withdrawals and Transfers are asp-v2 PR #92 per-asset fields. The deployed
  // API does not send them per chain yet, so both sum to null and omit
  // themselves rather than borrow the unscoped global count — which would be
  // a testnet number sitting next to mainnet-only totals. They appear on the
  // normal fetch cadence once the feed carries them.
  pushTile(
    'Withdrawals',
    countText(totals.withdrawalsCount),
    null,
  );

  pushTile(
    'Transfers',
    countText(totals.transfersCount),
    null,
  );

  // Guard on what actually renders. The tiles come from `totals` (the
  // per-chain feed) while `statistics` now only supplies the 24h sublines and
  // the freshness stamp — so keying this on `statistics` would have shown
  // "unavailable" over figures we already had, and an empty row whenever the
  // global payload arrived first. Both are optional reads below.
  if (tiles.length === 0) {
    return (
      <Card noPadding>
        <View className="gap-[10px] border-b border-b-border p-[16px]">
          <Text className="font-pp-bold text-[16px] leading-[16px] text-text">Protocol statistics</Text>
          <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
            All-time totals across every pool the ASP indexes
          </Text>
        </View>
        <View className="p-[20px]">
          <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">
            {isLoading
              ? 'Loading protocol statistics…'
              : error
                ? `Protocol statistics are unavailable right now (${error})`
                : 'Protocol statistics are unavailable right now.'}
          </Text>
        </View>
      </Card>
    );
  }

  const freshness = freshnessText(totals.cacheTimestamp ?? undefined);
  const attributionLinkProps = Platform.OS === 'web'
    ? ({ href: ATTRIBUTION_URL, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object)
    : { onPress: () => Linking.openURL(ATTRIBUTION_URL) };

  return (
    <Card noPadding>
      <View className="gap-[10px] border-b border-b-border p-[16px]">
        <Text className="font-pp-bold text-[16px] leading-[16px] text-text">Protocol statistics</Text>
        {/* Name the scope. A total that silently excludes chains is worse than
            no total. The reader has to be able to see what was counted. */}
        <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">
          All-time totals · {totals.scopeLabel}
          {totals.isTestnetScope ? ' (testnet)' : ''}
        </Text>
      </View>

      <View className={isWrapped ? 'flex-row flex-wrap' : 'flex-row items-stretch'}>
        {tiles.map((tile, index) => (
          <Fragment key={tile.label}>
            {!isWrapped && index > 0 ? (
              <View className="my-[16px] w-[1px] self-stretch bg-border" />
            ) : null}
            <View className={isWrapped ? 'w-[50%] gap-[7px] p-[16px]' : 'flex-1 gap-[7px] px-[16px] py-[18px]'}>
              <Text
                numberOfLines={1}
                className="font-pp-sans-medium text-[10px] uppercase leading-[12px] tracking-[0.4px] text-text-muted"
              >
                {tile.label}
              </Text>
              {/* The figure is the point of the column: big, tight, one line. */}
              <Text
                numberOfLines={1}
                className="font-pp-bold tracking-[-0.5px] text-text"
                // nw-keep(measured-or-inset): figure size follows the width-driven responsive scale
                style={{ fontSize: figureSize, lineHeight: Math.round(figureSize * 1.15) }}
              >
                {tile.value}
              </Text>
              {/* Reserved line so columns with and without a 24h delta keep the
                  same height and their baselines line up across the row. */}
              <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[14px] text-text-muted">
                {tile.sub ?? ' '}
              </Text>
            </View>
          </Fragment>
        ))}
      </View>

      {freshness === null ? null : (
        <View className="px-[20px] py-[12px]">
          <Text className="font-pp-regular text-[11px] leading-[12px] text-text-muted">
            <Text
              accessibilityRole="link"
              accessibilityLabel="0xbow.io"
              className="underline"
              {...attributionLinkProps}
            >
              0xbow.io
            </Text>{' '}figures as of {freshness}
          </Text>
        </View>
      )}
    </Card>
  );
}
