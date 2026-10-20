import React, { useMemo, useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { usePools } from '@/components/pools-provider';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { usePayroll } from '@/hooks/use-payroll';
import { usePayrollDisplayCurrency } from '@/components/payroll/use-display-currency';
import { NATIVE_ASSET_ADDRESS, getTokenMetadataBySymbol, isStablecoin } from '@/config/tokens';
import {
  addRun, updateRun, deleteRun, newId, getSnapshot,
  type PayrollRun, type PayrollRunItem,
} from '@/services/payroll-store';
import { PCard, PBadge, PButton, CardTitle, CardEmptyState, shortAddr, fmtToken, cx } from '@/components/payroll/ui';
import { buildRunItems, resolvePayrollTransferParams, applyMarkPaid } from '@/components/payroll/io';
import { networkChainId } from '@/services/payroll-store';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';

const usdRate = (cur: string, eth: number) => (cur.toUpperCase() === 'ETH' ? eth : isStablecoin(cur) ? 1 : 0);

export function PayrollRunView() {
  const router = useRouter();
  const { data } = usePools();
  const { openTransferModal } = useTransferModal();
  const { employees, runs } = usePayroll();
  const { formatFull } = usePayrollDisplayCurrency();
  const activeEvmChainId = useActiveEvmChain().id;
  // Refusals show inside the run card, not as a browser alert() (QA 2026-09-24:
  // a "privacypools.com says" dialog reads like a site error).
  // Keyed to the run it belongs to, so a refusal from a discarded run never
  // shows on the next one.
  const [noticeState, setNoticeState] = useState<{ runId: string; text: string } | null>(null);

  const ethPrice = data.priceMap?.[NATIVE_ASSET_ADDRESS.toLowerCase()] ?? 3000;
  const active = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);
  const pendingRun = useMemo(() => runs.find((r) => r.status === 'pending') ?? null, [runs]);

  const totalUsd = active.reduce((s, e) => s + e.salary * usdRate(e.currency, ethPrice), 0);
  const byCurrency = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of active) m.set(e.currency, (m.get(e.currency) ?? 0) + e.salary);
    return Array.from(m.entries());
  }, [active]);
  const perTransferFee = 0.35; // rough relayer-fee preview per transfer; exact fee shown when you pay

  const startRun = () => {
    // Guard against a double-click creating two pending runs before the
    // external store re-render lands.
    if (getSnapshot().runs.some((r) => r.status === 'pending')) return;
    const now = new Date();
    const run: PayrollRun = {
      id: newId('run'),
      date: now.getTime(),
      periodLabel: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }),
      status: 'pending',
      // Pin the run to the chain it executes on, so history explorer links
      // survive a later chain switch (staging serves two EVM chains).
      chainId: activeEvmChainId,
      items: buildRunItems(employees, networkChainId),
    };
    addRun(run);
  };

  const cancelRun = (run: PayrollRun) => {
    const doIt = () => deleteRun(run.id);
    if (typeof window !== 'undefined' && window.confirm) { if (window.confirm('Discard this payroll run?')) doIt(); }
    else Alert.alert('Discard run', 'Discard this payroll run?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: doIt }]);
  };

  // Read the LATEST run from the store (not a stale closure) so a late
  // callback can't revert items changed in the meantime.
  const markPaid = (runId: string, employeeId: string, txHash?: string) => {
    const current = getSnapshot().runs.find((r) => r.id === runId);
    if (!current) return;
    updateRun(runId, applyMarkPaid(current, employeeId, txHash));
  };

  const payItem = (run: PayrollRun, item: PayrollRunItem) => {
    const params = resolvePayrollTransferParams(item, {
      resolveChainId: networkChainId,
      getToken: (symbol, cid) => getTokenMetadataBySymbol(symbol, cid),
    });
    // Refusals (unknown network / unsupported currency / bad amount) surface
    // instead of silently substituting USDC-on-the-active-chain (codex r3).
    if ('refusal' in params) {
      setNoticeState({ runId: run.id, text: params.refusal });
      return;
    }
    // The row must execute on ITS chain: paying a Citrea row while Ethereum
    // is active would open an Ethereum transfer with the same symbol.
    const itemChainId = item.chainId ?? networkChainId(item.network);
    if (itemChainId !== undefined && itemChainId !== activeEvmChainId) {
      setNoticeState({ runId: run.id, text: `This row pays on ${item.network}. Switch the app to ${item.network} first.` });
      return;
    }
    setNoticeState(null);
    const expectedChainId = itemChainId;
    openTransferModal({
      recipient: params.recipient,
      amount: params.amount,
      tokenSymbol: params.tokenSymbol,
      // Mark the row paid ONLY when what was actually sent matches the row
      // (codex): the modal's fields stay editable and the chain can move
      // while it is open, so a different transfer must not close this row.
      onSent: (txHash, details) => {
        const matches = !details || (
          (expectedChainId === undefined || details.chainId === expectedChainId)
          && details.tokenSymbol.toUpperCase() === params.tokenSymbol.toUpperCase()
          && details.amount === params.amount
          && details.recipient.toLowerCase() === params.recipient.toLowerCase()
        );
        if (!matches) {
          setNoticeState({ runId: run.id, text: 'A transfer was sent, but it differs from this payroll row (token, amount, recipient or network changed in the modal). The row stays unpaid.' });
          return;
        }
        markPaid(run.id, item.employeeId, txHash);
      },
    });
  };

  // --- Review (no run in progress) ---
  if (!pendingRun) {
    if (active.length === 0) {
      return (
        <PCard>
          <CardEmptyState icon="people-outline" description="No active team members to pay.">
            <PButton label="Manage team" icon="people-outline" onPress={() => router.push('/payroll/employees' as Href)} />
          </CardEmptyState>
        </PCard>
      );
    }
    return (
      <View className="gap-[16px]">
        <PCard className="gap-[16px]">
          {/* The run at a glance: total + split, with the recipient list below —
              the review shows exactly who gets paid and how much. */}
          <View className="flex-row flex-wrap items-start justify-between gap-[16px]">
            <View className="gap-[4px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-secondary">Total this run</Text>
              <Text className="font-pp-sans-bold text-[26px] leading-[28px] text-text">{formatFull(totalUsd)}</Text>
              <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                {active.length} {active.length === 1 ? 'recipient' : 'recipients'}
                {byCurrency.length ? ` · ${byCurrency.map(([cur, amt]) => fmtToken(amt, cur)).join('  ·  ')}` : ''}
              </Text>
            </View>
          </View>

          <View>
            {active.map((e, i) => (
              <View key={e.id} className={cx('flex-row items-center justify-between gap-[12px] py-[10px]', i > 0 && 'border-t border-border-light')}>
                <View className="min-w-0 flex-1 gap-[2px]">
                  <Text numberOfLines={1} className="font-pp-sans-semi-bold text-[14px] text-text">{e.name}</Text>
                  <Text numberOfLines={1} className="font-pp-sans text-[12px] text-text-secondary">{shortAddr(e.walletAddress)} · {e.network}</Text>
                </View>
                <Text className="font-pp-sans-medium text-[13px] text-text">{fmtToken(e.salary, e.currency)}</Text>
              </View>
            ))}
          </View>

          <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">
            Each payment is a private transfer you sign from your Privacy Pools balance. Relayer fee ~{formatFull(perTransferFee)} per transfer, exact shown when you pay.
          </Text>
        </PCard>

        <PButton label={`Start payroll run · ${active.length} ${active.length === 1 ? 'payee' : 'payees'}`} icon="paper-plane-outline" size="default" onPress={startRun} className="self-end" />
      </View>
    );
  }

  // --- Run in progress ---
  const paidCount = pendingRun.items.filter((it) => it.status === 'paid').length;
  return (
    <View className="gap-[16px]">
      <PCard className="gap-[8px]">
        <View className="flex-row items-center justify-between gap-[12px]">
          <View>
            <CardTitle>{pendingRun.periodLabel} run</CardTitle>
            <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">{paidCount} of {pendingRun.items.length} paid</Text>
          </View>
          <PBadge label={paidCount === pendingRun.items.length ? 'complete' : 'in progress'} variant={paidCount === pendingRun.items.length ? 'success' : 'warning'} className="self-center" />
        </View>
        {noticeState && noticeState.runId === pendingRun.id ? (
          <Text testID="payroll-run-notice" className="font-pp-regular text-[12px] leading-[18px] text-warning">{noticeState.text}</Text>
        ) : null}
      </PCard>

      <View className="gap-[10px]">
        {pendingRun.items.map((it) => (
          <PCard key={it.employeeId} className="flex-row flex-wrap items-center gap-[12px]">
            <View className="min-w-[150px] flex-1 gap-[3px]">
              <Text className="font-pp-sans-semi-bold text-[14px] text-text">{it.name}</Text>
              <Text className="font-pp-sans text-[12px] text-text-secondary">{shortAddr(it.walletAddress)} · {it.network}</Text>
            </View>
            <Text className="font-pp-sans-medium text-[13px] text-text">{fmtToken(it.amount, it.currency)}</Text>
            {it.status === 'paid' ? (
              <PBadge label="paid" variant="success" className="self-center" />
            ) : (
              <PButton label="Pay" icon="paper-plane-outline" onPress={() => payItem(pendingRun, it)} />
            )}
          </PCard>
        ))}
      </View>

      <View className="flex-row flex-wrap justify-between gap-[10px]">
        <PButton label="Discard run" variant="outline" icon="trash-outline" onPress={() => cancelRun(pendingRun)} />
        {paidCount < pendingRun.items.length ? (
          <PButton label="Mark all paid" variant="outline" icon="checkmark-done-outline"
            onPress={() => updateRun(pendingRun.id, { items: pendingRun.items.map((it) => ({ ...it, status: 'paid' as const })), status: 'confirmed' })} />
        ) : (
          <PButton label="View in history" icon="time-outline" onPress={() => router.push('/payroll/history' as Href)} />
        )}
      </View>
    </View>
  );
}
