import { describe, expect, test } from 'bun:test';
import { bigintToHex } from '@privacy-pools-v2/sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  assertPaymentRequestPayable,
  decodePaymentRequestPayloadFromUrl,
  encodePaymentRequestPayloadForUrl,
  getPaymentRequestSigningDomain,
  getPaymentRequestSigningMessage,
  getPaymentRequestV3TypedData,
  isPaymentRequestExpired,
  isValidSdkPaymentRequestPayload,
  normalizeExpiresAt,
  parsePaymentRequestPayload,
  PAYMENT_REQUEST_EXPIRED_MESSAGE,
  PAYMENT_REQUEST_SIGNING_TYPES,
  paymentRequestRefusalMessage,
  SHARED_NOTE_SECRET_PLACEHOLDER,
  type PaymentRequestPayloadV3,
} from '@/services/payment-request-codec';
import { buildShareLinkForRecord, type StoredRequestRecordLike } from '@/services/payment-request-list';
import { PaymentRequestServiceStateSchema } from '@/services/payment-request-state-schema';
import type { Hash, Hex, PublicKey, Secret } from '@/services/sdk-types';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const CHAIN = 11155111;
const h = (byte: string) => `0x${byte.repeat(32)}` as Hex;

// 2026-10-09T00:00:00.000Z, what generatePaymentRequest stamps 7 days after
// a request made on 2026-10-02.
const EXPIRES_MS = 1_791_504_000_000;
// The SDK's own producer, padded to a 32-byte word (DEV-515): a compact
// hand-written value hid that real requests could not be packed.
const EXPIRES_AT = bigintToHex(BigInt(EXPIRES_MS)) as Hex;

/** A shareable v3 request: placeholder secrets, no address, as the create flow sanitizes it. */
const shareable = (slots = 2): PaymentRequestPayloadV3 => ({
  kind: 'ppv2-sdk-payment-request',
  version: 1,
  chainId: CHAIN,
  paymentId: h('12'),
  tag: h('34'),
  paymentPubKey: h('ab') as unknown as PublicKey,
  tokenId: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Hex,
  amount: '0x4c4b40' as Hex,
  noteSecretsMap: Array.from({ length: slots }, (_, i) => [
    `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as Hash,
    SHARED_NOTE_SECRET_PLACEHOLDER,
  ] as [Hash, Secret]),
  createdAt: '',
});

const bytesOf = (encoded: string) => Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function sign(payload: PaymentRequestPayloadV3): Promise<PaymentRequestPayloadV3> {
  const withAddress = { ...payload, recipientAddress: account.address as Hex };
  // The same helper the create flow signs with.
  const domain = getPaymentRequestSigningDomain(CHAIN);
  const typed = getPaymentRequestV3TypedData(withAddress, '');
  const signature = typed.primaryType === 'ExpiringPaymentRequest'
    ? await account.signTypedData({ domain, ...typed })
    : await account.signTypedData({ domain, ...typed });
  return { ...withAddress, signature: { signer: account.address, signature, signedAt: '2026-10-02T00:00:00.000Z' } };
}

describe('the binary link format', () => {
  // Pinned field by field: a request without a deadline must keep packing
  // exactly as every link already in the wild, or old links stop decoding the
  // same way and old builds stop opening new ones.
  test('a request without expiresAt packs under 0x03, byte for byte as before', () => {
    const p = shareable(2);
    const expected = Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from([0x00, 0xaa, 0x36, 0xa7]), // 11155111
      Buffer.from(p.paymentId.slice(2), 'hex'),
      Buffer.from(p.tag.slice(2), 'hex'),
      Buffer.from(String(p.paymentPubKey).slice(2), 'hex'),
      Buffer.from(p.tokenId.slice(2), 'hex'),
      Buffer.from([0x03, 0x4c, 0x4b, 0x40]), // amountLen, amount
      Buffer.from([0x02]), // slotCount
      ...p.noteSecretsMap.map(([hash, secret]) => Buffer.from(hash.slice(2) + secret.slice(2), 'hex')),
    ]);
    expect(bytesOf(encodePaymentRequestPayloadForUrl(p)).toString('hex')).toBe(expected.toString('hex'));
  });

  test('a request with expiresAt packs under 0x04: the same layout plus 8 big-endian bytes of unix ms', () => {
    const legacy = bytesOf(encodePaymentRequestPayloadForUrl(shareable(2)));
    const expiring = bytesOf(encodePaymentRequestPayloadForUrl({ ...shareable(2), expiresAt: EXPIRES_AT }));
    expect(expiring[0]).toBe(0x04);
    expect(expiring.length).toBe(legacy.length + 8);
    expect(expiring.subarray(1, legacy.length).toString('hex')).toBe(legacy.subarray(1).toString('hex'));
    expect(expiring.subarray(legacy.length).toString('hex')).toBe(EXPIRES_MS.toString(16).padStart(16, '0'));
  });

  test('a 5-slot expiring link (what the create flow makes) stays well inside URL limits', () => {
    // Worst case: the largest amount the format allows (32 bytes).
    const encoded = encodePaymentRequestPayloadForUrl({
      ...shareable(5), amount: `0x${'ff'.repeat(32)}` as Hex, expiresAt: EXPIRES_AT,
    });
    // 483 bytes (8 of them the deadline), base64url. 2000 is the conservative
    // ceiling for a URL that has to survive chat apps and older browsers.
    expect(bytesOf(encoded).length).toBe(483);
    expect(`https://v2.privacypools.com/pay/${encoded}`.length).toBeLessThan(2000);
  });

  test('a truncated deadline is refused, not read as a shorter one', () => {
    const bytes = bytesOf(encodePaymentRequestPayloadForUrl({ ...shareable(1), expiresAt: EXPIRES_AT }));
    const cut = Buffer.from(bytes.subarray(0, bytes.length - 3)).toString('base64url');
    expect(() => decodePaymentRequestPayloadFromUrl(cut)).toThrow(/expiresAt/);
  });

  test('a deadline wider than 8 bytes cannot be packed', () => {
    expect(() => encodePaymentRequestPayloadForUrl({ ...shareable(1), expiresAt: `0x1${'0'.repeat(16)}` as Hex }))
      .toThrow();
  });
});

