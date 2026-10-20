import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';
import { getTokenMetadata } from '@/config/tokens';
import { publicFeeds } from '@/services/public-feed-scheduler';
import { feedPriceMap } from '@/services/public-feeds';
import { priceFromMap } from '@/services/price-map-merge';
import { isStablecoin } from '@/services/token-format';

import {
  findWithdrawFeeIn,
  parseWithdrawFees,
  toWithdrawalTxHashSet,
  upsertWithdrawFee,
  withSendTimePrice,
  type WithdrawFee,
} from '@/services/withdraw-fees-core';

// Device-backed storage for the relayer fee paid on a relayed spend. All the
// logic (normalization, one-row-per-tx upsert, the withdrawal-kind filter that
// keeps transfer hashes out of the accounting ownership scope) lives in
// services/withdraw-fees-core so it can be unit-tested without react-native.

export type { WithdrawFee };

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_withdraw_fees_v1');

function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function storageSetItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[withdraw-fees-store] write failed', err);
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch (err) {
    console.warn('[withdraw-fees-store] write failed', err);
  }
}

export function readAllWithdrawFees(): WithdrawFee[] {
  return parseWithdrawFees(storageGetItem(STORAGE_KEY));
}

/** The fee token's current price from the public price feed's cache. A read
 *  of data the app already holds on its fixed schedule: it never fetches. */
function cachedPriceUsd(fee: WithdrawFee): { price: number | undefined; stablecoin: boolean } {
  const meta = getTokenMetadata(fee.tokenAddress, fee.chainId);
  const state = publicFeeds.read<Record<string, number>>(feedPriceMap(fee.chainId));
  const map = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : undefined;
  return {
    price: map ? priceFromMap(map, { chainId: fee.chainId, address: fee.tokenAddress, symbol: meta.symbol }) : undefined,
    stablecoin: isStablecoin(meta.symbol),
  };
}

export function recordWithdrawFee(fee: WithdrawFee): void {
  const { price, stablecoin } = cachedPriceUsd(fee);
  const next = upsertWithdrawFee(readAllWithdrawFees(), withSendTimePrice(fee, price, stablecoin));
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[withdraw-fees-store] write failed', err);
  }
}

export function findWithdrawFee(txHash: string | null | undefined): WithdrawFee | null {
  return findWithdrawFeeIn(readAllWithdrawFees(), txHash);
}

/** Tx hashes of withdrawals recorded on this device — written only when THIS
 *  account submitted the withdrawal, so the set is exact ownership evidence
 *  for the accounting scope (never label-based). Transfer fees live in the
 *  same store and are filtered out by kind (see withdraw-fees-core). */
export function buildWithdrawFeeTxHashSet(): Set<string> {
  return toWithdrawalTxHashSet(readAllWithdrawFees());
}
