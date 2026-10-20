import { describe, expect, test } from 'bun:test';

import { shouldAutoPickWithdrawToken } from '@/services/withdraw-token-selection';

const base = {
  isOpen: true,
  didAutoPick: false,
  hasPreferredTransactionAsset: false,
  hasExplicitTokenPin: false,
};

describe('withdraw token auto-pick policy', () => {
  test('runs when an open withdraw flow has no token pin yet', () => {
    expect(shouldAutoPickWithdrawToken(base)).toBe(true);
  });

  test('does not override an explicit launcher or dropdown token', () => {
    expect(shouldAutoPickWithdrawToken({ ...base, hasExplicitTokenPin: true })).toBe(false);
  });

  test('does not override a pinned transaction asset', () => {
    expect(shouldAutoPickWithdrawToken({ ...base, hasPreferredTransactionAsset: true })).toBe(false);
  });

  test('runs only once per open context', () => {
    expect(shouldAutoPickWithdrawToken({ ...base, didAutoPick: true })).toBe(false);
    expect(shouldAutoPickWithdrawToken({ ...base, isOpen: false })).toBe(false);
  });
});
