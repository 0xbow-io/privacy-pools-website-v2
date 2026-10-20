import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  CryptoService,
  FeeCommitmentExpired,
  NoteComputationService,
  PaymentRequestExpired,
  PoolSessionTransfer,
  PoseidonHashService,
  RecipientViewingKeyUnregistered,
  RelayerRejected,
  TransactOrchestrator,
  type RelayerInfo,
  type RelayTransferParams,
  type TransferRelayerQuote,
} from '@privacy-pools-v2/sdk';
import {
  assertRecipientBinding,
  buildTransferRecipient,
  plainTransferRelayError,
  planTransferOutputs,
  relayTransferParams,
  requestTransferQuote,
  TRANSFER_QUOTE_EXPIRED_MESSAGE,
  transferRelayExpectation,
  transferRelayFee,
  type TransferQuoteSource,
  type TransferRecipientDeps,
  type TransferRecipientSpec,
} from '@/services/relayed-transfer';
import { forgetRelayedTxHashes, recordRelayedHashes } from '@/services/relayed-receipt';
import { isKnownRejection } from '@/services/transfer-outcome';
import { isPayRelayIndeterminate } from '@/services/pay-relay-guard';
import { checkTransferRelay, expectTransferRelay, TRANSFER_PLAN_MISMATCH_MESSAGE } from '@/services/transfer-relay-outputs';
import type { Address, Hash, Hex } from '@/services/sdk-types';

const NOW = 1790962700000;
const ASSET = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
const RELAYER = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;
const VIEWING_KEY = `0x${'ab'.repeat(32)}` as Hex;
const TX_HASH = `0x${'cd'.repeat(32)}` as Hash;

const RELAYER_INFO = {
  name: 'Test relay', url: 'https://relayer.example', chainType: 'evm', chainId: 11155111,
  status: 'active', address: RELAYER, processorAddress: RELAYER,
} as unknown as RelayerInfo;

let quoteSerial = 0;
function quote({ lifetime = 60_000, fee = '1000', asset = ASSET.toLowerCase(), topFee = fee }: {
  lifetime?: number; fee?: string; asset?: string; topFee?: string;
} = {}): TransferRelayerQuote {
  quoteSerial++;
  return {
    txCost: '1', gasPrice: '1', feeAmount: topFee,
    feeCommitment: {
      data: '0x01', asset, expiration: NOW + lifetime, feeAmount: fee,
      signedRelayerCommitment: `0x${quoteSerial.toString(16).padStart(4, '0')}`,
    },
  } as TransferRelayerQuote;
}

function source(next: () => Promise<TransferRelayerQuote>, relayers: RelayerInfo[] = [RELAYER_INFO]) {
  const quoteFn = mock(async (_relayer: RelayerInfo, _params: unknown) => next());
  const src: TransferQuoteSource = { relayers: async () => relayers, quote: quoteFn };
  return { src, quoteFn };
}

