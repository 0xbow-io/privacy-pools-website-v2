/**
 * Claim material for a private swap-send to an unregistered recipient (DEV-511).
 *
 * The swap-send runs the SDK's reshield-and-transfer with the BLIND recipient
 * form (a pre-computed noteAddressHash plus our own announcement), the same
 * path a pay-with Shield uses (services/swap-deposit-recipient.ts). Nothing on
 * chain tells the recipient about the note, so a one-time claim link is their
 * only route to it, and the swap has already spent the sender's notes by the
 * time anyone could notice a lost link.
 *
 * Two copies of the claim exist, both written before the relay:
 * - on chain: the deposit's noteData is our sender backup
 *   (services/blind-deposit-backup.ts), encrypted to the sender's viewing key
 *   and bound into the proof, so it exists exactly when the deposit does;
 * - on this device: a SEALED record (this module), encrypted to the same key,
 *   written while the proof is built and re-keyed with the relayed hash on
 *   broadcast. It holds what the on-chain copy cannot: which chain the note
 *   landed on, the recipient and the commitment, so a cross-chain claim is
 *   rebuilt without a scan.
 *
 * The note secret is never stored in plaintext and never sent anywhere. The
 * record's only plaintext is the id (a commitment key), chain ids, the relayed
 * hash and a timestamp: the same facts the activity row already keeps.
 *
 * Pure: crypto and storage are injected, so this runs under bun.
 */
import type { BackupCryptoLike } from '@/services/blind-deposit-backup';

type Hex = `0x${string}`;

/** Everything a claim link names. Exactly one note: the recipient's. */
export interface SwapSendClaim {
  /** Where the note landed (the destination chain for a cross-chain send). */
  chainId: number;
  commitment: Hex;
  /** The recipient. */
  ownerAddress: Hex;
  noteSecret: Hex;
  tokenId: Hex;
  value: Hex;
  label: Hex;
}

export interface SealedSwapSendClaim {
  /** Commitment key: one record per prepared note. */
  id: string;
  sourceChainId: number;
  chainId: number;
  /** The relayed hash, once the relayer returned it. Null before broadcast. */
  txHash: string | null;
  ephemeralPubKey: string;
  ciphertext: string;
  createdAt: number;
}

export class SwapSendClaimError extends Error {}

const FIELDS = ['commitment', 'ownerAddress', 'noteSecret', 'tokenId', 'value', 'label'] as const;
const HEX = /^0x[0-9a-fA-F]+$/;

function isClaim(x: unknown): x is SwapSendClaim {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) return false;
  return FIELDS.every((k) => typeof o[k] === 'string' && HEX.test(o[k] as string));
}

/** One key per commitment, whatever its hex spelling. */
export function claimId(commitment: string): string {
  return BigInt(commitment).toString(16);
}

/** Encrypt a claim to the sender's own viewing key. */
export function sealSwapSendClaim(input: {
  claim: SwapSendClaim;
  sourceChainId: number;
  senderViewingPubKey: string;
  crypto: BackupCryptoLike;
  now: number;
}): SealedSwapSendClaim {
  if (!isClaim(input.claim)) throw new SwapSendClaimError('claim is incomplete');
  const plain = new TextEncoder().encode(JSON.stringify({
    chainId: input.claim.chainId,
    commitment: input.claim.commitment,
    ownerAddress: input.claim.ownerAddress,
    noteSecret: input.claim.noteSecret,
    tokenId: input.claim.tokenId,
    value: input.claim.value,
    label: input.claim.label,
  }));
  const ephemeral = input.crypto.generateEphemeralKeyPair();
  const shared = input.crypto.ecdh(ephemeral.privateKey, input.senderViewingPubKey);
  return {
    id: claimId(input.claim.commitment),
    sourceChainId: input.sourceChainId,
    chainId: input.claim.chainId,
    txHash: null,
    ephemeralPubKey: ephemeral.publicKey,
    ciphertext: input.crypto.encrypt(plain, shared),
    createdAt: input.now,
  };
}

