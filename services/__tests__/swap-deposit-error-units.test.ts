import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sdkErrorText } from '@/services/sdk-error-amounts';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-430: the pay-and-shield (swap + deposit) failure printed the SDK's raw
 * base units, "Deposit value 5194630821167384 is below the Entrypoint minimum
 * 20000000000000000". Every other flow already read it in units.
 */
describe('swap + deposit failures read in units', () => {
  const units = {
    input: { symbol: 'USDT', decimals: 6 },
    swapInput: { symbol: 'USDT', decimals: 6 },
    funding: { symbol: 'BNB', decimals: 18 },
    output: { symbol: 'BNB', decimals: 18 },
  };

  test('the Entrypoint minimum message names amounts, not base units', () => {
    const text = sdkErrorText(new Error('Deposit value 5194630821167384 is below the Entrypoint minimum 20000000000000000'), units, '');
    expect(text).not.toContain('5194630821167384');
    expect(text).not.toContain('20000000000000000');
    expect(text).toContain('BNB');
  });

  test('a deposit into a share reads the minimum in share units (18), not the 6-decimal coin', () => {
    const shareUnits = { ...units, funding: { symbol: 'USDC', decimals: 6 }, output: { symbol: 'USDC', decimals: 18 } };
    const text = sdkErrorText(new Error('Deposit value 5000000000000000 is below the Entrypoint minimum 20000000000000000'), shareUnits, '');
    expect(text).toContain('0.02');
    expect(text).not.toContain('20000000000');
  });

  test('the deposit modal routes the swap-deposit catch through it', () => {
    const src = readFileSync(join(ROOT, 'components/deposit-modal-provider.tsx'), 'utf8');
    expect(src).toContain('`Swap deposit failed: ${sdkErrorText(err, {');
    expect(src).not.toContain(': `Swap deposit failed: ${message}`');
    // #151 review: the output side is the share when the deposit lands in one.
    expect(src).toContain('output: swapOutputUnits,');
    expect(src).toContain('getConfiguredYieldDepositDeploymentForUnderlying(depositChainId, selectedToken.address)');
  });
});
