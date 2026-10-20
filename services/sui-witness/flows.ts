/**
 * High-level Sui flow orchestration: domain inputs -> circuit witness -> proof
 * inputs + PTB args. Pure (no React); the hooks call these then run snarkjs +
 * build the PTB.
 *
 * Each `prepare*` function returns:
 *   - `circuitInputs`: the snarkjs `fullProve` input object (feed to generateProof)
 *   - `nm` (transact only): the { n, m } config selecting the artifact + wrapper VK
 *   - the derived PTB args the Move call needs (commitment(s), nullifier(s),
 *     context, ciphertext blob, etc.)
 *
 * The proof itself is generated separately (useSuiProof / generateProof) since it
 * needs the browser fetch + snarkjs WASM. This keeps the crypto deterministic and
 * unit-testable in Node against the SDK.
 */

import {
  buildDepositWitness,
  buildTransactWitness,
  buildRagequitWitness,
  type DepositWitnessParams,
  type TransactWitnessParams,
  type RagequitWitnessParams,
  type CircuitInputs,
} from './witness';
import { addressToBytes32 } from './crypto';

export interface PreparedDeposit {
  circuitInputs: CircuitInputs;
  /** PTB outputCommitment arg. */
  outputCommitment: bigint;
  label: bigint;
  context: bigint;
  noteHint: Uint8Array;
  noteData: Uint8Array;
}

/** Prepare a deposit: build the native deposit witness + PTB args. */
export async function prepareDeposit(params: DepositWitnessParams): Promise<PreparedDeposit> {
  const w = await buildDepositWitness(params);
  return {
    circuitInputs: w.inputs,
    outputCommitment: w.commitment,
    label: w.label,
    context: w.context,
    noteHint: w.noteHint,
    noteData: w.noteData,
  };
}

export interface PreparedTransact {
  circuitInputs: CircuitInputs;
  /** NxM config + live gvk_enabled — selects the GVK vs plain wrapper artifact. */
  nm: { n: number; m: number; gvkEnabled: boolean };
  nullifierHashes: bigint[];
  outputCommitments: bigint[];
  /** GVK ciphertext blob [ephX, ephY, enc_0..4 per output] (empty on plain path). */
  ciphertext: bigint[];
  context: bigint;
  /** GVK public point passed to the Move call (x, y). 0 on the plain path. */
  gvkX: bigint;
  gvkY: bigint;
}

/**
 * Prepare a transact/withdraw: build the SuiTransact wrapper witness + PTB args.
 * Selects the NxM config from the note counts and the GVK/plain wrapper from the
 * live pool.gvk_enabled flag threaded in via params.gvkEnabled.
 */
export async function prepareTransact(params: TransactWitnessParams): Promise<PreparedTransact> {
  const w = await buildTransactWitness(params);
  const gvkEnabled = params.gvkEnabled ?? true;
  return {
    circuitInputs: w.inputs,
    nm: { n: params.inputNotes.length, m: params.outputNotes.length, gvkEnabled },
    nullifierHashes: w.nullifierHashes,
    outputCommitments: w.outputCommitments,
    ciphertext: w.ciphertext,
    context: w.context,
    // On the plain path the contract ignores gvk_x/gvk_y; pass 0 (not the static
    // config GVK) so a disabled pool never appears to bind a key.
    gvkX: gvkEnabled ? params.gvk[0] : 0n,
    gvkY: gvkEnabled ? params.gvk[1] : 0n,
  };
}

export interface PreparedRagequit {
  circuitInputs: CircuitInputs;
  nullifierHash: bigint;
  commitment: bigint;
}

/** Prepare a ragequit: build the native ragequit witness + PTB args. */
export async function prepareRagequit(params: RagequitWitnessParams): Promise<PreparedRagequit> {
  const w = await buildRagequitWitness(params);
  return {
    circuitInputs: w.inputs,
    nullifierHash: w.nullifierHash,
    commitment: w.commitment,
  };
}

/** Convert a Sui address (0x-hex) to the 32-byte processor bytes for context. */
export function processorAddressBytes(address: string): Uint8Array {
  return addressToBytes32(address);
}
