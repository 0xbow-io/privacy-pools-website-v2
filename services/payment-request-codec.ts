import { keccak256, toBytes, verifyTypedData } from 'viem';

import { NoteStatus } from '@/services/sdk-types';
import { isStellarContractAddress } from '@/services/stellar/strkey';
import type { AccountExport, Hex, Hash, Address, PublicKey, Secret } from '@/services/sdk-types';

/**
 * v1 - legacy: receiver generates noteSecret locally, stashes in localStorage,
 * publishes noteAddressHash. Sender pays and returns a receipt URL that the
 * receiver uses to reconstruct the note. Requires localStorage on the receiver.
 */
export type PaymentRequestPayloadV1 = {
  kind: 'ppv2-payment-request';
  version: 1;
  requestId: string;
  chainId: number;
  recipientAddress: Hex;
  tokenId: Hex;
  amount: Hex;
  noteAddressHash: Hex;
  createdAt: string;
};

/**
 * v2 - discoverable: receiver publishes their seed-derived viewing pubkey.
 * Sender generates the noteSecret, emits a Note event encrypted to the
 * recipient's viewing pubkey, and the recipient finds it via `scanCatchAll`
 * on any device with the wallet seed. No localStorage stash, no receipt URL.
 */
export type PaymentRequestPayloadV2 = {
  kind: 'ppv2-payment-request';
  version: 2;
  requestId: string;
  chainId: number;
  recipientAddress: Hex;
  recipientViewingPubKey: Hex;
  tokenId: Hex;
  amount: Hex;
  createdAt: string;
  signature?: PaymentRequestSignature;
};

/**
 * v3 - SDK-native: the recipient calls `poolSession.generatePaymentRequest`
 * which produces a per-request ephemeral X25519 keypair, a deterministic
 * `tag = Poseidon([paymentId])`, and N `(noteAddressHash, noteSecret)`
 * slots. We serialise the public half (the bits a sender needs) into the
 * share link and let the SDK persist the private half (paymentPrivKey +
 * lifecycle metadata) via its storage adapter. Sender fulfils with
 * `prepareFulfillPaymentRequest`, recipient discovers via the standard
 * `discoverNotes()` scan - works regardless of keystore registration.
 */
export type PaymentRequestPayloadV3 = {
  kind: 'ppv2-sdk-payment-request';
  version: 1;
  chainId: number;
  /**
   * OPTIONAL, and absent from every unsigned share link since 2026-08-31.
   *
   * The SDK's public PaymentRequest deliberately has no recipient address:
   * fulfilment needs only noteAddressHashes, paymentPubKey and tag, and the
   * address is already bound inside noteAddressHash = Poseidon(ownerAddress,
   * noteSecret), which a payer cannot invert. ppv2's own envelope was adding
   * it back and undoing that, so the sanitizer now strips it.
   *
   * It survives in exactly one case: a SIGNED request, where it is a field of
   * the EIP-712 message and the payer needs it to verify. Signing identifies
   * the seller anyway (the signature reveals the signer), so a signed request
   * is a deliberate opt-out of blindness rather than a leak.
   */
  recipientAddress?: Address;
  paymentId: Hex;
  tag: Hex;
  paymentPubKey: PublicKey;
  /**
   * Optional recipient-side private discovery key. Kept for decoding legacy
   * links and explicit backups; payer-facing share links must strip it.
   */
  paymentPrivKey?: Secret;
  tokenId: Address;
  amount: Hex;
  /** Wire form of the SDK's `noteSecretsMap: Map<Hash, Secret>`. */
  noteSecretsMap: [Hash, Secret][];
  /**
   * The SDK's own deadline (unix ms, hex), copied from generatePaymentRequest.
   * The requester stops scanning for the request shortly after it, so the
   * payer refuses to pay past it (see isPaymentRequestExpired). Absent on
   * links made before it was carried: no deadline is known, so they stay
   * payable, as the SDK treats a request without one.
   */
  expiresAt?: Hex;
  createdAt: string;
  signature?: PaymentRequestSignature;
};

export type PaymentRequestSignature = {
  signer: Address;
  signature: Hex;
  signedAt: string;
  sellerName?: string;
};

export type PaymentRequestPayload =
  | PaymentRequestPayloadV1
  | PaymentRequestPayloadV2
  | PaymentRequestPayloadV3;

export type PaymentReceiptPayload = {
  kind: 'ppv2-payment-receipt';
  version: 1;
  requestId: string;
  chainId: number;
  recipientAddress: Hex;
  tokenId: Hex;
  amount: Hex;
  noteAddressHash: Hex;
  commitment: Hex;
  label: Hex;
  txHash: Hex;
  createdAt: string;
};

export const PAYMENT_REQUEST_SIGNING_TYPES = {
  PaymentRequest: [
    { name: 'purpose', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'recipientAddress', type: 'address' },
    { name: 'tokenId', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'paymentId', type: 'bytes32' },
    { name: 'tag', type: 'bytes32' },
    { name: 'paymentPubKey', type: 'bytes32' },
    { name: 'noteSecretsMapHash', type: 'bytes32' },
    { name: 'sellerName', type: 'string' },
  ],
} as const;

/**
 * The same message plus the deadline, for a request that carries one. A
 * separate primary type rather than an optional field, so a signature over an
 * expiring request cannot verify once the deadline is stripped from the link
 * (the stripped payload is checked against PAYMENT_REQUEST_SIGNING_TYPES, a
 * different type hash). Requests signed before the deadline was carried keep
 * verifying against the old type.
 */
