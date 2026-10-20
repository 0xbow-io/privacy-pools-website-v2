import type { ReactNode } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';

import { Card } from '@/components/ui/card';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { getChainConfig } from '@/config/chains';
import { usePoints } from '@/hooks/use-points';
import {
  formatCohort,
  formatCountdown,
  formatPoints,
  pointsTotal,
  type PointsRow,
  type PointsRowStatus,
} from '@/services/points';

const STATUS_LABEL: Record<PointsRowStatus, string> = {
  accruing: 'Accruing',
  activating: 'Activating',
  'pending-review': 'Under review',
  closed: 'Closed',
};

const STATUS_TONE: Record<PointsRowStatus, { border: string; text: string }> = {
  accruing: { border: 'border-success', text: 'text-success' },
  activating: { border: 'border-warning', text: 'text-warning' },
  'pending-review': { border: 'border-warning', text: 'text-warning' },
  closed: { border: 'border-border', text: 'text-text-muted' },
};

function StatusChip({ status }: { status: PointsRowStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <View className={`self-start rounded-[4px] border px-[7px] py-[2px] ${tone.border}`}>
      <Text className={`font-pp-semi-bold text-[10px] uppercase tracking-[0.4px] ${tone.text}`}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View className="min-w-[140px] flex-1 gap-[6px] p-[20px]">
      <Text className="font-pp-regular text-[12px] leading-[12px] text-text-secondary">{label}</Text>
      <Text className="font-pp-bold text-[24px] text-text">{value}</Text>
      {!!hint && <Text className="font-pp-regular text-[11px] text-text-muted">{hint}</Text>}
    </View>
  );
}

function HeaderCell({ label, className }: { label: string; className: string }) {
  return <Text className={`font-pp-semi-bold text-[10px] uppercase text-text-muted ${className}`}>{label}</Text>;
}

function PositionRow({ row, nowSeconds, compact }: { row: PointsRow; nowSeconds: number; compact: boolean }) {
  const muted = row.status === 'activating' || row.status === 'closed';
  const chainName = getChainConfig(row.chainId)?.displayName ?? '';
  const rateText = row.status === 'activating' && row.activatesAt !== null
    ? `starts in ${formatCountdown(Math.max(0, row.activatesAt - nowSeconds))}`
    : row.pointsPerDay > 0n
      ? `${formatPoints(row.pointsPerDay)}/day`
      : '—';
  return (
    <View className="flex-row items-center gap-[8px] border-t border-t-border-light py-[10px]" testID="points-row">
      <View className="flex-[1.4] flex-row items-center gap-[8px]">
        <TokenNetworkIcon symbol={row.symbol} size={20} chainId={row.chainId} />
        <View>
          <Text className="font-pp-semi-bold text-[12px] text-text">{row.symbol || 'Unknown asset'}</Text>
          {!!chainName && <Text className="font-pp-regular text-[10px] text-text-muted">{chainName}</Text>}
        </View>
      </View>
      <View className="flex-[1.2]">
        <StatusChip status={row.status} />
      </View>
      {!compact && (
        <Text className="flex-[0.8] text-right font-pp-regular text-[12px] text-text">{formatCohort(row.cohortBps)}</Text>
      )}
      <View className="flex-1 items-end">
        <Text className={`text-right font-pp-regular text-[12px] ${muted ? 'text-text-muted' : 'text-text'}`}>
          {formatPoints(pointsTotal(row))}
        </Text>
        {row.pending > 0n && (
          <Text className="text-right font-pp-regular text-[10px] text-warning" testID="points-row-pending">
            {formatPoints(row.pending)} under review
          </Text>
        )}
      </View>
      {!compact && (
        <Text className={`flex-[1.3] text-right font-pp-regular text-[12px] ${muted ? 'text-text-muted' : 'text-text'}`}>
          {rateText}
        </Text>
      )}
    </View>
  );
}

function Footnote({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <Text className={`font-pp-regular text-[12px] leading-[18px] ${tone === 'warning' ? 'text-warning' : 'text-text-muted'}`}>
      {children}
    </Text>
  );
}

/**
 * Points on the Portfolio page. Every figure is computed on this device by the
 * SDK, from the account's own notes and the parameters the ASP publishes with
 * each epoch (hooks/use-points.ts). With points disabled it renders nothing.
 */
