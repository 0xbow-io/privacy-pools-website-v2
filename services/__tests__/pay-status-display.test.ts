import { describe, expect, test } from 'bun:test';
import { payStatusBoxHidden, paySuccessDetail } from '../pay-status-display';

const base = { mode: 'pay' as const, isBusy: false, pendingAutoAction: null, txHash: null };

describe('payStatusBoxHidden (DEV-496)', () => {
  test('while a payment runs the rail carries the status, not the box', () => {
    expect(payStatusBoxHidden({ ...base, isBusy: true })).toBe(true);
    expect(payStatusBoxHidden({ ...base, pendingAutoAction: 'transfer' })).toBe(true);
  });

  test('after the payment the success card is the only success state', () => {
    expect(payStatusBoxHidden({ ...base, txHash: '0xabc' })).toBe(true);
  });

  test('an idle pay form keeps the box (e.g. "Switched network. Press Pay again.")', () => {
    expect(payStatusBoxHidden(base)).toBe(false);
  });

  test('request and receive flows are untouched', () => {
    expect(payStatusBoxHidden({ ...base, mode: 'request', isBusy: true })).toBe(false);
    expect(payStatusBoxHidden({ ...base, mode: 'receive', isBusy: true, txHash: '0xabc' })).toBe(false);
  });
});

describe('paySuccessDetail (DEV-496)', () => {
  const fallback = 'The recipient discovers this payment automatically. No receipt link is needed.';

  test('keeps what the handler said after the lead sentence', () => {
    expect(paySuccessDetail(
      'Private transfer sent via relay. The recipient will discover the note automatically on their next sync.',
      fallback,
    )).toBe('The recipient will discover the note automatically on their next sync.');
    expect(paySuccessDetail(
      'Payment sent. The recipient will see it on their next sync, once the deposit clears its compliance review.',
      fallback,
    )).toBe('The recipient will see it on their next sync, once the deposit clears its compliance review.');
    expect(paySuccessDetail('Private transfer payment sent via relay. Share the receipt with the recipient.', fallback))
      .toBe('Share the receipt with the recipient.');
  });

  test('a progress line never lands under "Payment sent"', () => {
    expect(paySuccessDetail('Waiting for the transaction to confirm...', fallback)).toBe(fallback);
    expect(paySuccessDetail(null, fallback)).toBe(fallback);
    expect(paySuccessDetail('Payment sent.', fallback)).toBe(fallback);
  });
});
