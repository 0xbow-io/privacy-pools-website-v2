import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import type { ShareRate } from '@/services/share-rates';

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
  expect(source).toContain('const applyPresetAmount = (value: string) => applyShareAmount(amountField.toShares(value));');
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
  expect(field).not.toMatch(/useEffect|setAmount\(/);
});
