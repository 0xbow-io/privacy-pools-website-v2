import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The browser smokes check the amount a flow prepares by reading
// `data-prepared-amount` off its amount field (services/prepared-amount-data.ts).
// A field that does not expose it cannot be checked, so a share bug on it is
// invisible: the screen shows the coin either way. These guards keep every
// amount field that converts a typed coin into shares exposing the exact
// amount it holds, next to the conversion it is the proof of.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const FIELDS = [
  // [file, the field's testID, what its onChangeText converts through]
  ['components/home/action-hub.tsx', 'testID="hub-amount-input"', 'amountField.toShares(text)'],
  ['components/withdraw-modal-provider.tsx', 'testID="withdraw-amount-input"', 'amountField.toShares(stripAmountSeparators(typed))'],
  ['components/pools/pool-action-panel.tsx', 'testID="pool-amount-input"', 'amountField.toShares(text)'],
  ['components/transfer-modal-provider.tsx', 'testID="transfer-amount-input"', 'amountField.toShares(text)'],
] as const;

describe('amount fields expose the amount they prepare', () => {
  for (const [file, testId, conversion] of FIELDS) {
    const src = read(file);
    const at = src.indexOf(testId);

    test(`${file} imports the helper`, () => {
      expect(src).toContain("import { preparedAmountData } from '@/services/prepared-amount-data';");
    });

    test(`${file}: ${testId} is on the field and carries the prepared amount`, () => {
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 600)).toContain('{...preparedAmountData(amount)}');
    });

    test(`${file}: the field converts typed text through the share boundary`, () => {
      expect(at).toBeGreaterThan(0);
      expect(src.slice(Math.max(0, at - 2500), at)).toContain(conversion);
    });
  }
});
