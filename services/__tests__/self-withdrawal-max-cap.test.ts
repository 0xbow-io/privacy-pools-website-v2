// Own-wallet ("direct") withdrawal is ONE proof, and Confirm selects at most
// WITHDRAW_MAX_INPUTS notes. With batching enabled, its Max, 100% and Review
// must stop at that single-proof cap, or Confirm fails before sending. The
// relayed route keeps its whole-balance Max (it batches) and typed amounts are
// not rewritten. Expected values come from the same functions Confirm and the
// form use (topNAcrossLabels, selectWithdrawInputs, isFullBalanceRequest), not
// from restated numbers.
import { describe, expect, test } from 'bun:test';

import {
  resolveDisplayAvailableWei,
  resolveWithdrawMaxWei,
  resolveWithdrawPercentSelection,
  routeCanBatch,
  topNAcrossLabels,
} from '@/services/withdraw-quotes';
import { selectWithdrawInputs, WITHDRAW_MAX_INPUTS } from '@/services/withdraw-note-selection';
import { isFullBalanceRequest } from '@/services/batch-withdrawals';
import type { Note } from '@/services/sdk-types';

const note = (value: bigint, label: string, i: number): Note => ({
  value: `0x${value.toString(16)}`,
  label,
  commitment: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  tokenId: '0xToken',
} as unknown as Note);

// Seven notes over two labels: more than one proof can carry.
const NOTES = [10n, 20n, 30n, 40n, 50n, 60n, 70n].map((v, i) => note(v, i % 2 ? '0xa' : '0xb', i));
const SPENDABLE = NOTES.reduce((sum, n) => sum + BigInt(n.value), 0n);
const CAP = topNAcrossLabels(NOTES, WITHDRAW_MAX_INPUTS);

describe('fixture sanity', () => {
  test('the balance needs more than five inputs, the cap is what five can carry', () => {
    expect(NOTES.length).toBeGreaterThan(WITHDRAW_MAX_INPUTS);
    expect(CAP).toBeLessThan(SPENDABLE);
    // Confirm's own selection cannot cover the whole balance.
    expect(selectWithdrawInputs(NOTES, SPENDABLE, 0n).total).toBeLessThan(SPENDABLE);
  });
});

describe('direct mode never batches', () => {
  test('routeCanBatch: only the relayed route with batching on', () => {
    expect(routeCanBatch({ batchEnabled: true, isDirect: false })).toBe(true);
    expect(routeCanBatch({ batchEnabled: true, isDirect: true })).toBe(false);
    expect(routeCanBatch({ batchEnabled: false, isDirect: false })).toBe(false);
  });
});

describe('Max (the form and the action hub read getWithdrawMaxWei)', () => {
  test('direct Max is the single-proof cap, and Confirm can select exactly it within five inputs', () => {
    const max = resolveWithdrawMaxWei({ isDirect: true, spendableWei: SPENDABLE, singleProofCapWei: CAP });
    expect(max).toBe(CAP);
    const picked = selectWithdrawInputs(NOTES, max, 0n);
    expect(picked.total).toBeGreaterThanOrEqual(max);
    expect(picked.notes.length).toBeLessThanOrEqual(WITHDRAW_MAX_INPUTS);
    // One wei more is past what one proof can carry.
    expect(selectWithdrawInputs(NOTES, max + 1n, 0n).total).toBeLessThan(max + 1n);
  });

  test('direct Max never exceeds the balance', () => {
    expect(resolveWithdrawMaxWei({ isDirect: true, spendableWei: 5n, singleProofCapWei: 9n })).toBe(5n);
  });

  test('relayed Max is unchanged: the whole spendable balance', () => {
    expect(resolveWithdrawMaxWei({ isDirect: false, spendableWei: SPENDABLE, singleProofCapWei: CAP })).toBe(SPENDABLE);
  });
});

