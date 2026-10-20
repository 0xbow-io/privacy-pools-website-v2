import React, { useMemo, useState } from 'react';
import { View, Text } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { usePools } from '@/components/pools-provider';
import { useDepositModal } from '@/components/deposit-modal-provider';
import { usePayroll } from '@/hooks/use-payroll';
import { useChainRouter } from '@/hooks/use-chain-router';
import { getChainConfig } from '@/config/chains';
import { formatShortDate } from '@/components/payroll/format';
import { usePayrollDisplayCurrency } from '@/components/payroll/use-display-currency';
import { NATIVE_ASSET_ADDRESS } from '@/config/tokens';
import { PCard, MiniBars, PButton, PSegmented, CardTitle, CardEmptyState, useC } from '@/components/payroll/ui';
import { isStablecoin } from '@/config/tokens';

function usdRate(currency: string, ethPrice: number): number {
  const c = currency.toUpperCase();
  if (c === 'ETH' || c === 'WETH') return ethPrice;
  // $1 only for actual stables (codex): cBTC was valued at $1. Unknown
  // non-stables contribute $0 (honest 'unavailable') rather than a made-up rate.
  return isStablecoin(c) ? 1 : 0;
}

type Range = '3m' | '6m' | '12m' | 'ytd';
const RANGE_OPTIONS = [
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '12m', label: '12M' },
  { value: 'ytd', label: 'YTD' },
] as const;
const RANGE_CAPTION: Record<Range, string> = {
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  ytd: 'This year',
};