export function PointsCard() {
  const state = usePoints();
  const { width } = useWindowDimensions();
  const compact = width < 640;

  if (state.status === 'disabled') return null;

  const totals = state.status === 'ready' ? state.totals : null;
  const placeholder = state.status === 'error' ? 'Unavailable' : '—';
  const unavailableChains = state.status === 'ready'
    ? state.unavailableChainIds.map((chainId) => getChainConfig(chainId)?.displayName ?? `chain ${chainId}`)
    : [];

  return (
    <Card noPadding testID="portfolio-points-card">
      <View className="flex-row flex-wrap items-baseline gap-[8px] border-b border-b-border-light p-[16px]">
        <Text className="font-pp-bold text-[16px] text-text">Points</Text>
        {totals?.latestEpoch != null && (
          <Text className="font-pp-bold text-[12px] text-text-muted">Epoch {String(totals.latestEpoch)}</Text>
        )}
        <Text className="ml-auto font-pp-regular text-[12px] text-text-secondary">Calculated on this device</Text>
      </View>

      {state.status === 'no-epochs' ? (
        <View className="px-[16px] py-[14px]">
          <Text className="font-pp-regular text-[12px] text-text-secondary">
            Points start with the first published epoch. Funds already in the pool will be counted from when they arrived.
          </Text>
        </View>
      ) : (
        <View className="flex-row flex-wrap border-b border-b-border-light">
          <Stat
            label="Total points"
            value={totals ? formatPoints(pointsTotal(totals)) : placeholder}
            hint={totals && totals.pending > 0n ? `${formatPoints(totals.pending)} under ASP review` : undefined}
          />
          <Stat
            label="Accrual rate"
            value={totals ? `${formatPoints(totals.pointsPerDay)}/day` : placeholder}
          />
          <Stat
            label="Since last epoch"
            value={totals ? formatPoints(totals.estimated) : placeholder}
            hint="Estimate until the next epoch is published"
          />
        </View>
      )}

      {totals && totals.rows.length > 0 && (
        <View className="px-[16px] py-[8px]">
          <View className="flex-row items-center gap-[8px] py-[6px]">
            <HeaderCell label="Position" className="flex-[1.4]" />
            <HeaderCell label="Status" className="flex-[1.2]" />
            {!compact && <HeaderCell label="Multiplier" className="flex-[0.8] text-right" />}
            <HeaderCell label="Points" className="flex-1 text-right" />
            {!compact && <HeaderCell label="Rate" className="flex-[1.3] text-right" />}
          </View>
          {totals.rows.map((row) => (
            <PositionRow key={row.key} row={row} nowSeconds={state.status === 'ready' ? state.computedAt : 0} compact={compact} />
          ))}
        </View>
      )}

      {totals && totals.rows.length === 0 && (
        <View className="px-[16px] py-[14px]">
          <Text className="font-pp-regular text-[12px] text-text-secondary">
            No points yet. Funds start earning once they have been in the pool past the waiting period.
          </Text>
        </View>
      )}

      <View className="gap-[6px] border-t border-t-border-light px-[16px] py-[12px]">
        {totals && totals.unknownTimeCount > 0 && (
          <Footnote tone="warning">
            {totals.unknownTimeCount === 1 ? '1 note is' : `${totals.unknownTimeCount} notes are`} not counted yet
            because when {totals.unknownTimeCount === 1 ? 'it was' : 'they were'} created or spent is not known on this
            device yet.
          </Footnote>
        )}
        {unavailableChains.length > 0 && (
          <Footnote tone="warning">
            Points on {unavailableChains.join(', ')} could not be loaded and are not included. They will be retried
            automatically.
          </Footnote>
        )}
        {totals && totals.pending > 0n && (
          <Footnote>
            Points under review are on deposits the ASP has not approved yet. They become claimable once it approves
            them; if it declines them, they are not paid.
          </Footnote>
        )}
        <Footnote>
          Points accrue on funds held in the pool, after a waiting period that restarts with each deposit or transfer, at the multiplier of the
          tier the funds entered in. Spending a note starts its change again in the current tier. Points are worked out on
          this device from your own notes; nothing about your balance is sent anywhere. Claiming is not live yet.
        </Footnote>
      </View>
    </Card>
  );
}
