import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatUnits, parseUnits } from 'viem';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareFieldFigure, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { underlyingFeedPrice, type ShareRate } from '@/services/share-rates';
import { preparedAmountData } from '@/services/prepared-amount-data';

// The Swap modal opened outside the home card (the pool page) stored the typed
// figure as is, and `amountWei` read it as shares: "10 USDC" prepared 10 ppUSDC
// shares, worth more than 10 USDC. Underlying is display only: the typed coin
// converts to exact shares at the boundary, with no 1:1 fallback while the rate
// is missing.

type BunGlobal = { Bun: { Transpiler: new (options: { loader: 'ts' }) => { transformSync(source: string): string } } };
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// ppUSDC: an 18-decimal share over 6-decimal USDC, worth a little more than one.
const RATE: ShareRate = {
  chainId: 1, share: 'share', underlying: 'usdc', shareSymbol: 'ppUSDC', shareDecimals: 18,
  assetsPerShare: 1_004_217n, underlyingSymbol: 'USDC', underlyingDecimals: 6,
};

/** What the conversion boundary itself makes of a typed coin amount on Swap. */
const expectedShares = (text: string, cap = '0') =>
  shareAmountFromUnderlying({ text, rate: RATE, maxSharesExact: cap, displayedMax: shareFieldFigure(cap, RATE), clamp: false });

// Runs the REAL hook (hooks/use-share-amount-field.ts) with local state/effect
// adapters, called with the exact arguments the Swap modal passes.
function swapField(rate: ShareRate | null) {
  const states: unknown[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let amount = '';
  let currentRate = rate;
  let session = 0;
  const source = read('hooks/use-share-amount-field.ts').replace(/^import .*;$/gm, '').replace('export function', 'function');
  const body = new (globalThis as unknown as BunGlobal).Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const dependencies = {
    useState: (initial: unknown) => { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], (value: unknown) => { states[i] = value; }]; },
    useEffect: (effect: () => void) => { effects.push(effect); },
    useShareRates: () => ({ rateFor: () => currentRate ?? undefined }),
    useAllChainsPriceMap: () => ({}),
    useBalanceDisplay: () => (exact: string) => shareBalanceDisplay({ sharesExact: exact, shareSymbol: 'ppUSDC', rate: currentRate ?? undefined, priceMap: {}, fallbackPrice: 0 }),
    getTokenMetadataBySymbol: () => ({ address: 'share' }),
    formatUnits, shareAmountFromUnderlying, shareFieldFigure, shareRateSnapshotKey, shareUsdDisplayExact,
    parseTokenAmount, sanitizeAmountInput, displayTokenSymbol, isShareSymbol, underlyingFeedPrice,
  };
  const useField = new Function(...Object.keys(dependencies), `${body}; return useShareAmountField;`)(...Object.values(dependencies));
  const render = () => {
    cursor = 0; effects = [];
    // A fresh account: balance known and zero, as on the smoke's wallet.
    const field = useField({ amount, symbol: 'ppUSDC', chainId: 1, maxSharesExact: '0', capKnown: true,
      onAmountResolved: (shares: string) => { amount = shares; }, underlyingEntry: true, clampToMax: false, sessionKey: session });
    for (const effect of effects) effect();
    return field;
  };
  return {
    render,
    amount: () => amount,
    // editAmount: the typed text crosses through toShares, then the swap's own sanitizer.
    type: (text: string) => { amount = sanitizeAmountInput(render().toShares(text), 18); return render(); },
    rateArrives: (r: ShareRate) => { currentRate = r; render(); return render(); },
    // closeSwapModal / openSwapModal (resetState): a new session, an empty amount.
    reopen: () => { session += 1; amount = ''; return render(); },
  };
}

describe('Swap: the typed coin is converted to shares before it is prepared', () => {
  test('5 USDC prepares the shares 5 USDC buys, not 5 shares', () => {
    const f = swapField(RATE);
    f.type('5');
    expect(f.amount()).toBe(expectedShares('5'));
    expect(f.amount()).not.toBe('5');
    // Floored: the prepared shares are never worth more than what was typed.
    expect(parseUnits(f.amount(), 18) * RATE.assetsPerShare / 10n ** 18n).toBeLessThanOrEqual(parseUnits('5', 6));
  });

  test('above the balance it is not cut to the balance (the flow says insufficient)', () => {
    const f = swapField(RATE);
    f.type('1000');
    expect(f.amount()).toBe(expectedShares('1000'));
    expect(parseUnits(f.amount(), 18)).toBeGreaterThan(0n);
  });

  test('no rate: nothing is prepared and the field waits; the draft converts when the rate lands', () => {
    const f = swapField(null);
    const draft = f.type('5');
    expect(f.amount()).toBe('');
    expect(draft.loading).toBe(true);
    f.rateArrives(RATE);
    expect(f.amount()).toBe(expectedShares('5'));
  });

  test('a draft typed before the rate does not outlive the modal (close, reopen, then the rate lands)', () => {
    const f = swapField(null);
    f.type('5');
    expect(f.amount()).toBe('');
    const reopened = f.reopen();
    expect(reopened.value).toBe('');
    f.rateArrives(RATE);
    expect(f.amount()).toBe('');
    expect(f.render().value).toBe('');
  });

  test('the field shows the coin back, not the share count', () => {
    const f = swapField(RATE);
    f.type('5');
    expect(f.render().value).toBe('5');
    expect(f.render().unitLabel).toBe('USDC');
  });

  test('the smoke reads the exact prepared amount off the field', () => {
    expect(preparedAmountData('4.97')).toEqual({ dataSet: { preparedAmount: '4.97' } });
  });
});

