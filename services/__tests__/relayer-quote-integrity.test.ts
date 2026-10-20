import { describe, expect, test } from 'bun:test';
import { quoteMatchesSignedCommitment } from '@/services/relayer-quote-integrity';

const base = { feeAmount: '100', amountSent: '1100', amountReceived: '1000', feeCommitment: { feeAmount: '100', amountSent: '1100', amountReceived: '1000' } };

describe('quoteMatchesSignedCommitment', () => {
  test('agreeing copies pass, numeric or string', () => {
    expect(quoteMatchesSignedCommitment(base)).toBe(true);
    expect(quoteMatchesSignedCommitment({ ...base, feeAmount: 100 })).toBe(true);
  });
  test('a lower displayed fee over a higher signed fee fails, and so does any other field', () => {
    expect(quoteMatchesSignedCommitment({ ...base, feeAmount: '99' })).toBe(false);
    expect(quoteMatchesSignedCommitment({ ...base, amountSent: '1101' })).toBe(false);
    expect(quoteMatchesSignedCommitment({ ...base, feeCommitment: { ...base.feeCommitment, amountReceived: '999' } })).toBe(false);
  });
  test('junk never passes', () => {
    expect(quoteMatchesSignedCommitment({ ...base, feeAmount: 'abc' })).toBe(false);
  });
});