describe('100% and the Available line', () => {
  const pct100 = (isDirect: boolean) => resolveWithdrawPercentSelection({
    pct: 100,
    isSwapExit: false,
    batchEnabled: routeCanBatch({ batchEnabled: true, isDirect }),
    spendableWei: SPENDABLE,
    singleProofCapWei: CAP,
  });

  test('direct 100% is the cap and not a full-balance (batch) request', () => {
    expect(pct100(true)).toEqual({ amountWei: CAP, maxSelected: false });
  });

  test('relayed 100% still selects the whole balance for the batch route', () => {
    expect(pct100(false)).toEqual({ amountWei: SPENDABLE, maxSelected: true });
  });

  test('Available shows the cap in direct mode and the balance on the relayed route', () => {
    const shown = (isDirect: boolean) => resolveDisplayAvailableWei({
      isSwapExit: false,
      batchEnabled: routeCanBatch({ batchEnabled: true, isDirect }),
      spendableWei: SPENDABLE,
      singleProofCapWei: CAP,
    });
    expect(shown(true)).toBe(CAP);
    expect(shown(false)).toBe(SPENDABLE);
  });
});

describe('Review admission', () => {
  // The provider: canReview = gross <= cap || fullBalanceRequested, where
  // fullBalanceRequested needs routeBatchEnabled.
  const admits = (enteredWei: bigint, isDirect: boolean, maxSelected = false) => {
    const fullBalanceRequested = routeCanBatch({ batchEnabled: true, isDirect })
      && isFullBalanceRequest({ requestedWei: enteredWei, totalActiveWei: SPENDABLE, maxSelected });
    return enteredWei <= CAP || fullBalanceRequested;
  };

  test('a typed whole balance is refused in direct mode, admitted on the relayed (batch) route', () => {
    expect(admits(SPENDABLE, true)).toBe(false);
    expect(admits(SPENDABLE, false)).toBe(true);
    expect(admits(SPENDABLE, true, true)).toBe(false);
  });

  test('typed amounts within one proof are admitted on both routes', () => {
    expect(admits(CAP, true)).toBe(true);
    expect(admits(CAP, false)).toBe(true);
    expect(admits(1n, true)).toBe(true);
  });
});

describe('the withdraw modal wires the direct cap', () => {
  const source = require('node:fs').readFileSync(new URL('../../components/withdraw-modal-provider.tsx', import.meta.url), 'utf8') as string;

  test('Max (also the action hub Max) uses the per-token single-proof cap in direct mode', () => {
    const start = source.indexOf('const getWithdrawMaxWei = useCallback(');
    const body = source.slice(start, source.indexOf('}, [', start));
    expect(body).toContain('resolveWithdrawMaxWei({');
    expect(body).toContain('isDirect: directMode');
    expect(body).toContain('topNAcrossLabels(spendableActiveNotesFor(tokenSymbol), WITHDRAW_MAX_INPUTS)');
    // The hub reads the same function from the context.
    expect(source).toMatch(/WithdrawModalContext\.Provider value=\{\{[^}]*getWithdrawMaxWei/);
  });

  test('the batch route, 100% and Available are gated on the route, not the flag alone', () => {
    expect(source).toContain('const routeBatchEnabled = routeCanBatch({ batchEnabled, isDirect: directMode });');
    expect(source).toMatch(/const fullBalanceRequested =\s*routeBatchEnabled &&/);
    expect(source).toContain('batchEnabled: routeCanBatch({ batchEnabled, isDirect: nextIsDirect })');
    expect(source).not.toContain('resolveDisplayAvailableWei({ isSwapExit, batchEnabled, ');
  });

  test('the direct Review branch refuses an amount over the single-proof cap', () => {
    const start = source.indexOf('    if (directMode) {\n      if (!ensureWalletConnected()');
    const branch = source.slice(start, source.indexOf("setStep('review');", start));
    expect(branch).toContain('if (directReviewWei > availableWei)');
  });
});
