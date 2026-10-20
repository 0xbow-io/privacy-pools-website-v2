import { describe, expect, test } from 'bun:test';

import {
  buildPaymentRequestRows,
  buildShareLinkForRecord,
  hexTimestampToMs,
  normalizeSecretsEntries,
  type PaymentRequestListDeps,
  type StoredRequestRecordLike,
} from '@/services/payment-request-list';
import {
  decodePaymentRequestPayloadFromUrl,
  sanitizePaymentRequestPayloadForSharing,
  SHARED_NOTE_SECRET_PLACEHOLDER,
} from '@/services/payment-request-codec';

const SEPOLIA = 11155111;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const OWNER = '0x1111111111111111111111111111111111111111';

// Mirrors what the card passes (config/tokens getTokenMetadata + chain name).
const deps: PaymentRequestListDeps = {
  resolveToken: (tokenId) => {
    const id = tokenId.toLowerCase();
    if (id === ETH) return { symbol: 'ETH', address: ETH, decimals: 18 };
    if (id === USDC.toLowerCase()) return { symbol: 'USDC', address: USDC, decimals: 6 };
    return null;
  },
  resolveChainName: (chainId) => (chainId === SEPOLIA ? 'Sepolia' : undefined),
};

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function record(overrides: Partial<StoredRequestRecordLike> = {}): StoredRequestRecordLike {
  return {
    paymentId: hash(1),
    amount: '0xde0b6b3a7640000', // 1 ETH
    tokenId: ETH,
    tag: hash(2),
    paymentPubKey: hash(3),
    recipientAddress: OWNER,
    status: 'OPEN',
    createdAt: `0x${Date.parse('2026-07-01T00:00:00Z').toString(16)}`,
    noteSecretsMap: [[hash(4), hash(5)], [hash(6), hash(7)]],
    ...overrides,
  };
}

describe('hexTimestampToMs', () => {
  test('parses hex milliseconds', () => {
    const ms = Date.parse('2026-07-01T00:00:00Z');
    expect(hexTimestampToMs(`0x${ms.toString(16)}`)).toBe(ms);
  });

  test('upgrades legacy second-precision values', () => {
    expect(hexTimestampToMs(`0x${(1_750_000_000).toString(16)}`)).toBe(1_750_000_000_000);
  });

  test('returns 0 for garbage', () => {
    expect(hexTimestampToMs(undefined)).toBe(0);
    expect(hexTimestampToMs('not-hex')).toBe(0);
  });
});

describe('normalizeSecretsEntries', () => {
  const entries: [string, string][] = [[hash(4), hash(5)]];

  test('accepts Map, entries array, and plain object', () => {
    expect(normalizeSecretsEntries(new Map(entries))).toEqual(entries as never);
    expect(normalizeSecretsEntries(entries)).toEqual(entries as never);
    expect(normalizeSecretsEntries({ [entries[0][0]]: entries[0][1] })).toEqual(entries as never);
  });

  test('empty inputs yield empty list', () => {
    expect(normalizeSecretsEntries(null)).toEqual([]);
    expect(normalizeSecretsEntries([])).toEqual([]);
  });
});

