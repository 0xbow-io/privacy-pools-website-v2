import { describe, expect, test } from 'bun:test';
import { bigintToHex, DEFAULT_REQUEST_EXPIRY_MS } from '@privacy-pools-v2/sdk';

import {
  decodePaymentRequestPayloadFromUrl,
  encodePaymentRequestPayloadForUrl,
  isPaymentRequestExpired,
  isValidSdkPaymentRequestPayload,
  normalizeExpiresAt,
  SHARED_NOTE_SECRET_PLACEHOLDER,
  type PaymentRequestPayloadV3,
} from '@/services/payment-request-codec';
import { withoutPaymentRequest } from '@/services/payment-request-cleanup';
import type { Hash, Hex, PublicKey, Secret } from '@/services/sdk-types';

// DEV-515: the SDK mints expiresAt with its own bigintToHex, which pads to a
// 32-byte word. The old fixture fed a compact value the SDK never produces, so
// every real request failed "expiresAt too large to pack" while the tests
// passed. Every expiresAt here comes from the SDK's own producer.
const CREATED_MS = 1_791_000_000_000n;
const SDK_EXPIRES_AT = bigintToHex(CREATED_MS + BigInt(DEFAULT_REQUEST_EXPIRY_MS)) as Hex;
const h = (byte: string) => `0x${byte.repeat(32)}` as Hex;

const sdkShaped = (): PaymentRequestPayloadV3 => ({
  kind: 'ppv2-sdk-payment-request',
  version: 1,
  chainId: 1,
  paymentId: h('12'),
  tag: h('34'),
  paymentPubKey: h('ab') as unknown as PublicKey,
  tokenId: '0xdac17f958d2ee523a2206206994597c13d831ec7' as Hex,
  amount: '0x16e360' as Hex,
  noteSecretsMap: [[h('01') as Hash, SHARED_NOTE_SECRET_PLACEHOLDER as Secret]],
  expiresAt: SDK_EXPIRES_AT,
  createdAt: '',
});

describe('payment request expiry in the SDK shape (DEV-515)', () => {
  test('the SDK really pads it to a 32-byte word', () => {
    expect(SDK_EXPIRES_AT.length).toBe(66);
  });

  test('normalizeExpiresAt drops the padding, keeps the value', () => {
    const compact = normalizeExpiresAt(SDK_EXPIRES_AT);
    expect(BigInt(compact)).toBe(BigInt(SDK_EXPIRES_AT));
    expect(compact.length).toBeLessThanOrEqual(18);
  });

  test('a link packs from the SDK shape and decodes to the same deadline', () => {
    const encoded = encodePaymentRequestPayloadForUrl(sdkShaped());
    const decoded = decodePaymentRequestPayloadFromUrl(encoded) as PaymentRequestPayloadV3;
    expect(BigInt(decoded.expiresAt!)).toBe(BigInt(SDK_EXPIRES_AT));
  });

  test('the SDK shape validates, and expiry is judged on the value', () => {
    expect(isValidSdkPaymentRequestPayload(sdkShaped())).toBe(true);
    const deadline = Number(BigInt(SDK_EXPIRES_AT));
    expect(isPaymentRequestExpired(sdkShaped(), deadline - 1)).toBe(false);
    expect(isPaymentRequestExpired(sdkShaped(), deadline + 1)).toBe(true);
  });

  test('a value that really exceeds 8 bytes is still refused', () => {
    const tooBig = bigintToHex(1n << 64n) as Hex;
    expect(() => normalizeExpiresAt(tooBig)).toThrow('expiresAt too large to pack');
    expect(() => encodePaymentRequestPayloadForUrl({ ...sdkShaped(), expiresAt: tooBig })).toThrow(
      'expiresAt too large to pack',
    );
  });
});

// DEV-515: a create whose link cannot be built removes the record the SDK just
// stored. The rule itself, without the react-native storage around it.
describe('withoutPaymentRequest (the unshared-request cleanup rule)', () => {
  const rec = (id: string) => ({ paymentId: id, status: 'OPEN' });
  const A = `0x${'aa'.repeat(32)}`;
  const B = `0x${'bb'.repeat(32)}`;

  test('removes the matching request, case-insensitively, and keeps the rest and the other fields', () => {
    const state = { version: 2, requests: [rec(A), rec(B)] };
    expect(withoutPaymentRequest(state, A.toUpperCase().replace('0X', '0x'))).toEqual({ version: 2, requests: [rec(B)] });
  });

  test('a paymentId that is not there means nothing to write', () => {
    expect(withoutPaymentRequest({ requests: [rec(B)] }, A)).toBeNull();
    expect(withoutPaymentRequest(null, A)).toBeNull();
    expect(withoutPaymentRequest(undefined, A)).toBeNull();
  });
});