export const PAYMENT_REQUEST_EXPIRING_SIGNING_TYPES = {
  ExpiringPaymentRequest: [
    ...PAYMENT_REQUEST_SIGNING_TYPES.PaymentRequest,
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

export const PAYMENT_REQUEST_V2_SIGNING_TYPES = {
  DiscoverablePaymentRequest: [
    { name: 'purpose', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'recipientAddress', type: 'address' },
    { name: 'tokenId', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'requestId', type: 'string' },
    { name: 'recipientViewingPubKey', type: 'bytes32' },
    { name: 'sellerName', type: 'string' },
  ],
} as const;

export function getPaymentRequestSigningDomain(chainId: number) {
  return {
    name: 'Privacy Pools V2',
    version: '1',
    chainId,
  } as const;
}

function noteSecretsMapHash(noteSecretsMap: [Hash, Secret][]): Hash {
  const canonical = noteSecretsMap
    .map(([noteAddressHash, noteSecret]) => `${noteAddressHash.toLowerCase()}:${noteSecret.toLowerCase()}`)
    .join('|');
  return keccak256(toBytes(canonical)) as Hash;
}

type PaymentRequestV2SigningMessage = {
  purpose: string;
  chainId: bigint;
  recipientAddress: Hex;
  tokenId: Hex;
  amount: bigint;
  requestId: string;
  recipientViewingPubKey: Hex;
  sellerName: string;
};

type PaymentRequestV3SigningMessage = {
  purpose: string;
  chainId: bigint;
  recipientAddress: Address;
  tokenId: Address;
  amount: bigint;
  paymentId: Hex;
  tag: Hex;
  paymentPubKey: PublicKey;
  noteSecretsMapHash: Hash;
  sellerName: string;
};

export function getPaymentRequestSigningMessage(
  payload: PaymentRequestPayloadV2,
  sellerName?: string,
): PaymentRequestV2SigningMessage;
export function getPaymentRequestSigningMessage(
  payload: PaymentRequestPayloadV3,
  sellerName?: string,
): PaymentRequestV3SigningMessage;
export function getPaymentRequestSigningMessage(
  payload: PaymentRequestPayloadV2 | PaymentRequestPayloadV3,
  sellerName = '',
): PaymentRequestV2SigningMessage | PaymentRequestV3SigningMessage {
  if (payload.kind === 'ppv2-payment-request' && payload.version === 2) {
    return {
      purpose: 'Sign this payment request so the payer can verify who created it.',
      chainId: BigInt(payload.chainId),
      recipientAddress: payload.recipientAddress,
      tokenId: payload.tokenId,
      amount: BigInt(payload.amount),
      requestId: payload.requestId,
      recipientViewingPubKey: payload.recipientViewingPubKey,
      sellerName: sellerName.trim(),
    };
  }

  return {
    purpose: 'Sign this payment request so the payer can verify who created it.',
    chainId: BigInt(payload.chainId),
    // A signed V3 request always carries this: the create path sets it before
    // signing and the sanitizer keeps it whenever a signature is present. The
    // zero fallback only exists so the EIP-712 encoder is never handed
    // undefined for an `address` field, and such a message cannot verify
    // against a real signature anyway.
    recipientAddress: payload.recipientAddress ?? ('0x0000000000000000000000000000000000000000' as Address),
    tokenId: payload.tokenId,
    amount: BigInt(payload.amount),
    paymentId: payload.paymentId,
    tag: payload.tag,
    paymentPubKey: payload.paymentPubKey,
    noteSecretsMapHash: noteSecretsMapHash(payload.noteSecretsMap),
    sellerName: sellerName.trim(),
  };
}

/**
 * The EIP-712 types, primary type and message a v3 request is signed with.
 * The create flow signs with this and verification checks with it, so the two
 * always pick the same type: the expiring one exactly when the payload carries
 * a deadline.
 */
export function getPaymentRequestV3TypedData(payload: PaymentRequestPayloadV3, sellerName = '') {
  const message = getPaymentRequestSigningMessage(payload, sellerName);
  if (payload.expiresAt !== undefined) {
    return {
      types: PAYMENT_REQUEST_EXPIRING_SIGNING_TYPES,
      primaryType: 'ExpiringPaymentRequest' as const,
      message: { ...message, expiresAt: BigInt(payload.expiresAt) },
    };
  }
  return {
    types: PAYMENT_REQUEST_SIGNING_TYPES,
    primaryType: 'PaymentRequest' as const,
    message,
  };
}

export async function verifyPaymentRequestSignature(payload: PaymentRequestPayloadV2 | PaymentRequestPayloadV3): Promise<boolean> {
  if (!payload.signature) return false;
  if (payload.kind === 'ppv2-payment-request' && payload.version === 2) {
    return verifyTypedData({
      address: payload.signature.signer,
      domain: getPaymentRequestSigningDomain(payload.chainId),
      types: PAYMENT_REQUEST_V2_SIGNING_TYPES,
      primaryType: 'DiscoverablePaymentRequest',
      message: getPaymentRequestSigningMessage(payload, payload.signature.sellerName ?? ''),
      signature: payload.signature.signature,
    });
  }

  const base = {
    address: payload.signature.signer,
    domain: getPaymentRequestSigningDomain(payload.chainId),
    signature: payload.signature.signature,
  };
  const typed = getPaymentRequestV3TypedData(payload, payload.signature.sellerName ?? '');
  // Narrowed per branch: viem's types cannot take the union in one call.
  return typed.primaryType === 'ExpiringPaymentRequest'
    ? verifyTypedData({ ...base, ...typed })
    : verifyTypedData({ ...base, ...typed });
}

/**
 * Whether a request's deadline has passed. Only an SDK-native request carries
 * one, and only when its link was made with it: no deadline known means not
 * expired. Same comparison as the SDK's prepareFulfillPaymentRequest (refused
 * once now is past expiresAt).
 */
export function isPaymentRequestExpired(payload: PaymentRequestPayload, nowMs: number = Date.now()): boolean {
  if (payload.kind !== 'ppv2-sdk-payment-request' || payload.expiresAt === undefined) return false;
  try {
    return BigInt(Math.floor(nowMs)) > BigInt(payload.expiresAt);
  } catch {
    // An unreadable deadline is not one the payer can honour. The parsers
    // never produce this; a direct in-memory object can.
    return true;
  }
}

/** Shown wherever a payer meets an expired request. */
export const PAYMENT_REQUEST_EXPIRED_MESSAGE = 'This payment request has expired. Ask for a new one.';

/** What a payer is told when {@link assertPaymentRequestPayable} refuses. */
export function paymentRequestRefusalMessage(reason: 'tampered' | 'expired'): string {
  return reason === 'expired'
    ? PAYMENT_REQUEST_EXPIRED_MESSAGE
    : 'This request has been altered since it was signed. The recipient details no longer match the signature. Do not pay it; ask the sender for a fresh link.';
}

/** Result of {@link assertPaymentRequestPayable}, so the UI can gate on it. */
export type PaymentPayableResult =
  | { payable: true; signed: boolean }
  | { payable: false; reason: 'tampered' | 'expired' };

/**
 * THE single authority on "may this request be paid?" — used by EVERY pay
 * entry point (both handlers AND both buttons), so no surface can drift into
 * paying something another refuses.
 *
 * The threat this closes: the signature over a request seals exactly the two
 * fields that decide WHERE THE MONEY GOES (recipientAddress + the viewing/
 * payment key). A payment link travels through untrusted hands — chat, email,
 * a forward — and anyone in the middle can swap those fields for their own.
 * The seal then no longer verifies. Before this gate, that broken seal only
 * greyed out the private-transfer button while "Pay via Wallet" happily paid
 * the tampered target: swap both fields and the payment mints a note the
 * attacker owns; swap only the key and the note is unspendable by anyone.
 *
 * The rule, deliberately conservative:
 *   - a request that carries NO signature is unverified BY DESIGN (the sender
 *     chose not to sign). It stays payable, and callers surface it as
 *     unverified — we cannot prove tampering of something never sealed.
 *   - a request that carries a signature is a CLAIM to be verified. If that
 *     claim fails, the request is refused outright: a present-but-invalid
 *     signature is the exact fingerprint of tampering, never of an honest
 *     sender.
 *
 * A verification that THROWS (malformed signature bytes, a bad address) is
 * treated as failure, not swallowed — an unreadable seal is not a valid one.
 */
export async function assertPaymentRequestPayable(
  payload: PaymentRequestPayload,
  nowMs: number = Date.now(),
): Promise<PaymentPayableResult> {
  // v1 predates request signing; there is nothing to verify and it has always
  // been paid on the strength of its bare fields. But a v1 carrying a
  // signature-shaped field is a downgrade attack (a signed higher-version
  // request relabelled v1, whose unsigned noteAddressHash the attacker then
  // controls). The parser already rejects this on the link path; refuse it
  // HERE too, because a caller can hand the gate a direct in-memory object that
  // never went through the parser. Defence in depth — the gate is the
  // authority, so it must not trust its input's provenance.
  if (payload.kind === 'ppv2-payment-request' && payload.version === 1) {
    if ((payload as { signature?: unknown }).signature !== undefined) {
      return { payable: false, reason: 'tampered' };
    }
    return { payable: true, signed: false };
  }
  const signable = payload as PaymentRequestPayloadV2 | PaymentRequestPayloadV3;
  // ONLY an absent (undefined) signature is unsigned-by-design. Use a strict
  // `=== undefined` check, NOT `!signable.signature`: a direct in-memory object
  // (one that skipped the parser) carrying `signature:null` — or any other
  // falsy-but-present malformed seal — must NOT be waved through as unsigned.
  // Anything present falls into verification below, where an unreadable seal is
  // treated as failure and the request is refused as tampered.
  // Tampering is checked first and reported over expiry: a broken seal says
  // the deadline itself cannot be trusted. An expired request is refused
  // either way, signed or not, because the requester no longer looks for it.
  if (signable.signature === undefined) {
    return isPaymentRequestExpired(signable, nowMs)
      ? { payable: false, reason: 'expired' }
      : { payable: true, signed: false };
  }
  let valid = false;
  try {
    valid = await verifyPaymentRequestSignature(signable);
  } catch {
    valid = false;
  }
  if (!valid) return { payable: false, reason: 'tampered' };
  return isPaymentRequestExpired(signable, nowMs)
    ? { payable: false, reason: 'expired' }
    : { payable: true, signed: true };
}

function toBase64Url(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  throw new Error('Base64 encoding is unavailable in this environment.');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    return atob(padded);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  throw new Error('Base64 decoding is unavailable in this environment.');
}

const MARKER_REQUEST_V1 = 0x01;
const MARKER_REQUEST_V2 = 0x02;
const MARKER_REQUEST_V3 = 0x03;
/**
 * The v3 layout followed by the SDK's expiresAt as an 8-byte big-endian unix
 * ms. A request without a deadline still packs under 0x03, byte for byte as
 * before, so every link made before this decodes unchanged.
 */
const MARKER_REQUEST_V3_EXPIRING = 0x04;
const EXPIRES_AT_BYTES = 8;
/** Any hex word up to 32 bytes: the SDK mints expiresAt padded to one (bigintToHex). */
const EXPIRES_AT_INPUT_RE = /^0x[0-9a-fA-F]{1,64}$/;
const EXPIRES_AT_MAX = (1n << BigInt(EXPIRES_AT_BYTES * 8)) - 1n;

/**
 * expiresAt as the link carries it: unix ms in compact hex, at most 8 bytes.
 * The SDK mints it padded to a 32-byte word (`0x` + 64 digits), so the value
 * is what is checked, never the spelling: leading zeros are dropped, and only
 * a value that really exceeds 8 bytes is refused (DEV-515). The signed request
 * hashes the number, not the string, so compacting it never breaks a seal.
 */
export function normalizeExpiresAt(value: string): Hex {
  if (typeof value !== 'string' || !EXPIRES_AT_INPUT_RE.test(value)) {
    throw new Error('expiresAt is not a hex timestamp');
  }
  const v = BigInt(value);
  if (v > EXPIRES_AT_MAX) throw new Error('expiresAt too large to pack');
  return `0x${v.toString(16)}` as Hex;
}

function isPackableExpiresAt(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    normalizeExpiresAt(value);
    return true;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hex must have even length: ${hex}`);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex parse failed: ${hex}`);
    bytes[i] = byte;
  }
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw new Error(`hex expected ${expectedLen} bytes, got ${bytes.length}: ${hex}`);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as Hex;
}

