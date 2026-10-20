// Withdraw "Receive as" compose path (spec C5): the withdraw modal composes
// a swap into the exit through the SAME service-layer core the swap modal
// uses. These tests pin the three contracts the modal relies on:
//   - gating (flag + processor + EVM-only, fail closed; default = plain),
//   - the shared prepare→validate→shape core (prepareValidatedSwapQuote)
//     refusing invalid commitments before Review can render,
//   - the request parameters the core sends (gross as hex, same-chain omits
//     toChainId/fallback, cross-chain carries both).

import { describe, expect, test } from 'bun:test';

import {
  InvalidSwapQuoteError,
  isSwapExitSelection,
  prepareValidatedSwapQuote,
  resolveReceiveAsAvailability,
  type PreparedSwapQuoteLike,
  type SwapQuoteSessionLike,
} from '@/services/intent-swaps';

const SEPOLIA = 11155111;
const OPTIMISM = 10;
const PROCESSOR = '0x4444444444444444444444444444444444444444' as const;
const RECIPIENT = '0x1111111111111111111111111111111111111111' as const;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const;
const GROSS = 10n ** 18n; // 1 ETH gross leaving the pool

// Coherent same-chain fixture: net 0.99 ETH + fee 0.01 ETH = gross 1 ETH;
// on-chain min equals LiFi's destination min (1 USDC).
function makePrepared(overrides: Partial<PreparedSwapQuoteLike> = {}): PreparedSwapQuoteLike {
  return {
    selectedQuote: { quote: { feeCommitment: { expiration: 1_700_000_060_000 } } },
    swapCalldata: '0xdeadbeef',
    minOutputAmount: '0xf4240',
    destinationMinOutputAmount: '0xf4240',
    feeAmount: '10000000000000000',
    netAmount: '0xdbd2fc137a30000',
    estimatedOutput: '1050000',
    swapTarget: '0x2222222222222222222222222222222222222222',
    approvalAddress: '0x3333333333333333333333333333333333333333',
    dustRecipient: RECIPIENT,
    toChainId: SEPOLIA,
    ...overrides,
  };
}

function makeSession(prepared: PreparedSwapQuoteLike) {
  const calls: unknown[] = [];
  const session: SwapQuoteSessionLike = {
    prepareSwapQuote: (params) => {
      calls.push(params);
      return Promise.resolve(prepared);
    },
  };
  return { session, calls };
}

describe('resolveReceiveAsAvailability (the gate the Receive-as control renders behind)', () => {
  test('requires the flag AND a configured processor AND EVM. Fail closed', () => {
    expect(resolveReceiveAsAvailability(true, PROCESSOR, false)).toBe(true);
    expect(resolveReceiveAsAvailability(false, PROCESSOR, false)).toBe(false);
    expect(resolveReceiveAsAvailability(true, undefined, false)).toBe(false);
    expect(resolveReceiveAsAvailability(true, PROCESSOR, true)).toBe(false); // Sui: never
    expect(resolveReceiveAsAvailability(false, undefined, true)).toBe(false);
  });
});

describe('isSwapExitSelection (default = plain withdrawal)', () => {
  test('no selection is the plain withdrawal', () => {
    expect(isSwapExitSelection(null, ETH)).toBe(false);
    expect(isSwapExitSelection(undefined, ETH)).toBe(false);
    expect(isSwapExitSelection('', ETH)).toBe(false);
  });
  test('the pool asset itself is the plain withdrawal (case-insensitive)', () => {
    expect(isSwapExitSelection(ETH, ETH)).toBe(false);
    expect(isSwapExitSelection(ETH.toUpperCase().replace('0X', '0x'), ETH)).toBe(false);
    expect(isSwapExitSelection(USDC.toLowerCase(), USDC)).toBe(false);
  });
  test('a genuinely different output token composes the swap', () => {
    expect(isSwapExitSelection(USDC, ETH)).toBe(true);
  });
});

