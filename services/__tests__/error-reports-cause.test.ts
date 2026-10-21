import { describe, expect, test } from 'bun:test';

import { classifyFailure } from '../error-reports-cause';
import { ALLOWED_FLAGS } from '../error-reports-event';

/**
 * The classifier turns error text into at most one boolean. Two properties
 * matter and neither is about which regex matches what:
 *
 *   1. it can only ever return names the constructor would accept, and
 *   2. it returns nothing at all when it cannot tell.
 *
 * (2) is the one worth a test of its own. An "unknown" that quietly reports
 * `isNetworkError: false` would read as "we checked, it was not the network",
 * and a monitor would draw a conclusion from a bit that was never measured.
 */
describe('classifying a failure', () => {
  test('every name it can return is on the allowlist', () => {
    const samples = [
      'User rejected the request',
      'Relayer quote expired',
      'Wallet not connected.',
      'relayer returned HTTP 400',
      'Amount is below the minimum',
      'Failed to fetch',
    ];
    for (const sample of samples) {
      for (const name of Object.keys(classifyFailure(sample))) {
        expect(ALLOWED_FLAGS as readonly string[]).toContain(name);
      }
    }
  });

  test('at most one class, so a combination cannot be over-read', () => {
    // Text that answers to several patterns at once: a dismissed prompt on a
    // relayed withdrawal whose quote had expired.
    const both = classifyFailure('User rejected the relayer quote expired request');
    expect(Object.keys(both).length).toBe(1);
    expect(both).toEqual({ isUserRejected: true });
  });

  test('says nothing when it cannot tell, rather than saying false', () => {
    for (const input of ['', null, 'Deposit failed: 0x1f4a9', 'something went wrong']) {
      expect(classifyFailure(input)).toEqual({});
    }
  });

  test('reads the cause when the app message is generic', () => {
    expect(classifyFailure('Deposit failed', new Error('User denied transaction signature')))
      .toEqual({ isUserRejected: true });
    expect(classifyFailure('Deposit failed', 'Failed to fetch'))
      .toEqual({ isNetworkError: true });
  });

  test('the shapes the three providers actually produce', () => {
    expect(classifyFailure('Transaction was rejected.')).toEqual({ isUserRejected: true });
    expect(classifyFailure('Wallet not connected.')).toEqual({ isSessionError: true });
    expect(classifyFailure('Public client unavailable.')).toEqual({ isSessionError: true });
    expect(classifyFailure('Network switched. Press Deposit again to continue.')).toEqual({ isSessionError: true });
    expect(classifyFailure('The relayer quote expired. Nothing was sent.')).toEqual({ isQuoteExpired: true });
    expect(classifyFailure('Withdrawal failed: relayer signer is out of gas')).toEqual({ isRelayerRejected: true });
    expect(classifyFailure('Converting into USDC is not available on this network. Nothing was sent.'))
      .toEqual({ isValidationError: true });
  });

  test('a non-Error cause cannot smuggle an object in', () => {
    // The classifier reads text; anything else contributes nothing and, more
    // to the point, never reaches the returned value.
    expect(classifyFailure(null, { message: 'User rejected' })).toEqual({});
    expect(classifyFailure(null, 12345)).toEqual({});
  });
});

/**
 * The classes the real events taught us, rather than the ones we guessed.
 */
describe('classes learned from real events', () => {
  test('an on-chain revert is its own class', () => {
    // Verbatim from event 944acf1dbf34457e9fbb28d7b735b2b1 (2026-09-16), the
    // first diagnostic event, which carried NO class because nothing matched.
    expect(classifyFailure('Transfer failed', new Error('Transaction reverted on-chain. Your notes were NOT spent.')))
      .toEqual({ isChainReverted: true });
    expect(classifyFailure(null, new Error('execution reverted: PoolVault_ProofContextMismatch')))
      .toEqual({ isChainReverted: true });
  });

  test('a revert that the user caused is still the user, not the chain', () => {
    // Ordering check: the wallet prompt is answered before the chain is asked.
    expect(classifyFailure('User rejected the request before it reverted'))
      .toEqual({ isUserRejected: true });
  });

  test('a relayer that never answered is a network fault, not a rejection', () => {
    expect(classifyFailure('Could not reach the relayer', new Error('Failed to fetch')))
      .toEqual({ isNetworkError: true });
  });
});