function uuidToBytes(uuid: string): Uint8Array {
  const clean = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) throw new Error(`bad uuid: ${uuid}`);
  return hexToBytes(clean, 16);
}

function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('uuid bytes must be 16');
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return toBase64Url(binary);
}

function base64UrlToBytes(value: string): Uint8Array {
  const decoded = fromBase64Url(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
  return bytes;
}

function packPaymentRequestV3(payload: PaymentRequestPayloadV3): Uint8Array {
  const rawAmount = payload.amount.startsWith('0x') || payload.amount.startsWith('0X')
    ? payload.amount.slice(2)
    : payload.amount;
  const evenAmount = rawAmount.length % 2 === 0 ? rawAmount : '0' + rawAmount;
  const amountBytes = hexToBytes(('0x' + evenAmount) as Hex);
  if (amountBytes.length > 0xff) throw new Error('amount too large to pack');
  if (payload.noteSecretsMap.length > 0xff) throw new Error('too many slots to pack');

  const expiresAt = payload.expiresAt !== undefined ? normalizeExpiresAt(payload.expiresAt) : undefined;

  const parts: number[] = [];
  parts.push(expiresAt !== undefined ? MARKER_REQUEST_V3_EXPIRING : MARKER_REQUEST_V3);
  const c = payload.chainId >>> 0;
  parts.push((c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
  for (const b of hexToBytes(payload.paymentId, 32)) parts.push(b);
  for (const b of hexToBytes(payload.tag, 32)) parts.push(b);
  for (const b of hexToBytes(payload.paymentPubKey, 32)) parts.push(b);
  for (const b of hexToBytes(payload.tokenId, 20)) parts.push(b);
  parts.push(amountBytes.length);
  for (const b of amountBytes) parts.push(b);
  parts.push(payload.noteSecretsMap.length);
  for (const [noteAddressHash, noteSecret] of payload.noteSecretsMap) {
    for (const b of hexToBytes(noteAddressHash, 32)) parts.push(b);
    for (const b of hexToBytes(noteSecret, 32)) parts.push(b);
  }
  if (expiresAt !== undefined) {
    let v = BigInt(expiresAt);
    const tail = new Array<number>(EXPIRES_AT_BYTES);
    for (let i = EXPIRES_AT_BYTES - 1; i >= 0; i--) {
      tail[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    parts.push(...tail);
  }
  return new Uint8Array(parts);
}

function unpackPaymentRequestV3(bytes: Uint8Array): PaymentRequestPayloadV3 {
  const marker = bytes[0];
  if (marker !== MARKER_REQUEST_V3 && marker !== MARKER_REQUEST_V3_EXPIRING) {
    throw new Error(`Unexpected marker for v3 payment request: 0x${bytes[0].toString(16)}`);
  }
  const expiring = marker === MARKER_REQUEST_V3_EXPIRING;
  const MIN_FIXED = 1 + 4 + 32 + 32 + 32 + 20 + 1 + 1 + (expiring ? EXPIRES_AT_BYTES : 0);
  if (bytes.length < MIN_FIXED) {
    throw new Error(`v3 payment request payload truncated (${bytes.length} < ${MIN_FIXED} bytes)`);
  }
  let o = 1;
  const need = (n: number, field: string) => {
    if (o + n > bytes.length) {
      throw new Error(`v3 payload truncated reading ${field} (need ${n} bytes at offset ${o}, have ${bytes.length - o})`);
    }
  };
  need(4, 'chainId');
  const chainId = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  o += 4;

  need(32, 'paymentId');
  const paymentId = bytesToHex(bytes.slice(o, o + 32));
  o += 32;
  need(32, 'tag');
  const tag = bytesToHex(bytes.slice(o, o + 32));
  o += 32;
  need(32, 'paymentPubKey');
  const paymentPubKey = bytesToHex(bytes.slice(o, o + 32));
  o += 32;
  need(20, 'tokenId');
  const tokenId = bytesToHex(bytes.slice(o, o + 20));
  o += 20;
  need(1, 'amountLen');
  const amountLen = bytes[o];
  o += 1;
  if (amountLen === 0 || amountLen > 32) {
    throw new Error(`v3 payload has invalid amountLen ${amountLen} (expected 1..32)`);
  }
  need(amountLen, 'amount');
  const amount = bytesToHex(bytes.slice(o, o + amountLen));
  o += amountLen;
  need(1, 'slotCount');
  const slotCount = bytes[o];
  o += 1;
  if (slotCount === 0) {
    throw new Error('v3 payload has zero slots');
  }
  const noteSecretsMap: [Hash, Secret][] = [];
  for (let i = 0; i < slotCount; i++) {
    need(64, `slot[${i}]`);
    const noteAddressHash = bytesToHex(bytes.slice(o, o + 32));
    o += 32;
    const noteSecret = bytesToHex(bytes.slice(o, o + 32));
    o += 32;
    noteSecretsMap.push([noteAddressHash, noteSecret]);
  }
  let expiresAt: Hex | undefined;
  if (expiring) {
    need(EXPIRES_AT_BYTES, 'expiresAt');
    let v = 0n;
    for (let i = 0; i < EXPIRES_AT_BYTES; i++) v = (v << 8n) | BigInt(bytes[o + i]);
    o += EXPIRES_AT_BYTES;
    expiresAt = `0x${v.toString(16)}` as Hex;
  }
  if (o !== bytes.length) {
    throw new Error(`unexpected trailing bytes (${bytes.length - o}) after v3 unpack`);
  }
  return {
    kind: 'ppv2-sdk-payment-request',
    version: 1,
    chainId,
    paymentId,
    tag,
    paymentPubKey,
    tokenId: tokenId.toLowerCase() as Address,
    amount,
    noteSecretsMap,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    createdAt: '',
  };
}

function packPaymentRequest(payload: PaymentRequestPayloadV1 | PaymentRequestPayloadV2): Uint8Array {
  const rawAmount = payload.amount.startsWith('0x') || payload.amount.startsWith('0X')
    ? payload.amount.slice(2)
    : payload.amount;
  const evenAmount = rawAmount.length % 2 === 0 ? rawAmount : '0' + rawAmount;
  const amountBytes = hexToBytes(('0x' + evenAmount) as Hex);
  if (amountBytes.length > 0xff) throw new Error('amount too large to pack');
  const parts: number[] = [];
  parts.push(payload.version === 1 ? MARKER_REQUEST_V1 : MARKER_REQUEST_V2);
  const c = payload.chainId >>> 0;
  parts.push((c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
  for (const b of uuidToBytes(payload.requestId)) parts.push(b);
  for (const b of hexToBytes(payload.recipientAddress, 20)) parts.push(b);
  if (payload.version === 1) {
    for (const b of hexToBytes(payload.noteAddressHash, 32)) parts.push(b);
  } else {
    for (const b of hexToBytes(payload.recipientViewingPubKey, 32)) parts.push(b);
  }
  for (const b of hexToBytes(payload.tokenId, 20)) parts.push(b);
  parts.push(amountBytes.length);
  for (const b of amountBytes) parts.push(b);
  return new Uint8Array(parts);
}

function unpackPaymentRequest(bytes: Uint8Array): PaymentRequestPayloadV1 | PaymentRequestPayloadV2 {
  const marker = bytes[0];
  if (marker !== MARKER_REQUEST_V1 && marker !== MARKER_REQUEST_V2) {
    throw new Error(`Unknown payment request marker: 0x${marker.toString(16)}`);
  }
  let o = 1;
  const chainId = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  o += 4;
  const requestId = bytesToUuid(bytes.slice(o, o + 16));
  o += 16;
  const recipientAddress = bytesToHex(bytes.slice(o, o + 20));
  o += 20;
  const thirtyTwo = bytesToHex(bytes.slice(o, o + 32));
  o += 32;
  const tokenId = bytesToHex(bytes.slice(o, o + 20));
  o += 20;
  const amountLen = bytes[o];
  o += 1;
  const amount = bytesToHex(bytes.slice(o, o + amountLen));
  o += amountLen;
  if (o !== bytes.length) {
    throw new Error(`unexpected trailing bytes (${bytes.length - o}) after unpack`);
  }
  if (marker === MARKER_REQUEST_V1) {
    return {
      kind: 'ppv2-payment-request',
      version: 1,
      requestId,
      chainId,
      recipientAddress: recipientAddress.toLowerCase() as Hex,
      tokenId: tokenId.toLowerCase() as Hex,
      amount,
      noteAddressHash: thirtyTwo,
      createdAt: '',
    };
  }
  return {
    kind: 'ppv2-payment-request',
    version: 2,
    requestId,
    chainId,
    recipientAddress: recipientAddress.toLowerCase() as Hex,
    recipientViewingPubKey: thirtyTwo,
    tokenId: tokenId.toLowerCase() as Hex,
    amount,
    createdAt: '',
  };
}

// Shared hex predicates (also used by parsePaymentRequestPayload below) so the
// importer's classifier validates payloads exactly as strictly as the parser.
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const isHexValue = (v: unknown): v is Hex => typeof v === 'string' && HEX_RE.test(v);
const isHexOfBytesValue = (v: unknown, bytes: number): v is Hex =>
  isHexValue(v) && (v as string).length === 2 + bytes * 2;

/** True only for a fully-formed SDK-native (V3) payload — every field present
 *  and correctly sized, noteSecretsMap non-empty with valid 32-byte entries.
 *  Matches the checks in parsePaymentRequestPayload's V3 branch. */
export function isValidSdkPaymentRequestPayload(payload: unknown): payload is PaymentRequestPayloadV3 {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<PaymentRequestPayloadV3>;
  if (
    typeof p.chainId !== 'number'
    || !isHexOfBytesValue(p.paymentId, 32)
    || !isHexOfBytesValue(p.tag, 32)
    || !isHexOfBytesValue(p.paymentPubKey, 32)
    || (p.paymentPrivKey !== undefined && !isHexOfBytesValue(p.paymentPrivKey, 32))
    || (p.recipientAddress !== undefined && !isHexOfBytesValue(p.recipientAddress, 20))
    || !isHexOfBytesValue(p.tokenId, 20)
    || !isHexValue(p.amount)
    || (p.expiresAt !== undefined && !isPackableExpiresAt(p.expiresAt))
    || !Array.isArray(p.noteSecretsMap)
    || p.noteSecretsMap.length === 0
  ) {
    return false;
  }
  for (const entry of p.noteSecretsMap) {
    if (
      !Array.isArray(entry)
      || entry.length !== 2
      || !isHexOfBytesValue(entry[0], 32)
      || !isHexOfBytesValue(entry[1], 32)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Classifies a pasted/decoded SINGLE payment-request payload for the importer
 * (issue #212). Recognizes the three shapes this app has produced, and ONLY
 * when the payload is fully valid for that shape — so malformed JSON falls
 * through to null (the importer's "unrecognized" path) instead of being routed
 * to a restore/success path that reports success or throws a low-level error.
 *  - 'sdk-v3'        `ppv2-sdk-payment-request` (per-request keypair; restorable
 *                    when the private half rode along), including the kind-less
 *                    backup shape carrying the same structural fields
 *  - 'registered-v2' `ppv2-payment-request` v2 (registered viewing key; nothing
 *                    is stored locally, so there is nothing to import)
 *  - 'legacy-v1'     `ppv2-payment-request` v1 (needed this device's local
 *                    noteSecret stash; not importable from the payload alone)
 * Returns null when the object is none of these (or is a malformed instance).
 */
export type SinglePaymentRequestShape = 'sdk-v3' | 'registered-v2' | 'legacy-v1';

export function classifySinglePaymentRequestPayload(payload: unknown): SinglePaymentRequestShape | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<PaymentRequestPayloadV3>
    & Partial<PaymentRequestPayloadV2>
    & Partial<PaymentRequestPayloadV1>
    & { kind?: unknown; version?: unknown };

  // SDK-native V3 — explicit kind OR the kind-less backup shape. Either way it
  // must be a fully valid V3 payload before we route it to the restore path.
  if (candidate.kind === 'ppv2-sdk-payment-request') {
    return isValidSdkPaymentRequestPayload(candidate) ? 'sdk-v3' : null;
  }
  const looksKindlessV3 =
    candidate.kind === undefined
    && candidate.paymentId !== undefined
    && candidate.noteSecretsMap !== undefined
    && candidate.paymentPubKey !== undefined;
  if (looksKindlessV3) {
    return isValidSdkPaymentRequestPayload(candidate) ? 'sdk-v3' : null;
  }

  if (candidate.kind === 'ppv2-payment-request') {
    // Registered V2 — require the full v2 field set (mirrors the parser), so a
    // stub like {kind,version:2,recipientViewingPubKey} is NOT reported as an
    // imported request.
    if (
      candidate.version === 2
      && typeof candidate.requestId === 'string'
      && typeof candidate.chainId === 'number'
      && typeof candidate.recipientAddress === 'string'
      && typeof candidate.tokenId === 'string'
      && typeof candidate.amount === 'string'
      && typeof candidate.recipientViewingPubKey === 'string'
    ) {
      return 'registered-v2';
    }
    // Legacy V1 — require the full v1 field set incl. noteAddressHash.
    if (
      candidate.version === 1
      && typeof candidate.requestId === 'string'
      && typeof candidate.chainId === 'number'
      && typeof candidate.recipientAddress === 'string'
      && typeof candidate.tokenId === 'string'
      && typeof candidate.amount === 'string'
      && typeof candidate.noteAddressHash === 'string'
    ) {
      return 'legacy-v1';
    }
  }
  return null;
}

export function paymentRequestIdToHex(requestId: string): Hex {
  const cleaned = requestId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(cleaned)) {
    throw new Error(`paymentRequestIdToHex: '${requestId}' is not a 32-hex-char UUID`);
  }
  return `0x${cleaned}` as Hex;
}

export function paymentRequestIdFromHex(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error(`paymentRequestIdFromHex: '${hex}' is not 16 bytes of hex`);
  }
  const lower = clean.toLowerCase();
  return [
    lower.slice(0, 8),
    lower.slice(8, 12),
    lower.slice(12, 16),
    lower.slice(16, 20),
    lower.slice(20, 32),
  ].join('-');
}

export function parsePaymentRequestPayload(raw: string): PaymentRequestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Payment request is not valid JSON.');
  }

  const HEX = /^0x[0-9a-fA-F]+$/;
  const isHex = (v: unknown): v is Hex => typeof v === 'string' && HEX.test(v);
  const isHexOfBytes = (v: unknown, bytes: number): v is Hex =>
    isHex(v) && (v as string).length === 2 + bytes * 2;
  const parseSignature = (sig: unknown): PaymentRequestSignature | undefined => {
    // ONLY a wholly ABSENT field is unsigned-by-design → undefined. `null` is
    // NOT absence: JSON cannot carry `undefined`, so a tampered link sets
    // `signature:null` to strip the seal while keeping the field present. If we
    // let `null` mean "unsigned" the gate pays it — the exact malformed-seal
    // bypass we close below for garbage objects. A present-but-null seal is a
    // rejected link, same as any other malformed one.
    if (sig === undefined) return undefined;
    // Anything present that is not a plain object (null, a string, a number)
    // cannot be a seal. Reject it with a controlled message BEFORE the shape
    // check below dereferences it — `null.signer` would otherwise throw a raw
    // TypeError that callers don't recognise as "malformed link".
    if (typeof sig !== 'object' || sig === null) {
      throw new Error('Payment request signature is malformed.');
    }
    const candidate = sig as Partial<PaymentRequestSignature>;
    if (
      isHexOfBytes(candidate.signer, 20)
      && isHex(candidate.signature)
      && typeof candidate.signedAt === 'string'
    ) {
      return {
        signer: candidate.signer.toLowerCase() as Address,
        signature: candidate.signature as Hex,
        signedAt: candidate.signedAt,
        sellerName: typeof candidate.sellerName === 'string' ? candidate.sellerName : undefined,
      };
    }
    // A signature field is PRESENT but does not parse. Do NOT coerce it to
    // "unsigned" — that turned a tampered-and-corrupted seal into a payable
    // request at the gate (the sig no longer verifies, so an attacker just
    // mangles it). A malformed seal is a rejected link.
    throw new Error('Payment request signature is malformed.');
  };

  const sdk = parsed as Partial<PaymentRequestPayloadV3> & { kind?: string };
  if (sdk?.kind === 'ppv2-sdk-payment-request') {
    if (
      typeof sdk.chainId !== 'number'
      || !isHexOfBytes(sdk.paymentId, 32)
      || !isHexOfBytes(sdk.tag, 32)
      || !isHexOfBytes(sdk.paymentPubKey, 32)
      || (sdk.paymentPrivKey !== undefined && !isHexOfBytes(sdk.paymentPrivKey, 32))
      || (sdk.recipientAddress !== undefined && !isHexOfBytes(sdk.recipientAddress, 20))
      || !isHexOfBytes(sdk.tokenId, 20)
      || !isHex(sdk.amount)
      || (sdk.expiresAt !== undefined && !isPackableExpiresAt(sdk.expiresAt))
      || !Array.isArray(sdk.noteSecretsMap)
      || sdk.noteSecretsMap.length === 0
    ) {
      throw new Error('Payment request SDK-native payload is invalid.');
    }
    for (const entry of sdk.noteSecretsMap) {
      if (
        !Array.isArray(entry)
        || entry.length !== 2
        || !isHexOfBytes(entry[0], 32)
        || !isHexOfBytes(entry[1], 32)
      ) {
        throw new Error('Payment request SDK-native noteSecretsMap entry is invalid.');
      }
    }
    return {
      kind: 'ppv2-sdk-payment-request',
      version: 1,
      chainId: sdk.chainId,
      ...(sdk.recipientAddress
        ? { recipientAddress: sdk.recipientAddress.toLowerCase() as Hex }
        : {}),
      paymentId: sdk.paymentId as Hex,
      tag: sdk.tag as Hex,
      paymentPubKey: sdk.paymentPubKey as Hex,
      paymentPrivKey: sdk.paymentPrivKey as Hex | undefined,
      tokenId: sdk.tokenId.toLowerCase() as Hex,
      amount: sdk.amount as Hex,
      noteSecretsMap: sdk.noteSecretsMap as [Hex, Hex][],
      ...(sdk.expiresAt !== undefined ? { expiresAt: normalizeExpiresAt(sdk.expiresAt as string) } : {}),
      createdAt: typeof sdk.createdAt === 'string' ? sdk.createdAt : '',
      signature: parseSignature(sdk.signature),
    };
  }

  const base = parsed as Partial<PaymentRequestPayloadV1 | PaymentRequestPayloadV2> & { version?: number };
  if (
    base?.kind !== 'ppv2-payment-request'
    || typeof base.requestId !== 'string'
    || typeof base.chainId !== 'number'
    || typeof base.recipientAddress !== 'string'
    || typeof base.tokenId !== 'string'
    || typeof base.amount !== 'string'
  ) {
    throw new Error('Payment request payload is invalid.');
  }

  const normalized = {
    ...base,
    recipientAddress: (base.recipientAddress as string).toLowerCase() as Hex,
    tokenId: (base.tokenId as string).toLowerCase() as Hex,
  };

  if (normalized.version === 1) {
    const v1 = normalized as Partial<PaymentRequestPayloadV1> & { signature?: unknown };
    if (typeof v1.noteAddressHash !== 'string') {
      throw new Error('Payment request v1 is missing noteAddressHash.');
    }
    // v1 never had request signing, and the payable gate short-circuits it
    // WITHOUT verifying anything. A v1 that nonetheless carries a signature is
    // a downgrade: a signed v2 relabelled version:1 with an attacker-chosen
    // noteAddressHash (v1's fund-routing field, which is unsigned). Reject it.
    if (v1.signature !== undefined) {
      throw new Error('Payment request v1 must not carry a signature.');
    }
    return v1 as PaymentRequestPayloadV1;
  }

  if (normalized.version === 2) {
    const v2 = normalized as Partial<PaymentRequestPayloadV2>;
    if (typeof v2.recipientViewingPubKey !== 'string') {
      throw new Error('Payment request v2 is missing recipientViewingPubKey.');
    }
    return {
      ...v2,
      signature: parseSignature(v2.signature),
    } as PaymentRequestPayloadV2;
  }

  throw new Error(`Unsupported payment request version: ${normalized.version}`);
}

/**
 * Fixed non-secret filler for the noteSecret tuple slot in SHARED payloads.
 * The payer never needs the recipient's noteSecrets — the fulfill path maps
 * only the tuple KEYS (the pre-committed noteAddressHashes) — but the V3
 * wire layout carries (hash, secret) tuples, and older builds' decoders
 * expect exactly that layout. Keeping the tuple shape with this constant in
 * the value slot keeps old builds decoding while no recipient-local secret
 * ever leaves the device.
 */
export const SHARED_NOTE_SECRET_PLACEHOLDER: Secret = `0x${'00'.repeat(32)}` as Secret;

/**
 * Public-request sanitizer — the single choke point for anything that leaves
 * the recipient's device (share links, copyable JSON, rebuilt links). Strips
 * the per-request private key and replaces every noteSecret with the fixed
 * placeholder. V1/V2 payloads carry no recipient-local secrets and pass
 * through unchanged. If a payload was signed over REAL secrets (pre-fix
 * links), the signature no longer matches the sanitized bytes, so it is
 * dropped rather than shipping the secrets to keep it verifiable.
 */
export function sanitizePaymentRequestPayloadForSharing(payload: PaymentRequestPayload): PaymentRequestPayload {
  if (payload.kind !== 'ppv2-sdk-payment-request') return payload;
  const { paymentPrivKey: _omitted, recipientAddress, ...rest } = payload;
  const secretsChanged = payload.noteSecretsMap.some(([, secret]) => secret !== SHARED_NOTE_SECRET_PLACEHOLDER);
  // A signature computed over the real secrets map would fail verification
  // against the sanitized payload — and shipping the secrets to preserve it is
  // exactly the leak this guards against. New create-flow signatures are
  // computed AFTER sanitizing, so they survive this untouched.
  const signature = secretsChanged ? undefined : rest.signature;
  // recipientAddress is a field of the EIP-712 message, so a request that
  // KEEPS its signature has to keep the address or the payer cannot verify.
  // Everything else drops it: the SDK's public request has no such field,
  // fulfilment never reads one, and leaving it in undid the blindness the
  // note-address hashes were built to give (2026-08-31).
  const keepAddress = !!signature && recipientAddress !== undefined;
  // Idempotence by IDENTITY: an already-clean payload comes back as the same
  // reference, which callers rely on. Only rebuild when something must change.
  const mustDropAddress = recipientAddress !== undefined && !keepAddress;
  if (!secretsChanged && payload.paymentPrivKey === undefined && !mustDropAddress) return payload;
  return {
    ...rest,
    ...(keepAddress ? { recipientAddress } : {}),
    noteSecretsMap: payload.noteSecretsMap.map(
      ([noteAddressHash]) => [noteAddressHash, SHARED_NOTE_SECRET_PLACEHOLDER] as [Hash, Secret],
    ),
    signature,
  };
}

export function encodePaymentRequestPayloadForUrl(payload: PaymentRequestPayload): string {
  if (payload.kind === 'ppv2-sdk-payment-request') {
    // Choke point: no matter what a caller passes, the encoded link carries
    // neither the per-request private key nor any recipient noteSecret.
    const shareable = sanitizePaymentRequestPayloadForSharing(payload) as PaymentRequestPayloadV3;
    if (shareable.signature) {
      return toBase64Url(JSON.stringify(shareable));
    }
    return bytesToBase64Url(packPaymentRequestV3(shareable));
  }
  if (payload.version === 2 && payload.signature) {
    return toBase64Url(JSON.stringify(payload));
  }
  return bytesToBase64Url(packPaymentRequest(payload));
}

export function decodePaymentRequestPayloadFromUrl(encoded: string): PaymentRequestPayload {
  const bytes = base64UrlToBytes(encoded);
  if (bytes.length === 0) {
    throw new Error('Empty payment request payload.');
  }
  if (bytes[0] === 0x7B) {
    const decoded = fromBase64Url(encoded);
    return parsePaymentRequestPayload(decoded);
  }
  if (bytes[0] === MARKER_REQUEST_V3 || bytes[0] === MARKER_REQUEST_V3_EXPIRING) {
    return unpackPaymentRequestV3(bytes);
  }
  return unpackPaymentRequest(bytes);
}

export function encodePaymentReceiptPayloadForUrl(payload: PaymentReceiptPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodePaymentReceiptPayloadFromUrl(encoded: string): PaymentReceiptPayload {
  return parsePaymentReceiptPayload(fromBase64Url(encoded));
}

export function parsePaymentReceiptPayload(raw: string): PaymentReceiptPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Payment receipt is not valid JSON.');
  }

  const receipt = parsed as Partial<PaymentReceiptPayload>;
  if (
    receipt?.kind !== 'ppv2-payment-receipt'
    || receipt.version !== 1
    || typeof receipt.requestId !== 'string'
    || typeof receipt.chainId !== 'number'
    || typeof receipt.recipientAddress !== 'string'
    || typeof receipt.tokenId !== 'string'
    || typeof receipt.amount !== 'string'
    || typeof receipt.noteAddressHash !== 'string'
    || typeof receipt.commitment !== 'string'
    || typeof receipt.label !== 'string'
    || typeof receipt.txHash !== 'string'
  ) {
    throw new Error('Payment receipt payload is invalid.');
  }

  return receipt as PaymentReceiptPayload;
}

export function mergeImportedNote(accountExport: AccountExport | null, note: AccountExport['notes'][number]): AccountExport {
  const notes = accountExport?.notes ?? [];
  // A receipt always carries the note as ACTIVE. Re-importing the same link
  // AFTER it has been anchored/spent would otherwise overwrite the local SPENT
  // entry with an ACTIVE one — inflating the balance until the next sync, and
  // producing a note the wallet will try (and fail) to spend on-chain. Keep a
  // terminal local status; this mirrors the discovery merge's own SPENT/EXITED
  // skip in sdk-provider.
  //
  // EXIT_PENDING is held here too. It is not terminal — discovery can still send
  // it back to ACTIVE — but it means a ragequit for this note is already mined
  // and waiting to settle, and a receipt import must not quietly reset that to
  // ACTIVE and make the note look spendable again. Discovery is the only thing
  // allowed to resolve it, in either direction.
  //
  // Note this is a DENYLIST, unlike the SDK where spendability is an allowlist on
  // ACTIVE. A new status is therefore NOT safe by default here: it has to be
  // added by hand, which is exactly why this one was missed.
  const existing = notes.find((entry) => entry.commitment === note.commitment);
  const existingStatus = (existing as { status?: unknown } | undefined)?.status;
  if (
    existingStatus === NoteStatus.SPENT ||
    existingStatus === NoteStatus.EXITED ||
    existingStatus === NoteStatus.EXIT_PENDING
  ) {
    return {
      notes,
      syncCursor: accountExport?.syncCursor ?? '0x0',
    };
  }
  const nextNotes = notes.filter((entry) => entry.commitment !== note.commitment);
  nextNotes.push(note);
  return {
    notes: nextNotes,
    syncCursor: accountExport?.syncCursor ?? '0x0',
  };
}

// ------------------------------------------------------------ Stellar (v3)

/**
 * The v3 envelope on Stellar: the same `ppv2-sdk-payment-request` the EVM
 * flow shares, with the Stellar chain id and the request the Stellar SDK's
 * `generatePaymentRequest` returned. The payer fulfils from the slot hashes,
 * the payment key and the tag alone, so the link names no account.
 *
 * Differences from the EVM shape, all forced by the chain:
 * - `tokenId` is the asset's Soroban contract address (C..., a case-sensitive
 *   StrKey), never lowercased.
 * - never a `recipientAddress` and never a signature: EIP-712 is EVM only,
 *   and a Stellar request is always the blind kind.
 * - `expiresAt` rides along (the SDK's own field), so the payer refuses a
 *   request the recipient no longer scans for, rather than paying into it.
 *
 * The packed binary form has a 20-byte tokenId, so this envelope travels as
 * JSON (services/stellar/stellar-request.ts wraps it in an `xlm.` link).
 */
export type StellarSdkPaymentRequestPayload = {
  kind: 'ppv2-sdk-payment-request';
  version: 1;
  chainId: number;
  paymentId: Hex;
  tag: Hex;
  paymentPubKey: PublicKey;
  /** Asset contract (C...). */
  tokenId: string;
  amount: Hex;
  /** Slot hashes with the shared placeholder in the secret slot (see SHARED_NOTE_SECRET_PLACEHOLDER). */
  noteSecretsMap: [Hash, Secret][];
  /** Unix ms (hex) after which the request must not be paid. */
  expiresAt?: Hex;
  createdAt: string;
};

/** The SDK's public PaymentRequest, built from the envelope. */
export type StellarSdkPaymentRequest = {
  paymentId: Hex;
  noteAddressHashes: Hash[];
  amount: Hex;
  tokenId: string;
  tag: Hex;
  paymentPubKey: PublicKey;
  expiresAt?: Hex;
};

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ANY = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Strict parse of a Stellar v3 envelope. Every field must be present and
 * well formed; anything else on the object is dropped. A link is
 * attacker-controlled input that decides where money goes, so a field this
 * parser does not know (an address, a signature) is refused, not ignored.
 */
export function parseStellarSdkPaymentRequestPayload(raw: string, expectedChainId: number): StellarSdkPaymentRequestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('This payment request link is damaged.');
  }
  const p = parsed as Partial<StellarSdkPaymentRequestPayload> & Record<string, unknown>;
  const invalid = () => new Error('This payment request link is not valid for Stellar testnet.');
  if (!p || typeof p !== 'object' || p.kind !== 'ppv2-sdk-payment-request' || p.version !== 1) throw invalid();
  if (p.chainId !== expectedChainId) throw invalid();
  if ('recipientAddress' in p || 'signature' in p || 'paymentPrivKey' in p) throw invalid();
  if (
    typeof p.paymentId !== 'string' || !HEX_32.test(p.paymentId)
    || typeof p.tag !== 'string' || !HEX_32.test(p.tag)
    || typeof p.paymentPubKey !== 'string' || !HEX_32.test(p.paymentPubKey)
    || !isStellarContractAddress(p.tokenId)
    || typeof p.amount !== 'string' || !HEX_ANY.test(p.amount) || BigInt(p.amount) <= 0n
    || (p.expiresAt !== undefined && (typeof p.expiresAt !== 'string' || !HEX_ANY.test(p.expiresAt)))
    || !Array.isArray(p.noteSecretsMap) || p.noteSecretsMap.length === 0 || p.noteSecretsMap.length > 0xff
  ) {
    throw invalid();
  }
  for (const entry of p.noteSecretsMap) {
    if (
      !Array.isArray(entry) || entry.length !== 2
      || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
      || !HEX_32.test(entry[0]) || !HEX_32.test(entry[1])
    ) {
      throw invalid();
    }
  }
  return {
    kind: 'ppv2-sdk-payment-request',
    version: 1,
    chainId: p.chainId,
    paymentId: p.paymentId as Hex,
    tag: p.tag as Hex,
    paymentPubKey: p.paymentPubKey as PublicKey,
    // Case-sensitive StrKey: kept exactly as sent.
    tokenId: p.tokenId as string,
    amount: p.amount as Hex,
    noteSecretsMap: (p.noteSecretsMap as [Hash, Secret][]).map(([hash, secret]) => [hash, secret]),
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt as Hex } : {}),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
  };
}

/** The shareable copy: every secret slot replaced with the placeholder. */
export function sanitizeStellarSdkPaymentRequestForSharing(payload: StellarSdkPaymentRequestPayload): StellarSdkPaymentRequestPayload {
  return {
    kind: 'ppv2-sdk-payment-request',
    version: 1,
    chainId: payload.chainId,
    paymentId: payload.paymentId,
    tag: payload.tag,
    paymentPubKey: payload.paymentPubKey,
    tokenId: payload.tokenId,
    amount: payload.amount,
    noteSecretsMap: payload.noteSecretsMap.map(([hash]) => [hash, SHARED_NOTE_SECRET_PLACEHOLDER] as [Hash, Secret]),
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
    createdAt: payload.createdAt,
  };
}

/** The SDK's public request (what prepareFulfillPaymentRequest takes). The slot keys ARE the hashes. */
export function toStellarSdkPaymentRequest(payload: StellarSdkPaymentRequestPayload): StellarSdkPaymentRequest {
  return {
    paymentId: payload.paymentId,
    noteAddressHashes: payload.noteSecretsMap.map(([hash]) => hash),
    amount: payload.amount,
    tokenId: payload.tokenId,
    tag: payload.tag,
    paymentPubKey: payload.paymentPubKey,
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
  };
}

/** The envelope for a request the Stellar SDK just generated (public half only). */
export function stellarSdkPaymentRequestPayload(
  request: StellarSdkPaymentRequest,
  chainId: number,
  createdAt: string = new Date().toISOString(),
): StellarSdkPaymentRequestPayload {
  return sanitizeStellarSdkPaymentRequestForSharing({
    kind: 'ppv2-sdk-payment-request',
    version: 1,
    chainId,
    paymentId: request.paymentId,
    tag: request.tag,
    paymentPubKey: request.paymentPubKey,
    tokenId: request.tokenId,
    amount: request.amount,
    noteSecretsMap: request.noteAddressHashes.map((hash) => [hash, SHARED_NOTE_SECRET_PLACEHOLDER] as [Hash, Secret]),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    createdAt,
  });
}
