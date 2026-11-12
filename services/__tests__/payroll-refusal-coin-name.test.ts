import { describe, expect, test } from 'bun:test';

import { resolvePayrollTransferParams } from '@/components/payroll/io';
import { displayTokenSymbol } from '@/services/share-display';
import type { PayrollRunItem } from '@/services/payroll-store';

// Zeeshan's nit on #88: an employee saved earlier with a share symbol as its
// currency printed that share name in the two payroll refusals. They name the
// coin, as the rest of the screen does.

const item = (over: Partial<PayrollRunItem>): PayrollRunItem => ({
  employeeId: 'e', name: 'Payee', walletAddress: '0x1111111111111111111111111111111111111111',
  network: 'Ethereum', chainId: 1, amount: 5, amountText: '5', currency: 'ppUSDC', status: 'pending', ...over,
});
const refusal = (r: ReturnType<typeof resolvePayrollTransferParams>) => ('refusal' in r ? r.refusal : '');
const SHARE = /\bpp[A-Z]/;

describe('payroll refusals name the coin, never a share', () => {
  test('not available on the network', () => {
    const r = refusal(resolvePayrollTransferParams(item({}), { resolveChainId: () => 1, getToken: () => undefined }));
    expect(r.startsWith(`${displayTokenSymbol('ppUSDC')} is not available on Ethereum.`)).toBe(true);
    expect(r).not.toMatch(SHARE);
  });

  test('too many decimal places', () => {
    const r = refusal(resolvePayrollTransferParams(item({ amountText: '5.1234567' }), { resolveChainId: () => 1, getToken: () => ({ decimals: 6 }) }));
    expect(r.startsWith(`${displayTokenSymbol('ppUSDC')} supports 6 decimal places.`)).toBe(true);
    expect(r).not.toMatch(SHARE);
  });
});
