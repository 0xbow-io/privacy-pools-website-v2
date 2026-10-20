import { expect, test } from 'bun:test';
import { swapRouteKinds, txKey, withPublicSwapRows, withSwapRouteWithdrawals } from '../swap-route-evidence';
import { rowLegs } from '../swap-rows';
import { rowTypeLabel } from '../row-type-label';
import type { Transaction } from '@/components/pools-provider';

const hash = '0x' + 'a'.repeat(64);
const ROUTE = '0x' + 'd'.repeat(40);
const OTHER = '0x' + '1'.repeat(40);
const log = (over: Partial<{ chainId: number; txHash: string; caller: string }> = {}) => ({ chainId: 1, txHash: hash, caller: ROUTE, ...over });
const dep = (over: Partial<{ chainId: number; txHash: string }> = {}) => ({ chainId: 1, txHash: hash, ...over });
const kindsOf = (transacts: ReturnType<typeof log>[], deposits: ReturnType<typeof dep>[] = []) =>
  swapRouteKinds({ transacts, deposits }, (caller) => caller === ROUTE);

const row = (over: Partial<Transaction>) => ({
  id: `${over.type}`, type: 'Withdrawal', chainId: 1, chain: 'Ethereum', txHash: hash, asset: 'ETH', tokenAddress: '0xee',
  rawAmount: '500000000000000000', tokenAmount: 0.5, usdValue: 1250, address: '0xab...cd', fullAddress: '0xabcd',
  status: 'completed', reviewStatus: 'approved', label: '0x0b', ...over,
}) as Transaction;
const spend = row({});
const output = row({ type: 'Deposit', asset: 'USDC', tokenAddress: '0xa0', rawAmount: '1250000000', tokenAmount: 1250, status: 'pending', reviewStatus: 'pending', label: '0x0c' });

test('route logs with a deposit in the tx are a swap; without one, a withdrawal', () => {
  expect(kindsOf([log()], [dep()]).get(txKey(1, hash))).toBe('swap');
  expect(kindsOf([log()]).get(txKey(1, hash))).toBe('withdrawal');
  expect(kindsOf([log(), log()]).get(txKey(1, hash.toUpperCase()))).toBe('withdrawal');
});

test('another caller, a batch of swaps, or another chain proves nothing', () => {
  expect(kindsOf([log({ caller: OTHER })]).size).toBe(0);
  expect(kindsOf([log(), log({ caller: OTHER })]).size).toBe(0);
  expect(kindsOf([log(), log()], [dep(), dep()]).size).toBe(0);
  expect(kindsOf([log()], [dep({ chainId: 56 })]).get(txKey(1, hash))).toBe('withdrawal');
  expect(kindsOf([log()]).get(txKey(56, hash))).toBeUndefined();
});

test('only Withdrawal rows of a withdrawal-kind tx read via swap', () => {
  const kinds = kindsOf([log()]);
  const [w, t] = withSwapRouteWithdrawals([spend, row({ type: 'Transfer' })], kinds);
  expect(rowTypeLabel(w)).toBe('Withdrawal via swap');
  expect(t.viaSwap).toBeUndefined();
  expect(spend.viaSwap).toBeUndefined();
  expect(withSwapRouteWithdrawals([spend], kindsOf([log()], [dep()]))[0].viaSwap).toBeUndefined();
});

test("a stranger's same-chain swap is one Swap row, named for nobody", () => {
  const kinds = kindsOf([log()], [dep()]);
  const [swap, ...rest] = withPublicSwapRows([spend, output], kinds);
  expect(rest).toEqual([]);
  expect(rowTypeLabel(swap)).toBe('Swap');
  expect([swap.address, swap.fullAddress, swap.status, swap.reviewStatus]).toEqual(['', '', 'pending', 'pending']);
  const legs = rowLegs(swap)!;
  expect([legs.fromCaption, legs.from.asset, legs.toCaption, legs.to.asset, legs.toApprox]).toEqual(['Swapped', 'ETH', 'Received', 'USDC', false]);
});

test('an output of mine keeps its fund state on the Swap row', () => {
  const kinds = kindsOf([log()], [dep()]);
  const mine = { ...output, noteStatus: 'PENDING', fundsState: 'at_risk', fundsReason: 'asp_declined' } as Transaction;
  const [swap] = withPublicSwapRows([{ ...spend, fundsState: 'ready', fundsReason: 'spendable' } as Transaction, mine], kinds);
  expect([swap.noteStatus, swap.fundsState, swap.fundsReason]).toEqual(['PENDING', 'at_risk', 'asp_declined']);
});

test('a public swap whose source is called Transfer still folds once, without changing amounts', () => {
  const source = { ...spend, type: 'Transfer' } as Transaction;
  const [swap, ...rest] = withPublicSwapRows([source, output], kindsOf([log()], [dep()]));
  expect(rest).toEqual([]);
  expect(swap.type).toBe('Swap');
  expect(rowLegs(swap)?.from.rawAmount).toBe(spend.rawAmount);
  expect(rowLegs(swap)?.to.rawAmount).toBe(output.rawAmount);
  expect([swap.address, swap.fullAddress]).toEqual(['', '']);
  // Without public route proof an ordinary transfer must stay a transfer.
  expect(withPublicSwapRows([source, output], new Map())).toEqual([source, output]);
});

test('one leg alone, or a lineage row of mine, leaves the rows as they are', () => {
  const kinds = kindsOf([log()], [dep()]);
  expect(withPublicSwapRows([spend], kinds)).toEqual([spend]);
  expect(withPublicSwapRows([output], kinds)).toEqual([output]);
  const mine = { ...spend, isLineageSynthetic: true };
  expect(withPublicSwapRows([mine, output], kinds)).toEqual([mine, output]);
  expect(withPublicSwapRows([spend, output], new Map())).toEqual([spend, output]);
});
