import { maxCoverableTransfer, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS } from '@/services/transfer-note-selection';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { formatUnits, parseUnits } from 'viem';
import { maxStellarAmount, selectStellarInputs } from '@/services/stellar-fee-selection';
import { resolveRemainingBalanceWei, topNAcrossLabels } from '@/services/withdraw-quotes';
import type { Note } from '@/services/sdk-types';

// Evaluate the display expressions used by the screens, as the existing
// asp-affordances tests do, without loading React Native or wallet providers.
function screen(name: string) {
  const text = readFileSync(new URL(`../../components/${name}.tsx`, import.meta.url), 'utf8');
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (variable: string, env: Record<string, unknown>) => {
    let expression: string | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === variable && node.initializer) expression = node.initializer.getText(file);
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (!expression) throw new Error(`Missing production expression: ${variable}`);
    const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), code)(...Object.values(env));
  };
}
const withdraw = screen('withdraw-modal-provider');
const transfer = screen('transfer-modal-provider');
const pay = screen('stellar-pay-request');
const notes = ['0.6', '0.6', '2'].map((amount, i) => ({
  value: parseUnits(amount, 7).toString(), commitment: `0x${i}`, status: 'ACTIVE', label: 'a', tokenId: 'XLM',
})) as unknown as Note[];
const useMemo = (fn: () => unknown) => fn();
const selectionEnv = {
  isSui: true, isStellar: true, amount: '1', altDecimals: 7, notes,
  suiSpendability: { totalWei: 32000000n, maxSingleWei: 32000000n, storedNotes: [] },
  useMemo, parseTokenAmount: parseUnits, selectStellarInputs, stellarFeeFor: () => 492989n,
};

test('withdrawal displays use the estimate and selection use the reviewed fee with its allowance', () => {
  const selected = withdraw('suiWithdraw', selectionEnv);
  expect(selected.inputCount).toBe(2);
  expect(selected.selection).not.toBeNull();
  const env = {
    isSui: true, isStellar: true, suiWithdraw: selected, stellarFeeWei: 492989n,
    currentBalance: { active: 32000000n }, selectedTokenDecimals: 7,
    grossLeavingWei: 10000000n, grossWithdrawn: 1, altScale: 10000000,
    batchPlan: null, relayerFee: 0, resolveRemainingBalanceWei,
    tokenBalanceNum: (value: bigint, decimals: number) => Number(value) / 10 ** decimals,
  };
  expect(withdraw('reviewFee', env)).toBeCloseTo(0.0492989, 7);
  expect(withdraw('reviewGross', env)).toBeCloseTo(1.0492989, 7);
  expect(withdraw('remainingAmount', env)).toBeCloseTo(2.1507011, 7);
  for (const variable of ['reviewFee', 'reviewGross', 'remainingAmount']) {
    expect(withdraw(variable, { ...env, stellarFeeWei: null })).toBeNull();
  }
  // The allowance must fit too; the fee alone would leave too little room.
  const short = withdraw('suiWithdraw', { ...selectionEnv, notes: [
    { ...notes[0], value: '10492989' },
  ] });
  expect(short.selection).toBeNull();
  expect(short.inputCount).toBe(0);
  // EVM's quoted debit and Sui's amount-only debit retain their display math.
  expect(withdraw('remainingAmount', { ...env, isSui: false, isStellar: false, stellarFeeWei: null, grossLeavingWei: 11000000n })).toBeCloseTo(2.1, 7);
  expect(withdraw('remainingAmount', { ...env, isStellar: false, stellarFeeWei: null })).toBeCloseTo(2.2, 7);
});

test('payment request total uses its cached fee and the submit selection covers that fee', () => {
  const env = {
    stellarSession: { spendableNotes: notes }, stroops: 10000000n,
    useMemo, selectStellarInputs, feeFor: () => 2849562n,
  };
  const selected = pay('feeSelection', env);
  expect(selected).toEqual(selectStellarInputs(notes, 10000000n, env.feeFor));
  const display = { stroops: 10000000n, relayFee: 437862n, formatUnits, STELLAR_XLM: { decimals: 7 } };
  expect(pay('totalLabel', display)).toBe('~1.0437862 XLM');
  expect(pay('totalLabel', { ...display, relayFee: null })).toBe('Estimate unavailable');
});

test('all Stellar fee displays read the shared cache, including requests and saving a claim', () => {
  for (const [file, hook] of [
    ['transfer-modal-provider', 'useStellarFeeFor'],
    ['stellar-pay-request', 'useStellarFeeFor'],
    ['stellar-claim-note', 'useStellarTransferFeeEstimate'],
    ['withdraw-modal-provider', 'useStellarFeeFor'],
  ]) {
    const source = readFileSync(new URL(`../../components/${file}.tsx`, import.meta.url), 'utf8');
    expect(source).toContain(hook);
    expect(source).not.toMatch(/fetchStellarFees|readStellarFeeSettings/);
  }
});

