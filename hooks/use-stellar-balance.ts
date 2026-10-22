/**
 * Native XLM balance of the connected Stellar wallet (the Shield max).
 *
 * Read from Horizon's account endpoint. Gated on data readiness only (an
 * address) and polled on a fixed cadence: the account is the wallet's own,
 * already public (the same read wagmi makes for an EVM wallet on connect), and
 * nothing here depends on which tab or modal is open. Mounting another reader
 * (a modal opening) or focusing the tab never refetches: only the interval
 * and an explicit post-deposit refresh do.
 */
import { useQuery } from '@tanstack/react-query';

import { STELLAR_TESTNET_HORIZON_URL, STELLAR_XLM } from '@/config/stellar-deployment';
import { routedFetch } from '@/services/tor-fetch';

const REFRESH_MS = 20_000;

export interface HorizonAccount {
  balances: { asset_type: string; balance: string; selling_liabilities?: string }[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

export interface StellarBalance {
  /** Total native balance, stroops. */
  total: bigint;
  /**
   * What can actually leave the account: total minus the base reserve
   * (2 + subentries) × 0.5 XLM, minus XLM locked in open sell offers
   * (selling_liabilities), and a little headroom for the Soroban fee.
   */
  spendable: bigint;
  /** The account does not exist on the network yet (never funded). */
  unfunded: boolean;
}

const BASE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM
const FEE_HEADROOM_STROOPS = 10_000_000n; // 1 XLM for resource fees

function toStroops(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole) * 10n ** BigInt(STELLAR_XLM.decimals)
    + BigInt((frac + '0000000').slice(0, STELLAR_XLM.decimals));
}

/** Pure: the spendable figure from a Horizon account record. */
export function stellarBalanceFromAccount(account: HorizonAccount): StellarBalance {
  const native = account.balances.find((b) => b.asset_type === 'native');
  const total = native ? toStroops(native.balance) : 0n;
  const selling = native?.selling_liabilities ? toStroops(native.selling_liabilities) : 0n;
  const entries = BigInt(2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0));
  const locked = entries * BASE_RESERVE_STROOPS + FEE_HEADROOM_STROOPS + selling;
  return { total, spendable: total > locked ? total - locked : 0n, unfunded: false };
}

export async function fetchStellarBalance(address: string): Promise<StellarBalance> {
  const res = await routedFetch('rpc')(`${STELLAR_TESTNET_HORIZON_URL}/accounts/${encodeURIComponent(address)}`, { cache: 'no-store' });
  if (res.status === 404) return { total: 0n, spendable: 0n, unfunded: true };
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  return stellarBalanceFromAccount((await res.json()) as HorizonAccount);
}

export function useStellarBalance(address: string | null | undefined) {
  return useQuery({
    queryKey: ['stellarBalance', address],
    queryFn: () => fetchStellarBalance(address as string),
    enabled: !!address,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
    staleTime: REFRESH_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
