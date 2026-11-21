import { describe, expect, mock, test } from 'bun:test';
import { FeeCommitmentExpired, RelayerRejected, type ExecuteWithdrawRelayerParams, type WithdrawalRelayerQuote } from '@privacy-pools-v2/sdk';
import { RelayFeeIncreasedError, relayWithdrawalWithFreshQuote } from '@/services/relayed-withdrawal';
import { sdkErrorText } from '@/services/sdk-error-amounts';
import { FEE_COMMITMENT_EXPIRED_MESSAGE } from '@/services/fee-commitment';
import { RELAYED_REVERT_MESSAGE, RelayedRevertError, STALE_ASP_ROOT_MESSAGE, StaleAspRootError } from '@/services/stale-asp-root';

const NOW = 1790650900000;
const ASSET = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const PROCESSOR = '0x2222222222222222222222222222222222222222';
const rawExpired = 'Fee commitment expired at 1790650927071, current time 1790650970814';
const expired = () => new FeeCommitmentExpired(rawExpired);
function quote(lifetime = 60_000, fee = '1000'): WithdrawalRelayerQuote {
  const amounts = { feeAmount: fee, amountSent: String(100_000n + BigInt(fee)), amountReceived: '100000' };
  return {
    ...amounts, gasPrice: '1', txCost: '1',
    feeCommitment: {
      ...amounts, asset: ASSET, recipient: RECIPIENT, expiration: NOW + lifetime,
      data: '0x', signedRelayerCommitment: '0x', extraGas: false,
    },
  };
}
function option(lifetime = 60_000): ExecuteWithdrawRelayerParams & { processorAddress: typeof PROCESSOR } {
  return {
    inputCommitments: ['0x01'], amount: '0x186a0', tokenId: ASSET, recipientAddress: RECIPIENT,
    extraGas: false, processorAddress: PROCESSOR,
    selectedQuote: {
      relayerInfo: { name: 'Test relay', url: 'https://relayer.example', chainType: 'evm', chainId: 56,
        status: 'active', address: RECIPIENT, processorAddress: PROCESSOR },
      quote: quote(lifetime),
    },
  };
}
function setup(lifetime = 60_000) {
  const state = { errors: [] as Error[], quotes: [] as WithdrawalRelayerQuote[], current: true, stopDuringQuote: false };
  const prepareOption = mock(async () => {
    if (state.stopDuringQuote) state.current = false;
    const next = option(lifetime);
    const queued = state.quotes.shift();
    if (queued) next.selectedQuote.quote = queued;
    return next;
  });
  return {
    state,
    prepareOption, reviewedFee: 1000n, now: () => NOW,
    relay: mock(async (_option: ExecuteWithdrawRelayerParams) => {
      const error = state.errors.shift();
      if (error) throw error;
      return { txHash: '0x1234' };
    }),
    shouldContinue: () => state.current,
    onStaleAspRoot: mock((_error: Error) => {}),
  };
}

const staleRoot = () => new RelayerRejected('HTTP 400: PoolVault_InvalidASPRoot');

