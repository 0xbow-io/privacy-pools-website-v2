/**
 * Stellar payment request links: `xlm.` + base64url(JSON).
 *
 * New links carry the SDK's blind request (the v3 envelope of
 * services/payment-request-codec.ts with the Stellar chain id): pre-computed
 * note slots, a per-request payment key and a tag, made by the Stellar SDK's
 * `generatePaymentRequest`. The payer pays with `prepareFulfillPaymentRequest`
 * and the recipient's session finds the note through the request it kept, so
 * the link names no account and the recipient needs no published viewing key.
 *
 * Older links (`ppv2-stellar-payment-request`, version 1) name the
 * recipient's G... address and are paid with an ordinary private transfer to
 * it. They still decode and pay on the payer side; nothing creates them now.
 *
 * Pure module (no react-native) so it is bun-testable.
 */
import { STELLAR_TESTNET_CONTRACTS, STELLAR_TESTNET_ID } from '@/config/stellar-deployment';
import {
  parseStellarSdkPaymentRequestPayload,
  sanitizeStellarSdkPaymentRequestForSharing,
  type StellarSdkPaymentRequestPayload,
} from '@/services/payment-request-codec';
import { isStellarAccountAddress } from '@/services/stellar/strkey';

export { isStellarAccountAddress };

export const STELLAR_REQUEST_PREFIX = 'xlm.';
const STELLAR_REQUEST_CHAIN_ID = STELLAR_TESTNET_ID;
const G_ADDRESS = /^G[A-Z2-7]{55}$/;

/** An old, address-based request link (payer side only). */
export interface StellarPaymentRequest {
  kind: 'ppv2-stellar-payment-request';
  version: 1;
  requestId: string;
  chainId: number;
  /** Recipient account (G…). */
  recipient: string;
  /** Asset contract (C…); native XLM only for now. */
  asset: string;
  /** Requested amount, stroops, decimal string. */
  amount: string;
  createdAt: string;
}

export type DecodedStellarRequest =
  | { format: 'blind'; request: StellarSdkPaymentRequestPayload }
  | { format: 'address'; request: StellarPaymentRequest };

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isStellarRequestLink(encoded: string | null | undefined): boolean {
  return !!encoded && encoded.startsWith(STELLAR_REQUEST_PREFIX);
}

/** The pay link for a blind request. Only the shareable copy is ever encoded. */
export function encodeStellarBlindRequest(payload: StellarSdkPaymentRequestPayload): string {
  return STELLAR_REQUEST_PREFIX + toBase64Url(JSON.stringify(sanitizeStellarSdkPaymentRequestForSharing(payload)));
}

/** The request id a blind request is listed under: its paymentId, without 0x (64 chars). */
export function stellarBlindRequestId(paymentId: string): string {
  return paymentId.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

/**
 * Old address-based format, kept for the payer side: links already shared
 * before blind requests still open and pay.
 */
export function createStellarRequest(params: { recipient: string; amount: bigint; requestId: string }): StellarPaymentRequest {
  if (!G_ADDRESS.test(params.recipient)) throw new Error('Not a Stellar account address.');
  if (params.amount <= 0n) throw new Error('Enter an amount first.');
  return {
    kind: 'ppv2-stellar-payment-request',
    version: 1,
    requestId: params.requestId,
    chainId: STELLAR_REQUEST_CHAIN_ID,
    recipient: params.recipient,
    asset: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
    amount: params.amount.toString(),
    createdAt: new Date().toISOString(),
  };
}

export function encodeStellarRequest(request: StellarPaymentRequest): string {
  return STELLAR_REQUEST_PREFIX + toBase64Url(JSON.stringify(request));
}

function decodeJson(encoded: string): unknown {
  if (!isStellarRequestLink(encoded)) throw new Error('Not a Stellar payment request.');
  try {
    return JSON.parse(fromBase64Url(encoded.slice(STELLAR_REQUEST_PREFIX.length)));
  } catch {
    throw new Error('This payment request link is damaged.');
  }
}

function validateAddressRequest(parsed: unknown): StellarPaymentRequest {
  const r = parsed as Partial<StellarPaymentRequest>;
  const ok = r.kind === 'ppv2-stellar-payment-request'
    && r.version === 1
    && r.chainId === STELLAR_REQUEST_CHAIN_ID
    && typeof r.requestId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(r.requestId)
    && typeof r.recipient === 'string' && G_ADDRESS.test(r.recipient)
    && r.asset === STELLAR_TESTNET_CONTRACTS.nativeAssetContractId
    && typeof r.amount === 'string' && /^[1-9][0-9]{0,30}$/.test(r.amount)
    && typeof r.createdAt === 'string';
  if (!ok) throw new Error('This payment request link is not valid for Stellar testnet.');
  return r as StellarPaymentRequest;
}

/**
 * Strict decode of an old address-based link: every field must be present and
 * well-formed, the chain and asset must be this deployment's. A link is
 * attacker-controlled input that decides where money goes.
 */
export function decodeStellarRequest(encoded: string): StellarPaymentRequest {
  return validateAddressRequest(decodeJson(encoded));
}

/**
 * Decodes either format. A blind request must be for this deployment's chain
 * and its native XLM asset contract (the only asset the pay page offers).
 */
export function decodeStellarPayLink(encoded: string): DecodedStellarRequest {
  const parsed = decodeJson(encoded) as { kind?: unknown } | null;
  if (parsed?.kind === 'ppv2-sdk-payment-request') {
    const request = parseStellarSdkPaymentRequestPayload(JSON.stringify(parsed), STELLAR_REQUEST_CHAIN_ID);
    if (request.tokenId !== STELLAR_TESTNET_CONTRACTS.nativeAssetContractId) {
      throw new Error('This payment request link is not valid for Stellar testnet.');
    }
    return { format: 'blind', request };
  }
  return { format: 'address', request: validateAddressRequest(parsed) };
}

export type StellarRequestState = {
  paymentId: string;
  fulfilled: boolean;
  /** Commitments the SDK found through this request (its audit trail). */
  commitments: string[];
};

/** The request states in an account export (FULFILLED once a genuine slot was paid). */
export function requestStates(exported: { paymentRequests?: readonly unknown[] }): StellarRequestState[] {
  return (exported.paymentRequests ?? []).flatMap((raw) => {
    const r = raw as { paymentId?: unknown; status?: unknown; fulfilledByCommitments?: unknown };
    if (typeof r?.paymentId !== 'string') return [];
    const commitments = Array.isArray(r.fulfilledByCommitments)
      ? r.fulfilledByCommitments.filter((c): c is string => typeof c === 'string')
      : [];
    return [{ paymentId: r.paymentId, fulfilled: r.status === 'FULFILLED', commitments }];
  });
}

/** Whether a blind request's deadline has passed (no deadline: never). */
export function isStellarRequestExpired(request: StellarSdkPaymentRequestPayload, nowMs: number = Date.now()): boolean {
  return request.expiresAt !== undefined && BigInt(nowMs) > BigInt(request.expiresAt);
}
