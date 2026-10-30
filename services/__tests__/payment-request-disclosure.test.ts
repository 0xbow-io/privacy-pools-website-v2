import { expect, test } from 'bun:test';
import { paymentRequestRecipientLabel } from '../payment-request-disclosure';

test('registered requests disclose their recipient even without a signature', () => {
  expect(paymentRequestRecipientLabel({ recipientAddress: '0x1111111111111111111111111111111111111111' }))
    .toBe('0x1111…1111');
});

test('an unsigned SDK request without an address makes only a link-specific claim', () => {
  expect(paymentRequestRecipientLabel({})).toBe('Not included in link');
});