describe('plain relayed withdrawal quote', () => {
  test('relays the quote it requested right before proving, once', async () => {
    const args = setup();
    const outcome = await relayWithdrawalWithFreshQuote(args);
    expect(args.prepareOption).toHaveBeenCalledTimes(1);
    expect(args.relay).toHaveBeenCalledTimes(1);
    expect(args.relay.mock.calls[0][0]).toEqual(option());
    expect(outcome).toEqual({ result: { txHash: '0x1234' }, feeAmount: '1000' });
  });

  test('never proves against a quote that has already expired', async () => {
    const args = setup(0);
    await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow('already expired');
    expect(args.relay).toHaveBeenCalledTimes(0);
  });

  test('proves against a fresh quote that reads short on a fast device clock', async () => {
    const args = setup(45_000);
    expect((await relayWithdrawalWithFreshQuote(args))?.result).toEqual({ txHash: '0x1234' });
    expect(args.relay).toHaveBeenCalledTimes(1);
  });

  test('maps a local expiry to plain copy without another quote', async () => {
    const args = setup();
    args.state.errors = [expired()];
    await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow(FEE_COMMITMENT_EXPIRED_MESSAGE);
    expect(args.prepareOption).toHaveBeenCalledTimes(1);
    expect(args.relay).toHaveBeenCalledTimes(1);
  });

  test('re-proves once with a fresh quote after a stale ASP root', async () => {
    const args = setup();
    args.state.errors = [staleRoot()];
    const outcome = await relayWithdrawalWithFreshQuote(args);
    expect(outcome?.result).toEqual({ txHash: '0x1234' });
    expect(args.prepareOption).toHaveBeenCalledTimes(2);
    expect(args.relay).toHaveBeenCalledTimes(2);
    expect(args.onStaleAspRoot).toHaveBeenCalledTimes(1);
  });

  test('a second stale ASP root ends in the short copy, carrying the refusal', async () => {
    const args = setup();
    const second = staleRoot();
    args.state.errors = [staleRoot(), second];
    const refused = await relayWithdrawalWithFreshQuote(args).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StaleAspRootError);
    expect((refused as Error).message).toBe(STALE_ASP_ROOT_MESSAGE);
    expect((refused as Error).cause).toBe(second);
    expect(args.relay).toHaveBeenCalledTimes(2);
  });

  describe('a relayed withdrawal that mined reverted', () => {
    const PROOF_ROOT = 0xabcn;
    function withRoot(moved: boolean[]) {
      const args = setup();
      const calls: { proofRoot: bigint | null; wait: boolean }[] = [];
      const onRevert = mock((_error: RelayedRevertError) => {});
      return {
        args: {
          ...args,
          onRevert,
          rootMoved: mock(async (proofRoot: bigint | null, wait: boolean) => {
            calls.push({ proofRoot, wait });
            return moved.shift() ?? false;
          }),
        },
        calls,
        onRevert,
      };
    }

    test('re-proves once when the association set moved past the proof root', async () => {
      const { args, calls, onRevert } = withRoot([true]);
      args.state.errors = [new RelayedRevertError(PROOF_ROOT, '0x1234')];
      const outcome = await relayWithdrawalWithFreshQuote(args);
      expect(outcome?.result).toEqual({ txHash: '0x1234' });
      expect(args.prepareOption).toHaveBeenCalledTimes(2);
      expect(args.relay).toHaveBeenCalledTimes(2);
      expect(args.onStaleAspRoot).toHaveBeenCalledTimes(1);
      expect(onRevert).toHaveBeenCalledTimes(1);
      // The first check may wait for the grid's next refresh.
      expect(calls).toEqual([{ proofRoot: PROOF_ROOT, wait: true }]);
    });

    test('a revert the set does not explain is not retried and reads as the plain copy', async () => {
      const { args, calls } = withRoot([false]);
      const reverted = new RelayedRevertError(PROOF_ROOT);
      args.state.errors = [reverted];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toBe(reverted);
      expect(reverted.message).toBe(RELAYED_REVERT_MESSAGE);
      expect(args.relay).toHaveBeenCalledTimes(1);
      expect(args.onStaleAspRoot).toHaveBeenCalledTimes(0);
      expect(calls).toHaveLength(1);
    });

    test('a second revert past a moved set ends in the short copy, checked without waiting', async () => {
      const { args, calls } = withRoot([true, true]);
      args.state.errors = [new RelayedRevertError(PROOF_ROOT), new RelayedRevertError(0xdefn)];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow(STALE_ASP_ROOT_MESSAGE);
      expect(args.relay).toHaveBeenCalledTimes(2);
      expect(calls).toEqual([{ proofRoot: PROOF_ROOT, wait: true }, { proofRoot: 0xdefn, wait: false }]);
    });

    test('a refusal after a revert retry also ends in the short copy', async () => {
      const { args } = withRoot([true]);
      args.state.errors = [new RelayedRevertError(PROOF_ROOT), staleRoot()];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow(STALE_ASP_ROOT_MESSAGE);
      expect(args.relay).toHaveBeenCalledTimes(2);
    });

    test('a failing check counts as unexplained, never as a retry', async () => {
      const args = { ...setup(), rootMoved: async () => { throw new Error('grid unavailable'); } };
      const reverted = new RelayedRevertError(PROOF_ROOT);
      args.state.errors = [reverted];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toBe(reverted);
      expect(args.relay).toHaveBeenCalledTimes(1);
    });

    test('without a check a revert is never retried', async () => {
      const args = setup();
      const reverted = new RelayedRevertError(PROOF_ROOT);
      args.state.errors = [reverted];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toBe(reverted);
      expect(args.relay).toHaveBeenCalledTimes(1);
    });

    test('does not re-prove once the operation changed during the check', async () => {
      const base = setup();
      const args = { ...base, rootMoved: async () => { base.state.current = false; return true; } };
      args.state.errors = [new RelayedRevertError(PROOF_ROOT)];
      expect(await relayWithdrawalWithFreshQuote(args)).toBeNull();
      expect(args.prepareOption).toHaveBeenCalledTimes(1);
      expect(args.relay).toHaveBeenCalledTimes(1);
      expect(args.onStaleAspRoot).toHaveBeenCalledTimes(0);
    });
  });

  test('the retry quote is held to the reviewed fee', async () => {
    const args = setup();
    args.state.errors = [staleRoot()];
    args.state.quotes = [quote(), quote(60_000, '2000')];
    await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow('fee went up');
    expect(args.relay).toHaveBeenCalledTimes(1);
  });

  for (const error of [
    new Error('network timeout'),
    new Error('Receipt wait failed: PoolVault_InvalidASPRoot'),
    new Error(rawExpired),
    new RelayerRejected(rawExpired),
    new Error('Timed out waiting for relay receipt', { cause: expired() }),
  ]) {
    test(`preserves failure without another quote or relay: ${String(error)}`, async () => {
      const args = setup();
      args.state.errors = [error];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toBe(error);
      expect(args.prepareOption).toHaveBeenCalledTimes(1);
      expect(args.relay).toHaveBeenCalledTimes(1);
    });
  }

  test('enforces the reviewed fee ceiling before proving', async () => {
    const args = setup();
    args.state.quotes = [quote(60_000, '2000')];
    const refused = await relayWithdrawalWithFreshQuote(args).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayFeeIncreasedError);
    expect(refused).toMatchObject({ reviewedFee: 1000n, relayFee: 2000n });
    expect(args.relay).toHaveBeenCalledTimes(0);
  });

  for (const field of ['asset', 'recipient', 'feeAmount'] as const) {
    test(`refuses a signed ${String(field)} mismatch`, async () => {
      const args = setup();
      const wrong = quote();
      if (field === 'feeAmount') wrong.feeCommitment![field] = '999';
      else wrong.feeCommitment![field] = PROCESSOR;
      args.state.quotes = [wrong];
      await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow('does not match');
      expect(args.relay).toHaveBeenCalledTimes(0);
    });
  }

  test('checks requested amounts even when both quote copies agree', async () => {
    const args = setup();
    const wrong = quote();
    wrong.amountReceived = wrong.feeCommitment!.amountReceived = '200000';
    wrong.amountSent = wrong.feeCommitment!.amountSent = '201000';
    args.state.quotes = [wrong];
    await expect(relayWithdrawalWithFreshQuote(args)).rejects.toThrow('does not match');
    expect(args.relay).toHaveBeenCalledTimes(0);
  });

  test('preserves the existing reviewed-fee jitter allowance', async () => {
    const args = setup();
    args.state.quotes = [quote(60_000, '1016')];
    expect((await relayWithdrawalWithFreshQuote(args))?.feeAmount).toBe('1016');
    expect(args.relay).toHaveBeenCalledTimes(1);
  });

  test('does not request a quote after the operation changes', async () => {
    const args = setup();
    args.state.current = false;
    expect(await relayWithdrawalWithFreshQuote(args)).toBeNull();
    expect(args.prepareOption).toHaveBeenCalledTimes(0);
    expect(args.relay).toHaveBeenCalledTimes(0);
  });

  test('does not prove when the operation changes during the quote', async () => {
    const args = setup();
    args.state.stopDuringQuote = true;
    expect(await relayWithdrawalWithFreshQuote(args)).toBeNull();
    expect(args.relay).toHaveBeenCalledTimes(0);
  });
});

