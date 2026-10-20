import { describe, expect, test } from 'bun:test';

import {
  classifySinglePaymentRequestPayload,
  decodePaymentReceiptPayloadFromUrl,
  decodePaymentRequestPayloadFromUrl,
  encodePaymentReceiptPayloadForUrl,
  encodePaymentRequestPayloadForUrl,
  paymentRequestIdFromHex,
  paymentRequestIdToHex,
  SHARED_NOTE_SECRET_PLACEHOLDER,
  type PaymentReceiptPayload,
  type PaymentRequestPayloadV2,
  type PaymentRequestPayloadV3,
} from '@/services/payment-request-codec';
import type { Hex } from '@/services/sdk-types';

const baseV3: PaymentRequestPayloadV3 = {
  kind: 'ppv2-sdk-payment-request',
  version: 1,
  chainId: 11155111,
  recipientAddress: '0x1111111111111111111111111111111111111111',
  paymentId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tag: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  paymentPubKey: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  amount: '0x2386f26fc10000',
  noteSecretsMap: [
    [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ],
    [
      '0x3333333333333333333333333333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    ],
  ],
  createdAt: '2026-06-10T00:00:00.000Z',
};

const paymentPrivKey = '0x5555555555555555555555555555555555555555555555555555555555555555' as Hex;

const baseV2: PaymentRequestPayloadV2 = {
  kind: 'ppv2-payment-request',
  version: 2,
  requestId: 'e63ec791-8595-4a94-a292-6840b7639ee6',
  chainId: 11155111,
  recipientAddress: '0x1111111111111111111111111111111111111111',
  recipientViewingPubKey: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  amount: '0x2386f26fc10000',
  createdAt: '2026-06-10T00:00:00.000Z',
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fromBase64UrlString(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

// The encode path sanitizes every V3 payload: tuple KEYS (the payer-facing
// slot hashes) survive, the value slot carries the fixed placeholder, and the
// recipient-local secrets never appear in the encoded output.
const sanitizedMap = baseV3.noteSecretsMap.map(
  ([noteAddressHash]) => [noteAddressHash, SHARED_NOTE_SECRET_PLACEHOLDER],
) as PaymentRequestPayloadV3['noteSecretsMap'];
const realSecrets = baseV3.noteSecretsMap.map(([, secret]) => secret);

describe('payment request codec', () => {
  test('roundtrips unsigned SDK-native v3 requests through the binary codec (sanitized values)', () => {
    const encoded = encodePaymentRequestPayloadForUrl(baseV3);
    const decoded = decodePaymentRequestPayloadFromUrl(encoded);

    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    // recipientAddress is deliberately absent from an unsigned share link
    // (2026-08-31): the SDK's public request has no such field and fulfilment
    // never reads one.
    const { recipientAddress: _dropped, ...blindV3 } = baseV3;
    expect(decoded).toEqual({
      ...blindV3,
      noteSecretsMap: sanitizedMap,
      createdAt: '',
    });
    // No recipient-local secret rides the link bytes.
    const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    for (const secret of realSecrets) {
      expect(bytes.indexOf(Buffer.from(secret.slice(2), 'hex'))).toBe(-1);
    }
  });

  test('a signature over REAL secrets is dropped rather than shipped (pre-fix payloads)', () => {
    const signed: PaymentRequestPayloadV3 = {
      ...baseV3,
      signature: {
        signer: '0x9999999999999999999999999999999999999999',
        signature: `0x${'12'.repeat(65)}` as Hex,
        signedAt: '2026-06-10T00:01:00.000Z',
        sellerName: 'Bob',
      },
    };

    // Sanitizing changed the secrets map → the signature could no longer
    // verify, so it is dropped and the payload takes the binary path.
    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(signed));
    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    expect((decoded as PaymentRequestPayloadV3).signature).toBeUndefined();
    expect((decoded as PaymentRequestPayloadV3).noteSecretsMap).toEqual(sanitizedMap);
  });

  test('roundtrips signed sanitized v3 requests through the JSON fallback', () => {
    // The create flow signs AFTER sanitizing, so real signed links carry the
    // placeholder map — that signature survives encode/decode.
    const signed: PaymentRequestPayloadV3 = {
      ...baseV3,
      noteSecretsMap: sanitizedMap,
      signature: {
        signer: '0x9999999999999999999999999999999999999999',
        signature: `0x${'12'.repeat(65)}` as Hex,
        signedAt: '2026-06-10T00:01:00.000Z',
        sellerName: 'Bob',
      },
    };

    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(signed));

    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    expect(decoded).toEqual(signed);
  });

  test('strips paymentPrivKey from unsigned SDK-native share links', () => {
    const withPrivateKey: PaymentRequestPayloadV3 = {
      ...baseV3,
      paymentPrivKey,
    };

    const encoded = encodePaymentRequestPayloadForUrl(withPrivateKey);
    const decoded = decodePaymentRequestPayloadFromUrl(encoded);

    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    expect((decoded as PaymentRequestPayloadV3).paymentPrivKey).toBe(undefined);
    // recipientAddress is deliberately absent from an unsigned share link
    // (2026-08-31): the SDK's public request has no such field and fulfilment
    // never reads one.
    const { recipientAddress: _dropped, ...blindV3 } = baseV3;
    expect(decoded).toEqual({
      ...blindV3,
      noteSecretsMap: sanitizedMap,
      createdAt: '',
    });
    const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(bytes.indexOf(Buffer.from(paymentPrivKey.slice(2), 'hex'))).toBe(-1);
  });

  test('strips paymentPrivKey (and the stale signature) from signed key-bearing share links', () => {
    const signedWithPrivateKey: PaymentRequestPayloadV3 = {
      ...baseV3,
      paymentPrivKey,
      signature: {
        signer: '0x9999999999999999999999999999999999999999',
        signature: `0x${'34'.repeat(65)}` as Hex,
        signedAt: '2026-06-10T00:01:00.000Z',
        sellerName: 'Alice',
      },
    };

    const encoded = encodePaymentRequestPayloadForUrl(signedWithPrivateKey);
    const raw = fromBase64UrlString(encoded);
    const decoded = decodePaymentRequestPayloadFromUrl(encoded);

    expect(raw.includes(paymentPrivKey)).toBe(false);
    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    expect((decoded as PaymentRequestPayloadV3).paymentPrivKey).toBe(undefined);
    // Real-secret map was sanitized → the secrets-bound signature is dropped.
    expect((decoded as PaymentRequestPayloadV3).signature).toBeUndefined();
    expect((decoded as PaymentRequestPayloadV3).noteSecretsMap).toEqual(sanitizedMap);
  });

  test('keeps decoding legacy key-bearing JSON links', () => {
    const legacy = {
      ...baseV3,
      paymentPrivKey,
    };

    const decoded = decodePaymentRequestPayloadFromUrl(base64UrlJson(legacy));

    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    expect((decoded as PaymentRequestPayloadV3).paymentPrivKey).toBe(paymentPrivKey);
  });

  test('roundtrips signed discoverable v2 requests through JSON fallback', () => {
    const signed: PaymentRequestPayloadV2 = {
      ...baseV2,
      signature: {
        signer: '0x9999999999999999999999999999999999999999',
        signature: `0x${'56'.repeat(65)}` as Hex,
        signedAt: '2026-06-10T00:01:00.000Z',
        sellerName: 'Carol',
      },
    };

    const decoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(signed));

    expect(decoded).toEqual(signed);
  });

  test('auto-detects binary and legacy JSON payloads', () => {
    const binaryDecoded = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(baseV3));
    expect(binaryDecoded.kind).toBe('ppv2-sdk-payment-request');

    const jsonDecoded = decodePaymentRequestPayloadFromUrl(base64UrlJson(baseV3));
    expect(jsonDecoded.kind).toBe('ppv2-sdk-payment-request');
    expect(jsonDecoded).toEqual(baseV3);
  });

  test('rejects garbage payloads', () => {
    expect(() => decodePaymentRequestPayloadFromUrl('')).toThrow();
    expect(() => decodePaymentRequestPayloadFromUrl('!!!not-base64url!!!')).toThrow();
  });

  test('roundtrips payment receipts', () => {
    const receipt: PaymentReceiptPayload = {
      kind: 'ppv2-payment-receipt',
      version: 1,
      requestId: 'e63ec791-8595-4a94-a292-6840b7639ee6',
      chainId: 11155111,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      amount: '0x2386f26fc10000',
      noteAddressHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      commitment: '0x6666666666666666666666666666666666666666666666666666666666666666',
      label: '0x7777777777777777777777777777777777777777777777777777777777777777',
      txHash: '0x8888888888888888888888888888888888888888888888888888888888888888',
      createdAt: '2026-06-10T00:02:00.000Z',
    };

    expect(decodePaymentReceiptPayloadFromUrl(encodePaymentReceiptPayloadForUrl(receipt))).toEqual(receipt);
  });

  test('classifies single payment-request payloads for the importer (#212)', () => {
    expect(classifySinglePaymentRequestPayload(baseV3)).toBe('sdk-v3');
    // Kind-less V3 (structural fields only) still routes to the restore path.
    const { kind: _kind, ...v3NoKind } = baseV3;
    expect(classifySinglePaymentRequestPayload(v3NoKind)).toBe('sdk-v3');
    // Registered viewing-key request — the exact shape the create flow renders.
    expect(classifySinglePaymentRequestPayload(baseV2)).toBe('registered-v2');
    expect(classifySinglePaymentRequestPayload(JSON.parse(JSON.stringify(baseV2)))).toBe('registered-v2');
    expect(classifySinglePaymentRequestPayload({ ...baseV2, version: 1, noteAddressHash: '0x11' })).toBe('legacy-v1');
    expect(classifySinglePaymentRequestPayload(null)).toBeNull();
    expect(classifySinglePaymentRequestPayload('ppv2-payment-request')).toBeNull();
    expect(classifySinglePaymentRequestPayload({ paymentId: '0x1', chainId: 1 })).toBeNull();
    expect(classifySinglePaymentRequestPayload({ kind: 'ppv2-payment-request', version: 3 })).toBeNull();
  });

  test('classifies pay-link-decoded payloads the same way (#212)', () => {
    const decodedV2 = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(baseV2));
    expect(classifySinglePaymentRequestPayload(decodedV2)).toBe('registered-v2');
    const decodedV3 = decodePaymentRequestPayloadFromUrl(encodePaymentRequestPayloadForUrl(baseV3));
    expect(classifySinglePaymentRequestPayload(decodedV3)).toBe('sdk-v3');
  });

  test('rejects malformed single payloads instead of misclassifying them (#212 codex)', () => {
    // Registered-v2 stub missing requestId/chainId/recipientAddress/tokenId/amount:
    // must NOT report a successful registered request.
    expect(classifySinglePaymentRequestPayload({
      kind: 'ppv2-payment-request',
      version: 2,
      recipientViewingPubKey: 'x',
    })).toBeNull();
    // V2 with the right fields but a non-string amount is still invalid.
    expect(classifySinglePaymentRequestPayload({ ...baseV2, amount: 12345 })).toBeNull();
    // Legacy-v1 stub missing noteAddressHash.
    const { noteAddressHash: _n, ...v1NoHash } = { ...baseV2, version: 1, noteAddressHash: '0x11' } as Record<string, unknown>;
    expect(classifySinglePaymentRequestPayload(v1NoHash)).toBeNull();
    // Explicit sdk-v3 kind but malformed (short paymentId, no noteSecretsMap):
    // must fall through to null, not be routed to the SDK restore path.
    expect(classifySinglePaymentRequestPayload({
      kind: 'ppv2-sdk-payment-request',
      chainId: 11155111,
      paymentId: '0x1234',
      tag: baseV3.tag,
      paymentPubKey: baseV3.paymentPubKey,
      recipientAddress: baseV3.recipientAddress,
      tokenId: baseV3.tokenId,
      amount: baseV3.amount,
    })).toBeNull();
    // Kind-less V3 with an empty noteSecretsMap is invalid.
    const { kind: _k, ...v3NoKind } = baseV3;
    expect(classifySinglePaymentRequestPayload({ ...v3NoKind, noteSecretsMap: [] })).toBeNull();
    // A noteSecretsMap entry with a wrong-length hash is invalid.
    expect(classifySinglePaymentRequestPayload({
      ...v3NoKind,
      noteSecretsMap: [['0xabcd', baseV3.noteSecretsMap[0][1]]],
    })).toBeNull();
  });

  test('roundtrips payment request UUID ids through compact hex ids', () => {
    const ids = [
      'e63ec791-8595-4a94-a292-6840b7639ee6',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ];

    for (const id of ids) {
      expect(paymentRequestIdFromHex(paymentRequestIdToHex(id))).toBe(id);
    }
  });
});