describe('buildShareLinkForRecord', () => {
  test('old decoder accepts the rebuilt link and yields the same slot HASHES (payer-facing fields intact)', () => {
    const rec = record();
    const link = buildShareLinkForRecord(SEPOLIA, rec, 'https://example.test');
    expect(link).not.toBeNull();
    expect(link!.startsWith('https://example.test/pay/')).toBe(true);

    // decodePaymentRequestPayloadFromUrl is byte-identical to the shipped
    // baseline decoder — this is the old-build compatibility check.
    const decoded = decodePaymentRequestPayloadFromUrl(link!.split('/pay/')[1]);
    expect(decoded.kind).toBe('ppv2-sdk-payment-request');
    if (decoded.kind !== 'ppv2-sdk-payment-request') throw new Error('unreachable');
    expect(decoded.chainId).toBe(SEPOLIA);
    expect(decoded.paymentId).toBe(rec.paymentId as never);
    expect(decoded.tag).toBe(rec.tag as never);
    expect(decoded.paymentPubKey).toBe(rec.paymentPubKey as never);
    // Packing pads the amount to whole bytes — compare numerically.
    expect(BigInt(decoded.amount)).toBe(BigInt(rec.amount));
    expect(decoded.tokenId.toLowerCase()).toBe(ETH);
    // The tuple KEYS — the only part the payer consumes — round-trip exactly.
    expect(decoded.noteSecretsMap.map(([k]) => k)).toEqual(
      (rec.noteSecretsMap as [string, string][]).map(([k]) => k) as never,
    );
    // The private discovery key must never ride a rebuilt share link.
    expect(decoded.paymentPrivKey).toBeUndefined();
  });

  test('no recipient-local secret appears anywhere in the encoded link', () => {
    const rec = record();
    const realSecrets = (rec.noteSecretsMap as [string, string][]).map(([, secret]) => secret);
    const link = buildShareLinkForRecord(SEPOLIA, rec, 'https://example.test')!;
    const encoded = link.split('/pay/')[1];

    // Decoded tuples carry only the fixed placeholder in the value slot.
    const decoded = decodePaymentRequestPayloadFromUrl(encoded);
    if (decoded.kind !== 'ppv2-sdk-payment-request') throw new Error('unreachable');
    for (const [, value] of decoded.noteSecretsMap) {
      expect(value).toBe(SHARED_NOTE_SECRET_PLACEHOLDER);
      expect(realSecrets.includes(value)).toBe(false);
    }

    // And the raw encoded bytes contain none of the original secret bytes.
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(b64, 'base64');
    for (const secret of realSecrets) {
      const secretBytes = Buffer.from(secret.slice(2), 'hex');
      expect(bytes.indexOf(secretBytes)).toBe(-1);
    }
  });

  test('sanitizer strips privKey, is idempotent, and drops a secrets-bound signature', () => {
    const payload = {
      kind: 'ppv2-sdk-payment-request' as const,
      version: 1 as const,
      chainId: SEPOLIA,
      recipientAddress: OWNER as never,
      paymentId: hash(1) as never,
      tag: hash(2) as never,
      paymentPubKey: hash(3) as never,
      paymentPrivKey: hash(8) as never,
      tokenId: ETH as never,
      amount: '0xde0b6b3a7640000' as never,
      noteSecretsMap: [[hash(4), hash(5)]] as never,
      createdAt: new Date().toISOString(),
      signature: { signer: OWNER, signature: `0x${'ab'.repeat(65)}`, signedAt: new Date().toISOString() } as never,
    };
    const sanitized = sanitizePaymentRequestPayloadForSharing(payload);
    if (sanitized.kind !== 'ppv2-sdk-payment-request') throw new Error('unreachable');
    expect(sanitized.paymentPrivKey).toBeUndefined();
    expect(sanitized.noteSecretsMap).toEqual([[hash(4), SHARED_NOTE_SECRET_PLACEHOLDER]] as never);
    // Signature was computed over the REAL secrets → dropped, not leaked around.
    expect(sanitized.signature).toBeUndefined();
    // Already-sanitized payloads pass through unchanged (same reference).
    expect(sanitizePaymentRequestPayloadForSharing(sanitized)).toBe(sanitized as never);
  });

  test('no slots or no base → null', () => {
    expect(buildShareLinkForRecord(SEPOLIA, record({ noteSecretsMap: [] }), 'https://x')).toBeNull();
    expect(buildShareLinkForRecord(SEPOLIA, record(), '')).toBeNull();
  });
});

