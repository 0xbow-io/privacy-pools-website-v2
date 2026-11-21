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
import { friendlySwapError, isSwapValueOverRelayerCap, relaySwapRefusalText, SWAP_VALUE_CAP_TEXT } from '@/services/swap-error-copy';

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

  test('a 400 that may follow a broadcast never says nothing was sent, and never shows the raw JSON', () => {
    for (const message of [
      ETH_400,
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: timed out.","statusCode":400}',
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: nonce too low.","statusCode":400}',
      'HTTP 400: {"message":"RelaySwaps failed: The contract call \\"executeUnwrapped\\" failed: transaction already known.","statusCode":400}',
    ]) {
      const text = relaySwapRefusalText(rejected(message));
      expect(text).toBe('The relayer could not complete this swap. Check your balance before you try again.');
      expect(text).not.toContain('Nothing was sent');
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
    // A gateway error from in front of the relayer is not its answer, and may
    // follow a broadcast: the generic line, not "nothing was sent", not raw.
    expect(relaySwapRefusalText(rejected('HTTP 502: Bad Gateway'))).toBe('The relayer could not complete this swap. Check your balance before you try again.');
    // Not from the relayer interactor at all.
    expect(relaySwapRefusalText(new Error(BNB_400))).toBeNull();
    expect(relaySwapRefusalText(BNB_400)).toBeNull();
  });
});

// Prod Ethereum, Swap USDC to USDT through RelaySwaps executeUnwrapped,
// 2026-11-21. The relayer refused before broadcasting and the raw answer was on
// the Review screen. The body is the relayer's, verbatim; the message is built
// the way services/egress-http-client.ts builds it (HTTP/2, so no statusText,
// body cut at 500), and it arrives in the SDK's own RelayerRejected, which
// RelayerInteractor.relaySwap wraps every HTTP failure in.
const BUDGET_BODY = '{"message":"RelaySwaps executeUnwrapped rejected: the quoted relay fee no longer covers the transaction cost (fee worth 528948033800012 wei; cost 741277054791952 wei = 3011116 gas × 246180172 wei/gas). This transaction needs 3011116 gas but the relayer prices it at 2300000 gas on this chain, so a new quote will not cover it until the relayer\'s gas budget is raised. Request a new quote and retry later.","error":"Bad Request","statusCode":400}';
const ON_SCREEN = 'HTTP 400: {"message":"RelaySwaps executeUnwrapped rejected: the quoted relay fee no longer covers the transaction cost (fee worth 528948033800012 wei; cost 741277054791952 wei = 3011116 gas × 246180172 wei/gas). This transaction needs 3011116 gas but the relayer prices it at 2300000 gas on this chain, so a new quote will not cover it until the relayer\'s gas budget is raised. Request a new quote and retry later.","error":"Bad Request","statusCode":400}';
// The same refusal without the budget sentence: the gas price moved since the
// quote, so a fresh quote does cover it.
const DRIFT_BODY = '{"message":"RelaySwaps executeUnwrapped rejected: the quoted relay fee no longer covers the transaction cost (fee worth 528948033800012 wei; cost 741277054791952 wei = 2100000 gas × 352989073 wei/gas). Request a new quote and retry.","error":"Bad Request","statusCode":400}';

async function relayerRejected(body: string): Promise<Error> {
  const { RelayerRejected } = await import('@privacy-pools-v2/sdk');
  const statusText = '';
  const detail = [statusText, body.slice(0, 500)].filter(Boolean).join(': ');
  return new RelayerRejected(`HTTP 400${detail ? `: ${detail}` : ''}`);
}

describe('relay fee no longer covers the cost (2026-11-21)', () => {
  test('the fixture is what the user saw', async () => {
    const err = await relayerRejected(BUDGET_BODY);
    expect(err.name).toBe('RelayerRejected');
    expect(err.message).toBe(ON_SCREEN);
  });

  test('the gas budget case reads as one short line, no retry-now advice', async () => {
    const text = relaySwapRefusalText(await relayerRejected(BUDGET_BODY));
    expect(text).toBe("This swap can't go through the relayer right now. Nothing was sent. Please try again later.");
    expect(text).not.toMatch(/HTTP|statusCode|\{|wei|gas|quote|—|;/);
  });

  test('plain fee drift says a fresh quote fixes it', async () => {
    const text = relaySwapRefusalText(await relayerRejected(DRIFT_BODY));
    expect(text).toBe('The relayer fee went up since you reviewed this swap. Nothing was sent. Review again for a fresh quote.');
    expect(text).not.toMatch(/HTTP|statusCode|\{|wei|—|;/);
  });

  test('withdraw, transfer and claim name the same two cases', async () => {
    const { isRelayerFeeShort, isRelayerGasBudgetShort, isRelayerRefusal, isIndeterminateOutcome, relayerFeeShortMessage } = await import('@/services/transfer-outcome');
    const { claimRelayFailureText } = await import('@/services/relay-step-copy');
    expect(isRelayerFeeShort(ON_SCREEN)).toBe(true);
    expect(isRelayerGasBudgetShort(ON_SCREEN)).toBe(true);
    expect(isRelayerGasBudgetShort(`HTTP 400: ${DRIFT_BODY}`)).toBe(false);
    // A known non-send: a transfer must not latch the unknown-outcome receipt.
    expect(isRelayerRefusal(ON_SCREEN)).toBe(true);
    expect(isIndeterminateOutcome(ON_SCREEN, true)).toBe(false);
    expect(relayerFeeShortMessage('withdrawal', ON_SCREEN)).toBe("This withdrawal can't go through the relayer right now. Nothing was sent. Please try again later.");
    expect(relayerFeeShortMessage('transfer', `HTTP 400: ${DRIFT_BODY}`)).toContain('Review again for a fresh quote.');
    expect(claimRelayFailureText(await relayerRejected(BUDGET_BODY))).toContain("The relayer can't send the claim right now");
  });
});

// DEV-588: the relayer's per-chain swap value cap (maxSwapValueWei, 0.44 BNB on
// BNB Chain). The error is the SDK's own class, so the name and message are the
// ones a user would hit, not a copy of them.
describe('swap value over the relayer cap', () => {
  test('the SDK refusal reads as one short line, without base units', async () => {
    const { SwapValueExceedsRelayerCap } = await import('@privacy-pools-v2/sdk');
    const err = new SwapValueExceedsRelayerCap(500000000000000000n, 440000000000000000n);
    const { sdkErrorText } = await import('@/services/sdk-error-amounts');
    const text = sdkErrorText(err, { input: { decimals: 18, symbol: 'BNB' } }, 'fallback');
    expect(text).toBe(SWAP_VALUE_CAP_TEXT);
    expect(text).not.toMatch(/\d{6,}|max_swap_value_wei|—/);
    // Also when the class was lost on the way and only the message survived.
    expect(isSwapValueOverRelayerCap(new Error(err.message))).toBe(true);
  });

  test('a relayer refusal naming the cap reads the same; anything else does not', () => {
    expect(isSwapValueOverRelayerCap(new Error('HTTP 400: {"message":"swapValue exceeds max_swap_value_wei"}'))).toBe(true);
    expect(isSwapValueOverRelayerCap(new Error('HTTP 400: fee commitment has expired'))).toBe(false);
    expect(isSwapValueOverRelayerCap(undefined)).toBe(false);
  });
});