describe('requestTransferQuote', () => {
  test('requests one committed asset-only quote from the chain relayer', async () => {
    const fresh = quote({ fee: '1200' });
    const { src, quoteFn } = source(async () => fresh);
    const selected = await requestTransferQuote(src, ASSET, () => NOW);

    expect(quoteFn).toHaveBeenCalledTimes(1);
    expect(quoteFn.mock.calls[0]).toEqual([RELAYER_INFO, { asset: ASSET, commit: true }]);
    expect(selected).toEqual({ relayerInfo: RELAYER_INFO, quote: fresh });
    expect(transferRelayFee({ selectedQuote: selected! })).toBe(1200n);
  });

  test('resolves null when no relayer is configured, and requests nothing', async () => {
    const { src, quoteFn } = source(async () => quote(), []);
    expect(await requestTransferQuote(src, ASSET, () => NOW)).toBeNull();
    expect(quoteFn).toHaveBeenCalledTimes(0);
  });

  test('accepts a quote with any lifetime left, however short', async () => {
    const { src } = source(async () => quote({ lifetime: 1 }));
    const selected = await requestTransferQuote(src, ASSET, () => NOW);
    expect(selected?.quote.feeCommitment.expiration).toBe(NOW + 1);
  });

  test('refuses a quote that arrives already expired', async () => {
    const { src } = source(async () => quote({ lifetime: 0 }));
    await expect(requestTransferQuote(src, ASSET, () => NOW)).rejects.toThrow('had already expired when it arrived. Nothing was sent');
  });

  test('refuses a quote for another asset', async () => {
    const { src } = source(async () => quote({ asset: RELAYER }));
    await expect(requestTransferQuote(src, ASSET, () => NOW)).rejects.toThrow('does not match the requested transfer. Nothing was sent');
  });

  test('refuses a quote whose shown fee differs from the signed one', async () => {
    const { src } = source(async () => quote({ fee: '1000', topFee: '10' }));
    await expect(requestTransferQuote(src, ASSET, () => NOW)).rejects.toThrow('does not match the requested transfer');
  });

  test('a failed quote request propagates before anything is relayed', async () => {
    const { src } = source(async () => { throw new Error('HTTP 429: Too Many Requests'); });
    await expect(requestTransferQuote(src, ASSET, () => NOW)).rejects.toThrow('HTTP 429');
  });
});

