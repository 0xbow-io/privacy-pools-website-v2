import { describe, expect, test } from 'bun:test';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import type { StellarSdkPaymentRequest } from '@/services/payment-request-codec';
import { loadStellarSdk } from '@/services/stellar/stellar-runtime';

import {
  relayTransferOnce,
  type OneTimeRecipientNote,
  type TransferOnceRelayer,
  type TransferOnceSession,
} from '@/services/stellar/stellar-transfer-once';

const TOKEN = 'CNATIVE';
const FEE = 750_000n;
const A = 'GABC';
const commits = ['0x1', '0x2'] as `0x${string}`[];

function fakes(opts: { fee?: bigint; confirmed?: boolean } = {}) {
  const calls = { proofs: 0, prepare: 0, quotes: [] as unknown[], relayed: [] as Record<string, unknown>[], outputs: [] as unknown[][] };
  const session = {
    // The only place a proof is built in the SDK: prepare* and relayTransfer. prepare* must never run.
    prepareTransfer: () => { calls.prepare++; calls.proofs++; throw new Error('prepare must not be called'); },
    prepareFulfillPaymentRequest: () => { calls.prepare++; throw new Error('prepare must not be called'); },
    prepareColdStartTransfer: () => { calls.prepare++; calls.proofs++; throw new Error('prepare must not be called'); },
    relayTransfer: async (option: Record<string, unknown>) => {
      calls.proofs++;
      calls.relayed.push(option);
      return { txReceipt: { status: true, txHash: '0xabc' }, spentNullifiersConfirmed: opts.confirmed ?? true };
    },
    delegates: {
      transfer: {
        resolveRecipient: async () => ({ noteAddressHash: ['0xh1'], noteSecretsMap: new Map([['0xh1', 's1']]), publicViewingKey: '0xpk' }),
        generateNoteSecretsMap: () => new Map([['0xh1', 'secret1'], ['0xh2', 'secret2']]),
        core: {
          resolveAndValidateTransactInputs: () => ({ inputNotes: [{}, {}] }),
          getTransactOutputNotes: (...args: unknown[]) => {
            calls.outputs.push(args);
            return {
              recipientNotes: [
                { commitment: '0xc1', noteAddressHash: '0xh1', value: '0x64', tokenId: TOKEN, label: '0x7' },
                { commitment: '0xc2', noteAddressHash: '0xh2', value: '0x32', tokenId: TOKEN, label: '0x8' },
              ],
            };
          },
        },
      },
    },
  };
  const relayer = {
    getRelayers: async () => [{ address: 'GRELAY' }],
    getTransferQuote: async (_r: unknown, params: Record<string, unknown>) => {
      calls.quotes.push(params);
      return { feeCommitment: { feeAmount: (opts.fee ?? FEE).toString() } };
    },
  };
  return { calls, session: session as unknown as TransferOnceSession, relayer: relayer as unknown as TransferOnceRelayer };
}

const base = { tokenId: TOKEN, amount: 5_000_000n, inputCommitments: commits, maxFee: FEE, maxInputs: 5, maxOutputs: 5 };

describe('relayed Stellar transfer proves once (DEV-645)', () => {
  test('a registered recipient: one proof, no prepare, one quote, secrets map kept', async () => {
    const { calls, session, relayer } = fakes();
    await relayTransferOnce(session, relayer, { ...base, recipient: { kind: 'registered', address: A } });
    expect(calls.proofs).toBe(1);
    expect(calls.prepare).toBe(0);
    expect(calls.quotes).toHaveLength(1);
    expect(calls.quotes[0]).toEqual({ asset: TOKEN, commit: true, shape: { n: 2, m: 4 } });
    const option = calls.relayed[0];
    expect((option.recipient as { noteSecretsMap?: Map<string, string> }).noteSecretsMap?.size).toBe(1);
    expect(option.recipientEvmAddress).toBe(A);
    expect(option.amount).toBe('0x4c4b40');
  });

  test('a one-time link: one proof, relayed, notes saved before the relay request', async () => {
    const { calls, session, relayer } = fakes();
    const order: string[] = [];
    let saved: OneTimeRecipientNote[] = [];
    const orig = session.relayTransfer.bind(session);
    session.relayTransfer = (o) => { order.push('relay'); return orig(o); };
    await relayTransferOnce(session, relayer, {
      ...base,
      recipient: { kind: 'oneTime', address: A },
      beforeRelay: (notes) => { order.push('save'); saved = notes; },
    });
    expect(order).toEqual(['save', 'relay']);
    expect(calls.proofs).toBe(1);
    expect(calls.prepare).toBe(0);
    expect(saved.map((n) => [n.commitment, n.noteSecret])).toEqual([['0xc1', 'secret1'], ['0xc2', 'secret2']]);
    // The link's notes are sized with the quoted fee, the same one the relay signs.
    expect(calls.outputs[0].slice(1, 4)).toEqual(['0x4c4b40', '0xb71b0', TOKEN]);
    // No secrets reach the relay request, and the sender is not an argument of it.
    const option = calls.relayed[0];
    expect((option.recipient as { noteSecretsMap?: unknown }).noteSecretsMap).toBeUndefined();
    expect(JSON.stringify(calls.quotes)).not.toContain('0xc1');
  });

  test('a failed save sends nothing', async () => {
    const { calls, session, relayer } = fakes();
    await expect(
      relayTransferOnce(session, relayer, {
        ...base,
        recipient: { kind: 'oneTime', address: A },
        beforeRelay: () => { throw new Error('storage full'); },
      }),
    ).rejects.toThrow('storage full');
    expect(calls.relayed).toHaveLength(0);
    expect(calls.proofs).toBe(0);
  });

  test('a fee above the estimate is refused before any proof', async () => {
    const { calls, session, relayer } = fakes({ fee: FEE + 1n });
    await expect(relayTransferOnce(session, relayer, { ...base, recipient: { kind: 'registered', address: A } })).rejects.toThrow('more than the fee shown');
    expect(calls.proofs).toBe(0);
  });

  test('a receipt that did not spend this transfer is refused', async () => {
    const { session, relayer } = fakes({ confirmed: false });
    await expect(relayTransferOnce(session, relayer, { ...base, recipient: { kind: 'registered', address: A } })).rejects.toThrow('not this transfer');
  });

  test('the guard stops the send before the relay request', async () => {
    const { calls, session, relayer } = fakes();
    await expect(
      relayTransferOnce(session, relayer, { ...base, recipient: { kind: 'registered', address: A }, guard: () => { throw new Error('Superseded'); } }),
    ).rejects.toThrow('Superseded');
    expect(calls.proofs).toBe(0);
  });
});