describe('fee commitment display across all SDK error callers', () => {
  for (const error of [expired(), new Error(rawExpired), rawExpired]) {
    test(`never exposes epoch timestamps for an expiry: ${String(error)}`, () => {
      expect(sdkErrorText(error, null)).toBe(FEE_COMMITMENT_EXPIRED_MESSAGE);
      expect(sdkErrorText(error, { input: { symbol: 'BNB', decimals: 18 } })).not.toContain('179065');
    });
  }

  for (const message of [
    'HTTP 400: {"message":"Fee commitment has expired","error":"Bad Request","statusCode":400}',
    'HTTP 400: Bad Request {"message":"Batch fee commitment has expired","error":"Bad Request","statusCode":400}',
  ]) {
    test(`maps the relayer's own pre-submit expiry refusal: ${message}`, () => {
      expect(sdkErrorText(new RelayerRejected(message), null)).toBe(FEE_COMMITMENT_EXPIRED_MESSAGE);
    });
  }

  for (const error of [
    new Error('Receipt wait failed: FeeCommitmentExpired'),
    new Error(`Receipt wait failed: ${rawExpired}`),
    new Error('Receipt wait failed', { cause: expired() }),
    new Error('Receipt wait failed', { cause: new Error(rawExpired) }),
    new Error('Receipt wait failed', { cause: rawExpired }),
    new RelayerRejected(rawExpired),
    new RelayerRejected('HTTP 500: {"message":"Fee commitment has expired","statusCode":500}'),
    new Error('HTTP 400: {"message":"Fee commitment has expired","statusCode":400}'),
    new Error(`${rawExpired}; receipt status unknown`),
    'Diagnostic mentions FeeCommitmentExpired',
    `Receipt wait failed: ${rawExpired}`,
  ]) {
    test(`keeps unrelated failure diagnostics: ${String(error)}`, () => {
      const message = typeof error === 'string' ? error : error.message;
      expect(sdkErrorText(error, null)).toBe(message);
      expect(sdkErrorText(error, { input: { symbol: 'BNB', decimals: 18 } })).toBe(message);
    });
  }
});