test('payment requests show a preliminary estimate before a funded selection is available', () => {
  const selected = pay('feeSelection', { stellarSession: { spendableNotes: [] }, stroops: 10000000n,
    useMemo, selectStellarInputs, feeFor: () => 2849562n });
  expect(selected.covered).toBe(false);
  expect(pay('relayFee', { feeSelection: selected })).toBe(2849562n);
});

test('Review and Confirm retain the approved fee when the live feed changes', () => {
  for (const name of ['withdraw-modal-provider']) {
    const read = screen(name);
    const reviewedStellarFeeFor = () => 2849562n;
    const liveStellarFeeFor = () => 4000000n;
    for (const step of ['review', 'loading']) {
      const feeFor = read('stellarFeeFor', { step, reviewedStellarFeeFor, liveStellarFeeFor });
      expect(feeFor(1, 10000000n)).toBe(2849562n);
    }
    expect(read('stellarFeeFor', { step: 'withdraw', reviewedStellarFeeFor, liveStellarFeeFor })(1, 10000000n)).toBe(4000000n);
  }
});


test('a missing or excessive cached fee does not block the signed withdrawal quote', () => {
  const env = { useMemo, isSui: true, isStellar: true, altScale: 10000000, altSymbol: 'XLM', WITHDRAW_MAX_INPUTS: 5,
    stellarSession: { pendingTotal: 0n }, availableWei: 15000000n,
    suiWithdraw: { want: 10000000n, selection: null, activeTotal: 20000000n, maxSingle: 15000000n } };
  expect(withdraw('suiAmountError', env)).toBeNull();
  expect(withdraw('suiAmountError', { ...env, suiWithdraw: { ...env.suiWithdraw, want: 16000000n } })).toContain('5 notes');
  expect(withdraw('suiAmountError', { ...env, suiWithdraw: { ...env.suiWithdraw, want: 21000000n } })).toContain('Insufficient');
});


test('production Send and Withdraw gates reach live quotes when cached pricing is missing or too high', () => {
  for (const stellarFeeFor of [() => null, () => 1000000000n]) {
    const shared = { useMemo, isSui: true, isStellar: true, notes, stellarFeeFor, maxStellarAmount,
      stellarSession: { unlocked: true, lastSyncedAt: 1, pendingTotal: 0n }, suiStoredNotes: [],
      normalizeHashValue: (value: string) => value, maxCoverableTransfer, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS };
    const suiSpendability = withdraw('suiSpendability', shared);
    expect(suiSpendability.maxSingleWei).toBe(0n);
    const suiWithdraw = withdraw('suiWithdraw', { ...selectionEnv, ...shared, suiSpendability });
    expect(withdraw('suiAmountError', { ...shared, suiWithdraw, availableWei: 32000000n,
      altScale: 10000000, altSymbol: 'XLM', WITHDRAW_MAX_INPUTS: 5 })).toBeNull();
    const transferCapacity = transfer('transferCapacity', { ...shared, stellarActiveNotes: notes, suiMaxLineageTotal: 0n });
    expect(transferCapacity).toBe(32000000n);
    expect(transfer('amountError', { amount: '1', enteredAmount: 1, enteredAmountWei: 10000000n,
      isStellar: true, stellarConnected: true, stellarLocked: false, isSui: true,
      suiActiveTotal: 32000000n, suiMaxLineageTotal: 0n, transferCapacity })).toBeNull();
  }
});


test('withdrawal presets use raw capacity even when the estimated Max is unavailable', () => {
  let applied = '';
  const apply = withdraw('applyPresetAmount', {
    spendabilityBlocked: false, isStellar: true, availableWei: 20000000n,
    getWithdrawMaxWei: (_token: string, reserveFee = true) => reserveFee ? 0n : 20000000n, selectedToken: 'XLM', selectedTokenDecimals: 7,
    amountField: { presetExceedsMax: () => null, toShares: (value: string) => value },
    presetExceedsWithdrawMax: (value: string, max: bigint, decimals: number) => parseUnits(value, decimals) > max,
    applyShareAmount: (value: string) => { applied = value; },
    errorToast: () => { throw new Error('A fundable preset was blocked'); },
  });
  apply('1');
  expect(applied).toBe('1');
});


test('inline and modal presets can read raw capacity without changing fee-adjusted Max', () => {
  const getWithdrawMaxWei = withdraw('getWithdrawMaxWei', {
    useCallback: (fn: unknown) => fn, spendabilityBlocked: false, isStellar: true, isSui: true,
    altSymbol: 'XLM', suiSpendability: { maxSingleWei: 0n }, tokenBalances: new Map(),
    notes, activeNotesForSelectedToken: [], topNAcrossLabels, WITHDRAW_MAX_INPUTS: 5,
  });
  expect(getWithdrawMaxWei('XLM')).toBe(0n);
  expect(getWithdrawMaxWei('XLM', false)).toBe(32000000n);
  expect(screen('home/action-hub')('withdrawPresetMaxWei', { getWithdrawMaxWei, tokenMeta: { symbol: 'XLM' } })).toBe(32000000n);
});