describe('Swap modal wiring (source guard)', () => {
  const modal = read('components/swap-modal-provider.tsx');
  const slice = (start: string, length = 1200) => {
    const at = modal.indexOf(start);
    expect(at).toBeGreaterThan(0);
    return modal.slice(at, at + length);
  };

  test('the modal uses the shared share-amount field, unclamped, converting on EVM', () => {
    const call = slice('const amountField = useShareAmountField({', 700);
    expect(call).toContain('symbol: fromToken.symbol');
    expect(call).toContain('onAmountResolved: setAmount');
    expect(call).toContain('underlyingEntry: !isSui');
    expect(call).toContain('clampToMax: false');
    expect(call).toContain('sessionKey: formSession');
  });

  test('every open and every close starts a new field session', () => {
    expect(slice('const resetState = useCallback(', 1600)).toContain('setFormSession((n) => n + 1)');
    expect(slice('const closeSwapModal = useCallback(', 400)).toContain('setFormSession((n) => n + 1)');
  });

  test('typing goes through toShares and the field shows the coin', () => {
    expect(slice('const editAmount = useCallback(', 300)).toContain('setAmount(sanitizeAmountInput(toShares(v), fromToken.decimals))');
    const input = slice('value={amountField.value}', 500);
    expect(input).toContain('onChangeText={editAmount}');
    expect(input).toContain('{...preparedAmountData(amount)}');
    expect(modal).not.toContain('value={amount}\n');
  });

  test('Review is refused while a share rate is unknown', () => {
    expect(slice('const canReview =', 600)).toContain('!amountField.loading');
  });

  test('every write to the prepared amount is shares: a clear, a share hand-off, or the boundary', () => {
    // amountWei reads `amount` as the token's own units, so nothing typed may
    // reach setAmount except through toShares. A new call site has to be added
    // here on purpose, saying what units it writes.
    const writes = [...modal.matchAll(/setAmount\(([^;]*)\);/g)].map((m) => m[1].trim());
    const allowed = new Set([
      "''", // clears
      "options?.initialAmount ? sanitizeAmountInput(options.initialAmount, initial.decimals) : ''", // hand-off: shares
      'sanitizeAmountInput(patch.amount, nextFrom.decimals)', // the hub pushes shares
      'sanitizeAmountInput(toShares(v), fromToken.decimals)', // typed coin, converted
    ]);
    const unknown = writes.filter((w) => !allowed.has(w));
    expect(unknown).toEqual([]);
    expect(modal).toContain('onAmountResolved: setAmount');
    expect(modal).toContain('const amountWei = useMemo(() => {\n    try { return parseTokenAmount(amount, fromToken.decimals); }');
  });

  test('switching the token clears the amount instead of carrying shares into another asset', () => {
    const edit = slice('const editFromToken = useCallback(', 500);
    expect(edit).toContain("setAmount('')");
    expect(edit).not.toContain('setAmount((a) =>');
  });
});

describe('pool page Swap tab hands shares to the modal', () => {
  test('the panel converts on Swap as it does on Withdraw and Send, unclamped', () => {
    const panel = read('components/pools/pool-action-panel.tsx');
    expect(panel).toContain("underlyingEntry: action === 'withdraw' || action === 'transfer' || action === 'swap', clampToMax: action !== 'swap'");
    expect(panel).toContain('onChangeText={(text) => setTypedAmount(sanitizeAmountInput(active.spendsPool ? amountField.toShares(text) : text, decimals))}');
  });
  test('the hub keeps its own conversion (the path that already worked)', () => {
    const hub = read('components/home/action-hub.tsx');
    expect(hub).toContain("underlyingEntry: action === 'withdraw' || action === 'send' || action === 'swap'");
    expect(hub).toContain("clampToMax: action !== 'swap'");
  });
});

describe('expectations come from the boundary, not from copied numbers', () => {
  test('the expected shares differ from the typed figure at any rate above one', () => {
    expect(expectedShares('5')).not.toBe('5');
    // Read back at the same rate, the shares are worth the typed coin to within one base unit.
    const worth = parseUnits(expectedShares('5'), 18) * RATE.assetsPerShare / 10n ** 18n;
    expect(parseUnits('5', 6) - worth).toBeLessThanOrEqual(1n);
    expect(formatUnits(worth, 6).startsWith('4.99') || formatUnits(worth, 6) === '5').toBe(true);
  });
});