/** Decrypt a sealed claim with the sender's viewing key. Null when it is not ours or not a claim. */
export function openSwapSendClaim(input: {
  sealed: SealedSwapSendClaim;
  viewingPrivateKey: string;
  crypto: BackupCryptoLike;
}): SwapSendClaim | null {
  try {
    const shared = input.crypto.ecdh(input.viewingPrivateKey, input.sealed.ephemeralPubKey);
    const parsed = JSON.parse(new TextDecoder().decode(input.crypto.decrypt(input.sealed.ciphertext, shared))) as unknown;
    if (!isClaim(parsed)) return null;
    // The plaintext chain must match the record's: a swapped record must not
    // build a link for the wrong network.
    if (parsed.chainId !== input.sealed.chainId || claimId(parsed.commitment) !== input.sealed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stored value -> list, or `ok: false` when present but unreadable (never written over). */
export function parseSealedClaims(raw: string | null | undefined): { ok: true; list: SealedSwapSendClaim[] } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, list: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ok: false };
    return {
      ok: true,
      list: parsed.filter((r): r is SealedSwapSendClaim => !!r && typeof r === 'object'
        && typeof (r as SealedSwapSendClaim).id === 'string'
        && typeof (r as SealedSwapSendClaim).ciphertext === 'string'
        && typeof (r as SealedSwapSendClaim).ephemeralPubKey === 'string'),
    };
  } catch {
    return { ok: false };
  }
}

/** Insert or replace by id. */
export function upsertSealedClaim(list: readonly SealedSwapSendClaim[], record: SealedSwapSendClaim): SealedSwapSendClaim[] {
  return [...list.filter((r) => r.id !== record.id), record];
}

/** Attach the relayed hash to the record the relay committed to. */
export function rekeySealedClaim(list: readonly SealedSwapSendClaim[], id: string, txHash: string): SealedSwapSendClaim[] {
  return list.map((r) => (r.id === id ? { ...r, txHash: txHash.toLowerCase() } : r));
}

/** The records an activity row (keyed by its relayed hash) can rebuild a link from. */
export function sealedClaimsForTx(list: readonly SealedSwapSendClaim[], txHash: string | null | undefined): SealedSwapSendClaim[] {
  if (!txHash) return [];
  const needle = txHash.toLowerCase();
  return list.filter((r) => r.txHash === needle);
}

/** One stored record (per-claim key), or null. */
export function parseSealedClaim(raw: string | null | undefined): SealedSwapSendClaim | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as SealedSwapSendClaim | null;
    return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.ciphertext === 'string'
      && typeof r.ephemeralPubKey === 'string' && typeof r.chainId === 'number' ? r : null;
  } catch {
    return null;
  }
}

/**
 * Same-chain recovery with no sealed record (another browser), from the Note
 * ciphertexts of THIS row's tx that the app ALREADY downloaded on its own
 * schedule (services/note-ciphertexts.ts: the event snapshot and discovery's
 * reads). No request is made, so a click is visible to no one. Empty means
 * nothing of ours is in what has loaded so far.
 *
 * Cross-chain is deliberately not served without the record: the destination
 * deposit is another tx on another chain and nothing public ties it to this
 * row. Only this device's sealed record holds that association, so without it
 * the user is sent to the device that made the swap, never handed a guess.
 */
export function claimsFromLoadedCiphertexts<P extends object>(input: {
  chainId: number;
  txHash: string;
  ciphertexts: readonly { ephemeralPubKey: string; encryptedPayload: string }[];
  open: (c: { ephemeralPubKey: string; encryptedPayload: string }) => P | null;
}): (P & { chainId: number; txHash: string; blockNumber: Hex })[] {
  const out: (P & { chainId: number; txHash: string; blockNumber: Hex })[] = [];
  for (const c of input.ciphertexts) {
    const p = input.open(c);
    if (p) out.push({ ...p, chainId: input.chainId, txHash: input.txHash.toLowerCase(), blockNumber: '0x0' });
  }
  return out;
}

export const SWAP_SEND_NO_CLAIM_IN_TX = 'No claim link for this one: the recipient finds it automatically. A cross-chain send is recovered on the device that sent it.';

/**
 * What an empty recovery means, from local data only. The row's tx emits Note
 * events whatever the recipient (the change, or the registered recipient's
 * announcement), so ciphertexts loaded with none of ours = no claim was made.
 * Nothing loaded for the tx yet = the feed has not reached it.
 */
export function claimRecoveryOutcome(input: { loadedCiphertexts: number; claims: number }): 'found' | 'none-needed' | 'syncing' {
  if (input.claims > 0) return 'found';
  return input.loadedCiphertexts > 0 ? 'none-needed' : 'syncing';
}

