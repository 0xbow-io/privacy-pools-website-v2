/**
 * Browser-safe Merkle-proof RECONSTRUCTION layer for Sui Privacy Pools spends.
 *
 * This is the layer that was missing from the website (the UI-flow audit's MAJOR
 * gap): the witness builders in `witness.ts` already take `MerkleProof`s as
 * input, but nothing produced them from chain. This module rebuilds the three
 * trees from on-chain events + state and yields the per-note proofs a transact
 * (transfer / withdraw) needs, plus the keystore proof a ragequit needs.
 *
 * It is a faithful browser port of the proven-live Node reference
 * `scripts/live-relay-withdraw-e2e.mjs` (STEP 2 state tree, STEP 3 keystore,
 * STEP 4 ASP) — same field/encoding semantics, same cross-checks:
 *
 *   - STATE: fetch `LeavesInserted` (ordered), rebuild the client LeanIMT, read
 *     each input note's REAL on-chain commitment timestamp, recompute the
 *     timestamped leaf `Poseidon(TAG, commitment, timestamp)`, find its index,
 *     and CONFIRM the reconstructed root is in the pool root_buffer
 *     (E_UNKNOWN_STATE_ROOT otherwise).
 *   - KEYSTORE: rebuild the keystore tree from `LeafInserted`, locate the
 *     spender's leaf `Poseidon(owner, Poseidon(NK), Poseidon(0,RK))`, and
 *     CROSS-CHECK the reconstructed root against the live `current_root`
 *     (INTL-19 liveness `is_known_root`).
 *   - ASP: build the client-side ASP tree that includes the note's `labelHash`
 *     and CONFIRM the latest on-chain ASP root equals it (the contract checks
 *     `is_latest_root`, E_UNKNOWN_ASP_ROOT). Building/pushing the ASP root is a
 *     PostmanCap admin action — see {@link buildAspTreeForLabels} +
 *     `ASP_REQUIRES_POSTMAN` note; the browser cannot hold PostmanCap.
 *
 * CRITICAL: the per-leaf proof depth is `proof.siblings.length` (the documented
 * LeanIMT odd-leaf gotcha) — `witness.ts` already pads to the circuit max and
 * passes the real depth separately. Do NOT pre-pad here.
 */

import type { SuiChainReader } from './chain-reader';
import {
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateTimestampedLeaf,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
} from './crypto';
import {
  createTreeWithLeaves,
  generateProof,
  indexOf,
  getRoot,
  type MerkleProof,
} from './merkle';

/** A note being spent — the fields needed to recompute its commitment + leaf. */
export interface SpendNote {
  value: bigint;
  tokenId: bigint;
  label: bigint;
  noteSecret: bigint;
  /** Owner address (field element) used in the note commitment. */
  ownerAddress: bigint;
}

/** The reconstructed state-tree result for one or more input notes. */
export interface StateReconstruction {
  /** The reconstructed (and root-buffer-verified) state root. */
  stateRoot: bigint;
  /** One Merkle proof per input note (ordered with the input notes). */
  proofs: MerkleProof[];
  /** On-chain commitment timestamp per input note (ordered). */
  timestamps: bigint[];
  /** State-leaf index per input note (ordered). */
  leafIndices: number[];
  /** Total reconstructed leaf count (diagnostics). */
  leafCount: number;
}

/**
 * Reconstruct the state tree from `LeavesInserted` events and produce a Merkle
 * proof for each input note. Verifies the reconstructed root is a known pool
 * root (root_buffer). Mirrors live-relay-withdraw-e2e STEP 2.
 *
 * @throws if any note's timestamped leaf is not on-chain (timestamp/crypto
 *   mismatch) or the reconstructed root is not in the pool root_buffer.
 */
