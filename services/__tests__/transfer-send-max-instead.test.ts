import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Mike, 2026-09-24: a Send just under the one-transfer cap (a rounded 36.5
// against 36.502932) overflowed once the relayer fee rode on top, and the only
// way out was to do the subtraction by hand. The error now carries a one-tap
// fix that fills the largest amount the fee still fits beside.
test('the fee-overflow error offers to send the most that fits', () => {
  const source = readFileSync(new URL('../../components/transfer-modal-provider.tsx', import.meta.url), 'utf8');
  const at = source.indexOf('testID="transfer-send-max-instead"');
  expect(at).toBeGreaterThan(-1);
  const block = source.slice(source.lastIndexOf('{amountError && relayFeeExceeds', at), at + 400);
  // Only for the fee-on-top overflow, and only when something still fits.
  expect(block).toContain('{amountError && relayFeeExceeds && relayFeeMaxSend > 0n && (');
  // It fills exactly the amount the error message names.
  expect(block).toContain('onPress={() => setAmount(formatUnits(relayFeeMaxSend, selectedDecimals))}');
  expect(source).toContain('Send at most ${tokenAmountLabel(formatUnits(relayFeeMaxSend, selectedDecimals), selectedSymbol)}');
});
