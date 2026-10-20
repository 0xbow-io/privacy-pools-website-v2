import { describe, it, expect } from 'vitest';
import {
  buildTransactWitness,
  computeTransactContext,
  addressToBytes32,
  encodePayoutRouting,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateTimestampedLeaf,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
} from '@/services/sui-witness/witness';
import {
  getRoot,
  generateProof,
  indexOf,
  createTreeWithLeaves as createTree,
} from '@/services/sui-witness/merkle';

/**
 * Relayed-withdraw context binding (audit bug #1 fix).
 *
 * The bug: `use-sui-session.transferOrWithdraw` always bound the DIRECT context
 * (processor = 0x0, empty processor_data), so a RELAYED withdrawal's proof did
 * not carry the relayer/payout binding the relayer recomputes on-chain
 * (relay::relay_withdrawal) -> E_INVALID_PROOF.
 *
 * The fix adds `relayedWithdraw`, which feeds the SuiTransact witness with
 *   processor      = relayer signer (addressToBytes32)
 *   processor_data = encodePayoutRouting(recipient, feeRecipient, feeAmount)
 *
 * These tests exercise the SAME witness path the session feeds and assert the
 * proof binds the RELAYER context, not the 0x0 one.
 */

const OWNER = 12345678901234567890n;
const TOKEN = 9999n;
const NK = 33333333333333n;
const VALUE = 1_000_000n;
const NOTE_SECRET = 11111111111111n;
const LABEL = 5555555n;
const TS = 1_700_000_000n;

const RELAYER = '0x00000000000000000000000000000000000000000000000000000000000000aa';
const RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000bb';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000cc';
const FEE = 1234n;

/** Build a 1-input/1-output withdraw scenario with real Merkle proofs. */
async function buildWithdrawScenario() {
  const nah = await calculateNoteAddressHash(OWNER, NOTE_SECRET);
  const commitment = await calculateNoteCommitment(nah, TOKEN, VALUE, 0n, LABEL);
  const leaf = await calculateTimestampedLeaf(commitment, TS);
  const stateTree = await createTree([leaf, 424242n]);
  const stateProof = generateProof(stateTree, 0);

  const labelHash = await calculateLabelHash(LABEL);
  const aspTree = await createTree([labelHash, 999n]);
  const aspProof = generateProof(aspTree, indexOf(aspTree, labelHash));

  const nkHash = await calculateNullifyingKeyHash(NK);
  const authDigest = await computeAuthDigestDirectKey(NK);
  const ksLeaf = await calculateKeystoreLeaf(OWNER, nkHash, authDigest);
  const ksTree = await createTree([ksLeaf, 1234n]);
  const ksProof = generateProof(ksTree, 0);

  // Full-value withdrawal: amountOut = VALUE, one zero-value change output (a
  // transact requires >= 1 output). Conserves value: in == amountOut + out.
  return {
    inputNotes: [
      { value: VALUE, tokenId: TOKEN, label: LABEL, noteSecret: NOTE_SECRET, ownerAddress: OWNER, timestamp: TS, leafIndex: 0 },
    ],
    outputNotes: [
      { value: 0n, tokenId: TOKEN, label: LABEL, noteSecret: 88888888n, ownerAddress: OWNER },
    ],
    stateRoot: getRoot(stateTree),
    keystoreRoot: getRoot(ksTree),
    aspRoot: getRoot(aspTree),
    stateMerkleProofs: [stateProof],
    keystoreMerkleProof: ksProof,
    aspMerkleProofs: [aspProof],
  };
}

describe('relayed-withdraw context binding (witness layer)', () => {
  it('the relayed witness binds context = computeTransactContext(relayer, payoutRouting)', async () => {
    const scen = await buildWithdrawScenario();

    const processorBytes = addressToBytes32(RELAYER);
    const processorData = encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);

    const w = await buildTransactWitness({
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: VALUE,
      tokenIdOut: TOKEN,
      // Plain wrapper (no encryption) keeps this fast + deterministic; the
      // context binding is independent of the GVK path.
      gvkEnabled: false,
      gvk: [0n, 0n],
      encryptionRandomness: 0n,
      processorBytes,
      processorData,
      noteHints: [],
      noteData: [],
    });

    // 1. processor_data is EXACTLY the 72-byte payout routing.
    expect(processorData).toHaveLength(72);
    expect(processorData).toEqual(encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE));

    // 2. The proof binds the RELAYER context (the relayer recomputes this same
    //    value from ctx.sender()+processor_data on-chain).
    const expectedRelayerCtx = computeTransactContext(processorBytes, processorData, [], []);
    expect(w.context).toBe(expectedRelayerCtx);

    // 3. It is NOT the old, buggy direct (0x0) context.
    const directCtx = computeTransactContext(new Uint8Array(32), new Uint8Array(0), [], []);
    expect(w.context).not.toBe(directCtx);

    // 4. The circuit input echoes the same context (what gets proven).
    expect(w.inputs.context).toBe(expectedRelayerCtx.toString());
  });

  it('changing the recipient changes the bound context (relayer cannot redirect payout)', async () => {
    const scen = await buildWithdrawScenario();
    const processorBytes = addressToBytes32(RELAYER);

    const base = await buildTransactWitness({
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: VALUE,
      tokenIdOut: TOKEN,
      gvkEnabled: false,
      gvk: [0n, 0n],
      encryptionRandomness: 0n,
      processorBytes,
      processorData: encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE),
    });

    const redirected = await buildTransactWitness({
      ...scen,
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: VALUE,
      tokenIdOut: TOKEN,
      gvkEnabled: false,
      gvk: [0n, 0n],
      encryptionRandomness: 0n,
      processorBytes,
      processorData: encodePayoutRouting(
        '0x00000000000000000000000000000000000000000000000000000000000000de',
        FEE_RECIPIENT,
        FEE,
      ),
    });

    expect(base.context).not.toBe(redirected.context);
  });
});