export async function reconstructStateProofs(
  reader: SuiChainReader,
  notes: SpendNote[],
): Promise<StateReconstruction> {
  if (notes.length < 1) throw new Error('at least one input note is required');

  // 1. Recompute each note's commitment, read its on-chain stamped timestamp,
  //    and recompute the timestamped state-tree leaf.
  const noteLeaves: bigint[] = [];
  const timestamps: bigint[] = [];
  for (const note of notes) {
    const nah = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
    const commitment = await calculateNoteCommitment(nah, note.tokenId, note.value, 0n, note.label);
    const timestamp = await reader.getCommitmentTimestamp(commitment);
    timestamps.push(timestamp);
    noteLeaves.push(await calculateTimestampedLeaf(commitment, timestamp));
  }

  // 2. Rebuild the full ordered state-leaf list + the client LeanIMT.
  const stateLeaves = await reader.reconstructStateLeaves();
  if (stateLeaves.length === 0) throw new Error('no state leaves on-chain. Nothing to spend');
  const tree = await createTreeWithLeaves(stateLeaves);

  // 3. Confirm the reconstructed root is a live pool root (E_UNKNOWN_STATE_ROOT).
  const stateRoot = getRoot(tree);
  const rootBuffer = await reader.getPoolRootBuffer();
  if (!rootBuffer.includes(stateRoot)) {
    throw new Error(
      `reconstructed state root not present in on-chain root_buffer ` +
        `(reconstruction is stale or out of order)`,
    );
  }

  // 4. Locate each note's leaf + build its proof (per-leaf depth via siblings).
  const proofs: MerkleProof[] = [];
  const leafIndices: number[] = [];
  for (let i = 0; i < noteLeaves.length; i++) {
    const idx = indexOf(tree, noteLeaves[i]);
    if (idx < 0) {
      throw new Error(
        `input note ${i} reconstructed leaf not found in on-chain state tree ` +
          `(timestamp/crypto mismatch)`,
      );
    }
    leafIndices.push(idx);
    proofs.push(generateProof(tree, idx));
  }

  return { stateRoot, proofs, timestamps, leafIndices, leafCount: stateLeaves.length };
}

/** The reconstructed keystore result for the spender. */
export interface KeystoreReconstruction {
  /** The reconstructed (and current_root-verified) keystore root. */
  keystoreRoot: bigint;
  /** The spender's keystore Merkle proof. */
  proof: MerkleProof;
  /** The spender's keystore leaf index. */
  leafIndex: number;
}

/**
 * Reconstruct the keystore tree from `LeafInserted` events and produce the
 * spender's auth-policy membership proof. The leaf is
 * `Poseidon(ownerAddress, Poseidon(NK), Poseidon(0, RK))` — the SAME leaf
 * `use-sui-session::ensureKeystoreRegistered` writes via `set_auth_policy`.
 * Cross-checks the reconstructed root against the live `current_root`
 * (INTL-19 liveness; the proof must verify against a known keystore root).
 * Mirrors live-relay-withdraw-e2e STEP 3.
 *
 * @param ownerAddress spender's address as a field element (addressToU256).
 * @param privateNullifyingKey NK (drives Poseidon(NK)).
 * @param privateRevocableKey RK (drives the direct-key authDigest Poseidon(0,RK)).
 */
export async function reconstructKeystoreProof(
  reader: SuiChainReader,
  ownerAddress: bigint,
  privateNullifyingKey: bigint,
  privateRevocableKey: bigint,
): Promise<KeystoreReconstruction> {
  const keystoreLeaf = await computeExpectedKeystoreLeaf(
    ownerAddress,
    privateNullifyingKey,
    privateRevocableKey,
  );

  const leaves = await reader.reconstructKeystoreLeaves();
  const leafIndex = leaves.indexOf(keystoreLeaf);
  if (leafIndex < 0) {
    throw new Error(
      'spender keystore leaf not found on-chain. Register the auth policy first ' +
        '(ensureKeystoreRegistered)',
    );
  }
  const tree = await createTreeWithLeaves(leaves);
  const keystoreRoot = getRoot(tree);

  // Cross-check against the live current_root (the proof must verify against a
  // known root; INTL-19 keeps prior roots live for a window, but matching the
  // current root is the safe default and matches the live script).
  const onchainRoot = await reader.getKeystoreCurrentRoot();
  if (keystoreRoot !== onchainRoot) {
    throw new Error(
      `reconstructed keystore root does not match on-chain current_root ` +
        `(reconstruction stale)`,
    );
  }

  return { keystoreRoot, proof: generateProof(tree, leafIndex), leafIndex };
}

/**
 * Compute the spender's expected keystore leaf — the exact value
 * `keystore::set_auth_policy` inserts and {@link reconstructKeystoreProof}
 * looks up. Shared by the registration probe and the post-registration wait so
 * they can never drift from the reconstruction.
 */
export async function computeExpectedKeystoreLeaf(
  ownerAddress: bigint,
  privateNullifyingKey: bigint,
  privateRevocableKey: bigint,
): Promise<bigint> {
  const nullifyingKeyHash = await calculateNullifyingKeyHash(privateNullifyingKey);
  const authDigest = await computeAuthDigestDirectKey(privateRevocableKey);
  return calculateKeystoreLeaf(ownerAddress, nullifyingKeyHash, authDigest);
}

