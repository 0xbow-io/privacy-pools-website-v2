import { expect, test } from 'bun:test';
import { FEE_COMMITMENT_EXPIRED_MESSAGE } from '../../../services/fee-commitment';
import { canRetryExpiredWithdrawal } from '../withdrawal-retry';

test('retries only explicit expiry before submission, including wrapped UI copy', () => {
  expect(canRetryExpiredWithdrawal(FEE_COMMITMENT_EXPIRED_MESSAGE)).toBe(true);
  expect(canRetryExpiredWithdrawal(FEE_COMMITMENT_EXPIRED_MESSAGE.replaceAll(' ', '\n'))).toBe(true);
  for (const text of ['Withdrawal failed', 'Failed to fetch', 'Fee quote expired',
    'Withdrawal outcome unknown', 'transaction reverted', 'Withdrawal Successful',
    `${FEE_COMMITMENT_EXPIRED_MESSAGE} Withdrawal outcome unknown`]) {
    expect(canRetryExpiredWithdrawal(text)).toBe(false);
  }
});
