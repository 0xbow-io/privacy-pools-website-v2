import { Text, View, useWindowDimensions } from 'react-native';
import { usePools } from '@/components/pools-provider';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { countMyDeposits } from '@/services/my-activity';
import { buildOutgoingDepositTxHashSet } from '@/services/outgoing-deposits-store';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { countStellarDeposits } from '@/services/stellar-activity';

export function compactUsd(raw: string | undefined): string {
  const n = parseFloat(raw ?? '0') || 0;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function compactCount(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString('en-US');
}

/**
 * Three numbers, stated plainly, with no cards — just figures on the canvas
 * separated by hairlines, so the action card above keeps the visual weight.
 *
 * WHOSE numbers depends on whether anyone is signed in. Signed out they describe
 * the pool (how much is shielded, how big the crowd is, how alive it is today);
 * signed in they describe YOU, because once you have your own position the
 * protocol's aggregate is not what you came to check.
 *
 * The deposit COUNT comes from the public event feed rather than note data, so it
 * is right for a wallet-only connection too. The two balance figures are
 * note-derived and therefore read $0 until the account is unlocked — honest, and
 * the panel behind "My balances" is where that gets resolved.
 */
export function StatBand() {
  const { statistics, data } = usePools();
  const { width } = useWindowDimensions();
  const { isConnected, address } = useMultiChainWallet();
  const stacked = width < 560;

  const mine = data.myPoolsStats;
  // Stellar deposits are not in the ASP feed. Counted from the Stellar account's
  // own notes, which do not depend on the selected chain (its activity rows do).
  const stellar = useStellarSession();
  const stellarDeposits = countStellarDeposits(stellar.notes, stellar.noteOrigins, stellar.address ?? '');
  const stats = isConnected
    ? [
        { label: 'Total shielded', value: mine.acceptedFundsValue },
        { label: 'Pending', value: mine.pendingValue },
        { label: 'My deposits', value: compactCount(countMyDeposits(data.transactions, address, buildOutgoingDepositTxHashSet(address)) + stellarDeposits) },
      ]
    : [
        { label: 'Total shielded', value: compactUsd(statistics?.allTime?.tvlUsd) },
        { label: 'Deposits in the crowd', value: compactCount(statistics?.allTime?.totalDepositsCount) },
        { label: 'Shielded in 24h', value: compactUsd(statistics?.last24h?.totalDepositsValueUsd) },
      ];

  return (
    <View className={`justify-center py-[8px] ${stacked ? 'flex-col items-center gap-[16px]' : 'flex-row items-stretch'}`}>
      {stats.map((stat, i) => (
        <View key={stat.label} className="flex-row items-center">
          {i > 0 && !stacked && <View className="w-[1px] self-stretch my-[6px] bg-border" />}
          <View className="items-center px-[28px] gap-[4px]">
            <Text className="text-[26px] leading-[32px] tracking-[-0.5px] text-text font-pp-sans-bold">{stat.value}</Text>
            <Text className="text-[12px] tracking-[0.2px] text-text-muted font-pp-sans-medium">{stat.label}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
