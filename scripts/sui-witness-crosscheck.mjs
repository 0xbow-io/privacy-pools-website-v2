/**
 * Cross-check the browser witness module (services/sui-witness, bundled to
 * /tmp/website-witness.mjs by esbuild) against the protocol SDK's authoritative
 * crypto for the SAME inputs. This catches field/encoding mismatches WITHOUT a
 * chain or proof: if the browser port computes the same commitment / label /
 * context / nullifier / ciphertext as the SDK, the witness will match the
 * on-chain contract + circuit.
 *
 * Run (from the website repo root):
 *   node scripts/sui-witness-crosscheck.mjs
 *
 * It bundles services/sui-witness/witness.ts on the fly via esbuild (externalizing
 * the WASM-backed circomlibjs / @zk-kit/lean-imt, which resolve from the website's
 * node_modules), then compares against the SDK imported by absolute path.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const bundlePath = join(repoRoot, 'services', 'sui-witness', '.crosscheck-bundle.mjs');

await build({
  entryPoints: [join(repoRoot, 'services', 'sui-witness', 'witness.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  // Keep WASM-backed deps external (resolve from website node_modules); inline
  // pure-JS deps (js-sha3) so their CJS interop is handled by esbuild.
  external: ['circomlibjs', '@zk-kit/lean-imt'],
});

// Bundle the reconstruction layer too (it imports chain-reader types only).
const reconstructBundle = join(repoRoot, 'services', 'sui-witness', '.crosscheck-reconstruct.mjs');
await build({
  entryPoints: [join(repoRoot, 'services', 'sui-witness', 'reconstruct.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: reconstructBundle,
  external: ['circomlibjs', '@zk-kit/lean-imt'],
});

// Browser port (bundled into the website tree so bare imports resolve).
const W = await import(bundlePath);
const R = await import(reconstructBundle);

// SDK (source of truth) — uses v1-style note crypto aliases, matching the circuits.
const SDK = '/Users/nh2/0xbow/ppv2-sui-v2-sync/sdk/src';
const sdkCrypto = await import(`${SDK}/crypto.mjs`);
const sdkGvk = await import(`${SDK}/global-view-key.mjs`);

let failures = 0;
function check(name, got, exp) {
  const g = typeof got === 'bigint' ? got : BigInt(got);
  const e = typeof exp === 'bigint' ? exp : BigInt(exp);
  if (g === e) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}\n    browser: ${g}\n    sdk:     ${e}`);
  }
}

function eqArr(name, got, exp) {
  assert.equal(got.length, exp.length, `${name} length`);
  for (let i = 0; i < got.length; i++) check(`${name}[${i}]`, got[i], exp[i]);
}

// Fixed test inputs (deterministic, in-field).
const ownerField = 12345678901234567890n;
const tokenId = 9999n;
const value = 1_000_000n;
const noteSecret = 11111111111111n;
const depositSecret = 22222222222222n;
const nullifyingKey = 33333333333333n;

console.log('=== DEPOSIT witness cross-check ===');
{
  const noteHint = new Uint8Array([1, 2, 3]);
  const noteData = new Uint8Array([4, 5, 6, 7]);

  const dep = await W.buildDepositWitness({
    value, tokenId, noteSecret, depositSecret,
    ownerAddress: ownerField, noteHint, noteData,
  });

  // SDK reference (v1-style, matches Deposit.circom).
  const nah = await sdkCrypto.calculateNoteAddressHash(ownerField, noteSecret);
  const precommit = await sdkCrypto.calculatePrecommitment(nah, tokenId, value, 0n);
  const label = await sdkCrypto.calculateDepositLabel(precommit, depositSecret);
  const commitment = await sdkCrypto.calculateNoteCommitment(nah, tokenId, value, 0n, label);
  const ctx = sdkCrypto.computeDepositContext(Buffer.from(noteHint), Buffer.from(noteData));

  check('precommitment', dep.precommitment, precommit);
  check('label', dep.label, label);
  check('commitment', dep.commitment, commitment);
  check('context', dep.context, ctx);
  // Sanity: circuit inputs carry the right derived signals.
  check('inputs.noteAddressHash', BigInt(dep.inputs.noteAddressHash), nah);
  check('inputs.context', BigInt(dep.inputs.context), ctx);
}

console.log('=== RAGEQUIT witness cross-check ===');
{
  const label = 7777777n;
  const rq = await W.buildRagequitWitness({
    note: { value, tokenId, label, noteSecret, ownerAddress: ownerField },
    keystoreRoot: 4242n,
    ownerAddress: ownerField,
    keystoreMerkleProof: { root: 4242n, leaf: 0n, index: 0, siblings: [], pathIndices: [] },
    privateNullifyingKey: nullifyingKey,
    privateRevocableKey: nullifyingKey,
  });

  const nah = await sdkCrypto.calculateNoteAddressHash(ownerField, noteSecret);
  const commitment = await sdkCrypto.calculateNoteCommitment(nah, tokenId, value, 0n, label);
  const nh = await sdkCrypto.calculateNullifierHash(nullifyingKey, commitment);

  check('rq.commitment', rq.commitment, commitment);
  check('rq.nullifierHash', rq.nullifierHash, nh);
}

console.log('=== TRANSACT (1x1) witness cross-check ===');
{
  // Build a state tree with one timestamped commitment leaf, ASP + keystore trees.
  const inLabel = 5555555n;
  const inTs = 1_000_000n;
  const nah = await sdkCrypto.calculateNoteAddressHash(ownerField, noteSecret);
  const inCommit = await sdkCrypto.calculateNoteCommitment(nah, tokenId, value, 0n, inLabel);
  const inLeaf = await sdkCrypto.calculateTimestampedLeaf(inCommit, inTs);

  // Browser trees (must equal SDK trees built with identical leaves).
  const stateTree = await W.createTreeWithLeaves([inLeaf, 424242n]);
  const stateProof = W.generateProof(stateTree, 0);

  const labelHash = await sdkCrypto.calculateLabelHash(inLabel);
  const aspTree = await W.createTreeWithLeaves([labelHash, 999n]);
  const aspProof = W.generateProof(aspTree, 0);

  const authDigest = await sdkCrypto.computeAuthDigestDirectKey(nullifyingKey);
  const nkHash = await W.calculateNullifyingKeyHash(nullifyingKey);
  const ksLeaf = await sdkCrypto.calculateKeystoreLeaf(ownerField, nkHash, authDigest);
  const ksTree = await W.createTreeWithLeaves([ksLeaf, 1234n]);
  const ksProof = W.generateProof(ksTree, 0);

  // GVK from the SDK (privKey=42) — matches the deployment scheme.
  const gvk = await sdkGvk.deriveGlobalViewKeyPubKey(42n);
  const encRand = 7n;

  // Output note (1x1, pure transfer: amountOut=0, single output = full value).
  const outSecret = 88888888n;
  const outOwner = 24681357n;

  const t = await W.buildTransactWitness({
    inputNotes: [{
      value, tokenId, label: inLabel, noteSecret,
      ownerAddress: ownerField, timestamp: inTs, leafIndex: 0,
    }],
    outputNotes: [{
      value, tokenId, label: inLabel, noteSecret: outSecret, ownerAddress: outOwner,
    }],
    ownerAddress: ownerField,
    privateNullifyingKey: nullifyingKey,
    privateRevocableKey: nullifyingKey,
    amountOut: 0n,
    tokenIdOut: 0n,
    stateRoot: stateTree.root,
    keystoreRoot: ksTree.root,
    aspRoot: aspTree.root,
    stateMerkleProofs: [stateProof],
    keystoreMerkleProof: ksProof,
    aspMerkleProofs: [aspProof],
    gvk: [gvk[0], gvk[1]],
    encryptionRandomness: encRand,
    processorBytes: new Uint8Array(32),
    processorData: new Uint8Array(0),
    noteHints: [],
    noteData: [],
  });

  // SDK references.
  const expNh = await sdkCrypto.calculateNullifierHash(nullifyingKey, inCommit);
  const outNah = await sdkCrypto.calculateNoteAddressHash(outOwner, outSecret);
  const expOutCommit = await sdkCrypto.calculateNoteCommitment(outNah, tokenId, value, 0n, inLabel);
  const expCtx = sdkCrypto.computeTransactContext(Buffer.alloc(32), Buffer.alloc(0), [], []);

  eqArr('transact.nullifierHashes', t.nullifierHashes, [expNh]);
  eqArr('transact.outputCommitments', t.outputCommitments, [expOutCommit]);
  check('transact.context', t.context, expCtx);

  // GVK ciphertext: browser blob must decrypt (with SDK) back to the output note.
  const blob = t.ciphertext; // [ephX, ephY, enc0..4]
  const dec = await sdkGvk.decryptNote(42n, blob[0], blob[1], {
    encValue: blob[2], encTokenId: blob[3], encLabel: blob[4],
    encOwnerAddress: blob[5], encNoteSecret: blob[6],
  }, 0);
  check('gvk.dec.value', dec.value, value);
  check('gvk.dec.tokenId', dec.tokenId, tokenId);
  check('gvk.dec.label', dec.label, inLabel);
  check('gvk.dec.ownerAddress', dec.ownerAddress, outOwner);
  check('gvk.dec.noteSecret', dec.noteSecret, outSecret);

  // Trees: browser roots must equal SDK-built roots for identical leaves.
  const sdkMerkle = await import(`${SDK}/merkle.mjs`);
  const sdkStateTree = await sdkMerkle.createTree();
  sdkMerkle.insertLeaves(sdkStateTree, [inLeaf, 424242n]);
  check('stateRoot (browser vs sdk LeanIMT)', stateTree.root, sdkMerkle.getRoot(sdkStateTree));

  // Per-leaf depth sanity (siblings length, not max depth).
  console.log(`  INFO state proof siblings length = ${stateProof.siblings.length} (per-leaf depth)`);
  console.log(`  INFO circuit stateTreeDepth signal = ${t.inputs.stateTreeDepth[0]}`);
  assert.equal(String(stateProof.siblings.length), t.inputs.stateTreeDepth[0], 'stateTreeDepth must be per-leaf siblings length');
}

console.log('=== RECONSTRUCTION (state/keystore/ASP) cross-check ===');
{
  // Build a realistic on-chain scenario in the SDK, expose it through a MOCK
  // chain reader, run the browser reconstruction, and assert it produces the
  // SAME roots + proofs the SDK would — WITHOUT a chain or proof. This verifies
  // the Merkle PORT (the piece the website was missing) end-to-end.
  const sdkMerkle = await import(`${SDK}/merkle.mjs`);

  // The note we will spend.
  const spendLabel = 13579246801n;
  const spendTs = 1_700_000_000n;
  const nah = await sdkCrypto.calculateNoteAddressHash(ownerField, noteSecret);
  const spendCommit = await sdkCrypto.calculateNoteCommitment(nah, tokenId, value, 0n, spendLabel);
  const spendLeaf = await sdkCrypto.calculateTimestampedLeaf(spendCommit, spendTs);

  // State tree: some prior leaves + our timestamped leaf + a later leaf.
  const priorLeaf = 11111n;
  const laterLeaf = 22222n;
  const stateLeaves = [priorLeaf, spendLeaf, laterLeaf];

  // SDK reference state tree + proof.
  const sdkState = await sdkMerkle.createTree();
  sdkMerkle.insertLeaves(sdkState, stateLeaves);
  const sdkStateRoot = sdkMerkle.getRoot(sdkState);
  const sdkStateProof = sdkMerkle.generateProof(sdkState, 1); // spendLeaf at index 1

  // Keystore tree: spender leaf + a filler. nkHash = Poseidon(NK),
  // authDigest = Poseidon(0, RK), ksLeaf = Poseidon(owner, nkHash, authDigest).
  const nkHash = await sdkCrypto.poseidonHashN([nullifyingKey]);
  const authDigest = await sdkCrypto.computeAuthDigestDirectKey(nullifyingKey);
  const ksLeaf = await sdkCrypto.poseidonHashN([ownerField, nkHash, authDigest]);
  const ksLeaves = [98765n, ksLeaf];
  const sdkKs = await sdkMerkle.createTree();
  sdkMerkle.insertLeaves(sdkKs, ksLeaves);
  const sdkKsRoot = sdkMerkle.getRoot(sdkKs);

  // ASP tree: our note's labelHash + a filler (the approved set).
  const labelHash = await sdkCrypto.calculateLabelHash(spendLabel);
  const aspFiller = await sdkCrypto.calculateLabelHash(424242n);
  const aspLeaves = [labelHash, aspFiller];
  const sdkAsp = await sdkMerkle.createTree();
  sdkMerkle.insertLeaves(sdkAsp, aspLeaves);
  const sdkAspRoot = sdkMerkle.getRoot(sdkAsp);

  // MOCK reader matching the SuiChainReader surface the reconstruction uses.
  const mockReader = {
    async getCommitmentTimestamp(c) {
      if (c !== spendCommit) throw new Error(`unexpected commitment ${c}`);
      return spendTs;
    },
    async reconstructStateLeaves() { return stateLeaves; },
    async reconstructKeystoreLeaves() { return ksLeaves; },
    async getPoolRootBuffer() { return [sdkStateRoot]; }, // root is "known"
    async getKeystoreCurrentRoot() { return sdkKsRoot; },
    async getLatestAspRoot() { return sdkAspRoot; },
  };

  const spendNote = {
    value, tokenId, label: spendLabel, noteSecret, ownerAddress: ownerField,
  };

  // STATE reconstruction.
  const stateRec = await R.reconstructStateProofs(mockReader, [spendNote]);
  check('reconstruct.stateRoot', stateRec.stateRoot, sdkStateRoot);
  check('reconstruct.state leafIndex', BigInt(stateRec.leafIndices[0]), 1n);
  check('reconstruct.state timestamp', stateRec.timestamps[0], spendTs);
  eqArr('reconstruct.state siblings', stateRec.proofs[0].siblings, sdkStateProof.siblings);
  // per-leaf depth must equal the SDK proof's siblings length.
  assert.equal(
    stateRec.proofs[0].siblings.length, sdkStateProof.siblings.length,
    'state per-leaf depth (siblings length) must match SDK',
  );

  // KEYSTORE reconstruction.
  const ksRec = await R.reconstructKeystoreProof(mockReader, ownerField, nullifyingKey, nullifyingKey);
  check('reconstruct.keystoreRoot', ksRec.keystoreRoot, sdkKsRoot);
  check('reconstruct.keystore leafIndex', BigInt(ksRec.leafIndex), 1n);

  // ASP reconstruction (approved set = [spendLabel, 424242]).
  const aspRec = await R.reconstructAspProofs(mockReader, [spendNote], [spendLabel, 424242n]);
  check('reconstruct.aspRoot', aspRec.aspRoot, sdkAspRoot);

  // === Full spend witness: assert publicInputHash (plain-path origHash) matches.
  // Build the SuiTransact witness from the reconstructed proofs (pure transfer:
  // amountOut=0, single output back to self at full value, same label).
  const outSecret = 24681357n;
  const outOwner = ownerField;
  const witness = await W.buildTransactWitness({
    inputNotes: [{
      value, tokenId, label: spendLabel, noteSecret,
      ownerAddress: ownerField, timestamp: spendTs, leafIndex: stateRec.leafIndices[0],
    }],
    outputNotes: [{ value, tokenId, label: spendLabel, noteSecret: outSecret, ownerAddress: outOwner }],
    ownerAddress: ownerField,
    privateNullifyingKey: nullifyingKey,
    privateRevocableKey: nullifyingKey,
    amountOut: 0n,
    tokenIdOut: 0n,
    stateRoot: stateRec.stateRoot,
    keystoreRoot: ksRec.keystoreRoot,
    aspRoot: aspRec.aspRoot,
    stateMerkleProofs: stateRec.proofs,
    keystoreMerkleProof: ksRec.proof,
    aspMerkleProofs: aspRec.proofs,
    gvkEnabled: false, // plain path: publicInputHash == origHash (no proof needed)
    gvk: [0n, 0n],
    encryptionRandomness: 0n,
    processorBytes: new Uint8Array(32),
    processorData: new Uint8Array(0),
    noteHints: [],
    noteData: [],
  });

  // SDK reference origHash from the SAME derived values.
  const sdkWitnessMod = await import(`${SDK}/witness.mjs`);
  const sdkOrigHash = await sdkWitnessMod.computeOrigHash({
    nullifierHashes: witness.nullifierHashes,
    outputCommitments: witness.outputCommitments,
    stateRoot: stateRec.stateRoot,
    keystoreRoot: ksRec.keystoreRoot,
    aspRoot: aspRec.aspRoot,
    amountOut: 0n,
    tokenIdOut: 0n,
    context: witness.context,
  });
  // The plain-path publicInputHash the circuit/contract checks IS origHash.
  // Recompute the port's origHash from its own witness signals identically.
  const portOrigHash = await W.poseidonHashN([
    ...witness.nullifierHashes,
    ...witness.outputCommitments,
    BigInt(witness.inputs.stateRoot),
    BigInt(witness.inputs.keystoreRoot),
    BigInt(witness.inputs.associationSetRoot),
    BigInt(witness.inputs.amountOut),
    BigInt(witness.inputs.tokenIdOut),
    BigInt(witness.inputs.context),
  ]);
  check('witness.origHash (port) == SDK computeOrigHash', portOrigHash, sdkOrigHash);
  console.log(`  INFO plain-path publicInputHash = ${sdkOrigHash}`);
}

console.log('');
if (failures > 0) {
  console.log(`CROSS-CHECK FAILED: ${failures} mismatch(es)`);
  process.exit(1);
}
console.log('CROSS-CHECK PASSED: browser witness + reconstruction == SDK for all checked values');
