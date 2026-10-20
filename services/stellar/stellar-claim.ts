/**
 * One-time claim links for Stellar: a private transfer to an account that has
 * no viewing key yet. Nothing on chain announces that note, so the link IS the
 * recipient's only way to it: it carries the note's secret.
 *
 * Format: `/import-note/xlmn.<base64url(JSON)>?stellar=true&env=…`. The EVM
 * receipt codec (services/note-receipt.ts) packs 20-byte addresses, so Stellar
 * gets its own, decoded strictly: a link is attacker-controlled input that
 * decides which note a session imports. The SDK's importReceivedNote then
 * re-derives noteAddressHash and commitment from these fields and refuses any
 * that do not bind, or that name another owner.
 *
 * Pure module (no react-native, no SDK) so it is bun-testable.
 */
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { isStellarAccountAddress } from '@/services/stellar/stellar-request';

export const STELLAR_CLAIM_PREFIX = 'xlmn.';
const STELLAR_CLAIM_CHAIN_ID = 202;
const HEX32 = /^0x[0-9a-fA-F]{1,64}$/;
const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The fields of one claimable note, as the sender built it. */
export type StellarClaimNote = {
  commitment: string;
  noteAddressHash: string;
  noteSecret: string;
  value: string;
  tokenId: string;
  label: string;
  /** The recipient account (G...): only that session can import it. */
  ownerAddress: string;
  /** The transfer that created it; 0x0 when not known yet. */
  txHash: string;
};

export type StellarClaim = {
  kind: 'ppv2-stellar-claim';
  version: 1;
  chainId: number;
  notes: StellarClaimNote[];
};

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function isStellarClaimLink(encoded: string | null | undefined): boolean {
  return !!encoded && encoded.startsWith(STELLAR_CLAIM_PREFIX);
}

export function encodeStellarClaim(notes: readonly StellarClaimNote[]): string {
  const claim: StellarClaim = { kind: 'ppv2-stellar-claim', version: 1, chainId: STELLAR_CLAIM_CHAIN_ID, notes: [...notes] };
  return STELLAR_CLAIM_PREFIX + toBase64Url(JSON.stringify(claim));
}

function noteOk(n: Partial<StellarClaimNote>, owner: string): boolean {
  if (!n || typeof n !== 'object') return false;
  // The SDK wants exactly 32 bytes here; a short one would only fail at import.
  if (typeof n.noteAddressHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(n.noteAddressHash)) return false;
  for (const field of ['commitment', 'noteSecret', 'label'] as const) {
    if (typeof n[field] !== 'string' || !HEX32.test(n[field] as string)) return false;
  }
  if (typeof n.txHash !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(n.txHash)) return false;
  if (n.ownerAddress !== owner) return false;
  if (n.tokenId !== STELLAR_TESTNET_CONTRACTS.nativeAssetContractId) return false;
  try {
    const v = BigInt(n.value as string);
    return typeof n.value === 'string' && n.value.startsWith('0x') && v > 0n && v < BN254_SCALAR_FIELD;
  } catch {
    return false;
  }
}

/**
 * Strict decode: every note well-formed, one recipient for all of them, this
 * deployment's chain and asset. Throws a user-facing message otherwise.
 */
export function decodeStellarClaim(encoded: string): StellarClaim {
  if (!isStellarClaimLink(encoded)) throw new Error('Not a Stellar claim link.');
  let parsed: Partial<StellarClaim>;
  try {
    parsed = JSON.parse(fromBase64Url(encoded.slice(STELLAR_CLAIM_PREFIX.length))) as Partial<StellarClaim>;
  } catch {
    throw new Error('This claim link is damaged.');
  }
  const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const owner = notes[0]?.ownerAddress;
  const ok = parsed?.kind === 'ppv2-stellar-claim'
    && parsed.version === 1
    && parsed.chainId === STELLAR_CLAIM_CHAIN_ID
    && notes.length >= 1 && notes.length <= 5
    && typeof owner === 'string' && isStellarAccountAddress(owner)
    && notes.every((n) => noteOk(n, owner))
    && new Set(notes.map((n) => BigInt(n.commitment))).size === notes.length;
  if (!ok) throw new Error('This claim link is not valid for Stellar testnet.');
  return parsed as StellarClaim;
}

/** Total value of a claim, base units. */
export function stellarClaimTotal(claim: Pick<StellarClaim, 'notes'>): bigint {
  return claim.notes.reduce((sum, n) => sum + BigInt(n.value), 0n);
}

/** The SDK Note a session imports for one claim note. */
export function toImportableNote(n: StellarClaimNote) {
  return {
    commitment: n.commitment,
    noteAddressHash: n.noteAddressHash,
    noteSecret: n.noteSecret,
    value: n.value,
    tokenId: n.tokenId,
    label: n.label,
    ownerAddress: n.ownerAddress,
    txHash: n.txHash,
    isOwned: true,
    status: 'PENDING' as const,
    createdAtBlock: '0x0',
    spentAtBlock: null,
  };
}
