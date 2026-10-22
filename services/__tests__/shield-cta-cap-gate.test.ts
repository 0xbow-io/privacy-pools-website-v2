import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkDepositCap } from '@/services/deposit-cap';

/**
 * The hub's Shield button stayed black and pressable over the launch cap
 * (Mike, 2026-09-18: 0.05 ETH against $100 / 0.0385 ETH). The red line was
 * already rendered; only the CTA's `disabled` never learned about it, so the
 * press opened a modal that refused on the spot.
 *
 * The expression is lifted from the source and evaluated here, because the
 * failure mode is the CONDITION, not the rendering: a look-only fix (opacity
 * without `disabled`) would still read as fixed in a screenshot.
 */
const SOURCE = readFileSync(
  new URL('../../components/home/action-hub.tsx', import.meta.url),
  'utf8',
);

function ctaDisabled(env: {
  a: string;
  amountField: { error: string | null };
  swapOutToken: unknown;
  swapRecipientBlocks?: boolean;
  shieldRecipientInvalid: boolean;
  shieldCapBlocksDeposit: boolean;
  shieldPricing: boolean;
}): boolean {
  const match = SOURCE.match(/const ctaDisabled = ([\s\S]*?);\n/);
  if (!match) throw new Error('ctaDisabled is gone or was reshaped: update this guard');
  return new Function(...Object.keys(env), `return (${match[1]});`)(
    ...Object.values(env),
  ) as boolean;
}

const BASE = {
  a: 'shield',
  amountField: { error: null },
  swapOutToken: 'ETH',
  swapRecipientBlocks: false,
  shieldRecipientInvalid: false,
  shieldCapBlocksDeposit: false,
  shieldPricing: false,
};

test('a shield over the launch cap disables the CTA', () => {
  expect(ctaDisabled({ ...BASE, shieldCapBlocksDeposit: true })).toBe(true);
  expect(ctaDisabled(BASE)).toBe(false);
});

test('a shield still pricing its conversion disables the CTA', () => {
  expect(ctaDisabled({ ...BASE, shieldPricing: true })).toBe(true);
  expect(ctaDisabled({ ...BASE, a: 'withdraw', shieldPricing: true })).toBe(false);
});

test('the cap only gates shield, never the other actions', () => {
  for (const a of ['withdraw', 'send', 'swap', 'request']) {
    expect(ctaDisabled({ ...BASE, a, shieldCapBlocksDeposit: true })).toBe(false);
  }
});

test('entry errors disable only Withdraw and Send', () => {
  for (const a of ['withdraw', 'send']) {
    expect(ctaDisabled({ ...BASE, a, amountField: { error: 'Amount is too small.' } })).toBe(true);
  }
  for (const a of ['shield', 'swap', 'request']) {
    expect(ctaDisabled({ ...BASE, a, amountField: { error: 'Amount is too small.' } })).toBe(false);
  }
});

test('the conditions that already disabled it still do', () => {
  expect(ctaDisabled({ ...BASE, a: 'swap', swapOutToken: null })).toBe(true);
  // DEV-510: an invalid, unservable or unregistered Swap tab recipient.
  expect(ctaDisabled({ ...BASE, a: 'swap', swapRecipientBlocks: true })).toBe(true);
  expect(ctaDisabled({ ...BASE, shieldRecipientInvalid: true })).toBe(true);
});

test('the dead look and the dead behaviour read the SAME value', () => {
  // Both were written out inline and drifted; one symbol now feeds both.
  expect(SOURCE).toContain('disabled={ctaDisabled}');
  expect(SOURCE).toContain('${ctaDisabled ? \'opacity-40\' : \'active:bg-button-primary-pressed\'}');
});

test('"blocks" means every non-ok verdict except the transient one', () => {
  const capUsd = 100;
  // Over the cap: blocked.
  const over = checkDepositCap({ amount: 0.05, symbol: 'ETH', priceUsd: 2600, capUsd });
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.reason).toBe('over');
  // Price still loading: NOT blocked, it resolves on its own.
  const pending = checkDepositCap({ amount: 0.05, symbol: 'ETH', priceUsd: null, capUsd, pricePending: true });
  expect(pending.ok).toBe(false);
  if (!pending.ok) expect(pending.reason).toBe('pending');
  // Feed answered with nothing: blocked, matching checkDepositCap failing closed.
  const noPrice = checkDepositCap({ amount: 0.05, symbol: 'ETH', priceUsd: null, capUsd });
  expect(noPrice.ok).toBe(false);
  if (!noPrice.ok) expect(noPrice.reason).toBe('no-price');
  // Under the cap: nothing to block.
  expect(checkDepositCap({ amount: 0.01, symbol: 'ETH', priceUsd: 2600, capUsd }).ok).toBe(true);
});
