import React, { useState } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { View, Text, Pressable, Linking } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { usePayroll } from '@/hooks/use-payroll';
import { type PayrollRun } from '@/services/payroll-store';
import { getExplorerName, getExplorerTxUrl } from '@/config/chains';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { PCard, PBadge, PButton, PPagination, CardTitle, CardEmptyState, useC, shortAddr, fmtToken } from '@/components/payroll/ui';
import { formatShortDate } from '@/components/payroll/format';
import { downloadText, buildRunsCsv } from '@/components/payroll/io';

// Runs are tall cards (each lists its recipients), so page a handful at a time
// rather than an endless scroll.
const RUNS_PAGE_SIZE = 6;

export function PayrollHistory() {
  const c = useC();
  const { runs } = usePayroll();
  const chainId = useActiveEvmChain().id;

  const statusVariant = (s: PayrollRun['status']) => (s === 'confirmed' ? 'success' : s === 'failed' ? 'danger' : 'warning');

  // Page the history so it never grows into an endless scroll. Clamp the page
  // during render (self-limiting once currentPage <= totalPages) so a deleted
  // run can't strand us past the end.
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  if (currentPage > totalPages) setCurrentPage(totalPages);
  const pageStart = (currentPage - 1) * RUNS_PAGE_SIZE;
  const pagedRuns = runs.slice(pageStart, pageStart + RUNS_PAGE_SIZE);

  return (
    <View className="gap-[16px]">
      <View className="flex-row items-center justify-between gap-[10px]">
        <Text className="font-pp-sans-medium text-[13px] text-text-secondary">{runs.length} {runs.length === 1 ? 'run' : 'runs'}</Text>
        <PButton label="Export CSV" icon="download-outline" variant="outline" disabled={runs.length === 0}
          onPress={() => downloadText(`payroll-history-${new Date().toISOString().slice(0, 10)}.csv`, buildRunsCsv(runs), 'text/csv')} />
      </View>

      {runs.length === 0 ? (
        <PCard>
          <CardEmptyState icon="time-outline" description="No payroll runs yet." />
        </PCard>
      ) : pagedRuns.map((run) => {
        const totals = new Map<string, number>();
        for (const it of run.items) totals.set(it.currency, (totals.get(it.currency) ?? 0) + it.amount);
        // The run total is the card's headline number. Lead currency shows large;
        // a rare multi-currency run lists the remainder on a muted line beneath.
        const totalsArr = Array.from(totals.entries());
        return (
          <PCard key={run.id} className="gap-[12px]">
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="min-w-0 flex-1 gap-[4px]">
                <View className="flex-row items-center gap-[8px]">
                  <CardTitle>{run.periodLabel}</CardTitle>
                  {/* A run's status is derived from its recipients (confirmed ==
                      every payment paid), so the per-recipient badges below
                      already carry it. Flag the run only when it deviates from
                      that happy path: still pending, or failed. */}
                  {run.status !== 'confirmed' ? (
                    <PBadge label={run.status} variant={statusVariant(run.status)} />
                  ) : null}
                </View>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">
                  {formatShortDate(run.date)} · {run.items.length} {run.items.length === 1 ? 'recipient' : 'recipients'}
                </Text>
              </View>
              {totalsArr.length ? (
                <View className="items-end gap-[2px]">
                  <Text numberOfLines={1} className="font-pp-sans-bold text-[22px] leading-[24px] text-text">
                    {fmtToken(totalsArr[0][1], totalsArr[0][0])}
                  </Text>
                  {totalsArr.length > 1 ? (
                    <Text numberOfLines={1} className="font-pp-regular text-[12px] leading-[18px] text-text-muted">
                      {totalsArr.slice(1).map(([cur, amt]) => fmtToken(amt, cur)).join(' · ')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>

            <View className="gap-[8px] border-t border-border-light pt-[10px]">
              {run.items.map((it) => (
                <View key={it.employeeId} className="flex-row items-center gap-[12px]">
                  <Text className="flex-1 font-pp-sans-medium text-[13px] text-text" numberOfLines={1}>{it.name}</Text>
                  <Text className="font-pp-sans text-[12px] text-text-secondary">{fmtToken(it.amount, it.currency)}</Text>
                  {it.txHash ? (
                    <View className="flex-row items-center gap-[6px]">
<Pressable className="max-w-[140px] flex-row items-center gap-[4px]" onPress={() => Linking.openURL(getExplorerTxUrl(it.chainId ?? run.chainId ?? chainId, it.txHash!))}>
                      <Text className="font-pp-regular text-[11px] text-accent" numberOfLines={1}>{shortAddr(it.txHash)}</Text>
                      {/* nw-keep(data-color): accent link glyph color (theme token) into the vector-icon sink */}
                      <Ionicons name="open-outline" size={12} color={c.accent} />
                    </Pressable>
                      <ExplorerPrivacyHint explorerName={getExplorerName(it.chainId ?? run.chainId ?? chainId)} />
                    </View>
                  ) : (
                    <PBadge label={it.status} variant={it.status === 'paid' ? 'success' : it.status === 'failed' ? 'danger' : 'default'} />
                  )}
                </View>
              ))}
            </View>
          </PCard>
        );
      })}

      <PPagination page={currentPage} pageCount={totalPages} onChange={setCurrentPage} className="px-[8px] py-[4px]" />
    </View>
  );
}
