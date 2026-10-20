import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildDepositWitness,
  calculateNoteAddressHash,
  calculatePrecommitment,
  calculateDepositLabel,
  calculateNoteCommitment,
  computeDepositContext,
  addressToU256,
} from '@/services/sui-witness/witness';
import {
  upsertSuiNote,
  loadSuiNotes,
  markSuiNotesSpent,
} from '@/services/sui-witness/note-store';
import { SDK_AVAILABLE, loadSdkCrypto } from './helpers/sdk';
import { FIX, installLocalStorage } from './helpers/fixtures';

/**
 * FLOW 1 — DEPOSIT (Sui).
 *
 * Covers the pre-submission artifacts the deposit modal -> use-sui-session
 * deposit() path produces: the native-deposit witness (commitment / label /
 * precommitment / context), the min-amount guard, and owner-namespaced note
 * persistence. Live submission (real Groth16 + entrypoint::deposit) is covered
 * by the Node live scripts (scripts/live-deposit-smoke), not here.
 */
describe('deposit witness', () => {
  it('derives commitment/label/precommitment/context from raw note fields', async () => {
    const noteHint = new Uint8Array([1, 2, 3]);
    const noteData = new Uint8Array([4, 5, 6, 7]);

    const dep = await buildDepositWitness({
      value: FIX.value,
      tokenId: FIX.tokenId,
      noteSecret: FIX.noteSecret,
      depositSecret: FIX.depositSecret,
      ownerAddress: FIX.ownerField,
      noteHint,
      noteData,
    });

    // Independently recompute the expected derived values from the documented
    // V1-style note crypto (the circuits' NoteCommitment helper).
    const nah = await calculateNoteAddressHash(FIX.ownerField, FIX.noteSecret);
    const precommit = await calculatePrecommitment(nah, FIX.tokenId, FIX.value, 0n);
    const label = await calculateDepositLabel(precommit, FIX.depositSecret);
    const commitment = await calculateNoteCommitment(nah, FIX.tokenId, FIX.value, 0n, label);
    const ctx = computeDepositContext(noteHint, noteData);

    expect(dep.precommitment).toBe(precommit);
    expect(dep.label).toBe(label);
    expect(dep.commitment).toBe(commitment);
    expect(dep.context).toBe(ctx);

    // The circuit inputs carry the right derived signals (Deposit.circom names).
    expect(BigInt(dep.inputs.noteAddressHash as string)).toBe(nah);
    expect(BigInt(dep.inputs.context as string)).toBe(ctx);
    expect(dep.inputs.tokenId).toBe(FIX.tokenId.toString());
    expect(dep.inputs.value).toBe(FIX.value.toString());
    expect(dep.inputs.depositSecret).toBe(FIX.depositSecret.toString());
  });

  it('defaults context to the empty-hint/empty-data binding', async () => {
    const dep = await buildDepositWitness({
      value: FIX.value,
      tokenId: FIX.tokenId,
      noteSecret: FIX.noteSecret,
      depositSecret: FIX.depositSecret,
      ownerAddress: FIX.ownerField,
    });
    expect(dep.context).toBe(computeDepositContext(new Uint8Array(0), new Uint8Array(0)));
    expect(dep.noteHint.length).toBe(0);
    expect(dep.noteData.length).toBe(0);
  });

  it('REJECTS a zero (min_amount=0) deposit value before any proof work', async () => {
    await expect(
      buildDepositWitness({
        value: 0n,
        tokenId: FIX.tokenId,
        noteSecret: FIX.noteSecret,
        depositSecret: FIX.depositSecret,
        ownerAddress: FIX.ownerField,
      }),
    ).rejects.toThrow(/value must be > 0/);
  });

  it('REJECTS a negative deposit value', async () => {
    await expect(
      buildDepositWitness({
        value: -1n,
        tokenId: FIX.tokenId,
        noteSecret: FIX.noteSecret,
        depositSecret: FIX.depositSecret,
        ownerAddress: FIX.ownerField,
      }),
    ).rejects.toThrow(/value must be > 0/);
  });

  // Folds in the spirit of sui-witness-crosscheck.mjs: the PORT must agree with
  // the SDK (source of truth) on the on-chain-binding values.
  describe.skipIf(!SDK_AVAILABLE)('SDK cross-check', () => {
    it('matches the SDK commitment/label/context for identical inputs', async () => {
      const sdk = await loadSdkCrypto();
      const noteHint = new Uint8Array([1, 2, 3]);
      const noteData = new Uint8Array([4, 5, 6, 7]);

      const dep = await buildDepositWitness({
        value: FIX.value,
        tokenId: FIX.tokenId,
        noteSecret: FIX.noteSecret,
        depositSecret: FIX.depositSecret,
        ownerAddress: FIX.ownerField,
        noteHint,
        noteData,
      });

      const nah = await sdk.calculateNoteAddressHash(FIX.ownerField, FIX.noteSecret);
      const precommit = await sdk.calculatePrecommitment(nah, FIX.tokenId, FIX.value, 0n);
      const label = await sdk.calculateDepositLabel(precommit, FIX.depositSecret);
      const commitment = await sdk.calculateNoteCommitment(nah, FIX.tokenId, FIX.value, 0n, label);
      const ctx = sdk.computeDepositContext(Buffer.from(noteHint), Buffer.from(noteData));

      expect(dep.precommitment).toBe(precommit);
      expect(dep.label).toBe(label);
      expect(dep.commitment).toBe(commitment);
      expect(dep.context).toBe(ctx);
    });
  });
});

