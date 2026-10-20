import { describe, it, expect } from 'vitest';
import {
  buildTransactWitness,
  decryptNote,
  deriveGlobalViewKeyPubKey,
  createTreeWithLeaves,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateTimestampedLeaf,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
} from '@/services/sui-witness/witness';
import { getRoot, generateProof, indexOf } from '@/services/sui-witness/merkle';
import { getSuiCircuitUrls } from '@/config/sui-circuits';

/**
 * GVK binding (Flow 2/3): the transact witness must bind the LIVE pool GVK (read
 * from chain via chain-reader.getPoolGvk), select the GVK-vs-plain wrapper from
 * the live `pool.gvk_enabled` flag, and emit the right ciphertext shape:
 *   - gvk_enabled=true  -> ciphertext length 2 + 5*M, encrypted to pool.gvk,
 *                          GVK wrapper artifact `transact_NxM` (proof_type 1).
 *   - gvk_enabled=false -> EMPTY ciphertext, plain wrapper `transact_plain_NxM`
 *                          (proof_type 3, PROOF_TYPE_TRANSACT_PLAIN).
 *
 * Live proof + submit is covered by the Node live scripts; here we assert the
 * pre-submission artifacts (ciphertext + circuit selection).
 */

const OWNER = 12345678901234567890n;
const TOKEN = 9999n;
const NK = 33333333333333n;
const VALUE = 1_000_000n;
const NOTE_SECRET = 11111111111111n;
const LABEL = 5555555n;
const TS = 1_700_000_000n;

/** Build a minimal 1-input scenario with real Merkle proofs for the witness. */
async function build1x1(outputCount = 1) {
  const nah = await calculateNoteAddressHash(OWNER, NOTE_SECRET);
  const commitment = await calculateNoteCommitment(nah, TOKEN, VALUE, 0n, LABEL);
  const leaf = await calculateTimestampedLeaf(commitment, TS);
  const stateTree = await createTreeWithLeaves([leaf, 424242n]);
  const stateProof = generateProof(stateTree, 0);

  const labelHash = await calculateLabelHash(LABEL);
  const aspTree = await createTreeWithLeaves([labelHash, 999n]);
  const aspProof = generateProof(aspTree, indexOf(aspTree, labelHash));

  const nkHash = await calculateNullifyingKeyHash(NK);
  const authDigest = await computeAuthDigestDirectKey(NK);
  const ksLeaf = await calculateKeystoreLeaf(OWNER, nkHash, authDigest);
  const ksTree = await createTreeWithLeaves([ksLeaf, 1234n]);
  const ksProof = generateProof(ksTree, 0);

  // Outputs split the value across `outputCount` notes (conserves value).
  const per = VALUE / BigInt(outputCount);
  const outputNotes = Array.from({ length: outputCount }, (_, j) => ({
    value: j === outputCount - 1 ? VALUE - per * BigInt(outputCount - 1) : per,
    tokenId: TOKEN,
    label: LABEL,
    noteSecret: 88888888n + BigInt(j),
    ownerAddress: 24681357n + BigInt(j),
  }));

  return {
    inputNotes: [
      { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: OWNER, timestamp: TS, leafIndex: 0 },
    ],
    outputNotes,
    stateRoot: getRoot(stateTree),
    keystoreRoot: getRoot(ksTree),
    aspRoot: getRoot(aspTree),
    stateMerkleProofs: [stateProof],
    keystoreMerkleProof: ksProof,
    aspMerkleProofs: [aspProof],
  };
}