describe('plainTransferRelayError', () => {
  test("the SDK's local pre-POST expiry reads as nothing sent", () => {
    const err = plainTransferRelayError(new FeeCommitmentExpired('Fee commitment expired at 1790962728942, current time 1790962729420'));
    expect((err as Error).message).toBe(TRANSFER_QUOTE_EXPIRED_MESSAGE);
  });

  test("the relayer's own pre-submit expiry check reads the same", () => {
    const err = plainTransferRelayError(new RelayerRejected('HTTP 400: {"message":"Fee commitment has expired","error":"Bad Request","statusCode":400}'));
    expect((err as Error).message).toBe(TRANSFER_QUOTE_EXPIRED_MESSAGE);
  });

  test('other relay failures are unchanged', () => {
    const stale = new RelayerRejected('PoolVault transact failed: (PoolVault_InvalidASPRoot)');
    expect(plainTransferRelayError(stale)).toBe(stale);
    const timeout = new Error('Timed out while waiting for transaction receipt; Fee commitment expired at 1, current time 2');
    expect(plainTransferRelayError(timeout)).toBe(timeout);
  });

  test('the plain copies are known non-sends, so no flow treats them as an unknown outcome', () => {
    for (const message of [TRANSFER_QUOTE_EXPIRED_MESSAGE, TRANSFER_PLAN_MISMATCH_MESSAGE]) {
      expect(isKnownRejection(message)).toBe(true);
      expect(isPayRelayIndeterminate(message, true)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Parity with the SDK. A wrong recipient map or output plan creates notes
// nobody can spend, so both are checked against the vendored SDK's own code,
// with real Poseidon and only the randomness pinned.
// ---------------------------------------------------------------------------

let noteComputation: NoteComputationService;

beforeAll(async () => {
  noteComputation = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService: new CryptoService() });
});

/** The same secret sequence for the app and the SDK. */
function secrets() {
  let n = 0;
  return () => `0x${(0x5ec7e7n * BigInt(++n)).toString(16).padStart(64, '0')}` as Hex;
}

function deps(generateSecret: () => Hex, viewingKey: Hex = VIEWING_KEY): TransferRecipientDeps {
  return {
    generateSecret,
    noteAddressHash: (evmAddress, secret) => noteComputation.computeNoteAddressHash(evmAddress, secret) as Hash,
    commitment: (note) => noteComputation.computeFullCommitment(note) as Hash,
    getViewingKey: async () => viewingKey,
    errors: {
      unregistered: (evmAddress) => new RecipientViewingKeyUnregistered(evmAddress),
      expired: (expiresAt, nowMs) => new PaymentRequestExpired(expiresAt, nowMs),
    },
  };
}

const addressField = { toField: (a: string) => a, toTokenIdField: (t: string) => t };

/** The SDK's PoolSessionTransfer.resolveRecipient, on stubbed I/O. */
function sdkSession(generateSecret: () => Hex, viewingKey: Hex = VIEWING_KEY) {
  const session = Object.create(PoolSessionTransfer.prototype);
  Object.assign(session, {
    cryptoService: { generateSecret },
    noteComputationService: noteComputation,
    addressFieldConverter: addressField,
    keystoreInteractor: { getViewingKey: async () => viewingKey },
  });
  return session as {
    resolveRecipient: (params: unknown) => Promise<unknown>;
    generateNoteSecretsMap: (inputCommitments: string[], evmAddress: Address) => Map<Hash, Hex>;
  };
}

/** The SDK's TransactOrchestrator output builder, on pinned randomness. */
function sdkOrchestrator(generateSecret: () => Hex) {
  const core = Object.create(TransactOrchestrator.prototype);
  Object.assign(core, {
    cryptoService: { generateSecret },
    noteComputationService: noteComputation,
    addressFieldConverter: addressField,
    ownerAddress: RELAYER,
  });
  return core as {
    getTransactOutputNotes: (inputs: unknown[], amount: Hex, fee: Hex, tokenId: Address, recipient: unknown) => {
      changeNotes: { label: string; value: Hex; commitment: Hash }[];
      recipientNotes: { label: string; value: Hex; commitment: Hash; noteAddressHash: Hash; noteSecret: Hex }[];
    };
  };
}

const hex = (v: bigint) => `0x${v.toString(16)}` as Hex;
const label = (n: number) => `0x${(0x1abe1n + BigInt(n)).toString(16)}` as Hash;
const input = (n: number, value: bigint, lbl: Hash) => ({
  commitment: `0x${(0xc0ffeen + BigInt(n)).toString(16)}` as Hash, value: hex(value), label: lbl,
});

describe('buildTransferRecipient matches the SDK resolveRecipient', () => {
  const inputs = [input(1, 50n, label(1)), input(2, 30n, label(2)), input(3, 20n, label(1))];

  test('a registered address: one bound secret per input, and its viewing key', async () => {
    const built = await buildTransferRecipient({ kind: 'address', evmAddress: BOB }, inputs.length, deps(secrets()));
    const sdk = await sdkSession(secrets()).resolveRecipient({
      inputCommitments: inputs.map((i) => i.commitment), recipientDiscoveryData: { evmAddress: BOB },
    });
    expect(built.recipient).toEqual(sdk as never);
    expect(built.recipient.noteSecretsMap?.size).toBe(3);
    expect(built.recipientEvmAddress).toBe(BOB);
    expect(built.discoverable).toBe(true);
  });

  test('an unregistered address the flow opted out of band for: secrets and no key', async () => {
    const built = await buildTransferRecipient(
      { kind: 'address', evmAddress: BOB, allowOutOfBandFallback: true }, 2, deps(secrets(), '0x0'));
    const sdk = await sdkSession(secrets(), '0x0').resolveRecipient({
      inputCommitments: inputs.slice(0, 2).map((i) => i.commitment),
      recipientDiscoveryData: { evmAddress: BOB, allowOutOfBandFallback: true },
    });
    expect(built.recipient).toEqual(sdk as never);
    expect('publicViewingKey' in built.recipient).toBe(false);
    expect(built.discoverable).toBe(false);
  });

  test('an unregistered address without the opt-in throws the SDK error', async () => {
    const run = buildTransferRecipient({ kind: 'address', evmAddress: BOB }, 1, deps(secrets(), '0x0'));
    await expect(run).rejects.toBeInstanceOf(RecipientViewingKeyUnregistered);
    await expect(sdkSession(secrets(), '0x0').resolveRecipient({
      inputCommitments: [inputs[0].commitment], recipientDiscoveryData: { evmAddress: BOB },
    })).rejects.toBeInstanceOf(RecipientViewingKeyUnregistered);
  });

  test("a legacy v2 request: one bound secret, encrypted to the request's key", async () => {
    const built = await buildTransferRecipient({ kind: 'viewing-key', evmAddress: BOB, publicViewingKey: VIEWING_KEY }, 1, deps(secrets()));
    // The SDK takes this map from its caller, so it is built by the SDK's own
    // generator rather than handed the app's.
    const session = sdkSession(secrets());
    const sdk = await session.resolveRecipient({
      inputCommitments: [inputs[0].commitment],
      recipientDiscoveryData: { publicViewingKey: VIEWING_KEY, noteSecretsMap: session.generateNoteSecretsMap([inputs[0].commitment], BOB) },
    });
    expect(built.recipient).toEqual(sdk as never);
    const [[key, secret]] = [...built.recipient.noteSecretsMap!];
    expect(key).toBe(noteComputation.computeNoteAddressHash(BOB, secret));
  });

  test("an SDK-native request: its own slots, payment key and tag, as prepareFulfillPaymentRequest", async () => {
    const slots = [label(7), label(8)];
    const spec: TransferRecipientSpec = { kind: 'payment-request', noteAddressHashes: slots, paymentPubKey: VIEWING_KEY, tag: label(9) };
    const built = await buildTransferRecipient(spec, 2, deps(secrets()), () => NOW);
    const sdk = await sdkSession(secrets()).resolveRecipient({
      inputCommitments: [], recipientDiscoveryData: { publicViewingKey: VIEWING_KEY, noteAddressHashes: slots, hint: label(9) },
    });
    expect(built.recipient).toEqual(sdk as never);
    expect(built.discoverable).toBe(true);
    await expect(buildTransferRecipient(spec, 3, deps(secrets()), () => NOW)).rejects.toThrow('exceeds payment request slot count');
    await expect(buildTransferRecipient({ ...spec, expiresAt: hex(BigInt(NOW - 1)) }, 1, deps(secrets()), () => NOW))
      .rejects.toBeInstanceOf(PaymentRequestExpired);
  });

  test('a legacy v1 request: its one blinded slot', async () => {
    const built = await buildTransferRecipient({ kind: 'blind', noteAddressHash: label(5) }, 1, deps(secrets()));
    const sdk = await sdkSession(secrets()).resolveRecipient({ inputCommitments: [], recipientNoteAddressHash: [label(5)] });
    expect(built.recipient).toEqual(sdk as never);
    expect(built.discoverable).toBe(false);
  });

  test('a map whose keys are not bound to the address is refused', () => {
    const secret = secrets()();
    const wrong = new Map([[noteComputation.computeNoteAddressHash(RELAYER, secret) as Hash, secret]]);
    expect(() => assertRecipientBinding(wrong, BOB, deps(secrets()).noteAddressHash)).toThrow('do not match the recipient address');
  });
});

describe('planTransferOutputs matches the SDK getTransactOutputNotes', () => {
  // Labels interleaved, so first-occurrence order matters.
  const inputs = [input(1, 40n, label(1)), input(2, 25n, label(2)), input(3, 30n, label(1)), input(4, 5n, label(3))];

  async function compare(spec: TransferRecipientSpec, amount: bigint, fee: bigint) {
    const built = await buildTransferRecipient(spec, inputs.length, deps(secrets()));
    const plan = planTransferOutputs({
      inputNotes: inputs, amount, fee, tokenId: ASSET, recipient: built.recipient, commitment: deps(secrets()).commitment,
    });
    const sdk = sdkOrchestrator(secrets()).getTransactOutputNotes(inputs, hex(amount), hex(fee), ASSET, built.recipient);
    expect(plan.change).toEqual(sdk.changeNotes.map((n) => ({ label: n.label as Hash, value: BigInt(n.value) })));
    expect(plan.recipient.map((r) => ({ ...r, noteSecret: r.noteSecret ?? `0x${'0'.repeat(64)}` }))).toEqual(sdk.recipientNotes.map((n) => ({
      commitment: n.commitment, label: n.label as Hash, noteAddressHash: n.noteAddressHash, value: n.value, noteSecret: n.noteSecret,
    })));
    return plan;
  }

  test('one label covers the amount: one recipient note, every label keeps change', async () => {
    const plan = await compare({ kind: 'address', evmAddress: BOB }, 60n, 7n);
    expect(plan.recipient.map((r) => BigInt(r.value))).toEqual([60n]);
    expect(plan.change.map((c) => c.value)).toEqual([3n, 25n, 5n]);
  });

  test('a multi-lineage send: one recipient note per contributing label, summing to the amount', async () => {
    const plan = await compare({ kind: 'address', evmAddress: BOB }, 90n, 9n);
    expect(plan.recipient.map((r) => BigInt(r.value))).toEqual([70n, 20n]);
    expect(plan.recipient.every((r) => r.noteSecret !== null)).toBe(true);
  });

  test('recipient outputs do not depend on the fee', async () => {
    const a = await compare({ kind: 'address', evmAddress: BOB }, 90n, 0n);
    const b = await compare({ kind: 'address', evmAddress: BOB }, 90n, 10n);
    expect(a.recipient).toEqual(b.recipient);
    expect(a.change).not.toEqual(b.change);
  });

  test('a consolidation (zero amount, self): change only', async () => {
    const plan = await compare({ kind: 'address', evmAddress: BOB }, 0n, 11n);
    expect(plan.recipient).toEqual([]);
    expect(plan.change.map((c) => c.value)).toEqual([59n, 25n, 5n]);
  });

  test("a payment request's own slots carry no secret", async () => {
    const plan = await compare(
      { kind: 'payment-request', noteAddressHashes: [label(7), label(8), label(9), label(10)], paymentPubKey: VIEWING_KEY, tag: label(11) }, 50n, 3n);
    expect(plan.recipient.map((r) => r.noteSecret)).toEqual([null]);
  });

  test('too few slots for the input labels is refused, as the SDK does', async () => {
    const built = await buildTransferRecipient({ kind: 'blind', noteAddressHash: label(5) }, 1, deps(secrets()));
    const run = () => planTransferOutputs({ inputNotes: inputs, amount: 10n, fee: 0n, tokenId: ASSET, recipient: built.recipient, commitment: deps(secrets()).commitment });
    expect(run).toThrow('Too few noteAddressHashes');
    expect(() => sdkOrchestrator(secrets()).getTransactOutputNotes(inputs, hex(10n), '0x0', ASSET, built.recipient)).toThrow('Too few noteAddressHashes');
  });
});

describe('the relay check holds the one proof to the plan', () => {
  // The relayed-hash registry is process-wide; leave it as other files expect.
  afterEach(() => forgetRelayedTxHashes());

  const inputs = [input(1, 40n, label(1)), input(2, 25n, label(2))];

  /**
   * The SDK's own relayTransfer, with its proof stubbed: public signals are
   * the nullifiers, then the SDK's own output commitments (change first),
   * exactly as TransactOrchestrator lays them out. The relayer interactor is
   * wrapped with the app's relay hook.
   */
  async function relay(params: RelayTransferParams) {
    const orchestrator = sdkOrchestrator(secrets());
    const posted: unknown[] = [];
    const session = Object.create(PoolSessionTransfer.prototype);
    Object.assign(session, {
      core: {
        prepareTransact: async (p: { amount: Hex; feeAmount: Hex; tokenId: Address; recipient: unknown }) => {
          const { changeNotes, recipientNotes } = orchestrator.getTransactOutputNotes(inputs, p.amount, p.feeAmount, p.tokenId, p.recipient);
          const nullifiers = inputs.map((_, i) => String(1000 + i));
          return {
            proof: { proof: {}, publicSignals: [...nullifiers, ...[...changeNotes, ...recipientNotes].map((n) => BigInt(n.commitment).toString())] },
            notesData: [], spentNotes: inputs, spentNullifiers: [], changePendingNotes: changeNotes, recipientPendingNotes: recipientNotes,
          };
        },
      },
      relayerInteractor: recordRelayedHashes(
        { relayTransfer: async (_relayer: unknown, body: unknown) => { posted.push(body); return TX_HASH; } },
        { beforeRelay: checkTransferRelay },
      ),
      rpcInteractor: { waitForTransactionReceipt: async () => ({ status: true, txHash: TX_HASH }) },
      finalizeTransfer: async () => ({ txReceipt: { status: true, txHash: TX_HASH } }),
    });
    const relayTransfer = session.relayTransfer.bind(session) as (p: RelayTransferParams) => Promise<unknown>;
    return { run: () => relayTransfer(params), posted };
  }

  async function planned(amount: bigint) {
    const built = await buildTransferRecipient({ kind: 'address', evmAddress: BOB }, inputs.length, deps(secrets()));
    const selectedQuote = { relayerInfo: RELAYER_INFO, quote: quote({ fee: '7', lifetime: 600_000_000_000 }) };
    const plan = planTransferOutputs({
      inputNotes: inputs, amount, fee: 7n, tokenId: ASSET, recipient: built.recipient, commitment: deps(secrets()).commitment,
    });
    const params = relayTransferParams({ inputCommitments: inputs.map((i) => i.commitment), amount, tokenId: ASSET, built, selectedQuote });
    return { params, plan, selectedQuote };
  }

  test('a proof carrying the planned outputs is posted, and its change commitments are read', async () => {
    const { params, plan, selectedQuote } = await planned(50n);
    expect(params.feeAmount).toBe('0x7');
    expect(params.processorAddress).toBe(RELAYER);
    const check = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, plan));
    const { run, posted } = await relay(params);
    try {
      await run();
    } finally {
      check.release();
    }
    expect(posted).toHaveLength(1);
    const outputs = check.outputs()!;
    expect(outputs).toHaveLength(plan.change.length + plan.recipient.length);
    expect(outputs.slice(plan.change.length).map(BigInt)).toEqual(plan.recipient.map((r) => BigInt(r.commitment)));
  });

  test('a proof whose recipient outputs differ from the plan is refused before the POST', async () => {
    const { params, selectedQuote } = await planned(50n);
    const { plan: otherPlan } = await planned(51n);
    const check = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, otherPlan));
    const { run, posted } = await relay(params);
    try {
      await expect(run()).rejects.toThrow(TRANSFER_PLAN_MISMATCH_MESSAGE);
    } finally {
      check.release();
    }
    expect(posted).toHaveLength(0);
    expect(check.outputs()).toBeNull();
  });

  test('a plan sharing its signature with another armed plan is still found by its outputs', async () => {
    const { params, plan, selectedQuote } = await planned(50n);
    const { plan: otherPlan } = await planned(51n);
    const other = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, otherPlan));
    const check = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, plan));
    const { run, posted } = await relay(params);
    try {
      await run();
    } finally {
      other.release();
      check.release();
    }
    expect(posted).toHaveLength(1);
    expect(other.outputs()).toBeNull();
    expect(check.outputs()).not.toBeNull();
  });

  test('two requests sharing a signature and outputs each take their own plan', async () => {
    const { params, plan, selectedQuote } = await planned(50n);
    const first = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, plan));
    const second = expectTransferRelay(transferRelayExpectation(selectedQuote, inputs.length, plan));
    try {
      await (await relay(params)).run();
      await (await relay(params)).run();
    } finally {
      first.release();
      second.release();
    }
    expect(first.outputs()).not.toBeNull();
    expect(second.outputs()).not.toBeNull();
  });

  test('a transfer relay with no plan armed is refused', async () => {
    const { params } = await planned(50n);
    const { run, posted } = await relay(params);
    await expect(run()).rejects.toThrow(TRANSFER_PLAN_MISMATCH_MESSAGE);
    expect(posted).toHaveLength(0);
  });

  test('other relay methods pass through', () => {
    expect(() => checkTransferRelay('relayWithdrawal', {})).not.toThrow();
  });
});
