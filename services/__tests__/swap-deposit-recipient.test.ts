import { beforeAll, describe, expect, test } from 'bun:test';
import {
  AddressSchema,
  CryptoService,
  EMPTY_ADDRESS,
  EvmAddressEqualityComparator,
  NATIVE_ASSET_ADDRESS,
  NoteComputationService,
  PoolSessionSwapDeposit,
  PoseidonHashService,
} from '@privacy-pools-v2/sdk';

import {
  decryptBlindDepositBackup,
  splitNoteData,
  type BackupCryptoLike,
  type BackupNoteComputationLike,
} from '../blind-deposit-backup';
import {
  commitmentKey,
  swapDepositRecipient,
  SwapRecipientBackupMismatch,
  type BuiltClaimNote,
} from '../swap-deposit-recipient';

// DEV-489. The note the builder is handed is computed here exactly as the
// SDK's deposit pipeline computes it (PoolSessionDeposit.prepareDepositInternal:
// precommitment -> label -> commitment), with the REAL services the vendored
// SDK ships, so "the backup names the committed note" is checked against the
// same hashes the proof will bind.

type Hex = `0x${string}`;

const RECIPIENT = '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308' as Hex;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Hex;
const SHARE = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6' as Hex;

let crypto: CryptoService;
let ncs: NoteComputationService;
let senderViewPriv: Hex;
let senderViewPub: Hex;

beforeAll(async () => {
  const hashService = await PoseidonHashService.create();
  crypto = new CryptoService();
  ncs = new NoteComputationService({ hashService, cryptoService: crypto });
  const pair = crypto.generateEphemeralKeyPair();
  senderViewPriv = pair.privateKey as Hex;
  senderViewPub = pair.publicKey as Hex;
});

function blindMaterial() {
  const noteSecret = crypto.generateSecret() as Hex;
  const depositSecret = crypto.generateSecret() as Hex;
  const noteAddressHash = ncs.computeNoteAddressHash(RECIPIENT, noteSecret) as Hex;
  return {
    noteSecret,
    depositSecret,
    noteAddressHash,
    blind: {
      noteSecret,
      depositSecret,
      senderViewingPubKey: senderViewPub,
      noteAddressHash,
      noteComputation: ncs as unknown as BackupNoteComputationLike,
      crypto: crypto as unknown as BackupCryptoLike,
      randomFill: (out: Uint8Array) => { globalThis.crypto.getRandomValues(out as unknown as Uint8Array<ArrayBuffer>); },
    },
  };
}

/** The NoteDataBuilderInput the SDK passes, built the way the SDK builds it. */
function sdkNote(noteAddressHash: Hex, depositSecret: Hex, tokenId: Hex, value: Hex) {
  const precommitment = ncs.computePrecommitment(noteAddressHash, tokenId, value);
  const label = ncs.computeLabel(precommitment, depositSecret) as Hex;
  const commitment = ncs.computeFullCommitment({ noteAddressHash, tokenId, value, label }) as Hex;
  return { tokenId, value, noteAddressHash, depositSecret, label, commitment };
}