export function PayrollDashboard() {
  const c = useC();
  const router = useRouter();
  const { data } = usePools();
  const { activeChainId } = useChainRouter();
  const { openDepositModal } = useDepositModal();
  const { employees, runs } = usePayroll();
  const { format, formatFull } = usePayrollDisplayCurrency();
  const [range, setRange] = useState<Range>('6m');

  const ethPrice = data.priceMap?.[NATIVE_ASSET_ADDRESS.toLowerCase()] ?? data.priceMap?.['eth'] ?? 3000;

  const active = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);

  // Upcoming payroll: sum of active salaries.
  const upcomingUsd = active.reduce((s, e) => s + e.salary * usdRate(e.currency, ethPrice), 0);

  // How many months of history to chart, from the range filter. YTD counts
  // January of the current year through the current month.
  const rangeMonths = useMemo(() => {
    if (range === '3m') return 3;
    if (range === '12m') return 12;
    if (range === 'ytd') return new Date().getMonth() + 1;
    return 6;
  }, [range]);

  // Outflow over the selected window (USD), from recorded runs.
  const outflow = useMemo(() => {
    const months: { key: string; label: string; value: number }[] = [];
    const now = new Date();
    for (let i = rangeMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString(undefined, { month: 'short' }), value: 0 });
    }
    const idx = new Map(months.map((m, i) => [m.key, i] as const));
    for (const r of runs) {
      const d = new Date(r.date);
      const i = idx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i == null) continue;
      for (const it of r.items) {
        // Realized outflow only (codex round 3): pending and failed items
        // were charted as money paid the moment a run was created.
        if (it.status !== 'paid') continue;
        months[i].value += it.amount * usdRate(it.currency, ethPrice);
      }
    }
    return months;
  }, [runs, ethPrice, rangeMonths]);

  // Both figures are scoped to the selected window, so switching the range
  // actually changes them: total outflow in the window, and the average per
  // month that ran a payroll inside it.
  const rangeTotal = outflow.reduce((s, m) => s + m.value, 0);
  const monthsWithRuns = outflow.filter((m) => m.value > 0).length;
  const avgPaid = monthsWithRuns ? rangeTotal / monthsWithRuns : 0;

  const lastDay = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // The most recent run WITH at least one paid item, for the "last payroll"
  // column — a never-clicked pending run is an obligation, not a payroll.
  const lastRun = runs.find((r) => r.items.some((it) => it.status === 'paid')) ?? null;
  const lastRunUsd = lastRun
    ? lastRun.items.reduce((s, it) => s + (it.status === 'paid' ? it.amount * usdRate(it.currency, ethPrice) : 0), 0)
    : 0;
  // Count PAID rows only — a partially paid run showed the paid amount
  // beside the full recipient count (codex).
  const lastRunPaidCount = lastRun ? lastRun.items.filter((it) => it.status === 'paid').length : 0;
  const viewHistory = () => router.push('/payroll/history' as Href);

  // The treasury is the same Privacy Pools balance the home widget deposits
  // into; openDepositModal runs the connect + signature gates and the provider
  // renders the shared deposit flow, so the user never leaves payroll.
  // Scoped to the chain payroll actually runs on: `myPools` spans chains now
  // (multichain balances, 2026-08-18), so a row count claimed "Available in
  // Privacy Pools" — and demoted the Fund CTA — on a chain whose treasury is
  // empty (qwen3.8 confirmation review). The figure beside it stays the
  // account-wide total, so say which chain is unfunded rather than implying
  // the money is gone.
  const treasuryFunded = data.myPools.some(
    (p) => p.chainId === activeChainId && (parseFloat(p.balanceTokenExact) || 0) > 0,
  );
  const treasuryChainName = getChainConfig(activeChainId)?.displayName ?? 'this network';
  const runPayroll = () => router.push('/payroll/run' as Href);

  return (
    <View className="gap-[18px]">
      {/* The three things you need to run payroll on-chain: what's in the
          treasury (and fund it), what the last run was, and what the next run
          is. Three parallel columns, each with its own amount and action. */}
      <PCard>
        <View className="flex-row flex-wrap items-stretch gap-x-[32px] gap-y-[24px]">
          {/* Treasury */}
          <View className="min-w-[180px] flex-1 justify-between gap-[16px]">
            <View className="gap-[4px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Treasury</Text>
              <Text className="font-pp-sans-bold text-[26px] leading-[28px] text-text">{format(data.myPoolsStats.acceptedFundsUsd)}</Text>
              <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                {treasuryFunded ? 'Available in Privacy Pools' : `Not funded on ${treasuryChainName} yet`}
              </Text>
            </View>
            <PButton label="Fund treasury" icon="add-circle-outline" variant={treasuryFunded ? 'outline' : 'primary'} onPress={() => openDepositModal()} className="self-start" />
          </View>

          <View className="-my-[24px] hidden w-px self-stretch bg-border-light sm:flex" />

          {/* Last payroll */}
          <View className="min-w-[180px] flex-1 justify-between gap-[16px]">
            <View className="gap-[4px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Last payroll</Text>
              <Text className="font-pp-sans-bold text-[26px] leading-[28px] text-text">{lastRun ? formatFull(lastRunUsd) : format(0)}</Text>
              <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                {lastRun ? `${formatShortDate(lastRun.date)} · ${lastRunPaidCount} ${lastRunPaidCount === 1 ? 'payee' : 'payees'}` : 'No runs yet'}
              </Text>
            </View>
            {lastRun ? (
              <PButton label="View history" icon="time-outline" variant="outline" onPress={viewHistory} className="self-start" />
            ) : <View className="h-0" />}
          </View>

          <View className="-my-[24px] hidden w-px self-stretch bg-border-light sm:flex" />

          {/* Next payroll */}
          <View className="min-w-[180px] flex-1 justify-between gap-[16px]">
            <View className="gap-[4px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Next payroll</Text>
              <Text className="font-pp-sans-bold text-[26px] leading-[28px] text-text">{active.length ? formatFull(upcomingUsd) : format(0)}</Text>
              <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                {active.length ? `${lastDay} · ${active.length} ${active.length === 1 ? 'payee' : 'payees'}` : 'No active payees'}
              </Text>
            </View>
            <PButton label="Run payroll" icon="paper-plane-outline" variant={treasuryFunded ? 'primary' : 'outline'} onPress={runPayroll} className="self-start" />
          </View>
        </View>
      </PCard>

      {/* Outflow trend. The window's paid total and monthly average sit in the
          header beside the range toggle, so the chart owns the full width below
          instead of a near-empty summary row stranded on the left. */}
      <PCard>
        {runs.length ? (
          <View className="flex-row flex-wrap items-stretch gap-x-[32px] gap-y-[20px]">
            {/* Left: title over the full-width chart. */}
            <View className="min-w-[260px] flex-1 gap-[20px]">
              <CardTitle>Payroll outflow</CardTitle>
              <MiniBars data={outflow} currentIndex={outflow.length - 1} formatValue={format} />
            </View>
            <View className="hidden w-px self-stretch bg-border-light sm:flex" />
            {/* Right: the range toggle over its window figures, one aligned
                column so the toggle and numbers share a left edge. */}
            <View className="items-start justify-between gap-[32px]">
              <PSegmented value={range} onChange={(v) => setRange(v)} options={RANGE_OPTIONS} />
              <View className="gap-[24px]">
                <View className="gap-[4px]">
                  <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Paid · {RANGE_CAPTION[range]}</Text>
                  <Text className="font-pp-sans-bold text-[22px] leading-[24px] text-text">{formatFull(rangeTotal)}</Text>
                </View>
                <View className="gap-[4px]">
                  <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Avg / month</Text>
                  <Text className="font-pp-sans-bold text-[22px] leading-[24px] text-text">{formatFull(avgPaid)}</Text>
                </View>
              </View>
            </View>
          </View>
        ) : (
          <View className="gap-[16px]">
            <CardTitle>Payroll outflow</CardTitle>
            <CardEmptyState icon="bar-chart-outline" description="No payroll runs yet. Your monthly outflow will chart here." />
          </View>
        )}
      </PCard>

      <View className="flex-row items-center gap-[7px] px-[2px]">
        {/* nw-keep(data-color): muted lock glyph color (theme token) into the vector-icon sink */}
        <Ionicons name="lock-closed-outline" size={13} color={c.textMuted} />
        <Text className="flex-1 font-pp-regular text-[11px] text-text-muted">
          All payroll data is stored only in this browser. Treasury figures come from your Privacy Pools balance.
        </Text>
      </View>
    </View>
  );
}