describe('buildPaymentRequestRows', () => {
  const backup = {
    chains: {
      [String(SEPOLIA)]: {
        requests: [
          record(),
          record({
            paymentId: hash(9),
            status: 'FULFILLED',
            amount: '0xf4240', // 1 USDC (6 decimals)
            tokenId: USDC,
            createdAt: `0x${Date.parse('2026-07-05T00:00:00Z').toString(16)}`,
          }),
        ],
      },
    },
  };

  test('shapes sdk rows: amount, token, status, link', () => {
    const rows = buildPaymentRequestRows({ backup, linkBase: 'https://example.test', owner: OWNER }, deps);
    expect(rows.length).toBe(2);
    // Newest first.
    expect(rows[0].id).toBe(hash(9));
    expect(rows[0].status).toBe('FULFILLED');
    expect(rows[0].amountFormatted).toBe('1');
    expect(rows[0].assetSymbol).toBe('USDC');
    // Fulfilled rows carry no share link (nothing left to pay).
    expect(rows[0].payLink).toBeNull();
    expect(rows[0].reissue).toBeNull();

    expect(rows[1].status).toBe('OPEN');
    expect(rows[1].assetSymbol).toBe('ETH');
    expect(rows[1].amountFormatted).toBe('1');
    expect(rows[1].payLink).toContain('/pay/');
    // Open row with a link needs no re-issue fallback.
    expect(rows[1].reissue).toBeNull();
  });

  test('rows are scoped to the owner: another wallet sees neither sdk nor legacy records', () => {
    const otherWallet = '0x2222222222222222222222222222222222222222';
    const legacy = [{
      requestId: 'req-A',
      chainId: SEPOLIA,
      recipientAddress: OWNER as never,
      tokenId: ETH as never,
      amount: '0xde0b6b3a7640000' as never,
      createdAt: '2026-07-03T00:00:00Z',
    }];
    // Wallet B on the same device: no rows from wallet A's stores.
    expect(buildPaymentRequestRows({ backup, legacy, linkBase: 'https://x', owner: otherWallet }, deps)).toEqual([]);
    // Owner match is case-insensitive (checksummed vs lowercase forms).
    const mixed = '0xAbCdEf1111111111111111111111111111111111';
    const rows = buildPaymentRequestRows({
      backup: { chains: { [String(SEPOLIA)]: { requests: [record({ recipientAddress: mixed })] } } },
      linkBase: 'https://x',
      owner: mixed.toLowerCase(),
    }, deps);
    expect(rows.length).toBe(1);
  });

  test('open row without rebuildable link falls back to re-issue prefill (with source chain)', () => {
    const rows = buildPaymentRequestRows({
      backup: {
        chains: { [String(SEPOLIA)]: { requests: [record({ noteSecretsMap: [] })] } },
      },
      linkBase: 'https://example.test',
      owner: OWNER,
    }, deps);
    expect(rows[0].payLink).toBeNull();
    expect(rows[0].reissue).toEqual({ chainId: SEPOLIA, amount: '1', tokenAddress: ETH as never });
  });

  test('unknown token on the source chain → NO re-issue prefill (never a guessed asset)', () => {
    const unknownToken = '0x9999999999999999999999999999999999999999';
    const rows = buildPaymentRequestRows({
      backup: {
        chains: { [String(SEPOLIA)]: { requests: [record({ noteSecretsMap: [], tokenId: unknownToken })] } },
      },
      linkBase: 'https://example.test',
      owner: OWNER,
    }, deps);
    expect(rows.length).toBe(1);
    expect(rows[0].reissue).toBeNull();
  });

  test('legacy V1 entries become LEGACY rows with re-issue prefill, no link', () => {
    const rows = buildPaymentRequestRows({
      backup: null,
      legacy: [{
        requestId: 'req-1',
        chainId: SEPOLIA,
        recipientAddress: OWNER as never,
        tokenId: USDC as never,
        amount: '0x1e8480', // 2 USDC
        createdAt: '2026-06-01T00:00:00Z',
      }],
      linkBase: 'https://example.test',
      owner: OWNER,
    }, deps);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('legacy');
    expect(rows[0].status).toBe('LEGACY');
    expect(rows[0].payLink).toBeNull();
    expect(rows[0].reissue).toEqual({ chainId: SEPOLIA, amount: '2', tokenAddress: USDC as never });
  });

  test('sdk and legacy rows interleave newest-first', () => {
    const rows = buildPaymentRequestRows({
      backup,
      legacy: [{
        requestId: 'req-1',
        chainId: SEPOLIA,
        recipientAddress: OWNER as never,
        tokenId: ETH as never,
        amount: '0xde0b6b3a7640000',
        createdAt: '2026-07-03T00:00:00Z',
      }],
      linkBase: 'https://example.test',
      owner: OWNER,
    }, deps);
    expect(rows.map((r) => r.id)).toEqual([hash(9), 'req-1', hash(1)]);
  });

  test('one out-of-range timestamp cannot blank the list (per-record isolation)', () => {
    // Schema-valid but beyond the ECMAScript Date range (> 8.64e15 ms):
    // toISOString() on it would throw; the row must degrade to an unknown
    // date and the OTHER records must still render.
    const rows = buildPaymentRequestRows({
      backup: {
        chains: {
          [String(SEPOLIA)]: {
            requests: [
              record({ paymentId: hash(0xbad), createdAt: '0x40000000000000' }), // 1.8e16 ms
              record(),
            ],
          },
        },
      },
      linkBase: 'https://example.test',
      owner: OWNER,
    }, deps);
    expect(rows.length).toBe(2);
    const bad = rows.find((r) => r.id === hash(0xbad))!;
    expect(bad.createdAtMs).toBe(0);
    // The good record's link is intact.
    expect(rows.find((r) => r.id === hash(1))!.payLink).toContain('/pay/');
  });
});