describe('expiresAt round-trips', () => {
  test('through the binary link', () => {
    const decoded = decodePaymentRequestPayloadFromUrl(
      encodePaymentRequestPayloadForUrl({ ...shareable(), expiresAt: EXPIRES_AT }),
    ) as PaymentRequestPayloadV3;
    expect(BigInt(decoded.expiresAt!)).toBe(BigInt(EXPIRES_AT));
    expect({ ...decoded }).toEqual({ ...shareable(), expiresAt: normalizeExpiresAt(EXPIRES_AT) });
  });

  test('through the signed JSON link, and the signature still verifies', async () => {
    const signed = await sign({ ...shareable(), expiresAt: EXPIRES_AT });
    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(signed)) as PaymentRequestPayloadV3;
    expect(BigInt(decoded.expiresAt!)).toBe(BigInt(EXPIRES_AT));
    expect(await assertPaymentRequestPayable(decoded, EXPIRES_MS)).toEqual({ payable: true, signed: true });
  });

  test('through a pasted JSON payload', () => {
    const parsed = parsePaymentRequestPayload(JSON.stringify({ ...shareable(), expiresAt: EXPIRES_AT })) as PaymentRequestPayloadV3;
    expect(BigInt(parsed.expiresAt!)).toBe(BigInt(EXPIRES_AT));
  });

  test('a malformed deadline is a rejected link', () => {
    for (const bad of [123, '123', '0x', '0xzz', `0x${'f'.repeat(17)}`, null]) {
      expect(() => parsePaymentRequestPayload(JSON.stringify({ ...shareable(), expiresAt: bad }))).toThrow();
      expect(isValidSdkPaymentRequestPayload({ ...shareable(), expiresAt: bad })).toBe(false);
    }
  });

  test('a rebuilt link from a stored record keeps the deadline', () => {
    const record: StoredRequestRecordLike = {
      paymentId: h('12'),
      amount: '0x4c4b40',
      tokenId: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      tag: h('34'),
      paymentPubKey: h('ab'),
      recipientAddress: account.address,
      status: 'OPEN',
      createdAt: '0x199a3b1b000',
      expiresAt: EXPIRES_AT,
      noteSecretsMap: [[h('01'), h('99')]],
    };
    const link = buildShareLinkForRecord(CHAIN, record, 'https://x.test')!;
    const decoded = decodePaymentRequestPayloadFromUrl(link.split('/pay#')[1]) as PaymentRequestPayloadV3;
    expect(BigInt(decoded.expiresAt!)).toBe(BigInt(EXPIRES_AT));
  });

  test("ppv2's mirror of the SDK state schema does not strip it", () => {
    const parsed = PaymentRequestServiceStateSchema.parse({
      requests: [{
        paymentId: h('12'),
        noteAddressHashes: [h('01')],
        amount: '0x4c4b40',
        tokenId: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
        tag: h('34'),
        paymentPubKey: h('ab'),
        expiresAt: EXPIRES_AT,
        noteSecretsMap: [[h('01'), h('99')]],
        recipientAddress: account.address,
        status: 'OPEN',
        createdAt: '0x199a3b1b000',
        fulfilledByCommitments: [],
        scanRetiredAt: '0x1',
      }],
    }) as unknown as { requests: { expiresAt?: string; scanRetiredAt?: string }[] };
    expect(parsed.requests[0].expiresAt).toBe(EXPIRES_AT);
    expect(parsed.requests[0].scanRetiredAt).toBe('0x1');
  });
});

