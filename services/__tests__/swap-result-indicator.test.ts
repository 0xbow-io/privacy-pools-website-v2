import { describe, expect, test } from 'bun:test';
import { swapResultIndicator } from '../swap-outcome-copy';

describe('swapResultIndicator', () => {
  test('deposited is success and keeps a real sync warning', () => {
    expect(swapResultIndicator({ status: 'done' }, true)).toEqual({ tone: 'success', showNoteSyncWarning: true });
    expect(swapResultIndicator({ status: 'done' }, false)).toEqual({ tone: 'success', showNoteSyncWarning: false });
  });
  test('same-chain (no far leg) is success', () => {
    expect(swapResultIndicator(null, true)).toEqual({ tone: 'success', showNoteSyncWarning: true });
  });
  test('pending is neutral, sync warning still applies', () => {
    expect(swapResultIndicator({ status: 'pending' }, true)).toEqual({ tone: 'neutral', showNoteSyncWarning: true });
  });
  test('fallback payout is a warning with no note warning', () => {
    expect(swapResultIndicator({ status: 'recovered' }, true)).toEqual({ tone: 'warning', showNoteSyncWarning: false });
  });
  test('refund is a warning with no note warning', () => {
    expect(swapResultIndicator({ status: 'recovered', refunded: true }, true)).toEqual({ tone: 'warning', showNoteSyncWarning: false });
  });
  test('failed is a warning with no note warning', () => {
    expect(swapResultIndicator({ status: 'failed' }, true)).toEqual({ tone: 'warning', showNoteSyncWarning: false });
  });
});