describe('recipient address is not shared', () => {
  // The SDK deliberately keeps recipientAddress out of its public
  // PaymentRequest: fulfilment needs only noteAddressHashes/paymentPubKey/tag,
  // and the address is bound inside Poseidon(ownerAddress, noteSecret), which a
  // payer cannot invert. ppv2's own envelope used to add it back, undoing that.
  const v3 = {
    kind: 'ppv2-sdk-payment-request' as const,
    version: 1 as const,
    chainId: 11155111,
    recipientAddress: '0x7742c09a07645f6984f4d06b5a1b7f5b618e763c' as `0x${string}`,
    paymentId: `0x${'11'.repeat(32)}` as `0x${string}`,
    tag: `0x${'22'.repeat(32)}` as `0x${string}`,
    paymentPubKey: `0x${'33'.repeat(32)}` as `0x${string}`,
    tokenId: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as `0x${string}`,
    amount: '0x4c4b40' as `0x${string}`,
    noteSecretsMap: [[`0x${'44'.repeat(32)}`, `0x${'55'.repeat(32)}`]] as [`0x${string}`, `0x${string}`][],
    createdAt: '2026-08-31T00:00:00.000Z',
  };

  test('an unsigned share link carries no recipient address, in the bytes or the decode', () => {
    const encoded = encodePaymentRequestPayloadForUrl(v3);
    // Not merely absent from the decoded object: absent from the wire. The
    // address must not survive anywhere in the encoded bytes.
    const raw = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
    expect(raw).not.toContain(v3.recipientAddress.slice(2).toLowerCase());

    const decoded = decodePaymentRequestPayloadFromUrl(encoded) as typeof v3;
    expect(decoded.recipientAddress).toBeUndefined();
    // Everything a payer actually needs survives.
    expect(decoded.paymentId).toBe(v3.paymentId);
    expect(decoded.tag).toBe(v3.tag);
    expect(decoded.paymentPubKey).toBe(v3.paymentPubKey);
    expect(decoded.noteSecretsMap).toHaveLength(1);
  });

  test('a SIGNED share link keeps it, because the EIP-712 message covers it', () => {
    const signed = { ...v3,
      // Placeholder secrets, exactly as the create flow signs them: a signature
      // over the REAL map cannot verify against the sanitized payload, so the
      // sanitizer would rightly drop it (and the address with it).
      noteSecretsMap: [[`0x${'44'.repeat(32)}`, `0x${'00'.repeat(32)}`]] as [`0x${string}`, `0x${string}`][],
      signature: {
      signer: v3.recipientAddress,
      signature: `0x${'66'.repeat(65)}` as `0x${string}`,
      signedAt: '2026-08-31T00:00:00.000Z',
      sellerName: 'Pat',
    } };
    const decoded = decodePaymentRequestPayloadFromUrl(
      encodePaymentRequestPayloadForUrl(signed),
    ) as typeof signed;
    expect(decoded.recipientAddress?.toLowerCase()).toBe(v3.recipientAddress);
  });
});
