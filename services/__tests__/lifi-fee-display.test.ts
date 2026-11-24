import { expect, test } from 'bun:test';
import { lifiFeeText } from '../lifi-fee-display';

const token = { address: '0xabc', chainId: 1, symbol: 'USDC', decimals: 6 };
const fee = { name: 'LIFI Fixed Fee', amount: '125000', included: true, token, feeSplit: { lifiFee: '100000', integratorFee: '25000' } };
test('LI.FI display excludes integrator, bridge and gas charges and combines selected legs', () => {
  expect(lifiFeeText([fee, { ...fee, amount: '1000000', name: 'Relayer gas fee', feeSplit: undefined }])).toBe('0.10 USDC');
  expect(lifiFeeText([fee, fee])).toBe('0.20 USDC');
  expect(lifiFeeText([{ ...fee, feeSplit: undefined }])).toBe('0.13 USDC');
  expect(lifiFeeText(undefined)).toBeNull();
  expect(lifiFeeText([])).toBe('0');
  expect(lifiFeeText([{ ...fee, feeSplit: { lifiFee: 'invalid' } }])).toBeNull();
});
