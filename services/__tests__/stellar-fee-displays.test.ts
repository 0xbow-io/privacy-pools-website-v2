import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { formatUnits, parseUnits } from 'viem';
import { estimateStellarRelayFee, stellarTransferRelayFee } from '@/config/stellar-deployment';
import { selectWithdrawInputs } from '@/services/withdraw-note-selection';
import { selectGreedyTransferInputs, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS } from '@/services/transfer-note-selection';
import { resolveRemainingBalanceWei } from '@/services/withdraw-quotes';
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
const pay = screen('stellar-pay-request');
const notes = ['0.6', '0.6', '2'].map((amount, i) => ({
  value: parseUnits(amount, 7).toString(), commitment: `0x${i}`, status: 'ACTIVE', label: 'a', tokenId: 'XLM',
})) as unknown as Note[];
const useMemo = (fn: () => unknown) => fn();
const selectionEnv = {
  isSui: true, isStellar: true, amount: '1', altDecimals: 7, notes,
  suiSpendability: { totalWei: 32000000n, maxSingleWei: 32000000n, storedNotes: [] },
  useMemo, parseTokenAmount: parseUnits, estimateStellarRelayFee, selectWithdrawInputs,
};

test('withdrawal displays use the estimate while selection still reserves the ceiling', () => {
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
  // A smaller estimate cannot make the reserved selection cover this balance.
  const short = withdraw('suiWithdraw', { ...selectionEnv, notes: [
    { ...notes[0], value: '10500000' },
  ] });
  expect(short.selection).toBeNull();
  expect(short.inputCount).toBe(0);
  // EVM's quoted debit and Sui's amount-only debit retain their display math.
  expect(withdraw('remainingAmount', { ...env, isSui: false, isStellar: false, stellarFeeWei: null, grossLeavingWei: 11000000n })).toBeCloseTo(2.1, 7);
  expect(withdraw('remainingAmount', { ...env, isStellar: false, stellarFeeWei: null })).toBeCloseTo(2.2, 7);
});

test('payment request total uses its cached fee and the submit selection reserves the ceiling', () => {
  const env = {
    stellarSession: { spendableNotes: notes }, stroops: 10000000n,
    useMemo, selectGreedyTransferInputs, stellarTransferRelayFee, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS,
  };
  const selected = pay('feeSelection', env);
  expect(selected).toEqual(selectGreedyTransferInputs(notes, 10750000n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS));
  const display = { stroops: 10000000n, relayFee: 437862n, formatUnits, STELLAR_XLM: { decimals: 7 } };
  expect(pay('totalLabel', display)).toBe('~1.0437862 XLM');
  expect(pay('totalLabel', { ...display, relayFee: null })).toBe('Estimate unavailable');
});

test('all Stellar fee displays read the shared cache, including requests and saving a claim', () => {
  for (const [file, hook] of [
    ['transfer-modal-provider', 'useStellarTransferFeeEstimate'],
    ['stellar-pay-request', 'useStellarTransferFeeEstimate'],
    ['stellar-claim-note', 'useStellarTransferFeeEstimate'],
    ['withdraw-modal-provider', 'useStellarWithdrawalFeeEstimate'],
  ]) {
    const source = readFileSync(new URL(`../../components/${file}.tsx`, import.meta.url), 'utf8');
    expect(source).toContain(hook);
    expect(source).not.toMatch(/fetchStellarFees|readStellarFeeSettings/);
  }
});

test('payment requests show a preliminary estimate before a funded selection is available', () => {
  expect(pay('feeInputCount', { stroops: 10000000n, feeSelection: { covered: false, selectedNotes: [] } })).toBe(1);
  expect(pay('feeInputCount', { stroops: 10000000n, feeSelection: { covered: true, selectedNotes: notes } })).toBe(3);
  expect(pay('feeInputCount', { stroops: null, feeSelection: { covered: false, selectedNotes: [] } })).toBe(0);
});
