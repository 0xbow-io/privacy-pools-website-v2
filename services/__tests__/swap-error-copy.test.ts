/**
 * Nat, prod, 2026-09-22, verbatim on screen:
 *
 *   "Invalid transact params: LiFi needs 18623284 input but only 18623008
 *    available after fee. Reduce the amount or retry."
 *
 * Both figures are the swap INPUT token, 6-decimal USDC here, so it needs
 * 18.623284 and has 18.623008. As base units the two look like the same number
 * and the advice reads as nonsense.
 */
import { describe, expect, test } from 'bun:test';
import { friendlySwapError, relaySwapRefusalText } from '@/services/swap-error-copy';

const USDC = { decimals: 6, symbol: 'USDC' };
const NAT = 'Invalid transact params: LiFi needs 18623284 input but only 18623008 available after fee. Reduce the amount or retry.';

describe('friendlySwapError', () => {
  test("Nat's message, in units, with the gap spelled out", () => {
    const friendly = friendlySwapError(NAT, USDC);
    expect(friendly).toContain('18.623284 USDC');
    expect(friendly).toContain('18.623008 USDC');
    // The actionable part: 276 base units is 0.000276 USDC.
    expect(friendly).toContain('0.000276 USDC');
    // Never the raw figures that were on screen.
    expect(friendly).not.toContain('18623284');
    expect(friendly).not.toContain('18623008');
  });

  test('the units come from the caller, so a share reads as its underlying', () => {
    // The same numbers under an 18-decimal reading would be dust, which is what
    // makes passing the right units the whole point.
    const asShare = friendlySwapError(NAT, { decimals: 18, symbol: 'ETH' });
    expect(asShare).toContain('ETH');
    expect(asShare).not.toContain('18.623284');
  });

  test('an unrecognised error is passed through, not swallowed', () => {
    expect(friendlySwapError('Relayer rejected the swap', USDC)).toBeNull();
    expect(friendlySwapError('', USDC)).toBeNull();
  });

  test('a reworded upstream message falls through rather than being half-rewritten', () => {
    expect(friendlySwapError('LiFi needs more input than is available', USDC)).toBeNull();
  });
});

/** What the SDK's RelayerInteractor throws for a relay-swap answer. */
function rejected(message: string): Error {
  const err = new Error(message);
  err.name = 'RelayerRejected';
  return err;
}

describe('relaySwapRefusalText (DEV-459)', () => {
  test('keeps the wait-and-retry copy for the relayer\'s 429 throttle', () => {
    const text = relaySwapRefusalText(rejected('HTTP 429: {"message":"ThrottlerException: Too Many Requests","statusCode":429}'));
    expect(text).toContain('rate limiting');
    expect(text).toContain('this swap was not sent');
    expect(text).not.toBe('The swap could not be executed. Nothing was sent.');
  });

  // Verbatim from Mike's recordings: BNB Chain 2026-09-25, Ethereum 2026-09-28.
  const BNB_400 = 'HTTP 400: {"message":"RelaySwaps failed: The contract function \\"executeUnwrapped\\" reverted (RelaySwaps_SwapFailed).","error":"Bad Request","statusCode":400}';
  const ETH_400 = 'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: out of gas."}';
  // What the relayer answers for the Ethereum case once it reports its own wallet.
  const ETH_503 = 'HTTP 503: {"message":"Relayer temporarily unavailable on chain 1: the relayer\'s wallet cannot cover gas for RelaySwaps. This is a relayer-side fault, not a problem with your request — retry after the relayer wallet is topped up.","error":"Service Unavailable","statusCode":503}';

  test('a pre-broadcast relayer refusal says nothing was sent instead of the raw JSON', () => {
    for (const message of [
      BNB_400,
      'HTTP 400: {"message":"RelaySwaps rejected: estimated gas 900000 exceeds the relayer\'s cap of 600000 (300000 priced × 2). A recipient or callback that consumes gas on receive cannot be relayed.","statusCode":400}',
      'HTTP 400: {"message":"Swap fee commitment has expired","statusCode":400}',
    ]) {
      expect(relaySwapRefusalText(rejected(message))).toBe('The swap could not be executed. Nothing was sent.');
    }
  });

  test('a 400 that may follow a broadcast never says nothing was sent', () => {
    for (const message of [
      ETH_400,
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: timed out.","statusCode":400}',
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: nonce too low.","statusCode":400}',
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: transaction already known.","statusCode":400}',
    ]) {
      expect(relaySwapRefusalText(rejected(message))).toBeNull();
    }
  });

  test('a note already in flight says the earlier swap is still pending', () => {
    const text = relaySwapRefusalText(rejected('HTTP 400: {"message":"Nullifier 0xabc123 is already in-flight — a transaction spending this note is pending confirmation","statusCode":400}'));
    expect(text).toContain('still pending');
    expect(text).not.toContain('Nothing was sent');
  });

  test('the relayer unable to pay for gas is named as the relayer\'s fault', () => {
    const text = relaySwapRefusalText(rejected(ETH_503));
    expect(text).toContain('relayer cannot pay for gas');
    expect(text).toContain('this swap was not sent');
    expect(text).not.toMatch(/HTTP|statusCode|\{/);
  });

  test('anything that is not an HTTP refusal keeps its own wording', () => {
    // A transport failure on the relay POST: the relayer may have broadcast.
    expect(relaySwapRefusalText(rejected('Failed to fetch'))).toBeNull();
    // The SDK's own pre-send validation is more specific than the generic copy.
    expect(relaySwapRefusalText(rejected('Invalid relay swap params: amount: Required'))).toBeNull();
    // A gateway error from in front of the relayer is not its answer.
    expect(relaySwapRefusalText(rejected('HTTP 502: Bad Gateway'))).toBeNull();
    // Not from the relayer interactor at all.
    expect(relaySwapRefusalText(new Error(BNB_400))).toBeNull();
    expect(relaySwapRefusalText(BNB_400)).toBeNull();
  });
});
