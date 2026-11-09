// Relayed Stellar transfers prove ONCE (services/stellar/stellar-transfer-once.ts).
//
// The account used to call prepareTransfer / prepareColdStartTransfer (one proof, thrown away)
// and then relayTransfer (a second proof with the relayer's fee). These tests drive the real
// transfer / sendOneTime / keepClaim flows against a stubbed session that counts proofs, and
// check the one-time link's notes against the SDK's own output-note code, so the restated split
// rule cannot drift from it unnoticed.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));

import { STELLAR_TESTNET_CONTRACTS, STELLAR_TRANSFER_RELAY_FEE_ESTIMATE } from '@/config/stellar-deployment';
import {
  assertProofCreates,
  newRecipientSecrets,
  predictRecipientNotes,
  recipientCommitment,
  relayerWithBeforeSend,
} from '@/services/stellar/stellar-transfer-once';

type Hex = `0x${string}`;
const XLM = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
const ME = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const THEM = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const FEE = 400_000n;

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const sdkPromise = import('@privacy-pools-v2/stellar-sdk');

async function tools() {
  const sdk = await sdkPromise;
  const hashService = await sdk.PoseidonHashService.create();
  const cryptoService = new sdk.StellarCryptoService();
  const computation = new sdk.NoteComputationService({ hashService, cryptoService } as never);
  const converter = new sdk.StellarAddressFieldConverter();
  return { sdk, computation, converter, cryptoService };
}

/** The SDK's own TransactOrchestrator.getTransactOutputNotes, on a minimal orchestrator. */
async function sdkOutputNotes(
  inputNotes: { label: Hex; value: Hex; commitment: Hex }[],
  amount: bigint,
  fee: bigint,
  recipient: { noteAddressHash: Hex[]; noteSecretsMap: Map<Hex, Hex> },
) {
  const { sdk, computation, converter, cryptoService } = await tools();
  const orchestrator = Object.assign(Object.create(sdk.TransactOrchestrator.prototype), {
    noteComputationService: computation,
    addressFieldConverter: converter,
    cryptoService,
    ownerAddress: ME,
  }) as { getTransactOutputNotes: (...a: unknown[]) => { changeNotes: { commitment: Hex }[]; recipientNotes: { commitment: Hex; value: Hex; label: Hex; noteAddressHash: Hex }[] } };
  return orchestrator.getTransactOutputNotes(inputNotes, `0x${amount.toString(16)}`, `0x${fee.toString(16)}`, XLM, recipient);
}

const input = (i: number, label: number, value: bigint) => ({
  commitment: `0x${(0x1000 + i).toString(16).padStart(64, '0')}` as Hex,
  label: `0x${label.toString(16)}` as Hex,
  value: `0x${value.toString(16)}` as Hex,
  tokenId: XLM,
  status: 'ACTIVE',
  noteAddressHash: '0x1',
  createdAtBlock: '0x10',
});

describe('the one-time link notes match the SDK', () => {
  const cases: [string, ReturnType<typeof input>[], bigint][] = [
    ['one label', [input(1, 7, 50_000_000n)], 20_000_000n],
    ['one label, all of it', [input(1, 7, 50_000_000n)], 50_000_000n - FEE],
    ['two labels, first covers it', [input(1, 7, 50_000_000n), input(2, 9, 30_000_000n)], 40_000_000n],
    ['two labels, spills into the second', [input(1, 7, 10_000_000n), input(2, 9, 30_000_000n)], 25_000_000n],
    ['repeated label', [input(1, 7, 10_000_000n), input(2, 9, 5_000_000n), input(3, 7, 10_000_000n)], 22_000_000n],
  ];
  for (const [name, inputs, amount] of cases) {
    test(name, async () => {
      const { sdk, computation, converter } = await tools();
      const secrets = newRecipientSecrets(
        {
          computation,
          generateSecret: () => new sdk.StellarCryptoService().generateSecret(),
          recipientField: converter.toField(THEM as never) as Hex,
        },
        inputs.length,
      );
      const tokenField = converter.toTokenIdField(XLM as never) as Hex;
      const ours = predictRecipientNotes(inputs, amount, secrets.noteAddressHash).map((n) => ({
        ...n,
        commitment: recipientCommitment(computation, tokenField, n),
      }));
      const theirs = (await sdkOutputNotes(inputs, amount, FEE, secrets)).recipientNotes;
      expect(ours.map((n) => BigInt(n.commitment))).toEqual(theirs.map((n) => BigInt(n.commitment)));
      expect(ours.map((n) => n.value)).toEqual(theirs.map((n) => BigInt(n.value)));
      expect(ours.map((n) => BigInt(n.label))).toEqual(theirs.map((n) => BigInt(n.label)));
      // The fee never moves a recipient note.
      const noFee = (await sdkOutputNotes(inputs, amount, 0n, secrets)).recipientNotes;
      expect(noFee.map((n) => BigInt(n.commitment))).toEqual(theirs.map((n) => BigInt(n.commitment)));
    });
  }

  test('a proof that does not create the link notes is refused', () => {
    const signals = (outs: bigint[]) => ({
      proof: { proof: {}, publicSignals: ['0x1', ...outs.map((o) => `0x${o.toString(16)}`), '0', '0', '0', '0', '0', '0'] },
      inputNullifierNumber: 1,
      outputCommitmentNumber: outs.length,
    }) as never;
    expect(() => assertProofCreates(signals([0xc1n, 0xa1n]), ['0xa1'], 1)).not.toThrow();
    expect(() => assertProofCreates(signals([0xc1n, 0xa2n]), ['0xa1'], 1)).toThrow('Nothing was sent');
    expect(() => assertProofCreates(signals([0xc1n, 0xa1n, 0xa2n]), ['0xa1'], 1)).toThrow('Nothing was sent');
  });

  test('beforeSend runs before the relay request, and a throw stops it', async () => {
    const calls: string[] = [];
    const relayer = { relayTransfer: async () => { calls.push('post'); return '0x1'; }, getRelayers: async () => [] } as never;
    await relayerWithBeforeSend(relayer, () => void calls.push('before')).relayTransfer({} as never, {} as never);
    expect(calls).toEqual(['before', 'post']);
    await expect(relayerWithBeforeSend(relayer, () => { throw new Error('no'); }).relayTransfer({} as never, {} as never)).rejects.toThrow('no');
    expect(calls).toEqual(['before', 'post']);
  });
});