describe('prepareValidatedSwapQuote (shared quote core: prepare → validate → shape)', () => {
  const baseParams = {
    relayerInfo: { name: '0xbow Relayer' },
    poolChainId: SEPOLIA,
    grossWei: GROSS,
    inputToken: { address: ETH, decimals: 18 },
    outputToken: { address: USDC, decimals: 6 },
    recipientAddress: RECIPIENT,
    slippage: 0.005,
  } as const;

  test('valid same-chain quote returns the prepared commitment and shaped display', async () => {
    const { session, calls } = makeSession(makePrepared());
    const { prepared, display } = await prepareValidatedSwapQuote(session, baseParams);
    expect(prepared.netAmount).toBe('0xdbd2fc137a30000');
    expect(display.estimatedOutput).toBe('1.05');
    expect(display.minReceived).toBe('1');
    expect(display.relayerFee).toBe('0.01');
    expect(display.netSwapped).toBe('0.99');
    expect(display.mode).toBe('same-chain');
    // Request shape: gross as hex, same-chain omits toChainId/fallback.
    expect(calls).toHaveLength(1);
    const sent = calls[0] as Record<string, unknown>;
    expect(sent.amount).toBe(`0x${GROSS.toString(16)}`);
    expect(sent.tokenId).toBe(ETH);
    expect(sent.outputToken).toBe(USDC);
    expect(sent.recipientAddress).toBe(RECIPIENT);
    expect(sent.slippage).toBe(0.005);
    expect('toChainId' in sent).toBe(false);
    expect('fallbackAddress' in sent).toBe(false);
  });

  test('same-chain destination equal to the pool chain also stays same-chain', async () => {
    const { session, calls } = makeSession(makePrepared());
    const { display } = await prepareValidatedSwapQuote(session, { ...baseParams, toChainId: SEPOLIA });
    expect(display.mode).toBe('same-chain');
    expect('toChainId' in (calls[0] as Record<string, unknown>)).toBe(false);
  });

  test('gross-binding violation throws InvalidSwapQuoteError (never reaches Review)', async () => {
    // Committed net + fee = 1.01 ETH ≠ the reviewed 1 ETH gross.
    const { session } = makeSession(makePrepared({ netAmount: `0x${GROSS.toString(16)}` }));
    await expect(prepareValidatedSwapQuote(session, baseParams)).rejects.toBeInstanceOf(InvalidSwapQuoteError);
    try {
      await prepareValidatedSwapQuote(session, baseParams);
      throw new Error('unreachable');
    } catch (err) {
      const e = err as InvalidSwapQuoteError;
      expect(e.problems.join(' ')).toContain('does not equal the reviewed amount');
      expect(e.message).toContain('Nothing was signed or spent');
    }
  });

  test('same-chain zero minOutputAmount is refused (would disable the on-chain output check)', async () => {
    const { session } = makeSession(makePrepared({ minOutputAmount: '0x0', destinationMinOutputAmount: '0x0' }));
    await expect(prepareValidatedSwapQuote(session, baseParams)).rejects.toBeInstanceOf(InvalidSwapQuoteError);
  });

  test('cross-chain request carries toChainId + fallback and validates mode-aware', async () => {
    const prepared = makePrepared({
      toChainId: OPTIMISM,
      minOutputAmount: '0x0', // protocol rule: on-chain min must be 0 cross-chain
      destinationMinOutputAmount: '0xf4240',
    });
    const { session, calls } = makeSession(prepared);
    const { display } = await prepareValidatedSwapQuote(session, {
      ...baseParams,
      toChainId: OPTIMISM,
      fallbackAddress: RECIPIENT,
    });
    expect(display.mode).toBe('cross-chain');
    // Cross-chain min shown is LiFi's destination minimum, not the 0 on-chain value.
    expect(display.minReceived).toBe('1');
    const sent = calls[0] as Record<string, unknown>;
    expect(sent.toChainId).toBe(OPTIMISM);
    expect(sent.fallbackAddress).toBe(RECIPIENT);
  });

  test('cross-chain without a fallback address is refused', async () => {
    const prepared = makePrepared({ toChainId: OPTIMISM, minOutputAmount: '0x0' });
    const { session } = makeSession(prepared);
    await expect(
      prepareValidatedSwapQuote(session, { ...baseParams, toChainId: OPTIMISM }),
    ).rejects.toBeInstanceOf(InvalidSwapQuoteError);
  });
});
