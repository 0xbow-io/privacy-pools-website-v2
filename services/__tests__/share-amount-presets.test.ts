import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import type { ShareRate } from '@/services/share-rates';
// Bun.Transpiler is not in the app's type declarations, so the typecheck gate would reject a direct use.
type BunGlobal = { Bun: { Transpiler: new (options: { loader: 'ts' }) => { transformSync(source: string): string } } };

const RATE: ShareRate = { chainId: 1, share: 'share', underlying: 'asset', shareSymbol: 'ppETH', shareDecimals: 18,
  underlyingDecimals: 18, underlyingSymbol: 'WETH', assetsPerShare: 1001100000000000000n };
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('a literal 0.1 ETH preset means underlying and crosses the entry boundary once', () => {
  const shares = shareAmountFromUnderlying({ text: '0.1', rate: RATE, maxSharesExact: '1', displayedMax: '1.0011' });
  expect(shares).toBe('0.099890120867046249');
  expect(shares).not.toBe('0.1');
  expect(shareBalanceDisplay({ sharesExact: shares, shareSymbol: 'ppETH', rate: RATE, priceMap: { ETH: 2459 }, fallbackPrice: 0 }).text).toBe('0.10 ETH');
  expect(shareUsdDisplayExact(shares, RATE, '2459', { field: true })).toBe('245.90');
});

test('Use maximum keeps an exact share string, without treating it as underlying', () => {
  const exact = '0.099891872636417805';
  expect(sanitizeAmountInput(exact, 18)).toBe(exact);
  expect(parseTokenAmount(sanitizeAmountInput(exact, 18), 18)).toBe(99891872636417805n);
  const source = read('components/withdraw-modal-provider.tsx');
  const setter = source.slice(source.indexOf('  const applyShareAmount ='), source.indexOf('  const applyPresetAmount ='));
  expect(setter).toContain('setAmount(val)');
  expect(setter).not.toContain('toShares(');
  expect(source).toContain('applyShareAmount(amountField.toShares(value));');
  expect(source).toContain('onPress={() => applyShareAmount(formatUnits(singleProofMaxInputWei, tokenDecimalsForDisplay))}');
});

test('both quick-preset surfaces label literals and convert presses; percentages and Send Max stay shares', () => {
  const withdraw = read('components/withdraw-modal-provider.tsx');
  expect(withdraw).toContain('`${formatQuickAmount(preset)} ${amountField.symbol}`');
  expect(withdraw).not.toContain('balanceDisplay(preset, selectedToken');
  const hub = read('components/home/action-hub.tsx');
  expect(hub).toContain("const next = a === 'withdraw' ? amountField.toShares(preset) : preset;");
  expect(hub).toContain('`${preset} ${amountField.symbol}`');
  expect(hub).toContain('const next = sanitizeAmountInput(maxText, payMeta.decimals);');
  const panel = read('components/pools/pool-action-panel.tsx');
  expect(panel).toContain('setTypedAmount(sanitizeAmountInput(formatUnits(part, decimals), decimals));');
  const transfer = read('components/transfer-modal-provider.tsx');
  expect(transfer).toContain('onPress={() => setAmount(formatUnits(relayFeeMaxSend, selectedDecimals))}');
  expect(transfer).toContain('onPress={() => setAmount(maxSpendableFormatted)}');
});