describe('each relayed transfer flow proves once', () => {
  let events: string[];
  let keystoreReads: { contractId: string; method: string; source: string }[];

  beforeEach(() => {
    events = [];
    keystoreReads = [];
    memory.clear();
  });

  async function harness(notes: ReturnType<typeof input>[]) {
    const { stellarAccount } = await import('@/services/stellar/stellar-account');
    const { sdk } = await tools();
    const account = new (stellarAccount.constructor as new () => typeof stellarAccount)() as unknown as Record<string, unknown>;
    const relayerInfo = { address: 'GRELAYER', processorAddress: STELLAR_TESTNET_CONTRACTS.relayContractId, chainType: 'stellar' };
    const relayer = {
      getRelayers: async () => [relayerInfo],
      getTransferQuote: async (_info: unknown, params: { shape: { n: number; m: number } }) => {
        events.push(`quote n=${params.shape.n} m=${params.shape.m}`);
        return {
          feeAmount: FEE.toString(),
          txCost: '0',
          gasPrice: '0',
          feeCommitment: { feeAmount: FEE.toString(), asset: XLM, expiration: Date.now() + 60_000, data: '0x', extraGas: false },
        };
      },
      relayTransfer: async () => {
        events.push('post');
        return '0xfeed';
      },
    };
    const refuse = (name: string) => async () => {
      events.push(`proof:${name}`);
      throw new Error(`${name} must not be called: it proves a transact that is thrown away`);
    };
    const session = {
      exportAccount: async () => ({ notes }),
      prepareTransfer: refuse('prepareTransfer'),
      prepareColdStartTransfer: refuse('prepareColdStartTransfer'),
      // What the SDK's relayTransfer does: one proof (the outputs from its own note code), then
      // the session's relayer (the account's active one) posts it.
      relayTransfer: async (option: {
        inputCommitments: Hex[]; amount: Hex; tokenId: string; selectedQuote: { relayerInfo: unknown; quote: { feeCommitment: { feeAmount: string } } };
        recipient: { noteAddressHash: Hex[]; noteSecretsMap: Map<Hex, Hex>; publicViewingKey?: Hex };
      }) => {
        events.push('proof:relayTransfer');
        const inputs = option.inputCommitments.map((c) => notes.find((n) => BigInt(n.commitment) === BigInt(c))!);
        const outs = await sdkOutputNotes(inputs, BigInt(option.amount), BigInt(option.selectedQuote.quote.feeCommitment.feeAmount), option.recipient);
        const outputs = [...outs.changeNotes, ...outs.recipientNotes].map((n) => String(n.commitment));
        const active = account.activeRelayer as typeof relayer;
        await (active.relayTransfer as (info: unknown, params: unknown) => Promise<string>)(option.selectedQuote.relayerInfo, {
          proof: { proof: {}, publicSignals: [...inputs.map((_, i) => `0x${(i + 1).toString(16)}`), ...outputs, '0', '0', '0', '0', '0', '0'] },
          inputNullifierNumber: inputs.length,
          outputCommitmentNumber: outputs.length,
        } as never);
        events.push(`recipient:${option.recipient.publicViewingKey ? 'discoverable' : 'outOfBand'}`);
        return { txReceipt: { status: true, txHash: '0xfeed' }, spentNullifiersConfirmed: true, recipientNotes: outs.recipientNotes };
      },
    };
    Object.assign(account, {
      requireSigner: () => ({ address: ME, signer: {}, generation: 0 }),
      ensureSession: async () => session,
      connectRelayer: async () => relayer,
      ensureRegistered: async () => {},
      refreshLocal: async () => {},
      stampClaimedNotes: async () => true,
      rpc: {
        simulateRead: async (contractId: string, method: string, _args: unknown, source: string) => {
          keystoreReads.push({ contractId, method, source });
          return Buffer.alloc(32, 7);
        },
      },
    });
    return { account: account as unknown as typeof stellarAccount, sdk };
  }

  test('transfer to a registered account', async () => {
    const notes = [input(1, 7, 50_000_000n)];
    const { account, sdk } = await harness(notes);
    await account.transfer({ amount: 10_000_000n, recipient: THEM, inputCommitments: notes.map((n) => n.commitment) });
    expect(events.filter((e) => e.startsWith('proof:'))).toEqual(['proof:relayTransfer']);
    expect(events).toEqual(['quote n=1 m=2', 'proof:relayTransfer', 'post', 'recipient:discoverable']);
    // The same viewing-key read prepareTransfer made: the keystore, from the neutral read source.
    expect(keystoreReads).toEqual([{ contractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId, method: 'get_viewing_key', source: sdk.STELLAR_NEUTRAL_READ_SOURCE }]);
  });

  test('transfer to an unregistered account is refused before any proof', async () => {
    const notes = [input(1, 7, 50_000_000n)];
    const { account } = await harness(notes);
    (account as unknown as { rpc: { simulateRead: () => Promise<Buffer> } }).rpc.simulateRead = async () => Buffer.alloc(32, 0);
    const err = await account.transfer({ amount: 10_000_000n, recipient: THEM, inputCommitments: notes.map((n) => n.commitment) }).catch((e) => e);
    const { isUnregisteredRecipientError } = await import('@/services/stellar/stellar-claim');
    expect(isUnregisteredRecipientError(err)).toBe(true);
    expect(events).toEqual([]);
  });

  test('one-time link: one proof, link saved after it and before the send, naming what the proof creates', async () => {
    const notes = [input(1, 7, 10_000_000n), input(2, 9, 30_000_000n)];
    const { account } = await harness(notes);
    let savedAtReady: number | null = null;
    const sent = await account.sendOneTime({
      amount: 25_000_000n,
      recipient: THEM,
      inputCommitments: notes.map((n) => n.commitment),
      onClaimReady: () => {
        events.push('claim-ready');
        savedAtReady = [...memory.values()].length;
      },
    });
    expect(events.filter((e) => e.startsWith('proof:'))).toEqual(['proof:relayTransfer']);
    expect(events).toEqual(['quote n=2 m=4', 'proof:relayTransfer', 'claim-ready', 'post', 'recipient:outOfBand']);
    expect(savedAtReady).toBe(1);
    // The link names the notes the transaction created: the SDK's recipient notes for that proof.
    expect(sent.notes.map((n) => n.value)).toEqual(['0x989680', '0xe4e1c0']);
    const { findStellarSentClaim } = await import('@/services/stellar/stellar-account');
    const saved = findStellarSentClaim(ME, '0xfeed');
    expect(saved?.notes.map((n) => n.commitment)).toEqual(sent.notes.map((n) => n.commitment));
    expect(keystoreReads).toEqual([]);
  });

  test('one-time link: nothing is saved or sent when the proof would create other notes', async () => {
    const notes = [input(1, 7, 10_000_000n), input(2, 9, 30_000_000n)];
    const { account } = await harness(notes);
    // A session that cuts the outputs differently from the link (here: a different amount).
    const session = await (account as unknown as { ensureSession: () => Promise<{ relayTransfer: (o: { amount: Hex }) => Promise<unknown> }> }).ensureSession();
    const real = session.relayTransfer;
    session.relayTransfer = (o) => real({ ...o, amount: '0x1' as Hex });
    const err = await account.sendOneTime({ amount: 25_000_000n, recipient: THEM, inputCommitments: notes.map((n) => n.commitment) }).catch((e) => e);
    expect(String(err)).toContain('Nothing was sent');
    expect(events).toEqual(['quote n=2 m=4', 'proof:relayTransfer']);
    expect(memory.size).toBe(0);
  });

  test('keeping a claimed link', async () => {
    const notes = [input(1, 7, 10_000_000n), input(2, 9, 5_000_000n)];
    const { account } = await harness(notes);
    await account.keepClaim(notes.map((n) => n.commitment));
    expect(events).toEqual(['quote n=2 m=4', 'proof:relayTransfer', 'post', 'recipient:discoverable']);
    expect(keystoreReads.map((r) => r.method)).toEqual(['get_viewing_key']);
    expect(STELLAR_TRANSFER_RELAY_FEE_ESTIMATE).toBeGreaterThanOrEqual(FEE);
  });
});
