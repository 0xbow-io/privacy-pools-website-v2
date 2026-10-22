import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spendableBalanceLabel } from '@/services/spendable-balance-label';
import { parseTokenAmount } from '@/services/token-amount';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
test('plain spendable labels round down, including cents, ETH and dust', () => {
  for (const [exact, symbol, expected] of [['10.996', 'USDC', '10.99 USDC'], ['0.123456', 'ETH', '0.12345 ETH'], ['0.0044999', 'ETH', '0.00449 ETH'], ['0.000000009999', 'ETH', '0.0000000099 ETH']]) {
    const label = spendableBalanceLabel(exact, symbol, () => { throw new Error('Plain pools must not use share display'); });
    expect(label).toBe(expected);
    expect(parseTokenAmount(label.split(' ')[0], 18)).toBeLessThanOrEqual(parseTokenAmount(exact, 18));
  }
});
test('share spendable labels use the underlying display boundary', () => {
  expect(spendableBalanceLabel('0.09989', 'ppETH', () => '0.10 ETH')).toBe('0.10 ETH');
});
test('Available, Balance, exceeds and single-proof ceilings use the spendable formatter', () => {
  const withdraw = read('components/withdraw-modal-provider.tsx');
  expect(withdraw).toContain('Available: ${spendableLabel(');
  expect(withdraw).toContain("Balance: {spendabilityBlocked ? '—' : spendableLabel(");
  expect(withdraw).toContain('Amount exceeds your shielded balance (${spendableLabel(');
  expect(withdraw).toContain('One withdrawal can spend ${spendableLabel(');
  expect(read('components/home/action-hub.tsx')).toContain('spendableBalanceLabel(withdrawSpendableExact');
});

test('plain ceiling and Send shortfall fallbacks preserve their previous exact/floored labels', () => {
  const withdraw = read('components/withdraw-modal-provider.tsx');
  for (const value of ['max', 'maxInput']) {
    expect(withdraw).toContain(`isShareSymbol(selectedToken) ? balanceDisplay(${value}, selectedToken, chainId).text : tokenAmountLabel(${value}, selectedToken)`);
  }
  const send = read('components/transfer-modal-provider.tsx');
  expect(send).toContain(': tokenAmountLabel(formatShortfallAmount(v, selectedDecimals, up, selectedSymbol), selectedSymbol)');
  expect(send).toContain(': tokenAmountLabel(capText(maxSpendableWei, enteredAmountWei, selectedDecimals), selectedSymbol)');
});