describe('deposit note persistence (owner-namespaced)', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it('persists the note under the owner namespace and is recoverable', async () => {
    const owner = '0xAbC123';
    const dep = await buildDepositWitness({
      value: FIX.value,
      tokenId: FIX.tokenId,
      noteSecret: FIX.noteSecret,
      depositSecret: FIX.depositSecret,
      ownerAddress: addressToU256(owner.startsWith('0x') ? owner : `0x${owner}`),
    });

    upsertSuiNote(owner, {
      commitment: dep.commitment.toString(),
      value: FIX.value.toString(),
      tokenId: FIX.tokenId.toString(),
      label: dep.label.toString(),
      noteSecret: FIX.noteSecret.toString(),
      depositSecret: FIX.depositSecret.toString(),
      ownerAddress: addressToU256('0xabc123').toString(),
      coinType: '0x2::sui::SUI',
      status: 'active',
      txDigest: 'DIGEST1',
    });

    const notes = loadSuiNotes(owner);
    expect(notes).toHaveLength(1);
    expect(notes[0].commitment).toBe(dep.commitment.toString());
    expect(notes[0].status).toBe('active');
    expect(notes[0].txDigest).toBe('DIGEST1');
  });

  it('namespaces by owner so two accounts never collide', async () => {
    const store = installLocalStorage();
    const a = '0xAAAA';
    const b = '0xBBBB';
    upsertSuiNote(a, baseNote('111'));
    upsertSuiNote(b, baseNote('222'));

    expect(loadSuiNotes(a).map((n) => n.commitment)).toEqual(['111']);
    expect(loadSuiNotes(b).map((n) => n.commitment)).toEqual(['222']);

    // Distinct, lower-cased storage keys per owner (F11 namespacing).
    const keys = store.rawKeys();
    expect(keys).toContain('ppv2_sui_notes_0xaaaa');
    expect(keys).toContain('ppv2_sui_notes_0xbbbb');
  });

  it('upserts by commitment (re-running discovery never duplicates)', () => {
    const owner = '0xCCCC';
    upsertSuiNote(owner, baseNote('777'));
    upsertSuiNote(owner, { ...baseNote('777'), txDigest: 'D2' });
    const notes = loadSuiNotes(owner);
    expect(notes).toHaveLength(1);
    expect(notes[0].txDigest).toBe('D2');
  });

  it('marks notes spent without losing the secrets', () => {
    const owner = '0xDDDD';
    upsertSuiNote(owner, baseNote('888'));
    markSuiNotesSpent(owner, ['888']);
    const notes = loadSuiNotes(owner);
    expect(notes[0].status).toBe('spent');
    expect(notes[0].noteSecret).toBe('11');
  });
});

function baseNote(commitment: string) {
  return {
    commitment,
    value: '1000',
    tokenId: '9999',
    label: '5',
    noteSecret: '11',
    ownerAddress: '12345',
    coinType: '0x2::sui::SUI',
    status: 'active' as const,
  };
}