describe('swapDepositRecipient (DEV-489)', () => {
  test('a registered recipient is the discoverable form, by address', () => {
    expect(swapDepositRecipient({ recipient: RECIPIENT, blind: null })).toEqual({
      discoveryData: { evmAddress: RECIPIENT },
    });
  });

  test('blind: the builder returns a backup the SENDER recovers, naming the committed note', () => {
    const m = blindMaterial();
    const seen: [string, BuiltClaimNote][] = [];
    const r = swapDepositRecipient({ recipient: RECIPIENT, blind: m.blind, onNote: (k, n) => seen.push([k, n]) });
    if (!('noteAddressHash' in r) || typeof r.noteData !== 'function') throw new Error('expected the blind form with a builder');
    expect(r.noteAddressHash).toBe(m.noteAddressHash);
    expect(r.depositSecret).toBe(m.depositSecret);

    // A yield pool: the SDK sized 990000 shares of the share token, not the typed budget.
    const note = sdkNote(m.noteAddressHash, m.depositSecret, SHARE, '0xf1b30');
    const noteData = r.noteData(note);
    const split = splitNoteData(noteData.data);
    if (!split) throw new Error('unsplittable');
    const payload = decryptBlindDepositBackup({
      ephemeralPubKey: split.ephemeralPubKey,
      encryptedPayload: split.encryptedPayload,
      viewingPrivateKey: senderViewPriv,
      crypto: crypto as unknown as BackupCryptoLike,
    });
    expect(payload).not.toBeNull();
    expect(BigInt(payload!.value)).toBe(990_000n);
    expect(payload!.tokenId).toBe(SHARE.toLowerCase());
    expect(BigInt(payload!.label)).toBe(BigInt(note.label));
    expect(BigInt(payload!.noteSecret)).toBe(BigInt(m.noteSecret));
    // The claim record is keyed by the commitment the route will sign.
    expect(seen).toEqual([[commitmentKey(note.commitment), { tokenId: SHARE.toLowerCase() as Hex, value: '0xf1b30', label: note.label, commitment: note.commitment }]]);
  });

  test('each re-prepared value gets its own backup and record', () => {
    const m = blindMaterial();
    const seen = new Map<string, BuiltClaimNote>();
    const r = swapDepositRecipient({ recipient: RECIPIENT, blind: m.blind, onNote: (k, n) => { seen.set(k, n); } });
    if (!('noteAddressHash' in r) || typeof r.noteData !== 'function') throw new Error('expected a builder');
    const first = sdkNote(m.noteAddressHash, m.depositSecret, USDT, '0xf4240');
    const refit = sdkNote(m.noteAddressHash, m.depositSecret, USDT, '0xf0000');
    r.noteData(first);
    r.noteData(refit);
    expect(seen.get(commitmentKey(first.commitment))?.value).toBe('0xf4240');
    expect(seen.get(commitmentKey(refit.commitment))?.value).toBe('0xf0000');
  });

  test('a note the backup does not reproduce is refused and never recorded', () => {
    const m = blindMaterial();
    const seen: unknown[] = [];
    const r = swapDepositRecipient({ recipient: RECIPIENT, blind: m.blind, onNote: (k) => seen.push(k) });
    if (!('noteAddressHash' in r) || typeof r.noteData !== 'function') throw new Error('expected a builder');
    const build = r.noteData as (n: unknown) => unknown;
    const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return null; };
    const note = sdkNote(m.noteAddressHash, m.depositSecret, USDT, '0xf4240');
    expect(thrown(() => build({ ...note, label: `0x${'12'.repeat(32)}` }))).toBeInstanceOf(SwapRecipientBackupMismatch);
    // Another deposit secret means another label: also not this backup's note.
    const other = sdkNote(m.noteAddressHash, crypto.generateSecret() as Hex, USDT, '0xf4240');
    expect(thrown(() => build(other))).toBeInstanceOf(SwapRecipientBackupMismatch);
    expect(seen).toEqual([]);
  });

  test('commitmentKey ignores hex spelling', () => {
    expect(commitmentKey('0x00ABc')).toBe(commitmentKey('0xabc'));
  });
});

describe('the vendored SDK routes these recipients to depositFor', () => {
  // The real PoolSessionSwapDeposit from the pinned tarball: its schema runs
  // first, then the embedded deposit is prepared through the delegate. A fake
  // delegate records which method the SDK picked and stops the flow there.
  const STOP = new Error('stop after the deposit prepare');
  function harness() {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const record = (method: string) => async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      throw STOP;
    };
    const session = new PoolSessionSwapDeposit({
      ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chainId: 56,
      depositDelegate: { prepareDeposit: record('prepareDeposit'), prepareDepositFor: record('prepareDepositFor') },
      swapAndDepositQuoteProvider: {},
      entrypointInteractor: {},
      rpcInteractor: {},
      noteManager: {},
      poolVaultInteractor: {},
      relaySwapsAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      nativeAssetAddress: NATIVE_ASSET_ADDRESS,
      emptyAddress: EMPTY_ADDRESS,
      addressEqualityComparator: new EvmAddressEqualityComparator(),
      addressSchema: AddressSchema,
      swapChainAdapter: {},
    } as never);
    return { session, calls };
  }
  const base = {
    fromChainId: 56,
    inputToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    depositToken: USDT,
    depositAmount: '0xf4240',
  };

  test('both forms reach prepareDepositFor with the recipient spread in', async () => {
    const m = blindMaterial();
    for (const recipient of [
      swapDepositRecipient({ recipient: RECIPIENT, blind: null }),
      swapDepositRecipient({ recipient: RECIPIENT, blind: m.blind }),
    ]) {
      const { session, calls } = harness();
      await expect(session.prepareSwapAndDeposit({ ...base, recipient } as never)).rejects.toBe(STOP);
      expect(calls.map((c) => c.method)).toEqual(['prepareDepositFor']);
      expect(calls[0].params).toMatchObject({ tokenId: USDT, value: '0xf4240', ...recipient });
    }
  });

  test('no recipient is the owner\'s own prepareDeposit, as before', async () => {
    const { session, calls } = harness();
    await expect(session.prepareSwapAndDeposit(base as never)).rejects.toBe(STOP);
    expect(calls).toEqual([{ method: 'prepareDeposit', params: { tokenId: USDT, value: '0xf4240' } }]);
  });

  test('a recipient naming both forms is refused before anything is prepared', async () => {
    const { session, calls } = harness();
    const recipient = { noteAddressHash: `0x${'11'.repeat(32)}`, discoveryData: { evmAddress: RECIPIENT } };
    await expect(session.prepareSwapAndDeposit({ ...base, recipient } as never)).rejects.toMatchObject({ name: 'InvalidSwapAndDepositParams' });
    expect(calls).toEqual([]);
  });
});