/**
 * Wait until a keystore leaf is visible in the reconstructed `LeafInserted`
 * event stream. `set_auth_policy` landing on-chain is NOT enough for an
 * immediately-following spend: the reconstruction reads `queryEvents`, whose
 * indexing lags finality by a few seconds — reconstructing in that window
 * throws "spender keystore leaf not found" even though registration succeeded.
 *
 * Resolves with the leaf index, or throws after `tries` polls OR when
 * `deadlineMs` of wall-clock time has passed — whichever comes first. The
 * deadline matters because each poll is itself a paged `queryEvents` scan with
 * its own network timeout: tries×delay alone would let a degraded RPC stretch
 * ten "3s" polls into minutes. Poll failures (transient RPC) count as a miss
 * rather than aborting the wait; the last one is preserved as the thrown
 * error's `cause`.
 */
export async function waitForKeystoreLeaf(
  reader: SuiChainReader,
  keystoreLeaf: bigint,
  options: { tries?: number; delayMs?: number; deadlineMs?: number } = {},
): Promise<number> {
  const tries = Number.isFinite(options.tries) && (options.tries as number) > 0 ? (options.tries as number) : 10;
  const delayMs = Number.isFinite(options.delayMs) && (options.delayMs as number) >= 0 ? (options.delayMs as number) : 3000;
  const deadlineMs = Number.isFinite(options.deadlineMs) && (options.deadlineMs as number) > 0 ? (options.deadlineMs as number) : 60_000;
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const leaves = await reader.reconstructKeystoreLeaves();
      const index = leaves.indexOf(keystoreLeaf);
      if (index >= 0) return index;
    } catch (err) {
      // transient read failure — treat as a miss and keep polling
      lastError = err;
    }
    if (Date.now() + delayMs >= deadline) break;
    if (attempt < tries - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    'keystore registration has not appeared on-chain. The set_auth_policy ' +
      'transaction may have failed or event indexing is lagging. Retry the action.',
    lastError === undefined ? undefined : { cause: lastError },
  );
}

/**
 * Whether the browser can author the ASP root. The ASP root update is a
 * PostmanCap admin action (`asp_registry::update_asp_root`); a normal user
 * wallet does NOT hold PostmanCap, so the website CANNOT push an ASP root.
 * The note's label must therefore be ASP-approved OUT-OF-BAND (by the operator
 * running the postman), after which the latest on-chain ASP root will already
 * include the note's labelHash. {@link reconstructAspProofs} builds the proof
 * against whatever the live latest root is and FAILS LOUD if it does not match,
 * surfacing the "label not yet approved" condition clearly.
 */
export const ASP_REQUIRES_POSTMAN = true;

/** The reconstructed ASP result for the input notes. */
export interface AspReconstruction {
  /** The latest on-chain ASP root (the contract checks `is_latest_root`). */
  aspRoot: bigint;
  /** One ASP Merkle proof per input note (ordered with the input notes). */
  proofs: MerkleProof[];
}

/**
 * Build the client-side ASP tree over `labels` (typically: the spend's input
 * note labels plus any operator-published fillers) and return it, the root, and
 * per-label proofs. This is the BUILD half — the resulting root must be pushed
 * on-chain via `asp_registry::update_asp_root` (PostmanCap). Used by the live
 * relay e2e script (STEP 4) and the Node cross-check. A browser UI that does NOT
 * hold PostmanCap should instead use {@link reconstructAspProofs}, which builds
 * proofs against the EXISTING latest on-chain root.
 *
 * @param labels label values (the leaves are `Poseidon(label)`, oldest-first).
 */
export async function buildAspTreeForLabels(
  labels: bigint[],
): Promise<{ aspRoot: bigint; leaves: bigint[]; proofForLabel: (label: bigint) => MerkleProof }> {
  if (labels.length < 1) throw new Error('at least one label is required');
  const leaves: bigint[] = [];
  const leafByLabel = new Map<string, bigint>();
  for (const label of labels) {
    const leaf = await calculateLabelHash(label);
    leaves.push(leaf);
    leafByLabel.set(label.toString(), leaf);
  }
  const tree = await createTreeWithLeaves(leaves);
  const aspRoot = getRoot(tree);
  const proofForLabel = (label: bigint): MerkleProof => {
    const leaf = leafByLabel.get(label.toString());
    if (leaf == null) throw new Error(`label ${label} not in the ASP tree`);
    return generateProof(tree, indexOf(tree, leaf));
  };
  return { aspRoot, leaves, proofForLabel };
}

