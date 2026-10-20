import { describe, it, expect } from 'vitest';
import {
  buildRagequitWitness,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateNullifierHash,
  RagequitAddresslessNoteError,
} from '@/services/sui-witness/witness';
import { KEYSTORE_MAX_DEPTH } from '@/services/sui-witness/constants';
import type { MerkleProof } from '@/services/sui-witness/merkle';
import { SDK_AVAILABLE, loadSdkCrypto } from './helpers/sdk';

/**
 * FLOW 4 — RAGEQUIT (emergency single-note exit; exposes the label).
 *
 * The ragequit witness proves keystore membership + note ownership. We assert the
 * derived nullifier/commitment, the keystore-siblings padding to the circuit max,
 * and cross-check against the SDK. We also surface the dropped client-side guard
 * the UI-flow audit flagged (bug #6).
 */

const OWNER = 12345678901234567890n;
const TOKEN = 9999n;
const VALUE = 1_000_000n;
const NOTE_SECRET = 11111111111111n;
const NK = 33333333333333n;
const LABEL = 7777777n;

const KS_PROOF: MerkleProof = { root: 4242n, leaf: 0n, index: 0, siblings: [], pathIndices: [] };

describe('ragequit witness', () => {
  it('derives the nullifier hash + commitment from the note fields', async () => {
    const rq = await buildRagequitWitness({
      note: { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: OWNER },
      keystoreRoot: 4242n,
      ownerAddress: OWNER,
      keystoreMerkleProof: KS_PROOF,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
    });

    const nah = await calculateNoteAddressHash(OWNER, NOTE_SECRET);
    const commitment = await calculateNoteCommitment(nah, TOKEN, VALUE, 0n, LABEL);
    const nh = await calculateNullifierHash(NK, commitment);

    expect(rq.commitment).toBe(commitment);
    expect(rq.nullifierHash).toBe(nh);

    // Ragequit signals (Ragequit.circom): label is EXPOSED (public), metadata 0.
    expect(rq.inputs.label).toBe(LABEL.toString());
    expect(rq.inputs.metadata).toBe('0');
    expect(rq.inputs.ownerAddress).toBe(OWNER.toString());
    // keystore siblings padded to the circuit max; real depth passed separately.
    expect((rq.inputs.keystoreSiblings as string[])).toHaveLength(KEYSTORE_MAX_DEPTH);
    expect(rq.inputs.keystoreTreeDepth).toBe('0');
  });

  describe.skipIf(!SDK_AVAILABLE)('SDK cross-check', () => {
    it('matches the SDK commitment + nullifier hash', async () => {
      const sdk = await loadSdkCrypto();
      const rq = await buildRagequitWitness({
        note: { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: OWNER },
        keystoreRoot: 4242n,
        ownerAddress: OWNER,
        keystoreMerkleProof: KS_PROOF,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
      });
      const nah = await sdk.calculateNoteAddressHash(OWNER, NOTE_SECRET);
      const commitment = await sdk.calculateNoteCommitment(nah, TOKEN, VALUE, 0n, LABEL);
      expect(rq.commitment).toBe(commitment);
      expect(rq.nullifierHash).toBe(await sdk.calculateNullifierHash(NK, commitment));
    });
  });

  it('FIXED (audit #6): rejects an addressless (owner=0) note BEFORE proving', async () => {
    // The SDK rejects owner-0 notes before proving (sdk ragequit-addressless test).
    // The port now mirrors that guard: an addressless / payment-key note binds the
    // zero owner on-chain and the pool pays the proof's ownerAddress, which 0 can
    // never satisfy — fail clearly with a typed error instead of building a
    // witness that only fails opaquely on-chain.
    await expect(
      buildRagequitWitness({
        note: { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: 0n },
        keystoreRoot: 4242n,
        ownerAddress: 0n,
        keystoreMerkleProof: KS_PROOF,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
      }),
    ).rejects.toThrow(RagequitAddresslessNoteError);
  });

  it('the addressless guard fires when the NOTE owner is 0 even if a payout owner is given', async () => {
    // The note's bound owner (in the commitment) is what cannot satisfy the
    // payout; reject regardless of the proof-side ownerAddress.
    await expect(
      buildRagequitWitness({
        note: { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: 0n },
        keystoreRoot: 4242n,
        ownerAddress: OWNER, // non-zero payout owner, but the note owner is 0
        keystoreMerkleProof: KS_PROOF,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
      }),
    ).rejects.toThrow(/addressless|cannot ragequit/i);
  });

  it('a normal owned (non-zero owner) note is NOT tripped by the guard', async () => {
    const rq = await buildRagequitWitness({
      note: { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: OWNER },
      keystoreRoot: 4242n,
      ownerAddress: OWNER,
      keystoreMerkleProof: KS_PROOF,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
    });
    expect(rq.commitment).toBeGreaterThan(0n);
    expect(rq.inputs.ownerAddress).toBe(OWNER.toString());
  });
});
