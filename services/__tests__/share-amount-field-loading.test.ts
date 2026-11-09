import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatUnits } from 'viem';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareFieldFigure, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { underlyingFeedPrice, type ShareRate } from '@/services/share-rates';
import { formatUsdBalance } from '@/services/format-fiat';
// Bun.Transpiler is not in the app's type declarations, so the typecheck gate would reject a direct use.
type BunGlobal = { Bun: { Transpiler: new (options: { loader: 'ts' }) => { transformSync(source: string): string } } };

const rate: ShareRate = { chainId: 1, share: 'share', underlying: 'asset', shareSymbol: 'ppETH', shareDecimals: 18,
  underlyingDecimals: 18, underlyingSymbol: 'WETH', assetsPerShare: 1001100000000000000n };
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// Execute the real hook with local state/effect and feed adapters. No global
// module mocks, React Native imports, DOM, timers or network dependencies.
function fieldHarness(initialAmount = '', fieldRate: ShareRate | null = rate, prices: Record<string, number> = { asset: 2000 }) {
  const states: unknown[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let amount = initialAmount;
  let capKnown = false;
  let maxSharesExact = '0';
  const source = read('hooks/use-share-amount-field.ts').replace(/^import .*;$/gm, '').replace('export function', 'function');
  const body = new (globalThis as unknown as BunGlobal).Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const dependencies = {
    useState: (initial: unknown) => { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], (value: unknown) => { states[i] = value; }]; },
    useEffect: (effect: () => void) => { effects.push(effect); },
    useShareRates: () => ({ rateFor: () => fieldRate ?? undefined }),
    useAllChainsPriceMap: () => prices,
    useBalanceDisplay: () => (exact: string) => shareBalanceDisplay({ sharesExact: exact, shareSymbol: 'ppETH', rate: fieldRate ?? undefined, priceMap: {}, fallbackPrice: 0 }),
    getTokenMetadataBySymbol: () => ({ address: 'share' }),
    formatUnits, shareAmountFromUnderlying, shareFieldFigure, shareRateSnapshotKey, shareUsdDisplayExact,
    parseTokenAmount, sanitizeAmountInput, displayTokenSymbol, isShareSymbol, underlyingFeedPrice,
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
    expect(call.slice(0, call.indexOf('});') + 3)).toContain('capKnown:');
    expect(call.slice(0, call.indexOf('});') + 3)).toContain('onAmountResolved:');
  }
});

test('Send MAX: the field shows the underlying, the amount keeps every share wei, and the shown MAX typed back is the exact cap', () => {
  const h = fieldHarness();
  // 1.0001 shares x 1.0011 = 1.00120011 ETH: the shown figure rounds DOWN, so
  // typing it back reaches the cap only by being recognised as the shown MAX,
  // not by clamping (cubic on #324).
  const cap = '1.0001';
  h.cap(cap);
  const field = h.max(cap);
  expect(h.amount()).toBe(cap); // untouched MAX: never re-parsed
  expect(field.unitLabel).toBe('ETH');
  const exactUnderlying = parseTokenAmount(cap, 18) * rate.assetsPerShare / 10n ** 18n;
  expect(parseTokenAmount(field.value, 18) < exactUnderlying).toBe(true); // shown below, never above
  // Without recognition, the shown figure would convert to fewer shares than the cap.
  expect(parseTokenAmount(field.value, 18) * 10n ** 18n / rate.assetsPerShare < parseTokenAmount(cap, 18)).toBe(true);
  expect(field.display(cap)).toBe(`${field.value} ETH`); // what messages print is what the field shows
  h.type(field.value);
  expect(h.amount()).toBe(cap); // typing the shown MAX back keeps the exact cap
});

test('an editable cap never rounds above the exact value', () => {
  const h = fieldHarness();
  // 0.999 shares x 1.0011 = 1.0000989 ETH; a rounded label would read 1.00.
  const nearOne = formatUnits(999_999n * 10n ** 18n / 1_001_100n, 18);
  h.cap(nearOne);
  const field = h.max(nearOne);
  const exact = parseTokenAmount(nearOne, 18) * rate.assetsPerShare / 10n ** 18n;
  expect(parseTokenAmount(field.value, 18) <= exact).toBe(true);
});

