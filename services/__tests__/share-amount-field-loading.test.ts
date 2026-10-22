import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatUnits } from 'viem';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';

const rate: ShareRate = { chainId: 1, share: 'share', underlying: 'asset', shareSymbol: 'ppETH', shareDecimals: 18,
  underlyingDecimals: 18, underlyingSymbol: 'WETH', assetsPerShare: 1001100000000000000n };
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// Execute the real hook with local state/effect and feed adapters. No global
// module mocks, React Native imports, DOM, timers or network dependencies.
function fieldHarness(initialAmount = '') {
  const states: unknown[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let amount = initialAmount;
  let capKnown = false;
  let maxSharesExact = '0';
  const source = read('hooks/use-share-amount-field.ts').replace(/^import .*;$/gm, '').replace('export function', 'function');
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const dependencies = {
    useState: (initial: unknown) => { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], (value: unknown) => { states[i] = value; }]; },
    useEffect: (effect: () => void) => { effects.push(effect); },
    useShareRates: () => ({ rateFor: () => rate }),
    useAllChainsPriceMap: () => ({ asset: 2000 }),
    useBalanceDisplay: () => (exact: string) => shareBalanceDisplay({ sharesExact: exact, shareSymbol: 'ppETH', rate, priceMap: {}, fallbackPrice: 0 }),
    getTokenMetadataBySymbol: () => ({ address: 'share' }),
    formatUnits, shareAmountFromUnderlying, shareRateSnapshotKey, shareUsdDisplayExact,
    parseTokenAmount, sanitizeAmountInput, displayTokenSymbol, isShareSymbol,
  };
  const useField = new Function(...Object.keys(dependencies), `${body}; return useShareAmountField;`)(...Object.values(dependencies));
  const render = () => {
    cursor = 0; effects = [];
    const field = useField({ amount, symbol: 'ppETH', chainId: 1, maxSharesExact, capKnown,
      onAmountResolved: (shares: string) => { amount = shares; } });
    for (const effect of effects) effect();
    return field;
  };
  return {
    render, amount: () => amount,
    type: (text: string, denomination = 'underlying') => { amount = render().toShares(text, denomination); return render(); },
    cap: (cap: string, known = true) => { maxSharesExact = cap; capKnown = known; render(); return render(); },
    max: (exact: string) => { amount = exact; return render(); },
  };
}

for (const denomination of ['underlying', 'usd']) {
  test(`${denomination} draft waits for the cap, then converts without retyping`, () => {
    const h = fieldHarness('0.02');
    const text = denomination === 'usd' ? '200' : '0.1';
    const draft = h.type(text, denomination);
    expect(denomination === 'usd' ? draft.usdValue : draft.value).toBe(text);
    expect(h.amount()).toBe('0.02');
    expect(draft.error).toBeNull();
    const resolved = h.cap('1');
    expect(h.amount()).toBe('0.099890120867046249');
    expect(denomination === 'usd' ? resolved.usdValue : resolved.value).toBe(text);
    expect(resolved.error).toBeNull();
  });
}

test('an empty share amount retains a loading draft and a known zero reports unavailable', () => {
  const h = fieldHarness();
  expect(h.type('0.1').value).toBe('0.1');
  expect(h.amount()).toBe('');
  const zero = h.cap('0');
  expect(h.amount()).toBe('0');
  expect(zero.error).toBe('No shielded balance available.');
});

test('cap and readiness changes invalidate a resolved edit, without reparsing stored shares or MAX', () => {
  const h = fieldHarness();
  h.cap('0');
  expect(h.type('0.1').error).toBe('No shielded balance available.');
  expect(h.cap('1').error).toBeNull();
  expect(h.amount()).toBe('0');
  expect(h.cap('0', false).error).toBeNull();
  h.cap('1');
  h.type('0.100001');
  expect(h.render().value).toBe('0.100001');
  expect(h.cap('2').value).not.toBe('0.100001');
  const max = '0.099891872636417805';
  h.max(max); h.cap('3');
  expect(h.amount()).toBe(max);
});

test('all four amount-field surfaces explicitly identify unresolved caps and accept resolved shares', () => {
  for (const file of ['components/withdraw-modal-provider.tsx', 'components/home/action-hub.tsx', 'components/transfer-modal-provider.tsx', 'components/pools/pool-action-panel.tsx']) {
    const call = read(file).slice(read(file).indexOf('const amountField = useShareAmountField('));
    expect(call.slice(0, call.indexOf('});') + 3), file).toContain('capKnown:');
    expect(call.slice(0, call.indexOf('});') + 3), file).toContain('onAmountResolved:');
  }
});