describe('GVK-enabled path', () => {
  it('emits a ciphertext of length 2 + 5*M encrypted to the chain-read pool GVK', async () => {
    // The "chain-read" GVK (NOT a stale constant): derive a fresh key pair and
    // thread its public point through as the live pool.gvk().
    const gvkPriv = 42n;
    const gvk = await deriveGlobalViewKeyPubKey(gvkPriv);
    const M = 2;
    const scen = await build1x1(M);

    const w = await buildTransactWitness({
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: 0n,
      tokenIdOut: 0n,
      gvkEnabled: true,
      gvk: [gvk[0], gvk[1]],
      encryptionRandomness: 7n,
      processorBytes: new Uint8Array(32),
    });

    // Ciphertext shape: [ephX, ephY, (enc_0..4 per output)].
    expect(w.ciphertext).toHaveLength(2 + 5 * M);

    // The blob decrypts (with the matching private key) back to the output note —
    // i.e. it was encrypted to the GVK we passed, not a hardcoded/stale one.
    const blob = w.ciphertext;
    const dec0 = await decryptNote(
      gvkPriv,
      blob[0],
      blob[1],
      {
        encValue: blob[2],
        encTokenId: blob[3],
        encLabel: blob[4],
        encOwnerAddress: blob[5],
        encNoteSecret: blob[6],
      },
      0,
    );
    expect(dec0.value).toBe(scen.outputNotes[0].value);
    expect(dec0.ownerAddress).toBe(scen.outputNotes[0].ownerAddress);
    expect(dec0.noteSecret).toBe(scen.outputNotes[0].noteSecret);

    // GVK signals present on the GVK wrapper (proof_type 1).
    expect(w.inputs.gvkX).toBe(gvk[0].toString());
    expect(w.inputs.gvkY).toBe(gvk[1].toString());
    expect(w.inputs.encryptionRandomness).toBe('7');
  });

  it('does NOT bind to a stale constant: a different GVK yields a different ciphertext', async () => {
    const scen = await build1x1(1);
    const gvkA = await deriveGlobalViewKeyPubKey(42n);
    const gvkB = await deriveGlobalViewKeyPubKey(43n);
    const common = {
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: 0n,
      tokenIdOut: 0n,
      gvkEnabled: true,
      encryptionRandomness: 7n,
      processorBytes: new Uint8Array(32),
    };
    const wA = await buildTransactWitness({ ...common, gvk: [gvkA[0], gvkA[1]] });
    const wB = await buildTransactWitness({ ...common, gvk: [gvkB[0], gvkB[1]] });
    // Shared-secret differs -> ciphertext differs (proves the witness binds the
    // supplied GVK, not a constant baked into the module).
    expect(wA.ciphertext.slice(2)).not.toEqual(wB.ciphertext.slice(2));
  });

  it('selects the GVK wrapper artifact (transact_NxM, proof_type 1)', () => {
    const urls = getSuiCircuitUrls('transact', { n: 1, m: 1, gvkEnabled: true });
    expect(urls.wasmUrl).toContain('/transact_1x1/');
    expect(urls.wasmUrl).not.toContain('plain');
    expect(urls.zkeyUrl).toContain('/transact_1x1/groth16_pkey.zkey');
  });
});

describe('plain path (gvk_enabled = false)', () => {
  it('emits an EMPTY ciphertext and omits GVK signals (proof_type 3)', async () => {
    const scen = await build1x1(1);
    const w = await buildTransactWitness({
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: 0n,
      tokenIdOut: 0n,
      gvkEnabled: false,
      gvk: [0n, 0n],
      encryptionRandomness: 0n,
      processorBytes: new Uint8Array(32),
    });

    // Plain wrapper requires an EMPTY ciphertext (E_INVALID_CIPHERTEXT otherwise).
    expect(w.ciphertext).toEqual([]);
    // The plain wrapper declares no GVK signals; adding them would make snarkjs
    // reject the witness, so they must be absent.
    expect(w.inputs.gvkX).toBeUndefined();
    expect(w.inputs.gvkY).toBeUndefined();
    expect(w.inputs.encryptionRandomness).toBeUndefined();
  });

  it('selects the plain wrapper artifact (transact_plain_NxM, proof_type 3)', () => {
    const urls = getSuiCircuitUrls('transact', { n: 1, m: 1, gvkEnabled: false });
    expect(urls.wasmUrl).toContain('/transact_plain_1x1/');
    expect(urls.zkeyUrl).toContain('/transact_plain_1x1/groth16_pkey.zkey');
  });

  it('defaults to the GVK wrapper when gvkEnabled is unspecified (contract default)', () => {
    const urls = getSuiCircuitUrls('transact', { n: 1, m: 2 });
    expect(urls.wasmUrl).toContain('/transact_1x2/');
    expect(urls.wasmUrl).not.toContain('plain');
  });

  it('rejects configs whose artifacts are not shipped (fails loudly client-side)', () => {
    // Only transact_1x1 / transact_1x2 are staged under public/artifacts/sui;
    // anything else must throw here instead of 404ing at proving time.
    expect(() => getSuiCircuitUrls('transact', { n: 2, m: 3 })).toThrow(/not shipped/);
    expect(() => getSuiCircuitUrls('transact', { n: 6, m: 1 })).toThrow(/not shipped/);
    expect(() => getSuiCircuitUrls('transact', { n: 1 })).toThrow(/requires n and m/);
  });
});