test('Send manual edit converts once, rounds down and clamps to the exact share balance', () => {
  const h = fieldHarness();
  h.cap('1');
  h.type('0.5');
  // 0.5 / 1.0011 shares, rounded down in wei.
  expect(h.amount()).toBe(formatUnits(parseTokenAmount('0.5', 18) * 10n ** 18n / rate.assetsPerShare, 18));
  h.type('5');
  expect(h.amount()).toBe('1'); // clamped
});

test('Send without a live rate: the typed draft waits for the rate, the field never shows a count (DEV-621)', () => {
  const h = fieldHarness('', null);
  h.cap('1');
  const field = h.type('0.25');
  expect(h.amount()).toBe(''); // nothing converted, nothing taken as a count
  expect(field.value).toBe('0.25'); // the typed draft stays on screen
  expect(field.loading).toBe(true);
  expect(field.unitLabel).toBe('ETH');
  expect(field.unitLabel).not.toMatch(/pp|≈/i);
  expect(field.display('0.25')).toBeNull();
  // An exact amount set without a rate (MAX) shows no figure: the caller shows the shimmer.
  const max = h.max('0.5');
  expect(max.value).toBe('');
  expect(max.loading).toBe(true);
});

// QA on #72: the USDT pool header read "$4.76 / 4.77 USDT" while Withdraw at
// MAX read "4.77" over "$4.77". One position, one number (DEV-621 rule 3).
test('the field dollar line at MAX equals the balance header for the same position', () => {
  const usdt: ShareRate = { chainId: 1, share: 'share', underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7', shareSymbol: 'ppUSDT',
    shareDecimals: 18, underlyingDecimals: 6, underlyingSymbol: 'USDT', assetsPerShare: 1_005_578n };
  const prices = { [usdt.underlying]: 0.998, USDT: 0.998 };
  const cases: [ShareRate, Record<string, number>, string[]][] = [
    [usdt, prices, ['4.7525', '4.75249', '1', '0.5', '12.345678901234567891', '1234.5678']],
    [rate, { asset: 2459.37 }, ['0.0019', '0.1', '1', '0.099891872636417805']],
  ];
  for (const [fieldRate, priceMap, amounts] of cases) {
    for (const max of amounts) {
      const header = shareBalanceDisplay({ sharesExact: max, shareSymbol: fieldRate.shareSymbol, rate: fieldRate, priceMap, fallbackPrice: 0 });
      const h = fieldHarness('', fieldRate, priceMap);
      h.cap(max);
      const field = h.max(max);
      expect(`${field.value} ${header.symbol}`).toBe(header.text);
      expect(formatUsdBalance(parseFloat(field.usdValue))).toBe(formatUsdBalance(header.usd));
      expect(field.usdValue).toBe(formatUsdBalance(header.usd).replace(/[$,]/g, ''));
    }
  }
  // The QA position: both read $4.76, never $4.77.
  const h = fieldHarness('', usdt, prices);
  h.cap('4.7525');
  expect(h.max('4.7525').usdValue).toBe('4.76');
  expect(formatUsdBalance(shareBalanceDisplay({ sharesExact: '4.7525', shareSymbol: 'ppUSDT', rate: usdt, priceMap: prices, fallbackPrice: 0 }).usd)).toBe('$4.76');
});

test('every dollar line under an amount field uses the header formatter', () => {
  const withdraw = read('components/withdraw-modal-provider.tsx');
  const label = withdraw.slice(withdraw.indexOf('const amountDollarLabel'), withdraw.indexOf('const displayAvailableNum'));
  expect(label).toContain('formatUsdBalance(view.usd)');
  expect(label).not.toContain('toFixed(');
  const hub = read('components/home/action-hub.tsx');
  expect(hub).toContain('formatUsdBalance(shareFiatEntry ? parseFloat(amountField.usdValue) || 0 : balanceDisplay(activeAmountText');
  expect(read('hooks/use-share-amount-field.ts')).toContain('underlyingFeedPrice(rate, prices)');
});