describe('an expired request is refused', () => {
  const expiring = { ...shareable(), expiresAt: EXPIRES_AT };

  test('expired means strictly past the deadline, as the SDK compares it', () => {
    expect(isPaymentRequestExpired(expiring, EXPIRES_MS - 1)).toBe(false);
    expect(isPaymentRequestExpired(expiring, EXPIRES_MS)).toBe(false);
    expect(isPaymentRequestExpired(expiring, EXPIRES_MS + 1)).toBe(true);
  });

  test('the payable gate refuses an expired unsigned link with the expiry reason', async () => {
    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(expiring));
    expect(await assertPaymentRequestPayable(decoded, EXPIRES_MS + 1)).toEqual({ payable: false, reason: 'expired' });
    expect(await assertPaymentRequestPayable(decoded, EXPIRES_MS - 1)).toEqual({ payable: true, signed: false });
  });

  test('and an expired signed one', async () => {
    const signed = await sign(expiring);
    expect(await assertPaymentRequestPayable(signed, EXPIRES_MS + 1)).toEqual({ payable: false, reason: 'expired' });
  });

  test('the copy is short, says what to do, and has no em dash', () => {
    expect(paymentRequestRefusalMessage('expired')).toBe(PAYMENT_REQUEST_EXPIRED_MESSAGE);
    expect(PAYMENT_REQUEST_EXPIRED_MESSAGE).toBe('This payment request has expired. Ask for a new one.');
    expect(PAYMENT_REQUEST_EXPIRED_MESSAGE).not.toContain('—');
  });
});

describe('the deadline is under the seal', () => {
  test('stripping expiresAt from a signed link breaks the signature', async () => {
    const { expiresAt: _stripped, ...rest } = await sign({ ...shareable(), expiresAt: EXPIRES_AT });
    expect(await assertPaymentRequestPayable(rest as PaymentRequestPayloadV3, EXPIRES_MS + 1))
      .toEqual({ payable: false, reason: 'tampered' });
  });

  test('moving it later breaks the signature too, and tampering is reported over expiry', async () => {
    const signed = await sign({ ...shareable(), expiresAt: EXPIRES_AT });
    const later = { ...signed, expiresAt: `0x${(EXPIRES_MS + 86_400_000).toString(16)}` as Hex };
    expect(await assertPaymentRequestPayable(later, EXPIRES_MS + 1)).toEqual({ payable: false, reason: 'tampered' });
    expect(await assertPaymentRequestPayable(later, EXPIRES_MS * 2)).toEqual({ payable: false, reason: 'tampered' });
  });

  test('adding one to a request signed without it breaks the signature', async () => {
    const signed = await sign(shareable());
    expect(await assertPaymentRequestPayable({ ...signed, expiresAt: EXPIRES_AT }, 0))
      .toEqual({ payable: false, reason: 'tampered' });
  });
});

describe('a legacy link without expiresAt is still payable', () => {
  test('a 0x03 link made before the deadline was carried decodes with no deadline and is payable at any time', async () => {
    const encoded = encodePaymentRequestPayloadForUrl(shareable());
    expect(bytesOf(encoded)[0]).toBe(0x03);
    const decoded = decodePaymentRequestPayloadFromUrl(encoded) as PaymentRequestPayloadV3;
    expect('expiresAt' in decoded).toBe(false);
    expect(isPaymentRequestExpired(decoded, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(await assertPaymentRequestPayable(decoded, Number.MAX_SAFE_INTEGER)).toEqual({ payable: true, signed: false });
  });

  test('a request signed with the old type (no expiresAt) still verifies', async () => {
    const payload = { ...shareable(), recipientAddress: account.address as Hex };
    const signature = await account.signTypedData({
      domain: getPaymentRequestSigningDomain(CHAIN),
      types: PAYMENT_REQUEST_SIGNING_TYPES,
      primaryType: 'PaymentRequest',
      message: getPaymentRequestSigningMessage(payload, ''),
    });
    const signed = { ...payload, signature: { signer: account.address, signature, signedAt: '2026-09-01T00:00:00.000Z' } };
    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(signed));
    expect(await assertPaymentRequestPayable(decoded, Number.MAX_SAFE_INTEGER)).toEqual({ payable: true, signed: true });
  });
});