describe('Stellar payment requests use the same single-proof relay', () => {
  const request: StellarSdkPaymentRequest = {
    paymentId: '0x11', amount: '0x989680', tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
    noteAddressHashes: ['0x21', '0x22'], paymentPubKey: '0x31', tag: '0x41',
  };
  const payment = { tokenId: request.tokenId, inputCommitments: commits, maxFee: FEE, maxInputs: 5, maxOutputs: 5, paymentRequest: request };

  // Run the pinned SDK's original validation and recipient resolution, stopping
  // at prepareTransfer so the reference path never proves or touches the network.
  async function sdkRecipient(paymentRequest: StellarSdkPaymentRequest, inputCommitments = commits) {
    const sdk = await loadStellarSdk();
    const delegate = Object.create(sdk.PoolSessionTransfer.prototype);
    delegate.fulfillPaymentRequestParamsSchema = sdk.makePaymentRequestSchemas(sdk.StellarAddressSchema).fulfillPaymentRequestParamsSchema;
    delegate.prepareTransfer = async (params: { amount: string; tokenId: string }) => ({
      amount: params.amount, tokenId: params.tokenId, recipient: await delegate.resolveRecipient(params),
    });
    return delegate.prepareFulfillPaymentRequest({ paymentRequest, inputCommitments });
  }

  test('matches the SDK recipient and amount, proves once, and quotes only asset/shape', async () => {
    const { calls, session, relayer } = fakes();
    session.delegates.transfer.resolveRecipient = async () => { throw new Error('must not look up a recipient'); };
    session.delegates.transfer.generateNoteSecretsMap = () => { throw new Error('must not generate new slots'); };
    const expected = await sdkRecipient(request);
    await relayTransferOnce(session, relayer, payment);
    expect(calls.prepare).toBe(0);
    expect(calls.proofs).toBe(1);
    expect(calls.relayed[0]).toMatchObject(expected);
    expect(calls.relayed[0].recipient).toEqual({ noteAddressHash: request.noteAddressHashes, publicViewingKey: request.paymentPubKey, hint: request.tag });
    expect('recipientEvmAddress' in calls.relayed[0]).toBe(false);
    expect(calls.quotes).toEqual([{ asset: request.tokenId, commit: true, shape: { n: 2, m: 4 } }]);
    expect(calls.outputs).toHaveLength(0);
  });

  test('preserves SDK schema/expiry refusals before any quote or proof', async () => {
    const sdk = await loadStellarSdk();
    for (const changed of [
      { amount: '0x0' }, { tokenId: 'not-a-contract' }, { tag: 'invalid' },
      { noteAddressHashes: [] }, { noteAddressHashes: ['0x21'] }, { expiresAt: '0x1' },
    ]) {
      const invalid = { ...request, ...changed } as StellarSdkPaymentRequest;
      const expected = await sdkRecipient(invalid).catch((e: Error) => e);
      const { calls, session, relayer } = fakes();
      const actual = await relayTransferOnce(session, relayer, { ...payment, paymentRequest: invalid }).catch((e: Error) => e);
      expect(expected).toBeInstanceOf(changed.expiresAt ? sdk.PaymentRequestExpired : sdk.InvalidTransactParams);
      if (!(actual instanceof Error)) throw new Error('Expected payment validation to fail');
      expect(actual.constructor).toBe(expected.constructor);
      if (!changed.expiresAt) expect(actual.message).toBe(expected.message);
      expect(calls.quotes).toHaveLength(0);
      expect(calls.proofs).toBe(0);
    }
  });

  test('retains fee, supersession, and confirmed-spend guards for payments', async () => {
    for (const scenario of ['fee', 'superseded', 'unconfirmed']) {
      const { calls, session, relayer } = fakes({ fee: scenario === 'fee' ? FEE + 1n : FEE, confirmed: scenario !== 'unconfirmed' });
      await expect(relayTransferOnce(session, relayer, {
        ...payment,
        guard: () => { if (scenario === 'superseded') throw new Error('Superseded'); },
      })).rejects.toThrow(scenario === 'fee' ? 'more than the fee shown' : scenario === 'superseded' ? 'Superseded' : 'not this transfer');
      expect(calls.proofs).toBe(scenario === 'unconfirmed' ? 1 : 0);
    }
  });
});