/**
 * Produce ASP Merkle proofs for the input notes against an ASP tree built from
 * the supplied `approvedLabels` set, then CONFIRM that tree's root equals the
 * latest on-chain ASP root (the contract enforces `is_latest_root`,
 * E_UNKNOWN_ASP_ROOT). The `approvedLabels` set is the operator-published ASP
 * membership list (the same set whose root the postman pushed); each input
 * note's label MUST appear in it.
 *
 * If the rebuilt root does not match the on-chain latest root, this throws — the
 * note's label is NOT in the current ASP set (not yet approved, or the operator
 * published a different set). The browser cannot fix this itself (no PostmanCap).
 *
 * @param reader live chain reader.
 * @param notes input notes (their labels must be in `approvedLabels`).
 * @param approvedLabels the full ASP-approved label set (oldest-first), whose
 *   `Poseidon(label)` leaves form the on-chain ASP tree.
 */
export async function reconstructAspProofs(
  reader: SuiChainReader,
  notes: SpendNote[],
  approvedLabels: bigint[],
): Promise<AspReconstruction> {
  if (notes.length < 1) throw new Error('at least one input note is required');
  if (approvedLabels.length < 1) {
    throw new Error('approvedLabels is empty. No ASP set to prove against');
  }

  const leaves: bigint[] = [];
  for (const label of approvedLabels) leaves.push(await calculateLabelHash(label));
  const tree = await createTreeWithLeaves(leaves);
  const aspRoot = getRoot(tree);

  const onchainRoot = await reader.getLatestAspRoot();
  if (aspRoot !== onchainRoot) {
    throw new Error(
      'rebuilt ASP root does not match the latest on-chain ASP root. The input ' +
        "note label(s) are not in the current ASP set (not yet approved, or the " +
        'operator published a different set). The browser cannot push an ASP root ' +
        '(PostmanCap required); approval must happen out-of-band.',
    );
  }

  const proofs: MerkleProof[] = [];
  for (const note of notes) {
    const labelHash = await calculateLabelHash(note.label);
    const idx = indexOf(tree, labelHash);
    if (idx < 0) {
      throw new Error(
        `input note label ${note.label} not in the ASP-approved set (labelHash ` +
          `${labelHash} absent)`,
      );
    }
    proofs.push(generateProof(tree, idx));
  }

  return { aspRoot, proofs };
}

/**
 * Like {@link reconstructAspProofs}, but takes the ASP set as PRE-HASHED tree
 * leaves (`Poseidon(label)`, oldest-first) instead of label preimages. This is
 * the shape the 0xBow ASP publishes at `/association-set/leaves` (chainId 102):
 * the association-set leaves ARE the label hashes, so rebuilding the tree must
 * NOT hash them again. Each input note is located by `Poseidon(note.label)`.
 */
export async function reconstructAspProofsFromLeaves(
  reader: SuiChainReader,
  notes: SpendNote[],
  aspLeaves: bigint[],
): Promise<AspReconstruction> {
  if (notes.length < 1) throw new Error('at least one input note is required');
  if (aspLeaves.length < 1) {
    throw new Error('aspLeaves is empty. No ASP set to prove against');
  }

  const tree = await createTreeWithLeaves(aspLeaves);
  const aspRoot = getRoot(tree);

  const onchainRoot = await reader.getLatestAspRoot();
  if (aspRoot !== onchainRoot) {
    throw new Error(
      'rebuilt ASP root does not match the latest on-chain ASP root. The ASP-' +
        'published leaf set is stale or the input note label(s) are not yet ' +
        'approved. Approval happens out-of-band (ASP postman); retry shortly.',
    );
  }

  const proofs: MerkleProof[] = [];
  for (const note of notes) {
    const labelHash = await calculateLabelHash(note.label);
    const idx = indexOf(tree, labelHash);
    if (idx < 0) {
      throw new Error(
        `input note label ${note.label} not in the ASP-approved set (labelHash ` +
          `${labelHash} absent). Not yet validated by the ASP`,
      );
    }
    proofs.push(generateProof(tree, idx));
  }

  return { aspRoot, proofs };
}
