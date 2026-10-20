import { loadSdkCore } from '@/services/crypto-runtime';
/**
 * On-chain ASP label registration for Sui deposits.
 *
 * The Sui ASP only approves a deposit after its label is registered with the
 * on-chain `asp_registry` — an encrypted note payload the ASP indexer decrypts
 * with its x25519 key, verifies against the deposit, and then admits into the
 * association set. Without this call a deposit stays "pending" forever; the
 * EVM flow has no analog (the EVM ASP screens deposits from calldata alone).
 *
 * Two consumers:
 *  - the deposit flow appends `register_label` to the deposit PTB (atomic,
 *    one signature) via buildAspLabelCiphertext + appendRegisterLabelCall;
 *  - `use-sui-session` sweeps stored deposit notes that predate this wiring
 *    (or whose ciphertext build failed) and registers them after connect.
 */
import { Transaction } from '@mysten/sui/transactions';
// encodeASPCipherText is only reachable via the `utils` namespace in the
// vendored SDK bundle (the top-level named export exists in the types but not
// in the built cjs/esm output).
import type { Hash, Hex } from '@privacy-pools-v2/sdk';
import apiClient from '@/services/api-client';
import { calculateNoteAddressHash, calculateLabelHash } from './crypto';
import { fetchSuiApprovedSet } from './asp-labels';

const toHex64 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}` as Hex;

export interface AspLabelNoteFields {
  ownerAddress: bigint;
  noteSecret: bigint;
  tokenId: bigint;
  value: bigint;
  depositSecret: bigint;
}

/**
 * Encrypt the note payload to the ASP's published x25519 key. Verified
 * against the live Sui ASP: payload fields are 32-byte hex, metadata 0,
 * ephemeral viewing keypair per registration.
 */
export async function buildAspLabelCiphertext(note: AspLabelNoteFields): Promise<number[]> {
  const { publicKey: aspPublicKey } = await apiClient.getASPPublicKey();
  const noteAddressHash = toHex64(
    await calculateNoteAddressHash(note.ownerAddress, note.noteSecret),
  ) as Hash;
  // v2.0 migration: encodeASPCipherText now generates the ephemeral X25519
  // keypair internally (EncodingKeys carries only aspPublicKey) — the wire
  // format is unchanged: ephemeral pubkey prefix + ECDH-encrypted payload.
  // The split SDK takes the crypto service explicitly (it used to default to
  // `new CryptoService()` internally, which is what this passes).
  const { utils, CryptoService } = await loadSdkCore();
  const ciphertext = utils.encodeASPCipherText(
    {
      noteAddressHash,
      tokenId: toHex64(note.tokenId),
      value: toHex64(note.value),
      depositSecret: toHex64(note.depositSecret),
      metadata: toHex64(0n),
    },
    {
      aspPublicKey: aspPublicKey as Hex,
    },
    { cryptoService: new CryptoService() },
  );
  const hex = ciphertext.slice(2);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Append `asp_registry::register_label(registry, ciphertext)` to a PTB. */
export function appendRegisterLabelCall(
  tx: Transaction,
  params: { packageId: string; aspRegistryObjectId: string; ciphertext: number[] },
): void {
  tx.moveCall({
    target: `${params.packageId}::asp_registry::register_label`,
    arguments: [tx.object(params.aspRegistryObjectId), tx.pure.vector('u8', params.ciphertext)],
  });
}

/**
 * Which of the given labels are already admitted to the association set.
 * Handles both published shapes: raw labels or pre-hashed Poseidon(label)
 * leaves. Returns null when the set can't be fetched (caller should NOT
 * register blindly in that case).
 */
export async function approvedLabelSubset(labels: bigint[]): Promise<Set<bigint> | null> {
  let set;
  try {
    set = await fetchSuiApprovedSet();
  } catch {
    return null;
  }
  if (set === null) return null;
  const values = new Set(set.values.map(String));
  const approved = new Set<bigint>();
  for (const label of labels) {
    const key = set.kind === 'labels' ? label : await calculateLabelHash(label);
    if (values.has(String(key))) approved.add(label);
  }
  return approved;
}