test('share USD display writers use the exact equivalent, not shares times an underlying price', () => {
  const source = read('components/withdraw-modal-provider.tsx');
  expect(source).toContain('const view = balanceDisplay(sharesExact, selectedToken, chainId);');
  expect(source).toContain('view.usd.toFixed(2)');
  expect(source).toContain('setDollarValue(amountDollarLabel(val));');
  expect(source).not.toMatch(/setDollarValue\(`\$\$\{.*currentPrice/);
  expect(read('hooks/use-share-amount-field.ts')).toContain('shareUsdDisplayExact(shares, rate, priceExact, { field: true })');
});

test('one display unit above the rounded maximum never exceeds the original share cap', () => {
  const cap = '0.09989';
  for (const text of ['0.10001', '0.11']) {
    const result = shareAmountFromUnderlying({ text, rate: RATE, maxSharesExact: cap, displayedMax: '0.10' });
    expect(result).toBe(cap);
    expect(parseTokenAmount(result, 18)).toBeLessThanOrEqual(parseTokenAmount(cap, 18));
  }
  const usd = shareAmountFromUnderlying({ text: '245.91', rate: RATE, maxSharesExact: cap, displayedMax: '245.90', denomination: 'usd', usdPriceExact: '2459' });
  expect(usd).toBe(cap);
  const stable = { ...RATE, underlyingSymbol: 'USDC', underlyingDecimals: 6, assetsPerShare: 1000103n };
  expect(shareAmountFromUnderlying({ text: '38.11', rate: stable, maxSharesExact: '38.1', displayedMax: '38.10' })).toBe('38.1');
});

test('equivalent rate object refreshes preserve the draft key; actual rate changes never rewrite stored shares', () => {
  const stored = '0.099891872636417805';
  const submitted = parseTokenAmount(stored, 18);
  expect(shareRateSnapshotKey({ ...RATE })).toBe(shareRateSnapshotKey(RATE));
  const next = { ...RATE, assetsPerShare: RATE.assetsPerShare + 1n };
  expect(shareRateSnapshotKey(next)).not.toBe(shareRateSnapshotKey(RATE));
  shareBalanceDisplay({ sharesExact: stored, shareSymbol: 'ppETH', rate: next, priceMap: { ETH: 2459 }, fallbackPrice: 0 });
  expect(parseTokenAmount(stored, 18)).toBe(submitted);
  const field = read('hooks/use-share-amount-field.ts');
  expect(field).toContain('edit.rateKey === rateKey');
  expect(field).not.toContain('edit.rate === rate');
  expect(field).not.toMatch(/setAmount\(/);
  expect(field).toContain('if (!pendingEdit || !capKnown || !rate');
});


test('modal refuses an out-of-reach share preset before clamping and greys its chip', () => {
  const cap = '0.29967';
  const preview = shareAmountFromUnderlying({ text: '1', rate: RATE, maxSharesExact: cap, displayedMax: '0.30', preview: true });
  expect(preview.exceedsMax).toBe(true);
  let amount = '0.01';
  if (!preview.exceedsMax) amount = preview.shares;
  expect(amount).toBe('0.01');
  const source = read('components/withdraw-modal-provider.tsx');
  const setter = source.slice(source.indexOf('  const applyPresetAmount ='), source.indexOf('  // FullWithdrawalGuard escape hatch'));
  expect(setter).toContain('amountField.presetExceedsMax(value)');
  expect(setter).toContain('You can withdraw up to');
  expect(setter.indexOf('return;')).toBeLessThan(setter.indexOf('amountField.toShares(value)'));
  expect(source).toContain('accessibilityState={{ disabled: outOfReach || spendabilityBlocked }}');
  expect(source).toContain("outOfReach ? 'opacity-40'");
  let writes = 0;
  let conversions = 0;
  let ceiling = '';
  const run = new Function('spendabilityBlocked', 'getWithdrawMaxWei', 'selectedToken', 'selectedTokenDecimals',
    'amountField', 'presetExceedsWithdrawMax', 'errorToast', 'spendableLabel', 'formatUnits', 'chainId', 'applyShareAmount',
    new (globalThis as unknown as BunGlobal).Bun.Transpiler({ loader: 'ts' }).transformSync(`${setter}; return applyPresetAmount;`))(
      false, () => 299670000000000000n, 'ppETH', 18,
      { presetExceedsMax: (text: string) => shareAmountFromUnderlying({ text, rate: RATE, maxSharesExact: cap, displayedMax: '0.30', preview: true }).exceedsMax,
        toShares: (text: string) => { conversions++; return shareAmountFromUnderlying({ text, rate: RATE, maxSharesExact: cap, displayedMax: '0.30' }); } },
      () => false, (message: { title: string }) => { ceiling = message.title; }, () => '0.30 ETH',
      () => cap, 1, () => { writes++; });
  run('1');
  expect(writes).toBe(0);
  expect(conversions).toBe(0);
  expect(ceiling).toBe('You can withdraw up to 0.30 ETH.');
  run('0.1');
  expect(writes).toBe(1);
  expect(conversions).toBe(1);
});
